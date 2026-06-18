// One-time backfill: walk every contact for a user, look up their email
// domain in the firm registry, and merge the matching tags + company
// into the existing row. Idempotent — tags already on the contact are
// preserved, and company is only filled if blank.

import type { SupabaseClient } from '@supabase/supabase-js';
import { lookupFirmByEmail } from './firmDomains';

export async function applyFirmTagsForUser(
  sb: SupabaseClient,
  userId: string,
): Promise<{ scanned: number; tagged: number }> {
  const { data: contacts, error } = await sb
    .from('contacts')
    .select('id, email, company, tags')
    .eq('user_id', userId)
    .eq('is_self', false)
    .not('email', 'is', null);
  if (error || !contacts) {
    console.error('[firm-tags] load failed:', error);
    return { scanned: 0, tagged: 0 };
  }

  let tagged = 0;
  for (const c of contacts as { id: string; email: string | null; company: string | null; tags: string[] | null }[]) {
    const firm = lookupFirmByEmail(c.email);
    if (!firm) continue;

    const existing = new Set((c.tags || []).map((t) => t.toLowerCase()));
    const merged = [...(c.tags || [])];
    let changed = false;
    for (const t of firm.tags) {
      if (!existing.has(t.toLowerCase())) {
        merged.push(t);
        existing.add(t.toLowerCase());
        changed = true;
      }
    }
    const nextCompany = c.company && c.company.trim() ? c.company : firm.name;
    const companyChanged = nextCompany !== c.company;
    if (!changed && !companyChanged) continue;

    const { error: upErr } = await sb
      .from('contacts')
      .update({ tags: merged, company: nextCompany })
      .eq('id', c.id);
    if (!upErr) tagged += 1;
  }

  console.log(`[firm-tags] user=${userId} scanned=${contacts.length} tagged=${tagged}`);
  return { scanned: contacts.length, tagged };
}
