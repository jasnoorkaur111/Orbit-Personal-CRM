import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/routeAuth';
import { geminiAsk } from '@/lib/gemini';

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const { text, existingContacts, isImpromptu, recordedAt, existingProjects, existingTags } = await request.json();

  const contactNames = existingContacts?.map((c: any) => c.name) || [];
  const projectNames = existingProjects?.map((p: any) => p.name) || [];
  const tagList = existingTags || [];

  const recordedDate = recordedAt ? new Date(recordedAt) : new Date();
  const defaultDate = recordedDate.toISOString().split('T')[0];
  const defaultTime = recordedDate.toTimeString().slice(0, 5);

  const interactionFields = isImpromptu ? `
  "interaction": {
    "title": "short label like 'Coffee chat — {name}' or 'Call with {name}' or 'Ran into {name}'",
    "date": "${defaultDate}",
    "time": "${defaultTime}"
  },` : '';

  const interactionRules = isImpromptu ? `
- INTERACTION: This is an impromptu/unscheduled conversation the user is logging. Generate a short, natural title for it (e.g. "Coffee chat — Priya", "Quick call with Marcus", "Ran into Tina at gym"). The default date/time is when the user started recording (${defaultDate} at ${defaultTime}). Only change it if the user explicitly says otherwise (e.g. "this morning" → adjust time; "yesterday" → adjust date).` : '';

  const prompt = `You are a CRM assistant. The input below is raw voice transcription — it may have grammar issues, missing punctuation, or run-on sentences. First clean it up mentally, then parse it into structured data.

Existing contacts in the CRM: ${contactNames.length > 0 ? contactNames.join(', ') : 'none yet'}

Voice input: "${text}"

Extract and return JSON with this exact structure:
{${interactionFields}
  "name": "the main contact's full name (required) — IF the user is referring to someone in 'Existing contacts' above, use their FULL NAME exactly as listed (don't shorten 'Liz Mallen' → 'Liz'). Only invent a new name when no existing contact plausibly matches.",
  "matchedExistingContact": "if 'name' refers to one of the Existing contacts above, copy their full name here too. If new person, return null. If ambiguous (multiple candidates like 3 Sarahs), return null and the app will prompt the user.",
  "company": "company/organization or null",
  "role": "their role/title or null",
  "email": "email address if mentioned, or null",
  "phone": "phone number if mentioned, or null",
  "linkedin": "LinkedIn URL if mentioned, or null",
  "notes": "clean summary of the full interaction — include ALL key details, people mentioned, topics discussed, and outcomes",
  "connections": ["names of ALL people mentioned — anyone they know, are talking to, will introduce, work with, or referenced in any way"],
  "tags": ["short topic/industry/product tags extracted from the conversation — e.g. 'climate tech', 'defense contracting', 'fundraising', 'AI', 'real estate'"],
  "project": "name of the project/deal/initiative this relates to, or null",
  "tasks": [
    {
      "title": "task description",
      "type": "follow-up | send | meeting | other",
      "dueDate": "YYYY-MM-DD or null"
    }
  ]
}

Rules:
- Always extract a name. If unclear, use the most prominent proper noun.
- For due dates, today is ${new Date().toISOString().split('T')[0]}. Convert relative dates (tomorrow, next Friday, etc.) to absolute.
- CONNECTIONS: Cast a wide net. Include anyone mentioned by name — people they can intro you to, people they're going to talk to on your behalf, partners, colleagues, family members with relevant contacts, anyone in their network that came up. These all become nodes in a relationship graph. Even if someone is mentioned in passing ("she talked to Jacque about it"), include them.
- TASKS: Be thorough. If someone says they'll do something and get back to the user, that's a follow-up task (e.g. "Christina will talk to her partners and let me know" → task: "Waiting on Christina to hear back from partners"). If the user needs to do something, that's also a task. Capture ALL action items, including ones where the contact is the one taking action.
- Keep notes concise but capture key details. Fix grammar and punctuation in the notes output — make it read cleanly even though the input is raw speech.
- If the input mentions an existing contact name from the list above, include them in connections.
- If the input starts with [Context: ...], that means the user linked a calendar event. Use the event title to help identify the contact name if the user doesn't explicitly say it.
- If the user only provides notes/updates (no new name), still extract the most relevant person's name from the context.
- TAGS: Extract 1-4 short topic tags that describe what was discussed — industries, products, deal types, themes. Keep them lowercase, concise (1-3 words each). Don't include the person's name or company as a tag.${tagList.length > 0 ? ` Existing tags in the CRM: ${tagList.join(', ')}. REUSE existing tags when they match — do not create near-duplicates (e.g., if "AI" exists, don't create "artificial intelligence"; if "fundraising" exists, don't create "raising funds"). Only create new tags for genuinely new topics.` : ''}
- PROJECT: If the user mentions a deal, initiative, project, or effort by name (e.g. "this is for the Acme deal", "add her to the fundraise project", "related to our Series B"), extract it.${projectNames.length > 0 ? ` Existing projects: ${projectNames.join(', ')}. Reuse an existing project name if it matches.` : ''} If no project is mentioned, return null.${interactionRules}

Return ONLY valid JSON, no markdown or explanation.`;

  try {
    // Vertex Gemini Flash — cheaper + faster than gpt-4o-mini for this kind of
    // structured extraction. Schema-locked JSON so we never get malformed output.
    const raw = await geminiAsk(prompt, {
      model: 'flash',
      temperature: 0.3,
      thinkingBudget: 0,
      responseSchema: {
        type: 'object',
        properties: {
          ...(isImpromptu ? {
            interaction: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                date: { type: 'string' },
                time: { type: 'string' },
              },
            },
          } : {}),
          name: { type: 'string' },
          matchedExistingContact: { type: 'string', nullable: true } as any,
          company: { type: 'string', nullable: true } as any,
          role: { type: 'string', nullable: true } as any,
          email: { type: 'string', nullable: true } as any,
          phone: { type: 'string', nullable: true } as any,
          linkedin: { type: 'string', nullable: true } as any,
          notes: { type: 'string' },
          connections: { type: 'array', items: { type: 'string' } },
          tags: { type: 'array', items: { type: 'string' } },
          project: { type: 'string', nullable: true } as any,
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                type: { type: 'string' },
                dueDate: { type: 'string', nullable: true } as any,
              },
              required: ['title'],
            },
          },
        },
        required: ['name', 'notes', 'connections', 'tags', 'tasks'],
      },
    });
    const parsed = JSON.parse(raw || '{}');
    return NextResponse.json(parsed);
  } catch (error: any) {
    console.error('parse-voice failed:', error);
    const msg = error?.message || String(error);
    if (/RESOURCE_EXHAUSTED|quota|429|insufficient_quota/i.test(msg)) {
      return NextResponse.json(
        { error: 'AI quota exhausted. Try again later or top up billing.' },
        { status: 429 },
      );
    }
    return NextResponse.json({ error: msg || 'Parse failed' }, { status: 500 });
  }
}
