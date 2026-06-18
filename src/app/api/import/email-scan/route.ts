import { NextRequest, NextResponse } from 'next/server';
import { ImapFlow } from 'imapflow';
import { createClient } from '@supabase/supabase-js';
import { loadContactDedupSets } from '@/lib/contactDedup';
import { isNoiseEmail } from '@/lib/noiseEmails';
import { requireAuth } from '@/lib/routeAuth';

const COLORS = [
  '#6c63ff', '#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4',
  '#feca57', '#ff9ff3', '#54a0ff', '#5f27cd', '#00d2d3',
];

// Known IMAP presets
const IMAP_PRESETS: Record<string, { host: string; port: number }> = {
  gmail: { host: 'imap.gmail.com', port: 993 },
  outlook: { host: 'outlook.office365.com', port: 993 },
  icloud: { host: 'imap.mail.me.com', port: 993 },
  yahoo: { host: 'imap.mail.yahoo.com', port: 993 },
};

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const userId = auth.user.id;

  const { email, appPassword, provider } = await request.json();
  if (!email || !appPassword) {
    return NextResponse.json({ error: 'Missing credentials' }, { status: 400 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  const preset = IMAP_PRESETS[provider] || IMAP_PRESETS.gmail;

  const client = new ImapFlow({
    host: preset.host,
    port: preset.port,
    secure: true,
    auth: { user: email, pass: appPassword },
    logger: false,
  });

  try {
    await client.connect();

    // Scan sent mail for contacts
    const sentFolders = ['[Gmail]/Sent Mail', 'Sent', 'INBOX.Sent', 'Sent Items', 'Sent Messages'];
    let sentFolder = 'INBOX';

    for (const folder of sentFolders) {
      try {
        await client.mailboxOpen(folder);
        sentFolder = folder;
        break;
      } catch {
        continue;
      }
    }

    // Get last 6 months of sent emails
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const contactMap = new Map<string, { name: string; email: string; count: number }>();

    // Scan sent mail
    try {
      await client.mailboxOpen(sentFolder);
      const messages = client.fetch(
        { since: sixMonthsAgo },
        { envelope: true }
      );

      for await (const msg of messages) {
        const recipients = [
          ...(msg.envelope?.to || []),
          ...(msg.envelope?.cc || []),
        ];

        for (const r of recipients) {
          if (!r.address || r.address === email) continue;
          const addr = r.address.toLowerCase();
          const existing = contactMap.get(addr);
          const displayName = r.name || addr.split('@')[0];
          if (existing) {
            existing.count++;
            if (r.name && !existing.name.includes('@')) existing.name = r.name;
          } else {
            contactMap.set(addr, { name: displayName, email: addr, count: 1 });
          }
        }
      }
    } catch (e) {
      // Sent folder might not exist, continue with inbox
    }

    // Also scan inbox
    try {
      await client.mailboxOpen('INBOX');
      const messages = client.fetch(
        { since: sixMonthsAgo },
        { envelope: true }
      );

      for await (const msg of messages) {
        const sender = msg.envelope?.from?.[0];
        if (!sender?.address || sender.address === email) continue;
        const addr = sender.address.toLowerCase();
        const existing = contactMap.get(addr);
        const displayName = sender.name || addr.split('@')[0];
        if (existing) {
          existing.count++;
          if (sender.name && existing.name.includes('@')) existing.name = sender.name;
        } else {
          contactMap.set(addr, { name: displayName, email: addr, count: 1 });
        }
      }
    } catch (e) {
      // Continue
    }

    await client.logout();

    // Alias-aware dedup. Pass the IMAP login email as a fallback self-email so we
    // never re-import the user themselves (sent-folder envelopes may contain it via Bcc).
    const { existingEmails, selfEmails, deletedEmails } = await loadContactDedupSets(supabase, userId, email);
    const { data: existingByName } = await supabase
      .from('contacts').select('name').eq('user_id', userId);
    const existingNames = new Set((existingByName || []).map(c => c.name?.toLowerCase()).filter(Boolean));
    const baseCount = existingNames.size;

    // Sort by frequency (most emailed first)
    const sortedContacts = [...contactMap.values()].sort((a, b) => b.count - a.count);

    let imported = 0;
    let skipped = 0;

    for (const contact of sortedContacts) {
      // Skip self + noise (role-prefix / SaaS senders) + existing
      if (selfEmails.has(contact.email)) { skipped++; continue; }
      if (isNoiseEmail(contact.email)) { skipped++; continue; }
      if (deletedEmails.has(contact.email)) { skipped++; continue; }
      if (existingEmails.has(contact.email)) { skipped++; continue; }
      if (existingNames.has(contact.name.toLowerCase())) { skipped++; continue; }

      // Extract company from email domain
      const domain = contact.email.split('@')[1];
      const genericDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'me.com', 'aol.com', 'protonmail.com'];
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
    }

    // Save IMAP settings for future syncs
    await supabase.from('user_settings').upsert({
      user_id: userId,
      imap_email: email,
      imap_provider: provider || 'gmail',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });

    return NextResponse.json({
      imported,
      skipped,
      total: sortedContacts.length,
    });
  } catch (error: any) {
    console.error('IMAP scan error:', error);
    if (error.authenticationFailed) {
      return NextResponse.json({ error: 'Authentication failed — check your email and app password' }, { status: 401 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
