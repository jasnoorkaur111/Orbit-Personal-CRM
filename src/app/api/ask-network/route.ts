import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { geminiAsk } from '@/lib/gemini';

export const maxDuration = 60;

/**
 * "Ask your network" — natural-language Q&A over your contacts.
 * The user types a question like "who do I know in NYC working in AI?"
 * We pull every contact's compact dossier (name + role + company + tags +
 * notes + research signals + synthesis topics) and ask Gemini to pick the
 * top matches with one-sentence reasoning per match.
 */
export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const token = authHeader.replace('Bearer ', '');
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { global: { headers: { Authorization: `Bearer ${token}` } } },
    );
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const query = (body?.query || '').toString().trim();
    if (!query) return NextResponse.json({ error: 'Empty query' }, { status: 400 });
    if (query.length > 500) return NextResponse.json({ error: 'Query too long' }, { status: 400 });

    // Pull every non-self promoted contact + their enriched fields + email_stats
    // (the interaction-recency join lets us answer "going cold" / "haven't spoken
    // to" / "owe a reply" questions — without it the LLM falls back to fuzzy
    // wordplay matching, e.g. "going cold" matching "Coldbridge" the company).
    const { data: contacts, error: cErr } = await supabase
      .from('contacts')
      .select('id, name, role, company, notes, tags, last_contacted, research, synthesis, email_stats(emails_sent, emails_received, last_inbound_at, last_outbound_at, thread_count)')
      .eq('user_id', user.id)
      .eq('is_self', false)
      .neq('is_promoted', false);
    if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 });
    if (!contacts || contacts.length === 0) {
      return NextResponse.json({ matches: [], reasoning: 'No contacts to search.' });
    }

    const now = Date.now();
    const daysSince = (ts: string | null | undefined) =>
      ts ? Math.floor((now - new Date(ts).getTime()) / 86400000) : null;

    // Build a compact dossier per contact. Keep each blob ≲ 400 chars so we
    // can fit ~500 contacts within a single Flash call.
    type Dossier = { id: string; line: string };
    const dossiers: Dossier[] = contacts.map((c: any) => {
      const parts: string[] = [];
      if (c.role) parts.push(`role=${c.role}`);
      if (c.company) parts.push(`co=${c.company}`);
      if (c.tags?.length) parts.push(`tags=[${c.tags.slice(0, 5).join(',')}]`);

      // Interaction recency — top-line signals so "cold/dormant/recent" queries
      // hit real data instead of bio wordplay.
      const stats = Array.isArray(c.email_stats) ? c.email_stats[0] : c.email_stats;
      const dLastIn = daysSince(stats?.last_inbound_at);
      const dLastOut = daysSince(stats?.last_outbound_at);
      const dLastTouch = daysSince(c.last_contacted);
      const allDays = [dLastIn, dLastOut, dLastTouch].filter((d): d is number => d != null);
      const freshest = allDays.length ? Math.min(...allDays) : null;
      if (freshest != null) {
        parts.push(`last_touch=${freshest}d_ago`);
      } else {
        parts.push('last_touch=never');
      }
      if (stats?.thread_count) parts.push(`threads=${stats.thread_count}`);
      const totalEmails = (stats?.emails_sent || 0) + (stats?.emails_received || 0);
      if (totalEmails > 0) parts.push(`emails=${totalEmails}`);
      // Reply-debt signal: positive = you owe them, negative = they owe you
      if (dLastIn != null && (dLastOut == null || dLastIn < dLastOut)) {
        parts.push(`you_owe_reply=${dLastIn}d`);
      } else if (dLastOut != null && (dLastIn == null || dLastOut < dLastIn)) {
        parts.push(`awaiting_their_reply=${dLastOut}d`);
      }

      if (c.notes) parts.push(`notes="${String(c.notes).slice(0, 120)}"`);
      const signals = c.research?.signals;
      if (Array.isArray(signals) && signals.length) {
        const facts = signals.slice(0, 6).map((s: any) => s?.text).filter(Boolean).map((t: string) => t.slice(0, 110));
        if (facts.length) parts.push(`facts=[${facts.join(' | ')}]`);
      }
      const topics = c.synthesis?.common_topics;
      if (Array.isArray(topics) && topics.length) parts.push(`topics=[${topics.slice(0, 5).join(',')}]`);
      const hooks = c.synthesis?.hooks;
      if (Array.isArray(hooks) && hooks.length) parts.push(`hooks=[${hooks.slice(0, 3).map((h: string) => h.slice(0, 70)).join(' | ')}]`);
      const line = `${c.name}: ${parts.join(' | ')}`.slice(0, 480);
      return { id: c.id, line };
    });

    // Sort: contacts with more enriched data first (more likely to match)
    dossiers.sort((a, b) => b.line.length - a.line.length);

    const indexLines = dossiers.map((d, i) => `[${i}] ${d.line}`).join('\n');

    // Honor explicit counts in the query — "top 3", "the 5 best", "a few", etc.
    // For BROAD/EXHAUSTIVE phrasings ("all", "every", "list all", "complete
    // list of", "who are the") bump the default to 20 — these are explicitly
    // asking for the full set, so the 5-cap was hiding most matches.
    const explicitMatch = query.match(/\b(?:top|first|best|next|give me|find me|show me|the)?\s*(\d{1,2})\s*(?:people|contacts|matches|results|of them)?\b/i);
    const explicit = explicitMatch ? Math.min(30, parseInt(explicitMatch[1], 10)) : null;
    const isBroadQuery = /\b(all|every|each|complete\s+list|full\s+list|entire|who\s+are\s+the\s+|list\s+all|list\s+every)\b/i.test(query);
    const maxResults = explicit ?? (isBroadQuery ? 20 : 5);

    const prompt = `You're helping someone search their personal network. Be terse — like texting.

User asked: "${query}"

Their contacts (indexed). Field key:
- last_touch=Nd_ago: days since the FRESHEST interaction (email or meeting). last_touch=never means no recorded contact.
- you_owe_reply=Nd: they emailed you N days ago and you haven't replied.
- awaiting_their_reply=Nd: you emailed N days ago, they haven't responded.
- threads / emails: email volume signal — higher = closer relationship.
- facts: biographical facts from web research. topics/hooks: synthesized conversation themes.

${indexLines}

Rules:
- For "going cold" / "haven't spoken to" / "dormant" / "fading" questions: rank by HIGH last_touch=Nd_ago value (older = colder). Ignore people with last_touch=never (never spoken doesn't mean cold).
- For "who do I owe" questions: pick rows with you_owe_reply (highest N first).
- For "closest" / "strongest" questions: pick rows with highest threads/emails.
- For biographical / topic questions: use facts, topics, hooks, notes, role, company.
- Return at MOST ${maxResults} matches. ${explicit ? `User explicitly asked for ${maxResults} — do not exceed it.` : ''}${isBroadQuery ? ' User asked for ALL matches — be inclusive, include borderline matches if there is ANY signal (tag, company name, role keyword, web research fact). Better to surface a borderline match with a hedged reason ("Likely investor — works at Wildwood Ventures") than to miss them.' : ''}
- Each "reason" ≤ 10 words. CITE the matching field (e.g. "Last touch 47d ago" or "Founded AI startup in NYC"). No filler.
- If nothing genuinely matches, return [].
- "vibe" = ONE short group comment (≤ 8 words). Examples: "All in healthcare", "Tabai stands out", "Mostly cold for 30+ days". NEVER include a count number.

JSON shape:
{
  "vibe": "...",
  "matches": [
    { "index": 12, "reason": "Last touch 84d ago" }
  ]
}`;

    const raw = await geminiAsk(prompt, {
      // flash-lite has a separate, much more generous free-tier quota than
      // flash (flash free tier is 20 RPD; lite is ~1000 RPD). Quality is more
      // than enough for filtering an indexed contact list.
      model: 'flash-lite',
      temperature: 0.2,
      thinkingBudget: 0,
      responseSchema: {
        type: 'object',
        properties: {
          vibe: { type: 'string' },
          matches: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'integer' },
                reason: { type: 'string' },
              },
              required: ['index', 'reason'],
            },
          },
        },
        required: ['vibe', 'matches'],
      },
    });

    let parsed: { matches: { index: number; reason: string }[]; vibe: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: 'LLM returned malformed JSON', raw }, { status: 502 });
    }

    // Enforce explicit cap server-side as a backstop (LLMs sometimes overshoot)
    const results = (parsed.matches || [])
      .filter((m) => Number.isInteger(m.index) && m.index >= 0 && m.index < dossiers.length)
      .slice(0, maxResults)
      .map((m) => ({
        contactId: dossiers[m.index].id,
        reason: (m.reason || '').trim(),
      }));

    // Synthesize the intro server-side from the ACTUAL match count + LLM's vibe
    // line. This guarantees count and matches can never disagree (the bug where
    // LLM said "3 here" but returned 5 was the intro hallucinating).
    const vibe = (parsed.vibe || '').trim();
    let intro: string;
    if (results.length === 0) {
      intro = 'Nothing matched.';
    } else if (results.length === 1) {
      intro = vibe || 'One match.';
    } else {
      intro = `${results.length} matches${vibe ? ` — ${vibe}` : '.'}`;
    }

    return NextResponse.json({
      matches: results,
      intro,
      searchedCount: contacts.length,
    });
  } catch (e: any) {
    console.error('ask-network failed:', e);
    const msg = e?.message || String(e);
    // Gemini quota exhaustion → 429 so the client can show a friendly message
    if (/RESOURCE_EXHAUSTED|quota|429/i.test(msg)) {
      return NextResponse.json(
        { error: 'AI quota exhausted for today. Try again tomorrow, or enable Gemini billing for higher limits.' },
        { status: 429 },
      );
    }
    return NextResponse.json({ error: msg || 'Ask failed' }, { status: 500 });
  }
}
