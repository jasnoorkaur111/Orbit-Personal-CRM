import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { geminiSearch } from '@/lib/gemini';

// Lazy-init so the module can be imported (e.g. at build time) without an
// OPENAI_API_KEY set; the client is only constructed on first request.
let _openai: OpenAI | null = null;
const getOpenAI = () => (_openai ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));

export const maxDuration = 60;

// Extract a JSON object from text that may contain prose, code fences, or partial output
export function extractJson<T = unknown>(text: string): T | null {
  if (!text) return null;
  // Try fenced code block first
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1] : text;
  // Find first { ... last }
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace <= firstBrace) return null;
  try {
    return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }
}

export interface ResearchCandidate {
  name: string;
  role?: string;
  company?: string;
  location?: string;
  linkedinUrl?: string;
  photoUrl?: string;
  sourceUrl: string;
  rationale: string;
  confidence: 'high' | 'medium' | 'low';
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

  const { contactId } = await request.json();
  if (!contactId) {
    return NextResponse.json({ error: 'contactId required' }, { status: 400 });
  }

  const { data: contact } = await supabase
    .from('contacts')
    .select('id, name, company, role, email, linkedin, notes, is_self')
    .eq('id', contactId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!contact) {
    return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
  }

  if (contact.is_self) {
    return NextResponse.json({ error: 'This contact is marked as you. Research is disabled for self.' }, { status: 400 });
  }

  // Smart heuristic: warn if name looks like a self-reference
  const lowerName = contact.name.toLowerCase().trim();
  const userHandle = (user.email || '').toLowerCase().split('@')[0];
  if (lowerName && lowerName === userHandle) {
    return NextResponse.json({
      error: 'This name looks like you. Mark this contact as "This is me" to skip it from your network.',
      suggestSelf: true,
    }, { status: 400 });
  }

  // Build disambiguation query. Email is the single strongest signal we have
  // — pass it explicitly and instruct the model to use the local part to
  // validate name (e.g. "christina.fattore@" implies Christina Fattore) and
  // the domain to infer company if no company is set.
  const hints: string[] = [];
  if (contact.company) hints.push(`works at ${contact.company}`);
  if (contact.role) hints.push(`role: ${contact.role}`);
  if (contact.email) {
    const [local, domain] = contact.email.toLowerCase().split('@');
    const isPersonal = ['gmail.com','yahoo.com','outlook.com','hotmail.com','icloud.com','me.com','protonmail.com','aol.com','live.com','msn.com'].includes(domain);
    hints.push(`email: ${contact.email}`);
    if (!isPersonal && domain) {
      // Work email — domain is a strong company hint
      hints.push(`work email domain "${domain}" — if no company is set, this is almost certainly their employer; infer it from the domain (e.g. upfront.com → Upfront Ventures)`);
    }
    if (local) {
      // Local part often encodes the name format (firstname.lastname / flastname / firstname)
      hints.push(`email local part "${local}" — use this to validate the candidate's real name (e.g. firstname.lastname format means name parts must match)`);
    }
  }
  if (contact.linkedin) hints.push(`linkedin: ${contact.linkedin}`);
  if (contact.notes && contact.notes.trim()) {
    // The user's own notes are the highest-fidelity context we have. Pass a
    // condensed slice so the model can use them to disambiguate.
    hints.push(`user's existing notes (truncated): ${contact.notes.replace(/\s+/g, ' ').trim().slice(0, 400)}`);
  }

  // ── FAST PATH: skip web-search disambiguation when we have strong identity ──
  // Triggers when ANY of:
  //   - LinkedIn URL set (exact identity confirmed)
  //   - Work email (non-personal domain) — the email + domain together pin down
  //     who this person is; we synthesize company from the domain
  //   - Personal email but with name in local part AND company set
  // The deep-research step gets the synth candidate immediately, saves ~6-15s.
  const emailDomain = contact.email?.toLowerCase().split('@')[1];
  const isPersonalDomain = !!emailDomain && ['gmail.com','yahoo.com','outlook.com','hotmail.com','icloud.com','me.com','protonmail.com','aol.com','live.com','msn.com'].includes(emailDomain);
  const hasWorkEmail = !!contact.email && !isPersonalDomain;
  const hasStrongIdentity = !!contact.linkedin || hasWorkEmail || (!!contact.email && !!contact.company);
  if (hasStrongIdentity) {
    const inferredCompany =
      contact.company ||
      (hasWorkEmail && emailDomain
        // upfront.com → Upfront, operatorsandfriends.com → Operatorsandfriends
        ? emailDomain.split('.')[0].replace(/^\w/, (c: string) => c.toUpperCase())
        : null);
    const candidate: ResearchCandidate = {
      name: contact.name,
      role: contact.role || undefined,
      company: inferredCompany || undefined,
      linkedinUrl: contact.linkedin || undefined,
      sourceUrl: contact.linkedin || (contact.email ? `mailto:${contact.email}` : ''),
      rationale: 'Identity inferred from contact fields — skipped web disambiguation.',
      confidence: 'high',
    };
    return NextResponse.json({ candidates: [candidate], fastPath: true });
  }

  const prompt = `You are helping identify a specific real-world person. Search the web and find 3-5 most likely public identities matching this person.

Name: ${contact.name}
${hints.length > 0 ? hints.map(h => '- ' + h).join('\n') : '(no additional context)'}

For each candidate, return:
- name: their full public name
- role: current job title
- company: current employer
- location: city/region
- linkedinUrl: their LinkedIn URL (if you can identify one)
- photoUrl: a public photo URL if surfaced (LinkedIn profile photo URL, company headshot, Twitter avatar, etc.)
- sourceUrl: the primary source you found them on
- rationale: 1 short sentence on why this is them
- confidence: "high" | "medium" | "low"

Order by confidence. Do not invent details — only return what the web search supports.

Respond with ONLY a JSON object wrapped in a single \`\`\`json code block. No prose before or after. Shape:
{ "candidates": [...] }`;

  // Primary: Gemini Flash 2.5 with Google Search grounding (same stack as
  // Google AI Mode). Fallback: OpenAI gpt-4o-search-preview if Gemini errors.
  let text = '';
  let usedFallback = false;
  if (process.env.GCP_PROJECT_ID || process.env.GEMINI_API_KEY) {
    try {
      // thinkingBudget: 0 + flash-lite — candidates is just a web-grounded
      // JSON dump, no reasoning needed. Roughly: 30s (default) → 6-10s
      // (no thinking) → 3-5s (flash-lite, no thinking).
      text = await geminiSearch(prompt, { temperature: 0.2, thinkingBudget: 0, model: 'flash-lite' });
    } catch (e: any) {
      console.error('Gemini candidates failed, falling back to OpenAI:', e?.message);
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
        web_search_options: { search_context_size: 'medium' },
      } as any);
      text = completion.choices[0]?.message?.content || '';
    } catch (error: any) {
      console.error('Candidates research error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }
  const parsed = extractJson<{ candidates: ResearchCandidate[] }>(text) || { candidates: [] };
  return NextResponse.json({ candidates: parsed.candidates || [] });
}
