import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Pre-import dedup state. Use across all contact-importing routes so a single
 * person with multiple emails (primary + aliases) never gets imported twice,
 * and so the user themselves (self contact + all known self aliases) is never
 * re-imported as a contact.
 */
export interface ContactDedupSets {
  /** Every email known to belong to *any* existing contact, lowercase. */
  existingEmails: Set<string>;
  /** Every email known to be the user themselves, lowercase. Never import these. */
  selfEmails: Set<string>;
  /** Emails the user has explicitly deleted. Never re-import these. */
  deletedEmails: Set<string>;
}

export async function loadContactDedupSets(
  supabase: SupabaseClient,
  userId: string,
  fallbackSelfEmail?: string | null,
): Promise<ContactDedupSets> {
  const { data: existing } = await supabase
    .from('contacts')
    .select('email, email_aliases, is_self')
    .eq('user_id', userId);

  const existingEmails = new Set<string>();
  const selfEmails = new Set<string>();
  if (fallbackSelfEmail) selfEmails.add(fallbackSelfEmail.toLowerCase());

  for (const c of (existing as { email: string | null; email_aliases: string[] | null; is_self: boolean | null }[]) || []) {
    if (c.email) existingEmails.add(c.email.toLowerCase());
    for (const a of c.email_aliases || []) {
      if (a) existingEmails.add(a.toLowerCase());
      if (a && c.is_self) selfEmails.add(a.toLowerCase());
    }
    if (c.is_self && c.email) selfEmails.add(c.email.toLowerCase());
  }

  // Tombstones — emails the user explicitly deleted. Filter these from every
  // importer so a delete sticks across syncs. Best-effort: empty set if table missing.
  const deletedEmails = new Set<string>();
  try {
    const { data: tombstones } = await supabase
      .from('deleted_contacts').select('email').eq('user_id', userId);
    for (const t of tombstones || []) if (t.email) deletedEmails.add(t.email.toLowerCase());
  } catch { /* table missing on older deployments */ }

  return { existingEmails, selfEmails, deletedEmails };
}
