import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

// Lazy-init so the module can be imported (e.g. at build time) without an
// OPENAI_API_KEY set; the client is only constructed on first request.
let _openai: OpenAI | null = null;
const getOpenAI = () => (_openai ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));

export const maxDuration = 300; // 5 min for big batches

export interface EventEnrichment {
  participants: { name: string; evidence: string }[];      // names found in title + description
  event_type: 'meeting_1on1' | 'meeting_team' | 'meeting_external' | 'focus' | 'personal' | 'family' | 'travel' | 'admin' | 'other';
  topic_tags: string[];                                     // e.g. ["fundraise", "product", "hiring"]
  sentiment?: 'positive' | 'neutral' | 'negative';
  follow_up?: string | null;                                // any "follow up..." cue extracted from description
}

const BATCH_SIZE = 25;    // events per LLM call
const MAX_BATCHES = 20;   // ~500 events per API call max (cost cap)

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const token = authHeader.replace('Bearer ', '');

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${token}` } } }
  );

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const onlyMissing = body.onlyMissing !== false; // default: enrich only events without enrichment
  const limit = Math.min(body.limit || 500, 1000);

  // Pull contacts for context (LLM uses for participant resolution)
  const { data: contacts } = await supabase
    .from('contacts')
    .select('id, name, email, company')
    .eq('user_id', user.id)
    .eq('is_self', false);

  const knownNames = (contacts || []).map((c) => c.name).slice(0, 200); // cap context size

  // Pull events to enrich
  let query = supabase.from('events')
    .select('id, title, description, date, time, end_time, organizer_email, attendees')
    .eq('user_id', user.id)
    .order('date', { ascending: false })
    .limit(limit);
  if (onlyMissing) query = query.is('enriched_at', null);

  const { data: events } = await query;
  if (!events || events.length === 0) {
    return NextResponse.json({ enriched: 0, message: 'No events to enrich.' });
  }

  let totalEnriched = 0;
  const errors: string[] = [];

  for (let batchStart = 0; batchStart < Math.min(events.length, BATCH_SIZE * MAX_BATCHES); batchStart += BATCH_SIZE) {
    const batch = events.slice(batchStart, batchStart + BATCH_SIZE);
    if (batch.length === 0) break;

    const prompt = buildPrompt(batch, knownNames, user.email || '');

    try {
      const completion = await getOpenAI().chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        response_format: { type: 'json_object' },
      });

      const parsed = JSON.parse(completion.choices[0]?.message?.content || '{"results":[]}');
      const results: ({ id: string } & EventEnrichment)[] = parsed.results || [];

      // Bulk update — one query per event (could batch via RPC but this is fine for now)
      const now = new Date().toISOString();
      for (const r of results) {
        const { id, ...enrichment } = r;
        await supabase.from('events')
          .update({ enrichment, enriched_at: now })
          .eq('id', id)
          .eq('user_id', user.id);
        totalEnriched++;
      }
    } catch (e: any) {
      console.error('Enrichment batch failed:', e);
      errors.push(`batch ${batchStart}: ${e.message}`);
    }
  }

  return NextResponse.json({
    enriched: totalEnriched,
    total_pending: events.length,
    errors: errors.length > 0 ? errors : undefined,
  });
}

function buildPrompt(
  events: { id: string; title: string; description: string | null; date: string; time: string | null; end_time: string | null; organizer_email: string | null; attendees: any }[],
  knownNames: string[],
  userEmail: string,
): string {
  const trimDesc = (d: string | null) => (d || '').slice(0, 600).replace(/\s+/g, ' ').trim();
  return `You are enriching calendar events for a personal CRM.

The owner of this calendar: ${userEmail}. Anything tied to them is "self" — not a participant.

Known contacts (use these for participant resolution; only match against THIS list, never invent new people):
${knownNames.join(', ')}

For each event below, return:
- participants: array of names from the known-contacts list that appear in title/description/attendees/organizer. NEVER include the owner.
- event_type: meeting_1on1 | meeting_team | meeting_external | focus | personal | family | travel | admin | other
- topic_tags: 1-4 short lowercase tags (e.g. "fundraise", "product", "interview", "yoga", "flight")
- sentiment: positive | neutral | negative (skip if unclear)
- follow_up: any "follow up" / "next steps" / "todo" cue extracted from the description, or null

For each participant, briefly state the evidence in the "evidence" field (e.g. "name in title" / "attendee email matched" / "mentioned in description").

Respond with ONLY a JSON object: {"results":[{"id":"...","participants":[...],"event_type":"...","topic_tags":[...],"sentiment":"...","follow_up":"..."}]}

Events:
${events.map((e, i) => `--- Event ${i} (id=${e.id}) ---
Title: ${e.title}
Date: ${e.date}${e.time ? ' ' + e.time : ''}${e.end_time ? '-' + e.end_time : ''}
Organizer: ${e.organizer_email || '(none)'}
Attendees: ${e.attendees ? (Array.isArray(e.attendees) ? e.attendees.map((a: any) => a.email || a.name).join(', ') : '(none)') : '(none)'}
Description: ${trimDesc(e.description)}`).join('\n\n')}`;
}
