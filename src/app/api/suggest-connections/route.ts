import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isNoiseEmail } from '@/lib/noiseEmails';
import { geminiAsk } from '@/lib/gemini';

export const maxDuration = 120;

type Pair = { aId: string; bId: string; aName: string; bName: string; evidence: string[]; sharedEvents: number; mutualMentions: number; sameDomain: boolean; sharedEnrichment: number; sharedOrganizer: number };

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const token = authHeader.replace('Bearer ', '');

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${token}` } } }
  );

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Pull all data we need
  const [{ data: contacts }, { data: existingConnections }, { data: dismissed }, { data: events }, { data: existingPending }] = await Promise.all([
    supabase.from('contacts').select('id, name, email, email_aliases, company, notes, is_self').eq('user_id', user.id),
    supabase.from('connections').select('from_contact_id, to_contact_id').eq('user_id', user.id),
    supabase.from('dismissed_pairs').select('contact_a_id, contact_b_id').eq('user_id', user.id),
    supabase.from('events').select('id, title, attendees, organizer_email, enrichment, date').eq('user_id', user.id).gte('date', new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)),
    supabase.from('connection_suggestions').select('from_contact_id, to_contact_id').eq('user_id', user.id).eq('status', 'pending'),
  ]);

  if (!contacts) {
    return NextResponse.json({ error: 'No contacts' }, { status: 400 });
  }

  // Exclude self (and collect self aliases so we never link them as a contact)
  const selfEmails = new Set<string>();
  for (const c of contacts) {
    if (!c.is_self) continue;
    if (c.email) selfEmails.add(c.email.toLowerCase());
    for (const a of (c.email_aliases as string[] | null) || []) if (a) selfEmails.add(a.toLowerCase());
  }
  let candidates = contacts.filter((c) => !c.is_self);
  let contactsById = new Map(candidates.map((c) => [c.id, c]));
  let contactsByEmail = new Map(candidates.filter((c) => c.email).map((c) => [c.email!.toLowerCase(), c]));

  // ── Pre-pass: create Discovered contacts for unknown event attendees ──
  // Otherwise the matching loops below drop anyone not already in contacts,
  // and entire intro/meeting chains never produce any suggestion.
  const unknownAttendees = new Map<string, string>(); // email → best name we saw
  for (const ev of events || []) {
    const list = (ev.attendees as { name?: string; email?: string }[] | null) || [];
    for (const a of list) {
      const addr = a.email?.toLowerCase();
      if (!addr || selfEmails.has(addr) || contactsByEmail.has(addr) || isNoiseEmail(addr, a.name)) continue;
      const cur = unknownAttendees.get(addr);
      const nm = a.name?.trim();
      if (!cur || cur === addr) unknownAttendees.set(addr, nm || addr);
    }
    const orgAddr = (ev as any).organizer_email?.toLowerCase();
    if (orgAddr && !selfEmails.has(orgAddr) && !contactsByEmail.has(orgAddr) && !unknownAttendees.has(orgAddr) && !isNoiseEmail(orgAddr)) {
      unknownAttendees.set(orgAddr, orgAddr);
    }
  }
  if (unknownAttendees.size > 0) {
    const newRows = Array.from(unknownAttendees.entries()).map(([addr, name]) => ({
      user_id: user.id,
      email: addr,
      name: name || addr,
      is_promoted: true,   // auto-promoted: noise filter already ran, no review tray
      is_direct: false,
      is_self: false,
      tags: [],
      color: '#7c5cff',
      notes: '',
    }));
    for (let i = 0; i < newRows.length; i += 100) {
      const batch = newRows.slice(i, i + 100);
      const { data: inserted, error } = await supabase
        .from('contacts')
        .insert(batch)
        .select('id, name, email, company, notes, is_self');
      if (error) {
        console.error('Discovered-attendee insert failed:', error);
        continue;
      }
      for (const row of (inserted || []) as any[]) {
        candidates.push(row);
        contactsById.set(row.id, row);
        if (row.email) contactsByEmail.set(row.email.toLowerCase(), row);
      }
    }
  }

  // Build set of already-connected pairs (canonical-ordered)
  const orderedPair = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const connectedPairs = new Set<string>();
  (existingConnections || []).forEach((c) => connectedPairs.add(orderedPair(c.from_contact_id, c.to_contact_id)));
  const dismissedPairs = new Set<string>();
  (dismissed || []).forEach((d) => dismissedPairs.add(orderedPair(d.contact_a_id, d.contact_b_id)));
  const pendingPairs = new Set<string>();
  (existingPending || []).forEach((p) => pendingPairs.add(orderedPair(p.from_contact_id, p.to_contact_id)));

  // Aggregate evidence by pair
  const pairData = new Map<string, Pair>();

  const recordEvidence = (aId: string, bId: string, evType: 'shared_event' | 'mutual_mention' | 'same_domain' | 'shared_enrichment' | 'shared_organizer', detail: string) => {
    if (aId === bId) return;
    const key = orderedPair(aId, bId);
    if (connectedPairs.has(key) || dismissedPairs.has(key) || pendingPairs.has(key)) return;
    const [fromId, toId] = aId < bId ? [aId, bId] : [bId, aId];
    let p = pairData.get(key);
    if (!p) {
      const a = contactsById.get(fromId)!;
      const b = contactsById.get(toId)!;
      if (!a || !b) return;
      p = { aId: fromId, bId: toId, aName: a.name, bName: b.name, evidence: [], sharedEvents: 0, mutualMentions: 0, sameDomain: false, sharedEnrichment: 0, sharedOrganizer: 0 };
      pairData.set(key, p);
    }
    if (evType === 'shared_event') p.sharedEvents++;
    if (evType === 'mutual_mention') p.mutualMentions++;
    if (evType === 'same_domain') p.sameDomain = true;
    if (evType === 'shared_enrichment') p.sharedEnrichment++;
    if (evType === 'shared_organizer') p.sharedOrganizer++;
    if (p.evidence.length < 6) p.evidence.push(detail);
  };

  // ── Evidence source 1: shared calendar events (by attendee email) ──
  for (const ev of events || []) {
    const attendees = ev.attendees as { name: string; email: string }[] | null;
    if (!attendees || attendees.length < 2) continue;
    const matchedIds: string[] = [];
    for (const att of attendees) {
      const email = att.email?.toLowerCase();
      if (!email) continue;
      const c = contactsByEmail.get(email);
      if (c) matchedIds.push(c.id);
    }
    // All pairs of matched attendees
    for (let i = 0; i < matchedIds.length; i++) {
      for (let j = i + 1; j < matchedIds.length; j++) {
        recordEvidence(matchedIds[i], matchedIds[j], 'shared_event', `Co-attended "${ev.title}" on ${ev.date}`);
      }
    }
  }

  // ── Evidence source 1b: ORGANIZER co-attendance — even Outlook ships this ──
  for (const ev of events || []) {
    const orgEmail = (ev as any).organizer_email?.toLowerCase();
    if (!orgEmail) continue;
    const organizer = contactsByEmail.get(orgEmail);
    if (!organizer) continue;
    // If you (the user) attended and they organized, that's a 1:1 signal but no PAIR signal
    // BUT if any OTHER contact also appears in this event (via title mention or attendee), link them
    const matchedIds: string[] = [organizer.id];
    const attendees = (ev.attendees as { email: string }[] | null) || [];
    for (const att of attendees) {
      const c = contactsByEmail.get(att.email?.toLowerCase() || '');
      if (c && c.id !== organizer.id) matchedIds.push(c.id);
    }
    for (let i = 0; i < matchedIds.length; i++) {
      for (let j = i + 1; j < matchedIds.length; j++) {
        recordEvidence(matchedIds[i], matchedIds[j], 'shared_organizer', `${organizer.name} organized "${ev.title}" with both`);
      }
    }
  }

  // ── Evidence source 1c: LLM-enriched participants in events ──
  // Use AI-extracted participants from event title + description (more reliable than attendee field)
  const contactsByName = new Map(candidates.map((c) => [c.name.toLowerCase(), c]));
  for (const ev of events || []) {
    const enrichment = (ev as any).enrichment;
    if (!enrichment?.participants || !Array.isArray(enrichment.participants)) continue;
    const matchedIds: string[] = [];
    for (const p of enrichment.participants) {
      const c = contactsByName.get((p.name || '').toLowerCase());
      if (c) matchedIds.push(c.id);
    }
    for (let i = 0; i < matchedIds.length; i++) {
      for (let j = i + 1; j < matchedIds.length; j++) {
        recordEvidence(matchedIds[i], matchedIds[j], 'shared_enrichment', `AI-detected co-participation in "${ev.title}"`);
      }
    }
  }

  // ── Evidence source 1d: same email domain → coworker inference ──
  const PUBLIC_DOMAINS = new Set(['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'me.com', 'aol.com', 'protonmail.com', 'live.com', 'msn.com']);
  const byDomain = new Map<string, typeof candidates>();
  for (const c of candidates) {
    if (!c.email) continue;
    const domain = c.email.split('@')[1]?.toLowerCase();
    if (!domain || PUBLIC_DOMAINS.has(domain)) continue;
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain)!.push(c);
  }
  for (const [domain, group] of byDomain) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        recordEvidence(group[i].id, group[j].id, 'same_domain', `Both at @${domain}`);
      }
    }
  }

  // ── Evidence source 2: notes cross-references (first-name word boundary) ──
  // For each contact's notes, find mentions of OTHER contacts' first names
  const nameToId = new Map<string, string>();
  candidates.forEach((c) => {
    const first = c.name.split(' ')[0].toLowerCase();
    if (first.length >= 4 && !nameToId.has(first)) {
      nameToId.set(first, c.id);
    }
  });

  for (const c of candidates) {
    if (!c.notes) continue;
    const lower = c.notes.toLowerCase();
    nameToId.forEach((otherId, firstName) => {
      if (otherId === c.id) return;
      const re = new RegExp('\\b' + firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
      if (re.test(lower)) {
        recordEvidence(c.id, otherId, 'mutual_mention', `"${c.name}"'s notes reference "${contactsById.get(otherId)?.name}"`);
      }
    });
  }

  // Filter pairs that have enough evidence to be worth proposing
  // Weight each source: enrichment=3, shared_event=2, organizer=2, mention=2, same_domain=1
  const score = (p: Pair) => p.sharedEnrichment * 3 + p.sharedEvents * 2 + p.sharedOrganizer * 2 + p.mutualMentions * 2 + (p.sameDomain ? 1 : 0);
  const candidatesForLLM = Array.from(pairData.values())
    .filter((p) => score(p) >= 2)
    .sort((a, b) => score(b) - score(a))
    .slice(0, 60); // cap for cost control

  if (candidatesForLLM.length === 0) {
    return NextResponse.json({ suggestions: [], total: 0, message: 'No new suggestions found.' });
  }

  // LLM judgment pass: batch process pairs
  const prompt = `You're helping a user clean up their network graph by judging which pairs of their contacts are likely connected (i.e. know each other in real life).

For each pair below, assess:
1. confidence (0-100): how likely they actually know each other given the evidence
2. type: one of "coworker" | "collaborator" | "client" | "investor" | "friend" | "family" | "mutual_friend" | "weak"
3. summary: one short sentence explaining why

Strong signals: multiple shared meetings, both named in same notes, work at same company.
Weak signals: one event, one mention, names that could be coincidence.

Owner of this network: ${user.email}. Anything tied to that email is the user themselves and should NOT be treated as a connection.

Return JSON array, one object per input pair, in the same order:
{"results":[{"index":N,"confidence":N,"type":"...","summary":"..."}]}

Pairs:
${candidatesForLLM.map((p, i) => `${i}. ${p.aName} ↔ ${p.bName}
   Signals: ${p.sharedEvents} shared events, ${p.sharedEnrichment} AI-detected co-participation, ${p.sharedOrganizer} shared organizer, ${p.mutualMentions} notes mentions${p.sameDomain ? ', same email domain' : ''}
   Evidence: ${p.evidence.join(' | ')}`).join('\n\n')}`;

  try {
    const raw = await geminiAsk(prompt, {
      model: 'flash-lite',
      temperature: 0,
      responseSchema: {
        type: 'object',
        properties: {
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'integer' },
                confidence: { type: 'integer' },
                type: { type: 'string' },
                summary: { type: 'string' },
              },
              required: ['index', 'confidence', 'type', 'summary'],
            },
          },
        },
        required: ['results'],
      },
    });

    const parsed = JSON.parse(raw || '{}');
    const results: { index: number; confidence: number; type: string; summary: string }[] = parsed.results || [];

    const toInsert = results
      .filter((r) => r.confidence >= 40) // skip very weak suggestions
      .map((r) => {
        const p = candidatesForLLM[r.index];
        if (!p) return null;
        return {
          user_id: user.id,
          from_contact_id: p.aId,
          to_contact_id: p.bId,
          confidence: Math.min(100, Math.max(0, Math.round(r.confidence))),
          suggested_type: r.type,
          evidence_summary: r.summary,
          evidence_count: p.sharedEvents + p.mutualMentions,
        };
      })
      .filter(Boolean) as any[];

    if (toInsert.length > 0) {
      await supabase.from('connection_suggestions').upsert(toInsert, { onConflict: 'user_id,from_contact_id,to_contact_id', ignoreDuplicates: true });
    }

    return NextResponse.json({ suggestions: toInsert.length, total: candidatesForLLM.length });
  } catch (error: any) {
    console.error('Suggestion error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
