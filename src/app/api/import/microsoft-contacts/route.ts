import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { loadContactDedupSets } from '@/lib/contactDedup';
import { isNoiseEmail } from '@/lib/noiseEmails';
import { requireAuth } from '@/lib/routeAuth';

const GRAPH_URL = 'https://graph.microsoft.com/v1.0';
const COLORS = [
  '#6c63ff', '#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4',
  '#feca57', '#ff9ff3', '#54a0ff', '#5f27cd', '#00d2d3',
];

export async function POST(request: NextRequest) {
  // Was: trusted body { userId } → write-any-row-as-any-user. Now: auth required.
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const userId = auth.user.id;

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  const { data: settings } = await supabase
    .from('user_settings')
    .select('microsoft_access_token')
    .eq('user_id', userId)
    .single();

  if (!settings?.microsoft_access_token) {
    return NextResponse.json({ error: 'Microsoft not connected' }, { status: 400 });
  }

  const token = settings.microsoft_access_token;

  try {
    // Fetch contacts
    let allContacts: any[] = [];
    let nextUrl: string | null = `${GRAPH_URL}/me/contacts?$top=100&$select=displayName,emailAddresses,mobilePhone,companyName,jobTitle`;

    while (nextUrl) {
      const contactRes: Response = await fetch(nextUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (contactRes.status === 401) {
        return NextResponse.json({ error: 'Microsoft token expired — reconnect in Settings' }, { status: 401 });
      }

      const contactData: any = await contactRes.json();
      allContacts = allContacts.concat(contactData.value || []);
      nextUrl = contactData['@odata.nextLink'] || null;
    }

    // Also scan recent emails for contacts
    const emailRes = await fetch(
      `${GRAPH_URL}/me/messages?$top=200&$select=from,toRecipients,ccRecipients,receivedDateTime&$orderby=receivedDateTime desc`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const emailData = await emailRes.json();
    const emailContacts = new Map<string, { name: string; email: string }>();

    for (const msg of emailData.value || []) {
      const people = [
        msg.from?.emailAddress,
        ...(msg.toRecipients || []).map((r: any) => r.emailAddress),
        ...(msg.ccRecipients || []).map((r: any) => r.emailAddress),
      ].filter(Boolean);

      for (const p of people) {
        if (!p.address) continue;
        const addr = p.address.toLowerCase();
        if (addr.includes('noreply') || addr.includes('no-reply') || addr.includes('notifications')) continue;
        if (!emailContacts.has(addr)) {
          emailContacts.set(addr, { name: p.name || addr.split('@')[0], email: addr });
        }
      }
    }

    // Get existing contact dedup state (recognizes aliases + self aliases)
    const { existingEmails, selfEmails, deletedEmails } = await loadContactDedupSets(supabase, userId);
    // Name dedup is a separate dimension — keep it for legacy parity
    const { data: existingByName } = await supabase
      .from('contacts').select('name').eq('user_id', userId);
    const existingNames = new Set((existingByName || []).map(c => c.name?.toLowerCase()).filter(Boolean));
    const baseCount = existingNames.size;

    let imported = 0;
    let skipped = 0;

    // Import from contacts API
    for (const person of allContacts) {
      const name = person.displayName;
      if (!name) { skipped++; continue; }

      const email = person.emailAddresses?.[0]?.address?.toLowerCase();
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
        phone: person.mobilePhone || null,
        company: person.companyName || null,
        role: person.jobTitle || null,
        notes: '',
        tags: [],
        is_promoted: false,
        color,
      });

      imported++;
      existingNames.add(name.toLowerCase());
      if (email) existingEmails.add(email);
    }

    // Import from email scan
    for (const [, contact] of emailContacts) {
      if (selfEmails.has(contact.email)) { skipped++; continue; }
      if (isNoiseEmail(contact.email)) { skipped++; continue; }
      if (deletedEmails.has(contact.email)) { skipped++; continue; }
      if (existingEmails.has(contact.email)) continue;
      if (existingNames.has(contact.name.toLowerCase())) continue;

      const domain = contact.email.split('@')[1];
      const genericDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com', 'me.com'];
      const company = genericDomains.includes(domain) ? undefined : domain.split('.')[0].charAt(0).toUpperCase() + domain.split('.')[0].slice(1);

      const color = COLORS[(imported + baseCount) % COLORS.length];

      await supabase.from('contacts').insert({
        user_id: userId,
        name: contact.name,
        email: contact.email,
        company: company || null,
        notes: '',
        tags: [],
        is_promoted: false,
        color,
      });

      imported++;
      existingEmails.add(contact.email);
    }

    return NextResponse.json({ imported, skipped, total: allContacts.length + emailContacts.size });
  } catch (error: any) {
    console.error('Microsoft import error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
