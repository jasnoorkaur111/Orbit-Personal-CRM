import { NextRequest, NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { google } from 'googleapis';
import { graphFetchAllPages } from '@/lib/msgraph';
import { isNoiseEmail } from '@/lib/noiseEmails';
import { tierContacts } from '@/lib/tierContacts';
import { cleanupUserBrands } from '@/lib/cleanupUserBrands';
import { lookupFirmByEmail } from '@/lib/firmDomains';
import { applyFirmTagsForUser } from '@/lib/applyFirmTags';

export const maxDuration = 180;

interface MSGraphEvent {
  id: string;
  iCalUId?: string;
  subject?: string;
  bodyPreview?: string;
  body?: { content?: string };
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  isAllDay: boolean;
  isCancelled?: boolean;
  organizer?: { emailAddress: { name: string; address: string } };
  attendees?: { emailAddress: { name: string; address: string }; status?: { response: string }; type: string }[];
  location?: { displayName?: string };
  recurrence?: any;
  categories?: string[];
}

interface MSGraphPerson {
  id: string;
  displayName?: string;
  givenName?: string;
  surname?: string;
  scoredEmailAddresses?: { address: string; relevanceScore: number }[];
  jobTitle?: string;
  companyName?: string;
  department?: string;
  personType?: { class: string };
}

const PALETTE = ['#7c5cff', '#22d3ee', '#f5c542', '#ef4444', '#10b981', '#ec4899', '#f97316', '#a78bfa', '#06b6d4'];

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const token = authHeader.replace('Bearer ', '');

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${token}` } } }
  );

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: settings } = await supabase
    .from('user_settings')
    .select('microsoft_access_token, microsoft_refresh_token, google_access_token, google_refresh_token, timezone, brand_cleanup_v1_at, firm_tag_v1_at')
    .eq('user_id', user.id)
    .maybeSingle();

  // ── One-time brand cleanup backfill ─────────────────────────────────
  // Anyone who synced before the tierByRules Step-4 tightening landed
  // has brand contacts (Uber Eats, Starbucks Rewards, GoDaddy Renewals,
  // etc.) polluting their graph. Run the LLM classifier over their
  // existing contacts once, then mark them clean. Uses the service role
  // because cleanup spans tables that RLS protects.
  if (!settings?.brand_cleanup_v1_at && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const admin = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
      );
      const stats = await cleanupUserBrands(admin, user.id);
      await admin
        .from('user_settings')
        .update({ brand_cleanup_v1_at: new Date().toISOString() })
        .eq('user_id', user.id);
      console.log(`[sync-graph] brand backfill user=${user.id} scanned=${stats.scanned} dropped=${stats.dropped}`);
    } catch (e: any) {
      console.error('[sync-graph] brand backfill failed (continuing sync):', e?.message);
    }
  }

  // ── One-time VC/firm domain tag backfill ───────────────────────────
  // Walk all existing contacts and apply the firmDomains tags to anyone
  // whose email matches a known VC/accelerator/angel-platform. Powers
  // "who are my investors?" in Ask-network without needing per-contact
  // web research. Gated by firm_tag_v1_at so it only ever runs once.
  if (!settings?.firm_tag_v1_at && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const admin = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
      );
      const stats = await applyFirmTagsForUser(admin, user.id);
      await admin
        .from('user_settings')
        .update({ firm_tag_v1_at: new Date().toISOString() })
        .eq('user_id', user.id);
      console.log(`[sync-graph] firm-tag backfill user=${user.id} scanned=${stats.scanned} tagged=${stats.tagged}`);
    } catch (e: any) {
      console.error('[sync-graph] firm-tag backfill failed (continuing sync):', e?.message);
    }
  }

  // Resolve user timezone for event time formatting. Priority:
  //   1. user_settings.timezone (explicit, set in Settings)
  //   2. tz from request body (client-derived from Intl.DateTimeFormat)
  //   3. UTC (last-resort fallback so we never crash)
  let body: any = {};
  try { body = await request.json(); } catch {}
  const userTz = settings?.timezone || body?.tz || 'UTC';

  const userEmail = (user.email || '').toLowerCase();
  const results: Record<string, any> = {};

  const hasMS = !!(settings?.microsoft_access_token && settings?.microsoft_refresh_token);
  const hasGoogle = !!(settings?.google_access_token && settings?.google_refresh_token);

  if (!hasMS && !hasGoogle) return NextResponse.json({ error: 'No OAuth provider connected' }, { status: 400 });

  // ── Self-alias detection ──
  // The signup email is rarely the same as the user's MS / Google account
  // email (e.g. signed up with gmail, connected outlook for calendar). Without
  // this step those provider emails get imported as separate Discovered
  // contacts and even appear at the center of the user's own network graph
  // (the "Maya Fairman is me" bug). Fix: hit /me before syncing and merge
  // anything we find into the self contact's email_aliases. Best-effort —
  // failures here must not break the whole sync.
  try {
    const aliases = new Set<string>();
    let providerName: string | null = null;
    if (hasMS) {
      const me = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,proxyAddresses,displayName,givenName,surname', {
        headers: { Authorization: `Bearer ${settings!.microsoft_access_token}` },
      }).then((r) => r.ok ? r.json() : null).catch(() => null);
      if (me?.mail) aliases.add(String(me.mail).toLowerCase());
      if (me?.userPrincipalName) aliases.add(String(me.userPrincipalName).toLowerCase());
      for (const p of (me?.proxyAddresses || []) as string[]) {
        // SMTP:foo@bar.com → foo@bar.com
        const clean = p.replace(/^smtp:/i, '').toLowerCase();
        if (clean.includes('@')) aliases.add(clean);
      }
      // Prefer displayName, fall back to constructed "given surname". This is
      // the user's "gov name" as their employer / MS account knows it — store
      // it separately from their chosen display name on the self contact.
      const msName = (me?.displayName as string | undefined)?.trim()
        || `${me?.givenName || ''} ${me?.surname || ''}`.trim();
      if (msName) providerName = msName;
    }
    if (hasGoogle) {
      const info = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${settings!.google_access_token}` },
      }).then((r) => r.ok ? r.json() : null).catch(() => null);
      if (info?.email) aliases.add(String(info.email).toLowerCase());
      // MS takes precedence if both connected — usually the more authoritative
      // identity source (work account, real legal name on file). Only use
      // Google name as fallback.
      if (!providerName) {
        const gName = (info?.name as string | undefined)?.trim();
        if (gName) providerName = gName;
      }
    }
    if (aliases.size > 0 || providerName) {
      await mergeSelfAliases(supabase, user.id, userEmail, Array.from(aliases), providerName);
    }
  } catch (e: any) {
    console.warn('[sync-graph] self-alias detection failed (continuing):', e?.message);
  }

  if (hasMS) {
    try {
      results.microsoft = await syncMicrosoft(supabase, user.id, settings, userEmail, userTz);
    } catch (e: any) { results.microsoft = { error: e.message }; }
  }

  if (hasGoogle) {
    try {
      results.google = await syncGoogle(supabase, user.id, settings, userEmail, userTz);
    } catch (e: any) { results.google = { error: e.message }; }
  }

  return NextResponse.json({ ok: true, ...results });
}

// Merge provider-side identities into the self contact's email_aliases.
// Also collapses any existing non-self contact that matches one of the new
// aliases into the self contact, because previous syncs likely imported the
// connected-account email as a stranger (the original "Maya Fairman" bug).
// `providerName` (the user's "gov name" per /me) is stored on user_settings —
// kept separate from contacts.name so the user's onboarding-set preference
// isn't overwritten.
async function mergeSelfAliases(
  supabase: SupabaseClient,
  userId: string,
  signupEmail: string,
  newAliases: string[],
  providerName: string | null,
) {
  // Provider-reported "gov name" lives on user_settings. Write-once: only
  // populate the column if it's currently NULL. We deliberately don't
  // overwrite on subsequent syncs — if the user later changes their MS
  // displayName (job change, married name, garbage test value), we'd lose
  // the original authoritative signal. The `.is(..., null)` guard makes the
  // UPDATE a no-op for any row that already has a value.
  if (providerName) {
    await supabase.from('user_settings')
      .update({ provider_display_name: providerName })
      .eq('user_id', userId)
      .is('provider_display_name', null);
  }

  const { data: selfRow } = await supabase
    .from('contacts')
    .select('id, email, email_aliases')
    .eq('user_id', userId)
    .eq('is_self', true)
    .maybeSingle();
  if (!selfRow) return;

  const existing = new Set<string>((selfRow.email_aliases || []).map((a: string) => a.toLowerCase()));
  if (selfRow.email) existing.add(selfRow.email.toLowerCase());
  if (signupEmail) existing.add(signupEmail.toLowerCase());

  let changed = false;
  for (const a of newAliases) {
    if (!a) continue;
    const norm = a.toLowerCase();
    if (!existing.has(norm)) { existing.add(norm); changed = true; }
  }

  if (changed) {
    await supabase.from('contacts')
      .update({ email_aliases: Array.from(existing) })
      .eq('id', selfRow.id);
  }

  // Re-absorb any stranger contact whose email matches one of these aliases.
  // Edges and events still reference the old contact id, so re-point them at
  // the self contact before deleting the stranger.
  const aliasList = Array.from(existing);
  const { data: strangers } = await supabase
    .from('contacts')
    .select('id, email')
    .eq('user_id', userId)
    .neq('id', selfRow.id)
    .in('email', aliasList);

  if (strangers && strangers.length > 0) {
    const strangerIds = strangers.map((s) => s.id);
    // Edges live in `connections` with from_contact_id / to_contact_id.
    // Repoint to the self contact before deleting the duplicates so we don't
    // lose the relationship signal already mined from emails/calendar.
    await supabase.from('connections').update({ from_contact_id: selfRow.id }).in('from_contact_id', strangerIds);
    await supabase.from('connections').update({ to_contact_id: selfRow.id }).in('to_contact_id', strangerIds);
    // Drop self-loops that this repoint may have introduced.
    await supabase.from('connections').delete().eq('from_contact_id', selfRow.id).eq('to_contact_id', selfRow.id);
    await supabase.from('contacts').delete().in('id', strangerIds);
  }
}

// ═══════════════════════════════════════════════════════════════
// MICROSOFT
// ═══════════════════════════════════════════════════════════════
async function syncMicrosoft(supabase: SupabaseClient, userId: string, settings: any, userEmail: string, userTz: string) {
  const out: Record<string, any> = {};

  const sixMoBack = new Date(); sixMoBack.setMonth(sixMoBack.getMonth() - 6);
  const sixMoFwd = new Date(); sixMoFwd.setMonth(sixMoFwd.getMonth() + 6);

  // Calendar
  const calRes = await graphFetchAllPages(
    `/me/calendarview?startDateTime=${sixMoBack.toISOString()}&endDateTime=${sixMoFwd.toISOString()}&$top=100&$select=id,iCalUId,subject,bodyPreview,body,start,end,isAllDay,isCancelled,organizer,attendees,location,categories`,
    userId, supabase,
    settings.microsoft_access_token, settings.microsoft_refresh_token, 30
  );
  if (calRes.error) throw new Error('MS calendar: ' + calRes.error);

  const events = (calRes.items as MSGraphEvent[])
    .filter((e) => !e.isCancelled && e.subject && e.start && e.end)
    .map((e) => {
      const sD = new Date(e.start.dateTime + (e.start.timeZone === 'UTC' ? 'Z' : ''));
      const eD = new Date(e.end.dateTime + (e.end.timeZone === 'UTC' ? 'Z' : ''));
      const attendees = (e.attendees || [])
        .filter((a) => a.emailAddress?.address && !a.emailAddress.address.includes('calendar.') && !a.emailAddress.address.includes('resource.'))
        .map((a) => ({ name: a.emailAddress.name || a.emailAddress.address.split('@')[0], email: a.emailAddress.address.toLowerCase() }));
      return {
        user_id: userId,
        title: e.subject!,
        date: sD.toLocaleDateString('en-CA', { timeZone: userTz }),
        time: e.isAllDay ? null : sD.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: userTz }),
        end_time: e.isAllDay ? null : eD.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: userTz }),
        description: e.body?.content?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000) || e.bodyPreview || null,
        source: 'msgraph_calendar',
        external_id: `msgraph_${e.iCalUId || e.id}`,
        organizer_email: e.organizer?.emailAddress?.address?.toLowerCase() || null,
        attendees: attendees.length > 0 ? attendees : null,
      };
    });

  const { data: existing } = await supabase.from('events')
    .select('external_id').eq('source', 'msgraph_calendar').eq('user_id', userId);
  const existingIds = new Set((existing || []).map((r) => r.external_id));
  const newRows = events.filter((r) => !existingIds.has(r.external_id));

  let inserted = 0;
  for (let i = 0; i < newRows.length; i += 100) {
    const { error } = await supabase.from('events').insert(newRows.slice(i, i + 100));
    if (!error) inserted += Math.min(100, newRows.length - i);
  }
  out.calendar = { fetched: events.length, inserted };

  // People
  const peopleRes = await graphFetchAllPages(
    '/me/people?$top=100&$select=id,displayName,givenName,surname,scoredEmailAddresses,jobTitle,companyName,department,personType',
    userId, supabase, settings.microsoft_access_token, settings.microsoft_refresh_token, 5
  );
  if (!peopleRes.error) {
    out.people = await ingestPeople(
      supabase, userId, userEmail,
      (peopleRes.items as MSGraphPerson[])
        .filter((p) => p.personType?.class === 'Person' && p.scoredEmailAddresses?.[0]?.address)
        .map((p) => ({
          name: p.displayName || `${p.givenName || ''} ${p.surname || ''}`.trim() || p.scoredEmailAddresses![0].address.split('@')[0],
          email: p.scoredEmailAddresses![0].address.toLowerCase(),
          company: p.companyName || null,
          role: p.jobTitle || null,
          // Don't pollute the user-facing notes field with import provenance.
          // Department goes in there only if present (it's actually useful context).
          notes: p.department ? `Dept: ${p.department}` : '',
          tag: 'msgraph-import',
        }))
    );
  } else {
    out.people = { error: peopleRes.error };
  }

  return out;
}

// ═══════════════════════════════════════════════════════════════
// GOOGLE
// ═══════════════════════════════════════════════════════════════
async function syncGoogle(supabase: SupabaseClient, userId: string, settings: any, userEmail: string, userTz: string) {
  const out: Record<string, any> = {};

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.NEXT_PUBLIC_APP_URL + '/api/auth/google/callback'
  );
  oauth2Client.setCredentials({
    access_token: settings.google_access_token,
    refresh_token: settings.google_refresh_token,
  });

  // Persist rotated refresh tokens
  oauth2Client.on('tokens', async (tokens) => {
    if (tokens.refresh_token || tokens.access_token) {
      try {
        await supabase.rpc('save_oauth_tokens', {
          p_user_id: userId,
          p_provider: 'google',
          p_access_token: tokens.access_token || settings.google_access_token,
          p_refresh_token: tokens.refresh_token || settings.google_refresh_token,
        });
      } catch {}
    }
  });

  // ── Calendar ──
  try {
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const sixMoBack = new Date(); sixMoBack.setMonth(sixMoBack.getMonth() - 6);
    const sixMoFwd = new Date(); sixMoFwd.setMonth(sixMoFwd.getMonth() + 6);

    let pageToken: string | undefined;
    const allEvents: any[] = [];
    do {
      const { data } = await calendar.events.list({
        calendarId: 'primary',
        timeMin: sixMoBack.toISOString(),
        timeMax: sixMoFwd.toISOString(),
        singleEvents: true,
        maxResults: 250,
        pageToken,
      });
      allEvents.push(...(data.items || []));
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken && allEvents.length < 2000);

    const rows = allEvents
      .filter((e) => e.status !== 'cancelled' && e.summary && (e.start?.dateTime || e.start?.date))
      .map((e) => {
        const isAllDay = !e.start.dateTime;
        const sD = new Date(e.start.dateTime || e.start.date + 'T12:00:00');
        const eD = new Date(e.end.dateTime || e.end.date + 'T12:00:00');
        const attendees = (e.attendees || [])
          .filter((a: any) => a.email && !a.resource && !a.email.includes('calendar.google'))
          .map((a: any) => ({ name: a.displayName || a.email.split('@')[0], email: a.email.toLowerCase() }));
        return {
          user_id: userId,
          title: e.summary,
          date: isAllDay ? e.start.date : sD.toLocaleDateString('en-CA', { timeZone: userTz }),
          time: isAllDay ? null : sD.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: userTz }),
          end_time: isAllDay ? null : eD.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: userTz }),
          description: e.description ? String(e.description).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000) : null,
          source: 'gcal_api',
          external_id: `gcal_${e.iCalUID || e.id}`,
          organizer_email: e.organizer?.email?.toLowerCase() || null,
          attendees: attendees.length > 0 ? attendees : null,
        };
      });

    const { data: existing } = await supabase.from('events')
      .select('external_id').eq('source', 'gcal_api').eq('user_id', userId);
    const existingIds = new Set((existing || []).map((r) => r.external_id));
    const newRows = rows.filter((r) => !existingIds.has(r.external_id));

    let inserted = 0;
    for (let i = 0; i < newRows.length; i += 100) {
      const { error } = await supabase.from('events').insert(newRows.slice(i, i + 100));
      if (!error) inserted += Math.min(100, newRows.length - i);
    }
    out.calendar = { fetched: rows.length, inserted };
  } catch (e: any) {
    out.calendar = { error: e.message };
  }

  // ── People (Google Contacts + Other contacts) ──
  try {
    const people = google.people({ version: 'v1', auth: oauth2Client });
    const collected: any[] = [];

    // Connections (your Contacts app)
    let pageToken: string | undefined;
    do {
      const { data } = await people.people.connections.list({
        resourceName: 'people/me',
        pageSize: 500,
        personFields: 'names,emailAddresses,organizations,phoneNumbers',
        pageToken,
      });
      collected.push(...(data.connections || []));
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken && collected.length < 3000);

    // Other contacts (auto-saved from email replies — goldmine of work relationships)
    // NOTE: otherContacts.list does NOT support 'organizations' in readMask — only names/emails/phones/photos
    try {
      let otherPageToken: string | undefined;
      do {
        const { data } = await people.otherContacts.list({
          pageSize: 500,
          readMask: 'names,emailAddresses,phoneNumbers',
          pageToken: otherPageToken,
        });
        collected.push(...(data.otherContacts || []));
        otherPageToken = data.nextPageToken ?? undefined;
      } while (otherPageToken && collected.length < 5000);
    } catch (e: any) {
      console.error('otherContacts.list failed:', e.message);
    }

    const mapped = collected
      .filter((p) => p.emailAddresses?.[0]?.value && p.emailAddresses[0].value.toLowerCase() !== userEmail)
      .map((p) => ({
        name: p.names?.[0]?.displayName || p.emailAddresses[0].value.split('@')[0],
        email: p.emailAddresses[0].value.toLowerCase(),
        company: p.organizations?.[0]?.name || null,
        role: p.organizations?.[0]?.title || null,
        notes: 'via Google People',
        tag: 'google-import',
      }));

    out.people = await ingestPeople(supabase, userId, userEmail, mapped);
  } catch (e: any) {
    out.people = { error: e.message };
  }

  return out;
}

// ═══════════════════════════════════════════════════════════════
// SHARED — ingest "people" entries as contacts (dedup by email)
// ═══════════════════════════════════════════════════════════════
async function ingestPeople(
  supabase: SupabaseClient,
  userId: string,
  userEmail: string,
  people: { name: string; email: string; company: string | null; role: string | null; notes: string; tag: string }[]
) {
  const { data: existingContacts } = await supabase
    .from('contacts').select('id, email, email_aliases, is_self').eq('user_id', userId);

  // Tombstones — emails the user explicitly deleted. We MUST NOT re-import
  // them from /me/people or anywhere else, otherwise the delete button feels
  // broken (contact comes back on the next sync). Best-effort load: if the
  // table doesn't exist yet on a self-hosted instance, fall back to empty set.
  const deletedEmails = new Set<string>();
  try {
    const { data: tombstones } = await supabase
      .from('deleted_contacts').select('email').eq('user_id', userId);
    for (const t of tombstones || []) if (t.email) deletedEmails.add(t.email.toLowerCase());
  } catch { /* table missing, treat as no tombstones */ }

  // Build full email lookup: primary + aliases for every existing contact.
  // Anything that matches a self alias is treated as self — never re-imported as a contact.
  const existingEmails = new Set<string>();
  const selfEmails = new Set<string>([userEmail.toLowerCase()]);
  for (const c of existingContacts || []) {
    if (c.email) existingEmails.add(c.email.toLowerCase());
    for (const a of (c.email_aliases || [])) {
      if (a) existingEmails.add(a.toLowerCase());
      if (a && c.is_self) selfEmails.add(a.toLowerCase());
    }
    if (c.is_self && c.email) selfEmails.add(c.email.toLowerCase());
  }

  const fresh = people
    .filter((p) => !selfEmails.has(p.email.toLowerCase()) && !existingEmails.has(p.email.toLowerCase()))
    // Skip anything the user explicitly deleted. Without this every delete
    // gets undone by the next sync-graph run.
    .filter((p) => !deletedEmails.has(p.email.toLowerCase()))
    // Skip noise: role-prefix inboxes (hello@, info@…), SaaS senders (stripe,
    // substack…), AND brand names (Uber Eats, Starbucks Rewards, App Store
    // Connect, etc.). Passing p.name as the second arg is critical — without
    // it the display-name pattern check is silently skipped and brand
    // contacts come in disguised as "people."
    .filter((p) => !isNoiseEmail(p.email, p.name))
    // dedupe within this batch
    .filter((p, i, arr) => arr.findIndex((x) => x.email === p.email) === i)
    .slice(0, 100);

  const newRows = fresh.map((p, i) => {
    // Auto-detect VC/accelerator/angel-platform via email domain. Sets the
    // 'investor' tag so Ask-network can answer "who are my investors?"
    // without having to web-research every contact, and fills in `company`
    // when missing so the LLM has a label to chew on.
    const firm = lookupFirmByEmail(p.email);
    return {
      user_id: userId,
      name: p.name,
      email: p.email,
      company: p.company || firm?.name || null,
      role: p.role,
      notes: p.notes,
      tags: firm ? firm.tags : [],
      is_direct: true,
      // Auto-discovered: lands in the Discovered tray, not the live network.
      // User promotes them when they prove out (or bulk-deletes the rest).
      is_promoted: true,
      color: PALETTE[((existingContacts?.length || 0) + i) % PALETTE.length],
    };
  });

  let added = 0;
  const insertedIds: { id: string; name: string | null; email: string | null }[] = [];
  if (newRows.length > 0) {
    for (let i = 0; i < newRows.length; i += 100) {
      const batch = newRows.slice(i, i + 100);
      // Upsert against the (user_id, email) unique index. If a concurrent sync
      // already inserted this email, ignoreDuplicates skips it cleanly instead
      // of failing the whole batch with a 23505. `.select()` still returns the
      // rows we just inserted so downstream (auto-tier, edge-mining) can use them.
      const { data, error } = await supabase
        .from('contacts')
        .upsert(batch, { onConflict: 'user_id,email', ignoreDuplicates: true })
        .select('id, name, email');
      if (!error) {
        added += (data || []).length;
        for (const row of (data || []) as { id: string; name: string | null; email: string | null }[]) {
          insertedIds.push(row);
        }
      } else console.error('Contact insert error:', error);
    }
  }

  // ── LLM tier classifier ─────────────────────────────────────────────
  // The cheap noise filter above catches obvious cases (noreply@, substack
  // domain, role-prefix inboxes). For the rest — "Uber Eats", "Starbucks
  // Rewards", "App Store Connect", anything where the brand-vs-person
  // judgment requires general knowledge — we run a rule-first + LLM-tiebreaker
  // classifier and delete contacts the LLM marks as not-a-person.
  let dropped = 0;
  if (insertedIds.length > 0) {
    try {
      const tierInputs = insertedIds.map((r) => ({
        id: r.id, name: r.name, email: r.email,
      }));
      const verdicts = await tierContacts(tierInputs, new Set(), new Map());
      const toDelete: string[] = [];
      for (const v of verdicts.values()) if (v.tier === 'drop') toDelete.push(v.id);
      if (toDelete.length > 0) {
        for (let i = 0; i < toDelete.length; i += 100) {
          const batch = toDelete.slice(i, i + 100);
          const { error } = await supabase.from('contacts').delete().in('id', batch).eq('user_id', userId);
          if (!error) dropped += batch.length;
        }
        added -= dropped;
        console.log(`[sync-graph] LLM-tiered ${insertedIds.length} contacts, dropped ${dropped} brand/non-person`);
      }
    } catch (e: any) {
      console.error('[sync-graph] tier classification failed (keeping all):', e?.message);
    }
  }

  return { fetched: people.length, new_contacts_added: added, dropped_by_tier: dropped, skipped_dup_or_self: people.length - fresh.length };
}
