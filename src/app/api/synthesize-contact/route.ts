import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { geminiAsk } from '@/lib/gemini';
import { extractJson } from '../research-contact/candidates/route';

export const maxDuration = 60;

export interface ContactSynthesis {
  relationship_type: string;            // "coworker" | "collaborator" | "investor" | "mentor" | "friend" | "family" | "client" | "weak"
  tempo: string;                        // "weekly 1-on-1" / "monthly catch-up" / "stale 90 days"
  common_topics: string[];              // ["fundraise", "product roadmap"]
  cadence_signal: string | null;        // "spike in last month" | "drifting" | null
  prebrief: string[];                   // 3-5 bullets for next meeting
  hooks: string[];                      // conversation starters
  approach: string | null;              // "prefers async slack" / "always brings coffee"
  avoid: string | null;                 // "don't discuss former co" / null
  evidence_count: number;
  synthesized_at: string;
}

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

  const { contactId } = await request.json();
  if (!contactId) return NextResponse.json({ error: 'contactId required' }, { status: 400 });

  // Pull contact + all signals
  const { data: contact } = await supabase
    .from('contacts')
    .select('id, name, email, company, role, notes, is_self, research, synthesis, synthesized_at')
    .eq('id', contactId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
  if (contact.is_self) return NextResponse.json({ error: 'Cannot synthesize self' }, { status: 400 });

  const firstName = contact.name.split(' ')[0].toLowerCase();
  const nameRegex = new RegExp('\\b' + firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');

  // Pull related events: where this contact is in attendees / enrichment.participants / title / description
  const { data: allEvents } = await supabase
    .from('events')
    .select('id, title, description, date, time, end_time, source, contact_id, attendees, organizer_email, enrichment')
    .eq('user_id', user.id)
    .gte('date', new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10))
    .order('date', { ascending: false });

  const contactEvents = (allEvents || []).filter((e: any) => {
    if (e.contact_id === contact.id) return true;
    if (contact.email && Array.isArray(e.attendees) && (e.attendees as any[]).some((a) => a.email?.toLowerCase() === contact.email!.toLowerCase())) return true;
    if (contact.email && e.organizer_email?.toLowerCase() === contact.email.toLowerCase()) return true;
    const enrichment = e.enrichment as any;
    if (enrichment?.participants?.some((p: any) => p.name?.toLowerCase() === contact.name.toLowerCase())) return true;
    if (nameRegex.test(e.title || '')) return true;
    return false;
  }).slice(0, 50); // cap context size

  // Pull this contact's pending tasks
  const { data: tasks } = await supabase
    .from('tasks')
    .select('title, completed, due_date, created_at')
    .eq('contact_id', contact.id)
    .order('created_at', { ascending: false })
    .limit(20);

  const prompt = `You're synthesizing a behavioral relationship profile for a CRM user about one of their contacts.

USER: ${user.email}
CONTACT: ${contact.name}${contact.role ? ', ' + contact.role : ''}${contact.company ? ' at ' + contact.company : ''}

NOTES (user's own observations):
${(contact.notes || '(none)').slice(0, 2500)}

WEB RESEARCH (if previously gathered):
${contact.research ? JSON.stringify((contact.research as any).signals || []).slice(0, 1500) : '(none)'}

INTERACTION HISTORY (last 12 months, ${contactEvents.length} events with this contact):
${contactEvents.map((e) => `- ${e.date}${e.time ? ' ' + e.time.slice(0, 5) : ''} · ${e.title}${(e.enrichment as any)?.topic_tags?.length ? ' [' + (e.enrichment as any).topic_tags.join(', ') + ']' : ''}`).join('\n')}

TASKS:
${(tasks || []).map((t) => `- ${t.completed ? '[done]' : '[open]'} ${t.title}`).join('\n') || '(none)'}

Synthesize the relationship. Return ONLY a JSON object wrapped in a single \`\`\`json code block:

{
  "relationship_type": "coworker" | "collaborator" | "client" | "investor" | "mentor" | "friend" | "family" | "weak" | "unknown",
  "tempo": "one short phrase about meeting frequency (e.g. 'weekly 1-on-1', 'monthly catch-up', 'stale 90 days', 'sporadic')",
  "common_topics": ["max 5 short tags of recurring topics, lowercase"],
  "cadence_signal": "spike in last month" | "drifting" | "steady" | null,
  "prebrief": ["3-5 short bullets for next meeting — what to ask, what to bring up, status of open threads"],
  "hooks": ["2-4 specific personal conversation starters based on what's known"],
  "approach": "any specific approach style if known (e.g. 'prefers async slack', 'always brings coffee'), or null",
  "avoid": "any topic to avoid if explicitly flagged in notes, or null"
}

Be SPECIFIC, not generic. Skip platitudes. If evidence is thin, return short answers (e.g. 1 bullet) rather than padding.`;

  try {
    // Vertex Gemini Flash for the behavioral synthesis pass.
    const text = await geminiAsk(prompt, {
      model: 'flash',
      temperature: 0.3,
      thinkingBudget: 0,
    });
    const parsed = extractJson<Omit<ContactSynthesis, 'evidence_count' | 'synthesized_at'>>(text);

    if (!parsed) {
      return NextResponse.json({ error: 'Synthesis parse failed' }, { status: 500 });
    }

    const synthesis: ContactSynthesis = {
      ...parsed,
      evidence_count: contactEvents.length + (tasks?.length || 0),
      synthesized_at: new Date().toISOString(),
    };

    await supabase
      .from('contacts')
      .update({ synthesis, synthesized_at: synthesis.synthesized_at })
      .eq('id', contactId)
      .eq('user_id', user.id);

    return NextResponse.json({ synthesis });
  } catch (error: any) {
    console.error('Synthesis error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
