import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import type { ResearchCandidate } from '../candidates/route';
import { extractJson } from '../candidates/route';
import { geminiSearch } from '@/lib/gemini';

// Lazy-init so the module can be imported (e.g. at build time) without an
// OPENAI_API_KEY set; the client is only constructed on first request.
let _openai: OpenAI | null = null;
const getOpenAI = () => (_openai ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));

export const maxDuration = 120;

export interface ResearchSignal {
  text: string;
  category: 'professional' | 'interest' | 'recent' | 'mutual' | 'personal' | 'context';
  source: string;
  sourceUrl: string;
}

export interface ContactResearch {
  confirmed: ResearchCandidate;
  signals: ResearchSignal[];
  summary: string;
  prebrief: string;
  lastResearched: string;
}

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

  const { contactId, candidate } = await request.json() as { contactId: string; candidate: ResearchCandidate };
  if (!contactId || !candidate) {
    return NextResponse.json({ error: 'contactId and candidate required' }, { status: 400 });
  }

  const { data: contact } = await supabase
    .from('contacts')
    .select('id, name, company, role, email, notes')
    .eq('id', contactId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!contact) {
    return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
  }

  const prompt = `Quick background brief on this person. Be fast. Specific facts only — no bio paraphrase.

Identity:
- Name: ${candidate.name}
${candidate.role ? `- Role: ${candidate.role}` : ''}
${candidate.company ? `- Company: ${candidate.company}` : ''}
${(contact as any).email ? `- Email: ${(contact as any).email}` : ''}
${candidate.linkedinUrl ? `- LinkedIn: ${candidate.linkedinUrl}` : ''}
${contact.notes && contact.notes.trim() ? `- User's notes: ${contact.notes.replace(/\s+/g, ' ').trim().slice(0, 400)}` : ''}

Search the web. Prioritize: LinkedIn, recent news, X/Twitter, podcasts.
Pull out 5-8 SIGNALS. Each must be specific + sourced + categorized.

Categories: professional | recent | interest | personal | mutual | context

GOOD: "Just announced $40M Series B (techcrunch, Mar 2026)" (recent)
GOOD: "Owns rare Yamazaki bottles, posts about whiskey" (interest)
BAD:  "Works at Acme as VP Engineering" (already known)
BAD:  "Has a LinkedIn profile" (useless)

Then:
- summary: ONE SHORT SENTENCE (max 20 words). Crisp, no fluff.
- prebrief: 3-4 SHORT bullet points (5-10 words each). Headlines, not paragraphs.

Respond with ONLY a JSON object wrapped in a single \`\`\`json code block. No prose before or after. Shape:
{
  "signals": [{"text": "...", "category": "...", "source": "...", "sourceUrl": "..."}],
  "summary": "...",
  "prebrief": "- bullet\\n- bullet\\n..."
}`;

  // Primary: Gemini Flash 2.5 with Google Search grounding. Fallback: OpenAI.
  // Track quota state across both providers — if BOTH are out, return a single
  // friendly 429 so the UI can show "try again tomorrow" instead of a raw
  // upstream stack trace.
  const isQuotaErr = (e: any) => /RESOURCE_EXHAUSTED|quota|rate.?limit|insufficient_quota|429/i.test(e?.message || String(e));
  let text = '';
  let usedFallback = false;
  let geminiQuotaErr: any = null;
  if (process.env.GCP_PROJECT_ID || process.env.GEMINI_API_KEY) {
    try {
      text = await geminiSearch(prompt, { temperature: 0.4, thinkingBudget: 512 });
    } catch (e: any) {
      console.error('Gemini deep failed, falling back to OpenAI:', e?.message);
      if (isQuotaErr(e)) geminiQuotaErr = e;
      usedFallback = true;
    }
  } else {
    usedFallback = true;
  }
  if (usedFallback) {
    try {
      const completion = await getOpenAI().chat.completions.create({
        model: 'gpt-4o-search-preview',
        messages: [{ role: 'user', content: prompt }],
        web_search_options: { search_context_size: 'high' },
      } as any);
      text = completion.choices[0]?.message?.content || '';
    } catch (error: any) {
      console.error('Deep research error:', error);
      if (isQuotaErr(error) && geminiQuotaErr) {
        return NextResponse.json(
          { error: 'AI quota exhausted on both Gemini and OpenAI. Try again later, or top up billing on either provider.' },
          { status: 429 },
        );
      }
      if (isQuotaErr(error)) {
        return NextResponse.json(
          { error: 'OpenAI quota exhausted. Falling back to Gemini next sync, or top up OpenAI billing.' },
          { status: 429 },
        );
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  const parsed = extractJson<{ signals: ResearchSignal[]; summary: string; prebrief: string }>(text);
  if (!parsed) {
    console.error('Deep research returned unparseable text:', text.slice(0, 500));
    return NextResponse.json({ error: 'Research returned malformed response. Try again.' }, { status: 500 });
  }

  const research: ContactResearch = {
    confirmed: candidate,
    signals: parsed.signals || [],
    summary: parsed.summary || '',
    prebrief: parsed.prebrief || '',
    lastResearched: new Date().toISOString(),
  };

  await supabase
    .from('contacts')
    .update({ research })
    .eq('id', contactId)
    .eq('user_id', user.id);

  return NextResponse.json({ research });
}
