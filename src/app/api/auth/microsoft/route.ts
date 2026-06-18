import { NextRequest, NextResponse } from 'next/server';

// /common/ supports both work/school AND personal Microsoft accounts
const tenant = process.env.MICROSOFT_TENANT_ID || 'common';
const MICROSOFT_AUTH_URL = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`;

export async function GET(request: NextRequest) {
  if (!process.env.MICROSOFT_CLIENT_ID || !process.env.NEXT_PUBLIC_APP_URL) {
    console.error('Microsoft OAuth env missing:', {
      has_id: !!process.env.MICROSOFT_CLIENT_ID,
      app_url: process.env.NEXT_PUBLIC_APP_URL,
    });
    return NextResponse.json({ error: 'Microsoft OAuth not configured on server' }, { status: 500 });
  }

  const userId = request.nextUrl.searchParams.get('user_id') || '';
  const returnTo = request.nextUrl.searchParams.get('return_to') || '/settings';
  const state = JSON.stringify({ uid: userId, rt: returnTo });

  const redirectUri = process.env.NEXT_PUBLIC_APP_URL + '/api/auth/microsoft/callback';
  // Log exactly what we're sending — surfaces redirect_uri mismatches with Azure
  console.log('Microsoft OAuth init — redirect_uri:', redirectUri);

  const params = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: 'User.Read Calendars.Read People.Read Contacts.Read Mail.Read offline_access',
    state,
    prompt: 'consent',
  });

  return NextResponse.redirect(`${MICROSOFT_AUTH_URL}?${params.toString()}`);
}
