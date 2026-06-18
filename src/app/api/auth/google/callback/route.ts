import { NextRequest, NextResponse } from 'next/server';
import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';

// Lazy-init (see init route comment)
function makeClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.NEXT_PUBLIC_APP_URL + '/api/auth/google/callback',
  );
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// State may be plain userId (legacy) OR JSON { uid, rt } (onboarding round-trip).
function parseState(raw: string | null): { userId: string; returnTo: string } {
  if (!raw) return { userId: '', returnTo: '/settings' };
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === 'object' && typeof j.uid === 'string') {
      const rt = typeof j.rt === 'string' && j.rt.startsWith('/') ? j.rt : '/settings';
      return { userId: j.uid, returnTo: rt };
    }
  } catch { /* legacy plain-userId state */ }
  return { userId: raw, returnTo: '/settings' };
}
function appendQuery(path: string, query: string): string {
  return path + (path.includes('?') ? '&' : '?') + query;
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const { userId, returnTo } = parseState(request.nextUrl.searchParams.get('state'));
  const base = process.env.NEXT_PUBLIC_APP_URL!;

  if (!code || !userId) {
    return NextResponse.redirect(base + appendQuery(returnTo, 'error=missing_code'));
  }

  try {
    const oauth2Client = makeClient();
    const { tokens } = await oauth2Client.getToken(code);

    const { error: rpcError } = await supabase.rpc('save_oauth_tokens', {
      p_user_id: userId,
      p_provider: 'google',
      p_access_token: tokens.access_token,
      p_refresh_token: tokens.refresh_token,
    });

    if (rpcError) {
      console.error('Google token save failed:', rpcError);
      return NextResponse.redirect(base + appendQuery(returnTo, 'error=token_save_failed'));
    }

    return NextResponse.redirect(base + appendQuery(returnTo, 'google=connected'));
  } catch (error) {
    console.error('Google OAuth error:', error);
    return NextResponse.redirect(base + appendQuery(returnTo, 'error=google_auth_failed'));
  }
}
