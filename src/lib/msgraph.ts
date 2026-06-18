// Microsoft Graph API helper — handles token refresh + authenticated requests
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

interface TokenRefreshResult {
  access_token: string;
  refresh_token?: string;
}

/**
 * Refresh an expired MS access token using the stored refresh token.
 * Updates user_settings via the save_oauth_tokens RPC (RLS-safe).
 */
async function refreshAccessToken(
  refreshToken: string,
  userId: string,
  supabase: SupabaseClient,
): Promise<TokenRefreshResult | null> {
  const tenant = process.env.MICROSOFT_TENANT_ID || 'common';
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.MICROSOFT_CLIENT_ID!,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: 'User.Read Calendars.Read People.Read Contacts.Read Mail.Read offline_access',
    }),
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    console.error('MS token refresh failed:', data);
    return null;
  }

  // Persist refreshed token (refresh_token may rotate)
  await supabase.rpc('save_oauth_tokens', {
    p_user_id: userId,
    p_provider: 'microsoft',
    p_access_token: data.access_token,
    p_refresh_token: data.refresh_token || refreshToken,
  });

  return { access_token: data.access_token, refresh_token: data.refresh_token };
}

/**
 * Make an authenticated request to MS Graph. Auto-refreshes if 401.
 */
export async function graphFetch(
  path: string,
  userId: string,
  supabase: SupabaseClient,
  accessToken: string,
  refreshToken: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: any; newAccessToken?: string }> {
  const url = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`;

  const doFetch = (token: string) =>
    fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(init?.headers || {}),
      },
    });

  let res = await doFetch(accessToken);
  let usedToken = accessToken;

  if (res.status === 401 && refreshToken) {
    const refreshed = await refreshAccessToken(refreshToken, userId, supabase);
    if (refreshed) {
      usedToken = refreshed.access_token;
      res = await doFetch(usedToken);
    }
  }

  let data: any = null;
  try { data = await res.json(); } catch { /* may be empty */ }

  return {
    ok: res.ok,
    status: res.status,
    data,
    newAccessToken: usedToken !== accessToken ? usedToken : undefined,
  };
}

/**
 * Fetch ALL pages of a paginated MS Graph collection.
 * Returns the concatenated `value` arrays and — for /delta endpoints — the
 * deltaLink emitted on the final page (use it on the next sync to fetch only
 * what changed). Also returns the last seen nextLink so the caller can resume
 * a multi-page initial sync that hit maxPages before completing.
 */
export async function graphFetchAllPages(
  path: string,
  userId: string,
  supabase: SupabaseClient,
  accessToken: string,
  refreshToken: string,
  maxPages = 20,
): Promise<{ items: any[]; error?: string; finalToken?: string; deltaLink?: string; nextLink?: string }> {
  const all: any[] = [];
  let nextUrl: string | null = path;
  let currentToken = accessToken;
  let pages = 0;
  let deltaLink: string | undefined;
  let lastNextLink: string | undefined;

  while (nextUrl && pages < maxPages) {
    const res = await graphFetch(nextUrl, userId, supabase, currentToken, refreshToken);
    if (res.newAccessToken) currentToken = res.newAccessToken;
    if (!res.ok) {
      return { items: all, error: `Graph fetch failed (${res.status}): ${JSON.stringify(res.data).slice(0, 300)}` };
    }
    if (res.data?.value && Array.isArray(res.data.value)) all.push(...res.data.value);
    const dl: string | undefined = res.data?.['@odata.deltaLink'];
    const nl: string | undefined = res.data?.['@odata.nextLink'];
    if (dl) deltaLink = dl;     // only present on the final page of a delta cycle
    lastNextLink = nl;
    nextUrl = nl || null;
    pages++;
  }

  return {
    items: all,
    finalToken: currentToken !== accessToken ? currentToken : undefined,
    deltaLink,
    nextLink: nextUrl ? lastNextLink : undefined,    // only return if we stopped early due to maxPages
  };
}
