// Hard-delete the authenticated user's account: nukes auth row + every
// piece of CRM data tied to the user. Used by the Danger zone in Settings.
//
// Confirmation: the client must POST { confirmEmail: "<user@email>" } that
// matches the authenticated user's email exactly. Prevents accidental
// click-through deletion since the user has to physically retype their email.
//
// Cascades: contacts/projects/tasks/events/connections/email_stats all have
// ON DELETE CASCADE from user_id, so deleting the auth.users row removes
// everything. user_settings + project_contacts dropped explicitly for safety.

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/routeAuth';

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => ({}));
  const confirmEmail = (body?.confirmEmail || '').toString().trim().toLowerCase();
  const actual = (auth.user.email || '').trim().toLowerCase();
  if (!confirmEmail || confirmEmail !== actual) {
    return NextResponse.json({ error: 'Email confirmation does not match' }, { status: 400 });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    return NextResponse.json({ error: 'Server not configured for account deletion' }, { status: 500 });
  }
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey);

  const userId = auth.user.id;
  try {
    // Best-effort wipe of rows that may not cascade. auth.admin.deleteUser
    // at the end handles the cascading tables (contacts, events, tasks, etc.).
    await admin.from('user_settings').delete().eq('user_id', userId);
    await admin.from('project_contacts').delete().eq('user_id', userId);

    const { error: delErr } = await admin.auth.admin.deleteUser(userId);
    if (delErr) {
      console.error('[delete-account] auth.admin.deleteUser failed:', delErr);
      return NextResponse.json({ error: delErr.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error('[delete-account] failed:', e);
    return NextResponse.json({ error: e?.message || 'Delete failed' }, { status: 500 });
  }
}
