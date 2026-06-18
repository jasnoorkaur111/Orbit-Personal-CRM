// Identity-resolution sweep. Generates likely-duplicate candidate pairs from
// SQL heuristics, has gpt-4o-mini judge each pair, writes results into
// merge_suggestions for one-click review in the Suggestions inbox.
//
// Heuristics intentionally err on the side of *over*-generating candidates;
// the LLM is the precision filter. Cost: ~$0.03 for a 200-contact user.

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { geminiAsk } from '@/lib/gemini';

export const maxDuration = 60;

interface ContactLite {
  id: string;
  name: string;
  email: string | null;
  email_aliases: string[] | null;
  company: string | null;
  role: string | null;
  notes: string | null;
  emails_received: number;
  emails_sent: number;
  linked_event_titles: string[] | null;
}

function emailLocal(e: string | null): string | null {
  if (!e) return null;
  const [local] = e.toLowerCase().split('@');
  return local || null;
}
function firstName(name: string): string {
  return (name.split(/[\s,]/)[0] || '').toLowerCase();
}
function lastName(name: string): string {
  const parts = name.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
  return (parts[parts.length - 1] || '').toLowerCase();
}
// Levenshtein for fuzzy name match (small inputs, cheap)
function lev(a: string, b: string): number {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]) as number[][];
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const token = authHeader.replace('Bearer ', '');
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${token}` } } },
  );
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Load all non-self contacts (both promoted and discovered — merges across both)
  const { data: contactsRaw } = await supabase
    .from('contacts')
    .select('id, name, email, email_aliases, company, role, notes, is_self')
    .eq('user_id', user.id)
    .eq('is_self', false);

  if (!contactsRaw) return NextResponse.json({ error: 'Failed to load contacts' }, { status: 500 });

  // Load email_stats per contact
  const { data: stats } = await supabase
    .from('email_stats')
    .select('contact_id, emails_sent, emails_received')
    .eq('user_id', user.id);
  const statsByCid = new Map((stats || []).map((s) => [s.contact_id, s]));

  // Load linked-event titles per contact (helps LLM see "they're in the same meeting")
  const { data: events } = await supabase
    .from('events')
    .select('contact_id, title, date')
    .eq('user_id', user.id)
    .not('contact_id', 'is', null)
    .gte('date', new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  const eventsByCid = new Map<string, string[]>();
  for (const e of events || []) {
    if (!e.contact_id) continue;
    const arr = eventsByCid.get(e.contact_id) || [];
    if (arr.length < 5) arr.push(e.title);
    eventsByCid.set(e.contact_id, arr);
  }

  // Build enriched list
  const contacts: ContactLite[] = contactsRaw.map((c) => ({
    id: c.id, name: c.name, email: c.email, email_aliases: c.email_aliases,
    company: c.company, role: c.role, notes: c.notes,
    emails_received: statsByCid.get(c.id)?.emails_received || 0,
    emails_sent: statsByCid.get(c.id)?.emails_sent || 0,
    linked_event_titles: eventsByCid.get(c.id) || null,
  }));

  // Load tombstones — don't re-suggest dismissed pairs
  const { data: dismissed } = await supabase
    .from('dismissed_merges').select('contact_a_id, contact_b_id').eq('user_id', user.id);
  const dismissedSet = new Set<string>(
    (dismissed || []).map((d) => [d.contact_a_id, d.contact_b_id].sort().join('|')),
  );

  // ── Candidate generation ──
  // For each contact, generate buckets keyed by lowercased first-name, last-name,
  // and email local-part. Pairs within the same bucket are candidates.
  const buckets = new Map<string, ContactLite[]>();
  const push = (k: string, c: ContactLite) => {
    if (!k) return;
    const arr = buckets.get(k) || [];
    arr.push(c); buckets.set(k, arr);
  };
  for (const c of contacts) {
    const fn = firstName(c.name);
    const ln = lastName(c.name);
    if (fn && fn.length >= 3) push('fn:' + fn, c);
    if (ln && ln.length >= 3 && ln !== fn) push('ln:' + ln, c);
    const local = emailLocal(c.email);
    if (local && local.length >= 3) push('em:' + local, c);
    for (const a of c.email_aliases || []) {
      const al = emailLocal(a);
      if (al && al.length >= 3) push('em:' + al, c);
    }
    if (c.company) push('co:' + c.company.toLowerCase().trim(), c);
  }

  const candidatePairs: [ContactLite, ContactLite][] = [];
  const seen = new Set<string>();
  for (const arr of buckets.values()) {
    if (arr.length < 2 || arr.length > 30) continue; // skip huge buckets (e.g. shared first names that are TOO common)
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i], b = arr[j];
        const key = [a.id, b.id].sort().join('|');
        if (seen.has(key)) continue;
        if (dismissedSet.has(key)) continue;
        // Skip if both already exact-name duplicates (auto-merge would have caught them)
        if (a.name.toLowerCase().trim() === b.name.toLowerCase().trim()) continue;
        // Extra prefilter: at least ONE of {name similar, email-local similar, shared event title}
        const fnA = firstName(a.name), fnB = firstName(b.name);
        const lnA = lastName(a.name), lnB = lastName(b.name);
        const emA = emailLocal(a.email), emB = emailLocal(b.email);
        const nameSimilar =
          (fnA && fnB && (fnA === fnB || lev(fnA, fnB) <= 1)) &&
          (lnA && lnB && (lnA === lnB || lev(lnA, lnB) <= 2));
        const emailSimilar = !!emA && !!emB && (emA === emB || (emA.length >= 4 && emB.length >= 4 && lev(emA, emB) <= 2));
        const sameCompany = !!a.company && a.company.toLowerCase() === (b.company || '').toLowerCase();
        const sharedEvent =
          a.linked_event_titles && b.linked_event_titles &&
          a.linked_event_titles.some((t) => b.linked_event_titles!.includes(t));
        if (!nameSimilar && !emailSimilar && !sameCompany && !sharedEvent) continue;
        seen.add(key);
        candidatePairs.push([a, b]);
      }
    }
  }

  if (candidatePairs.length === 0) {
    return NextResponse.json({ candidates: 0, suggestions: 0, note: 'No candidate pairs found.' });
  }

  // ── Judge with LLM in batches of 8 ──
  const accepted: { canonical_id: string; duplicate_id: string; confidence: number; reasoning: string; evidence: any }[] = [];
  const CHUNK = 8;
  for (let i = 0; i < candidatePairs.length; i += CHUNK) {
    const chunk = candidatePairs.slice(i, i + CHUNK);

    const promptPairs = chunk.map(([a, b], idx) => {
      const cleanA = {
        name: a.name, email: a.email, aliases: a.email_aliases,
        company: a.company, role: a.role,
        notes: (a.notes || '').slice(0, 200),
        email_volume: a.emails_received + a.emails_sent,
        sample_events: (a.linked_event_titles || []).slice(0, 3),
      };
      const cleanB = {
        name: b.name, email: b.email, aliases: b.email_aliases,
        company: b.company, role: b.role,
        notes: (b.notes || '').slice(0, 200),
        email_volume: b.emails_received + b.emails_sent,
        sample_events: (b.linked_event_titles || []).slice(0, 3),
      };
      return `Pair ${idx}:\n  A: ${JSON.stringify(cleanA)}\n  B: ${JSON.stringify(cleanB)}`;
    }).join('\n\n');

    const prompt = `You are an identity-resolution judge. For each pair below, decide if A and B are the SAME real-world person whose data is split across two contact records.

Cues that indicate SAME person:
- Shared email local-part (jane@gmail.com vs jane@work.com)
- One name is a nickname/short form (Jim vs James) of the other
- One record is the personal email, the other is the org/team email but a person clearly runs it (e.g. "SportsRANCH Foundation" with email nitin.office2020@gmail.com → that's Nitin's personal address running the foundation)
- Same company AND similar name
- Appear in the same calendar events

Cues that indicate DIFFERENT people:
- Same first name but clearly different last name (Sarah Smith vs Sarah Jones)
- Same company but different roles
- One is clearly a personal contact, the other is an organization with no name in common

Canonical is the row to KEEP (richer data wins — email > no email, real name > org name, more email volume).

${promptPairs}`;

    try {
      const raw = await geminiAsk(prompt, {
        model: 'flash-lite',
        temperature: 0,
        responseSchema: {
          type: 'object',
          properties: {
            judgments: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  pair: { type: 'integer' },
                  same_person: { type: 'boolean' },
                  canonical: { type: 'string' },          // "A" or "B"
                  confidence: { type: 'integer' },
                  reasoning: { type: 'string' },
                },
                required: ['pair', 'same_person', 'canonical', 'confidence', 'reasoning'],
              },
            },
          },
          required: ['judgments'],
        },
      });
      const parsed = JSON.parse(raw || '{}');
      for (const out of (parsed.judgments || []) as any[]) {
        if (out.same_person !== true) continue;
        if (typeof out.confidence !== 'number' || out.confidence < 60) continue;
        const idx = out.pair;
        if (typeof idx !== 'number' || !chunk[idx]) continue;
        const [a, b] = chunk[idx];
        const canonical = out.canonical === 'B' ? b : a;
        const duplicate = canonical.id === a.id ? b : a;
        accepted.push({
          canonical_id: canonical.id,
          duplicate_id: duplicate.id,
          confidence: Math.round(out.confidence),
          reasoning: String(out.reasoning || '').slice(0, 400),
          evidence: {
            canonical_name: canonical.name, canonical_email: canonical.email,
            duplicate_name: duplicate.name, duplicate_email: duplicate.email,
          },
        });
      }
    } catch (e: any) {
      console.error('LLM judge failed for chunk', i, e?.message);
    }
  }

  // Upsert merge_suggestions (don't overwrite already-accepted/rejected)
  let inserted = 0;
  for (const s of accepted) {
    const { error } = await supabase.from('merge_suggestions').upsert(
      { user_id: user.id, ...s },
      { onConflict: 'user_id,canonical_id,duplicate_id', ignoreDuplicates: true },
    );
    if (!error) inserted++;
  }

  return NextResponse.json({
    candidates: candidatePairs.length,
    suggestions: accepted.length,
    inserted,
  });
}
