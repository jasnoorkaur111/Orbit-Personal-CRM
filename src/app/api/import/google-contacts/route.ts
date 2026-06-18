import { NextRequest, NextResponse } from 'next/server';
import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';
import { loadContactDedupSets } from '@/lib/contactDedup';
import { isNoiseEmail } from '@/lib/noiseEmails';
import { requireAuth } from '@/lib/routeAuth';

const COLORS = [
  '#6c63ff', '#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4',
  '#feca57', '#ff9ff3', '#54a0ff', '#5f27cd', '#00d2d3',
];

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const userId = auth.user.id;

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  // Get stored tokens
  const { data: settings } = await supabase
    .from('user_settings')
    .select('google_access_token, google_refresh_token')
    .eq('user_id', userId)
    .single();

  if (!settings?.google_access_token) {
    return NextResponse.json({ error: 'Google not connected' }, { status: 400 });
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.NEXT_PUBLIC_APP_URL + '/api/auth/google/callback'
  );

  oauth2Client.setCredentials({
    access_token: settings.google_access_token,
    refresh_token: settings.google_refresh_token,
  });

  try {
    const people = google.people({ version: 'v1', auth: oauth2Client });

    // Fetch all contacts
    let allContacts: any[] = [];
    let nextPageToken: string | undefined;

    do {
      const res = await people.people.connections.list({
        resourceName: 'people/me',
        pageSize: 200,
        personFields: 'names,emailAddresses,phoneNumbers,organizations,photos,urls',
        pageToken: nextPageToken,
      });
      allContacts = allContacts.concat(res.data.connections || []);
      nextPageToken = res.data.nextPageToken || undefined;
    } while (nextPageToken);

    // Alias-aware dedup
    const { existingEmails, selfEmails, deletedEmails } = await loadContactDedupSets(supabase, userId);
    const { data: existingByName } = await supabase
      .from('contacts').select('name').eq('user_id', userId);
    const existingNames = new Set((existingByName || []).map(c => c.name?.toLowerCase()).filter(Boolean));
    const baseCount = existingNames.size;

    let imported = 0;
    let skipped = 0;

    for (const person of allContacts) {
      const name = person.names?.[0]?.displayName;
      if (!name) { skipped++; continue; }

      const email = person.emailAddresses?.[0]?.value?.toLowerCase();
      const phone = person.phoneNumbers?.[0]?.value;
      const company = person.organizations?.[0]?.name;
      const role = person.organizations?.[0]?.title;
      const photo = person.photos?.[0]?.url;
      const linkedin = person.urls?.find((u: any) => u.value?.includes('linkedin'))?.value;

      // Skip self + noise + existing (by email + alias)
      if (email && selfEmails.has(email)) { skipped++; continue; }
      if (email && isNoiseEmail(email)) { skipped++; continue; }
      if (email && deletedEmails.has(email)) { skipped++; continue; }
      if (existingNames.has(name.toLowerCase())) { skipped++; continue; }
      if (email && existingEmails.has(email)) { skipped++; continue; }

      const color = COLORS[(imported + baseCount) % COLORS.length];

      await supabase.from('contacts').insert({
        user_id: userId,
        name,
        email: email || null,
        phone: phone || null,
        company: company || null,
        role: role || null,
        linkedin: linkedin || null,
        photo: (photo && !photo.includes('default-user')) ? photo : null,
        notes: '',
        tags: [],
        is_promoted: false,
        color,
      });

      imported++;
    }

    return NextResponse.json({ imported, skipped, total: allContacts.length });
  } catch (error: any) {
    console.error('Google Contacts import error:', error);
    if (error.code === 401) {
      return NextResponse.json({ error: 'Google token expired — reconnect in Settings' }, { status: 401 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
