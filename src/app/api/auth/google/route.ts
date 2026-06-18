import { NextRequest, NextResponse } from 'next/server';
import { google } from 'googleapis';

// Lazy-init: module-level construction can freeze undefined env values if the
// module loads before .env is parsed (Turbopack edge case). Build the client
// at request time so we always see the current env.
function makeClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.NEXT_PUBLIC_APP_URL + '/api/auth/google/callback',
  );
}

export async function GET(request: NextRequest) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.error('Google OAuth env missing:', {
      has_id: !!process.env.GOOGLE_CLIENT_ID,
      has_secret: !!process.env.GOOGLE_CLIENT_SECRET,
      app_url: process.env.NEXT_PUBLIC_APP_URL,
    });
    return NextResponse.json({ error: 'Google OAuth not configured on server' }, { status: 500 });
  }
  const oauth2Client = makeClient();
  const scopes = [
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/contacts.readonly',
    'https://www.googleapis.com/auth/contacts.other.readonly',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ];

  const userId = request.nextUrl.searchParams.get('user_id') || '';
  const returnTo = request.nextUrl.searchParams.get('return_to') || '/settings';
  // Round-trip both via state (Google passes verbatim)
  const state = JSON.stringify({ uid: userId, rt: returnTo });

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    state,
    prompt: 'consent',
  });

  return NextResponse.redirect(authUrl);
}
