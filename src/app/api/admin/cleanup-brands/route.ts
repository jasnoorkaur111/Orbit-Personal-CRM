// Admin sweep: run the brand-cleanup backfill against every user that
// hasn't been cleaned yet. Used to retro-fix all existing accounts in
// one shot after the tierByRules Step-4 tightening landed.
//
// Auth: Bearer header must equal SUPABASE_SERVICE_ROLE_KEY. The service
// role key is already an admin-grade secret on Vercel, so we reuse it
// rather than adding a new env var.
//
// Trigger:
//   curl -X POST https://your-app.example.com/api/admin/cleanup-brands \
//     -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { cleanupUserBrands } from '@/lib/cleanupUserBrands';

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    return NextResponse.json({ error: 'service role key not configured' }, { status: 500 });
  }
  const authHeader = request.headers.get('Authorization') || '';
  if (authHeader !== `Bearer ${serviceKey}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey);

  const { data: pending, error } = await sb
    .from('user_settings')
    .select('user_id')
    .is('brand_cleanup_v1_at', null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!pending || pending.length === 0) {
    return NextResponse.json({ ok: true, swept: 0, message: 'no users need cleanup' });
  }

  const results: { user_id: string; scanned: number; dropped: number; error?: string }[] = [];
  for (const row of pending) {
    try {
      const stats = await cleanupUserBrands(sb, row.user_id);
      await sb
        .from('user_settings')
        .update({ brand_cleanup_v1_at: new Date().toISOString() })
        .eq('user_id', row.user_id);
      results.push({ user_id: row.user_id, ...stats });
    } catch (e: any) {
      results.push({ user_id: row.user_id, scanned: 0, dropped: 0, error: e?.message });
    }
  }

  const totalDropped = results.reduce((a, r) => a + r.dropped, 0);
  const totalScanned = results.reduce((a, r) => a + r.scanned, 0);
  return NextResponse.json({
    ok: true,
    swept: results.length,
    total_scanned: totalScanned,
    total_dropped: totalDropped,
    results,
  });
}
