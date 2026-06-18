import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const tenant = process.env.MICROSOFT_TENANT_ID || 'common';
const TOKEN_URL = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// State may be plain userId (legacy) OR JSON { uid, rt } (onboarding round-trip).
// Parse both shapes; default redirect target is /settings.
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
    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.MICROSOFT_CLIENT_ID!,
        client_secret: process.env.MICROSOFT_CLIENT_SECRET!,
        code,
        redirect_uri: base + '/api/auth/microsoft/callback',
        grant_type: 'authorization_code',
      }),
    });

    const tokens = await tokenRes.json();

    if (tokens.error) {
      console.error('Microsoft token error:', tokens);
      return NextResponse.redirect(base + appendQuery(returnTo, 'error=microsoft_auth_failed'));
    }

    const { error: rpcError } = await supabase.rpc('save_oauth_tokens', {
      p_user_id: userId,
      p_provider: 'microsoft',
      p_access_token: tokens.access_token,
      p_refresh_token: tokens.refresh_token,
    });

    if (rpcError) {
      console.error('Microsoft token save failed:', rpcError);
      return NextResponse.redirect(base + appendQuery(returnTo, 'error=token_save_failed'));
    }

    return NextResponse.redirect(base + appendQuery(returnTo, 'microsoft=connected'));
  } catch (error) {
    console.error('Microsoft OAuth error:', error);
    return NextResponse.redirect(base + appendQuery(returnTo, 'error=microsoft_auth_failed'));
  }
}
