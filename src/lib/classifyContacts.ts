// Batch-classify contacts with Gemini to filter out brands / services / bots
// that look like real emails (e.g. customercare@delta.com, hello@aritzia.com)
// but aren't actual people. Runs after sync-email-stats inserts new
// Discovered contacts. Cheap: one batched Gemini call per 50-100 contacts.

import { geminiAsk } from './gemini';

export interface ContactToClassify {
  id: string;
  name: string | null;
  email: string | null;
}

export interface ClassifyResult {
  id: string;
  is_person: boolean;
  reason: string;
}

/**
 * Classify a batch of contacts. Returns per-id verdicts.
 * Failures default to is_person=true (don't delete on uncertainty).
 */
export async function classifyContacts(
  contacts: ContactToClassify[],
  opts?: { batchSize?: number },
): Promise<Map<string, ClassifyResult>> {
  const results = new Map<string, ClassifyResult>();
  if (contacts.length === 0) return results;
  const batchSize = opts?.batchSize ?? 80;
  // Throttle between batches to avoid Vertex rate-limit (sticking ~6 batches
  // per minute even on Flash-Lite). Without this, the 5th+ call 429s and
  // an entire batch defaults to is_person=true, missing real noise.
  const THROTTLE_MS = 1200;

  for (let i = 0; i < contacts.length; i += batchSize) {
    if (i > 0) await new Promise((r) => setTimeout(r, THROTTLE_MS));
    const batch = contacts.slice(i, i + batchSize);
    const indexLines = batch
      .map((c, idx) => `[${idx}] name="${c.name || '?'}" email="${c.email || '?'}"`)
      .join('\n');

    const prompt = `Classify each contact below as a real person OR a brand / service / automated sender (newsletter, store, airline, support bot, etc).

Examples of NOT a person:
  - "Delta Airlines" / customercare@delta.com
  - "Aritzia" / hello@aritzia.com
  - "Apple Support" / itunesconnect@apple.com
  - "Conference Services" / conferenceservices@northwestern.edu
  - "Spotify" / no-reply@spotify.com
  - "Office Hub" / a generic service inbox

Examples of REAL person:
  - "Jane Smith" / jane.smith@gmail.com
  - "Adam Dale" / adam.dale@ndm.ox.ac.uk
  - "Kanaya, Alka" / alka.kanaya@ucsf.edu (institutional but a real human)
  - "Class Peter" / classpeter27@gmail.com (real name, even if odd)
  - "ALYSSAMPEEK@GMAIL.COM" / alyssampeek@gmail.com (caps but a person)

Be conservative: if uncertain whether it's a person, return is_person=true.
Only flag is_person=false when you're confident it's a brand / service / automated.

Contacts:
${indexLines}`;

    try {
      const raw = await geminiAsk(prompt, {
        model: 'flash-lite',
        temperature: 0,
        thinkingBudget: 0,
        responseSchema: {
          type: 'object',
          properties: {
            verdicts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  index: { type: 'integer' },
                  is_person: { type: 'boolean' },
                  reason: { type: 'string' },
                },
                required: ['index', 'is_person', 'reason'],
              },
            },
          },
          required: ['verdicts'],
        },
      });
      const parsed = JSON.parse(raw || '{"verdicts":[]}');
      for (const v of parsed.verdicts as any[]) {
        if (typeof v.index !== 'number' || !batch[v.index]) continue;
        results.set(batch[v.index].id, {
          id: batch[v.index].id,
          is_person: v.is_person !== false,    // default true on missing/null
          reason: String(v.reason || '').slice(0, 200),
        });
      }
    } catch (e: any) {
      console.error('[classifyContacts] batch failed, defaulting to is_person=true:', e?.message);
      // Soft-fail: mark all as person so nothing gets accidentally deleted
      for (const c of batch) {
        results.set(c.id, { id: c.id, is_person: true, reason: 'classify failed' });
      }
    }
  }

  return results;
}
