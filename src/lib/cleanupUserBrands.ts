// One-time backfill: run the LLM tier classifier over every existing
// non-self contact for a user, delete the drops + all dependent rows.
//
// Called from sync-graph the FIRST time a user syncs after the Step-4
// tightening landed — gated by user_settings.brand_cleanup_v1_at so it
// only ever runs once per user. New contacts are caught by the inline
// classifier in sync-graph; this handles the pre-fix backlog.

import type { SupabaseClient } from '@supabase/supabase-js';
import { tierContacts, TierInput } from './tierContacts';

const DELETE_BATCH = 100;

export async function cleanupUserBrands(
  sb: SupabaseClient,
  userId: string,
): Promise<{ scanned: number; dropped: number }> {
  const { data: contacts, error } = await sb
    .from('contacts')
    .select('id, name, email')
    .eq('user_id', userId)
    .eq('is_self', false);
  if (error || !contacts) {
    console.error('[cleanup-brands] load failed:', error);
    return { scanned: 0, dropped: 0 };
  }
  if (contacts.length === 0) return { scanned: 0, dropped: 0 };

  const inputs: TierInput[] = contacts.map((c) => ({
    id: c.id, name: c.name, email: c.email,
  }));
  const verdicts = await tierContacts(inputs, new Set(), new Map());
  const dropIds: string[] = [];
  for (const v of verdicts.values()) if (v.tier === 'drop') dropIds.push(v.id);

  if (dropIds.length === 0) return { scanned: contacts.length, dropped: 0 };

  for (let i = 0; i < dropIds.length; i += DELETE_BATCH) {
    const batch = dropIds.slice(i, i + DELETE_BATCH);
    const inList = batch.join(',');
    await sb.from('project_contacts').delete().in('contact_id', batch);
    await sb.from('tasks').delete().in('contact_id', batch);
    await sb.from('email_stats').delete().in('contact_id', batch);
    await sb.from('connections').delete().or(`from_contact_id.in.(${inList}),to_contact_id.in.(${inList})`);
    await sb.from('contacts').delete().in('id', batch).eq('user_id', userId);
  }

  console.log(`[cleanup-brands] user=${userId} scanned=${contacts.length} dropped=${dropIds.length}`);
  return { scanned: contacts.length, dropped: dropIds.length };
}
