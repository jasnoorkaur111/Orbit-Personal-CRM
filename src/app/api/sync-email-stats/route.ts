// Walks Microsoft Graph /me/messages for the last 6 months and aggregates
// per-contact email-exchange stats: emails_sent, emails_received, last in/out,
// first_seen, thread_count. The AFTER-trigger on email_stats auto-promotes
// any Discovered contact the moment they reply for the first time.
//
// Auth: same Mail.Read scope we already requested at OAuth time.
// Cost: free. ~30s for ~3000 messages.

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isNoiseEmail } from '@/lib/noiseEmails';
import { graphFetchAllPages } from '@/lib/msgraph';
import { tierContacts } from '@/lib/tierContacts';

// Bumped from 60 → 300 (Vercel Pro max). New users with multi-year mailboxes
// were timing out before the cursor saved → infinite re-fetch loop.
export const maxDuration = 300;

interface GraphAddress { emailAddress?: { name?: string; address?: string } }
interface GraphMessage {
  id: string;
  conversationId?: string;
  subject?: string;
  sentDateTime?: string;
  receivedDateTime?: string;
  from?: GraphAddress;
  toRecipients?: GraphAddress[];
  ccRecipients?: GraphAddress[];
}

// Strip punctuation + collapse whitespace so "Jane Doe" matches
// "jane  doe" or "Jane, Doe". Cheap and good enough for the
// conservative name-match guard.
function normalizeNameStr(s: string | null | undefined): string {
  return (s || '').toLowerCase().trim().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// True only when both names are non-empty AND identical after normalization.
// Deliberately strict — we don't want "Jane" to match "Jane Doe".
function namesMatchExact(a: string | null | undefined, b: string | null | undefined): boolean {
  const an = normalizeNameStr(a);
  const bn = normalizeNameStr(b);
  if (!an || !bn) return false;
  return an === bn;
}

// True when the email's local-part shares a token or initials with the name.
// Prevents the false-positive case where a coincidental name match on a
// totally unrelated business email (e.g. "marketing@…" with display name
// "Jane Doe" copied into a campaign) gets misidentified as the user.
function localPartMatchesName(email: string, providerName: string | null | undefined): boolean {
  if (!providerName) return false;
  const local = (email.split('@')[0] || '').toLowerCase();
  if (!local) return false;
  const tokens = normalizeNameStr(providerName).split(' ').filter((t) => t.length >= 3);
  if (tokens.length === 0) return false;
  // Whole-token match (e.g. "jane" in "jane.doe")
  for (const t of tokens) {
    if (local.includes(t)) return true;
  }
  // Initials match (e.g. "jk" in "jk@…" or "jkaur@…")
  const initials = tokens.map((t) => t[0]).join('');
  if (initials.length >= 2 && (local === initials || local.startsWith(initials))) return true;
  return false;
}

// Heuristic: subjects that obviously signal an introduction. A single message
// with this subject pattern is enough evidence to create an edge — intros only
// happen once and they ARE the highest-value 2nd-degree signal we have.
function isIntroSubject(subj: string | undefined | null): boolean {
  if (!subj) return false;
  const s = subj.toLowerCase();
  return (
    /\bintro(duction)?\b/.test(s) ||           // "intro", "introduction"
    /\bconnect(ing)?\b/.test(s) ||              // "connecting you two"
    /\b(meet|meeting) [a-z]+\b/.test(s) ||      // "meet Alex", "meeting Alex"
    /\s[x×]\s/.test(s) ||                       // "Jane x Felix" or "Jane × Felix"
    /\bhandoff\b/.test(s) ||
    /\bwarm intro\b/.test(s)
  );
}

interface StatBucket {
  emails_sent: number;
  emails_received: number;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  last_inbound_cc_names: string[];
  last_outbound_cc_names: string[];
  last_inbound_subject: string | null;
  last_outbound_subject: string | null;
  first_seen_at: string | null;
  thread_ids: Set<string>;
}

function bumpFirstSeen(b: StatBucket, ts: string | undefined | null) {
  if (!ts) return;
  if (!b.first_seen_at || new Date(ts) < new Date(b.first_seen_at)) {
    b.first_seen_at = ts;
  }
}

export async function POST(request: NextRequest) {
  try {
  // Authenticate caller
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const token = authHeader.replace('Bearer ', '');
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${token}` } } },
  );
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Load OAuth tokens + persisted delta cursor + provider gov name.
  // provider_display_name powers the conservative self-detection guard
  // below — catches "From: <user's name> <unknown-third-address>" cases
  // that the email-based alias check misses.
  const { data: settings } = await supabase
    .from('user_settings')
    .select('microsoft_access_token, microsoft_refresh_token, microsoft_messages_delta_link, provider_display_name')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!settings?.microsoft_access_token) {
    return NextResponse.json({ error: 'Microsoft not connected' }, { status: 400 });
  }
  const providerDisplayName: string | null = settings.provider_display_name || null;

  // Load contacts (for email → contact_id map) AND self aliases + self contact id
  const { data: contactRows } = await supabase
    .from('contacts')
    .select('id, email, email_aliases, is_self, name')
    .eq('user_id', user.id);

  const emailToContact = new Map<string, string>();
  // nameToContact powers the backfill pass at the end of the route — CC
  // headers often arrive as display names ("Anttoni Aniebonam") rather than
  // raw addresses, so we need to resolve by name too.
  const nameToContact = new Map<string, string>();
  const selfEmails = new Set<string>();
  // Tombstones — if the user deleted a contact, CC mining must not silently
  // re-create them from the same emails. Best-effort: empty set if table missing.
  const deletedEmails = new Set<string>();
  try {
    const { data: tombstones } = await supabase
      .from('deleted_contacts').select('email').eq('user_id', user.id);
    for (const t of tombstones || []) if (t.email) deletedEmails.add(t.email.toLowerCase());
  } catch { /* table missing */ }
  let selfContactId: string | null = null;
  for (const c of (contactRows as { id: string; email: string | null; email_aliases: string[] | null; is_self: boolean | null; name: string | null }[]) || []) {
    if (c.is_self) {
      selfContactId = c.id;
      if (c.email) selfEmails.add(c.email.toLowerCase());
      for (const a of c.email_aliases || []) if (a) selfEmails.add(a.toLowerCase());
      continue;
    }
    if (c.email) emailToContact.set(c.email.toLowerCase(), c.id);
    for (const a of c.email_aliases || []) {
      if (a) emailToContact.set(a.toLowerCase(), c.id);
    }
    if (c.name) nameToContact.set(c.name.trim().toLowerCase(), c.id);
  }

  // Microsoft Graph: /me/messages/delta is unsupported, and folder-scoped
  // delta only catches Inbox + SentItems — missing 70-90% of an organized
  // user's mail (Archive, sub-folders, etc). So we use the non-delta
  // /me/messages endpoint which spans ALL folders.
  //
  // Bidirectional cursor — lifetime scan, no 24-month wall:
  //   newest_seen     : ISO of newest message ever indexed (for incremental)
  //   backfill_oldest : ISO of oldest message indexed so far (walks backward)
  //   backfill_done   : true once we've reached the bottom of the mailbox
  //
  // Each invocation does ONE chunk (up to 20 pages = 2000 messages) and
  // returns has_more so the client loops until done. Backfill walks
  // newest→oldest; once exhausted, future runs are incremental only.
  //
  // Legacy { since } cursor is migrated to { newest_seen, backfill_done:false }
  // so existing users automatically backfill their full history on next sync.
  interface Cursor {
    newest_seen?: string;
    backfill_oldest?: string;
    backfill_done?: boolean;
    total_count?: number;        // mailbox size (refreshed periodically) — for progress %
    scanned_total?: number;      // cumulative messages walked across all chunks
    since?: string;              // legacy
  }
  let cursors: Cursor = {};
  if (settings.microsoft_messages_delta_link) {
    try { cursors = JSON.parse(settings.microsoft_messages_delta_link); }
    catch { cursors = {}; }
  }
  if (cursors.since && !cursors.newest_seen) {
    cursors = { newest_seen: cursors.since, backfill_done: false };
  }

  // Mailbox total count — one cheap call gives us a denominator for the
  // honest progress percentage. /me/messages/$count returns plain text so
  // we hit it directly instead of via graphFetch (which parses JSON only).
  // Cached in the cursor; refreshed every ~10K messages so the % stays
  // honest as new mail arrives.
  if (typeof cursors.total_count !== 'number' || ((cursors.scanned_total || 0) > 0 && (cursors.scanned_total || 0) % 10000 < 2000)) {
    try {
      const r = await fetch('https://graph.microsoft.com/v1.0/me/messages/$count', {
        headers: {
          Authorization: `Bearer ${settings.microsoft_access_token}`,
          ConsistencyLevel: 'eventual',
        },
      });
      if (r.ok) {
        const txt = (await r.text()).trim();
        const n = parseInt(txt, 10);
        if (Number.isFinite(n)) cursors.total_count = n;
      }
    } catch (e: any) {
      console.warn('[sync-email-stats] $count fetch failed:', e?.message);
    }
  }

  type Mode = 'initial' | 'backfill' | 'incremental';
  let mode: Mode;
  let filterClause = '';
  if (!cursors.newest_seen) {
    mode = 'initial';
  } else if (!cursors.backfill_done) {
    mode = 'backfill';
    const upper = cursors.backfill_oldest || cursors.newest_seen;
    filterClause = `&$filter=${encodeURIComponent(`receivedDateTime lt ${upper}`)}`;
  } else {
    mode = 'incremental';
    filterClause = `&$filter=${encodeURIComponent(`receivedDateTime gt ${cursors.newest_seen}`)}`;
  }

  const allFoldersPath =
    `/me/messages` +
    `?$top=100` +
    `&$select=id,conversationId,subject,sentDateTime,receivedDateTime,from,toRecipients,ccRecipients` +
    `&$orderby=receivedDateTime desc` +
    filterClause;

  const res = await graphFetchAllPages(
    allFoldersPath,
    user.id,
    supabase,
    settings.microsoft_access_token,
    settings.microsoft_refresh_token,
    20,
  );

  // Track both ends of this batch — newest updates incremental cursor,
  // oldest extends the backfill window further back.
  let newestSeen: string | null = cursors.newest_seen || null;
  let oldestSeen: string | null = null;
  for (const m of (res.items as GraphMessage[]) || []) {
    const ts = m.receivedDateTime || m.sentDateTime;
    if (!ts) continue;
    if (!newestSeen || ts > newestSeen) newestSeen = ts;
    if (!oldestSeen || ts < oldestSeen) oldestSeen = ts;
  }

  const fetchedCount = res.items?.length || 0;
  const newCursors: Cursor = {
    newest_seen: newestSeen || cursors.newest_seen,
    backfill_oldest: cursors.backfill_oldest,
    backfill_done: cursors.backfill_done,
    total_count: cursors.total_count,
    scanned_total: (cursors.scanned_total || 0) + fetchedCount,
  };
  if (mode === 'initial' || mode === 'backfill') {
    if (oldestSeen) newCursors.backfill_oldest = oldestSeen;
    // Exhausted when the page returns nothing OR Graph signals end-of-list
    // (no nextLink AND less than a full first page).
    if (fetchedCount === 0 || (!res.nextLink && fetchedCount < 100)) {
      newCursors.backfill_done = true;
    }
  }
  console.log(`[sync-email-stats] mode=${mode} fetched=${fetchedCount} user=${user.id} nextLink=${!!res.nextLink} backfill_done=${newCursors.backfill_done} oldest=${newCursors.backfill_oldest} newest=${newCursors.newest_seen}`);

  if (res.error) {
    console.error(`[sync-email-stats] graph error for user ${user.id}: ${res.error}`);
    return NextResponse.json({ error: res.error }, { status: 500 });
  }

  // Aggregate per contact
  const buckets = new Map<string, StatBucket>();
  const getBucket = (cid: string): StatBucket => {
    let b = buckets.get(cid);
    if (!b) {
      b = {
        emails_sent: 0, emails_received: 0,
        last_inbound_at: null, last_outbound_at: null,
        last_inbound_cc_names: [], last_outbound_cc_names: [],
        last_inbound_subject: null, last_outbound_subject: null,
        first_seen_at: null, thread_ids: new Set<string>(),
      };
      buckets.set(cid, b);
    }
    return b;
  };

  // Pull the participant names from a message (excluding self + the focused contact's
  // email + the from address) so the timeline can say "Jane emailed you (cc'd Bob, Alice)"
  const ccNamesFor = (msg: GraphMessage, focusEmail: string | undefined): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    const all: GraphAddress[] = [
      ...(msg.toRecipients || []),
      ...(msg.ccRecipients || []),
    ];
    for (const r of all) {
      const addr = r.emailAddress?.address?.toLowerCase();
      if (!addr) continue;
      if (selfEmails.has(addr)) continue;
      if (focusEmail && addr === focusEmail) continue;
      if (seen.has(addr)) continue;
      seen.add(addr);
      const nm = r.emailAddress?.name?.trim();
      out.push(nm && nm !== addr ? nm : addr);
      if (out.length >= 6) break;
    }
    return out;
  };

  let scanned = 0;
  let matched = 0;

  // ── CC/BCC topology: track pair co-occurrences across distinct conversations ──
  // For every message, the SET of non-self contacts on it (sender + all recipients
  // that resolve to known contacts) is a clique — they all share context. Each
  // pair that appears together gets +1 per distinct conversationId. Pairs with
  // count ≥ 2 (i.e. they've co-occurred in at least 2 different threads) become
  // inferred 2nd-degree edges. This is the data we already have but weren't mining.
  const pairThreads = new Map<string, Set<string>>(); // 'cidA|cidB' (sorted) → Set<conversationId>
  const introPairs = new Set<string>();                // pair keys we saw in an INTRO subject (single-thread = enough)
  const pairMinClique = new Map<string, number>();     // pair key → smallest thread-clique size it appeared in
  const pairKey = (a: string, b: string) => a < b ? `${a}|${b}` : `${b}|${a}`;
  const addPair = (a: string, b: string, threadKey: string | null, isIntro: boolean, cliqueSize: number) => {
    if (a === b || !threadKey) return;
    const k = pairKey(a, b);
    let set = pairThreads.get(k);
    if (!set) { set = new Set(); pairThreads.set(k, set); }
    set.add(threadKey);
    if (isIntro) introPairs.add(k);    // intros bypass the ≥2-thread threshold downstream
    const cur = pairMinClique.get(k);
    if (cur === undefined || cliqueSize < cur) pairMinClique.set(k, cliqueSize);
  };

  // ── Pre-pass: create Discovered contacts for unknown email participants ──
  // Without this, CC mining silently drops anyone not already in the contacts
  // table, which kills intro detection — the highest-value 2nd-degree signal
  // we have. The auto_promote_on_edge trigger will promote these the moment a
  // real edge materializes (if they pass the noise filter).
  const unknownEmails = new Map<string, string>(); // addr → best display name we saw
  for (const msg of res.items as GraphMessage[]) {
    const all: GraphAddress[] = [
      ...(msg.from ? [msg.from] : []),
      ...(msg.toRecipients || []),
      ...(msg.ccRecipients || []),
    ];
    for (const a of all) {
      const addr = a.emailAddress?.address?.toLowerCase();
      const nm = a.emailAddress?.name?.trim();
      if (!addr || selfEmails.has(addr) || emailToContact.has(addr) || deletedEmails.has(addr) || isNoiseEmail(addr, nm)) continue;
      // Conservative self-detection: skip auto-creating Discovered contacts
      // when the from-header display name exactly matches the user's
      // provider-reported "gov name" AND the local-part shares a token /
      // initials with that name. Catches "From: Jane Doe <unknown-third-
      // address>" without false-positives on coincidental name collisions.
      if (providerDisplayName && namesMatchExact(nm, providerDisplayName) && localPartMatchesName(addr, providerDisplayName)) continue;
      const cur = unknownEmails.get(addr);
      if (!cur || cur === addr) unknownEmails.set(addr, nm || addr);
    }
  }
  if (unknownEmails.size > 0) {
    const newRows = Array.from(unknownEmails.entries()).map(([addr, name]) => ({
      user_id: user.id,
      email: addr,
      name: name || addr,
      is_promoted: true,   // auto-promoted: noise filter already ran, no review tray
      is_direct: false,
      is_self: false,
      tags: [],
      color: '#7c5cff',
      notes: '',
    }));
    const insertedAll: { id: string; email: string | null; name: string }[] = [];
    for (let i = 0; i < newRows.length; i += 100) {
      const batch = newRows.slice(i, i + 100);
      // Upsert against the (user_id, email) unique index. Without this,
      // a concurrent sync-graph run inserting the same email between our
      // dedup-set load and this insert would 23505 the whole batch.
      const { data: inserted, error } = await supabase
        .from('contacts')
        .upsert(batch, { onConflict: 'user_id,email', ignoreDuplicates: true })
        .select('id, email, name');
      if (error) {
        console.error('Discovered-contact insert failed:', error);
        continue;
      }
      for (const row of (inserted || []) as { id: string; email: string | null; name: string }[]) {
        if (row.email) emailToContact.set(row.email.toLowerCase(), row.id);
        insertedAll.push(row);
      }
    }

    // ── Rule-first + LLM-tiebreaker classifier for newly discovered contacts ──
    // Steps 1-2 (newsletter domain, role inbox) catch ~30-40% of noise cheaply.
    // Steps 3-5 (direct evidence, name pattern, warm intro) keep real people.
    // Step 6 (LLM) is used only on the residual that no rule decided.
    // Mid-sync we don't have full behavioral data yet for these new contacts —
    // their email_stats rows get written further down. So Steps 3 and 5 fire
    // sparsely here; the next sync pass re-evaluates with full data.
    if (insertedAll.length > 0) {
      try {
        const inputs = insertedAll.map((r) => ({
          id: r.id, name: r.name, email: r.email,
          emails_sent: 0, emails_received: 0,
          co_attended_count: 0, cc_edges_count: 0,
        }));
        const verdicts = await tierContacts(inputs, new Set(), new Map());
        const toDelete: string[] = [];
        for (const v of verdicts.values()) if (v.tier === 'drop') toDelete.push(v.id);
        if (toDelete.length > 0) {
          for (let i = 0; i < toDelete.length; i += 100) {
            const batch = toDelete.slice(i, i + 100);
            await supabase.from('contacts').delete().in('id', batch).eq('user_id', user.id);
            for (const ic of insertedAll) if (batch.includes(ic.id) && ic.email) emailToContact.delete(ic.email.toLowerCase());
          }
          console.log(`[sync-email-stats] tiered+deleted ${toDelete.length}/${insertedAll.length} non-person contacts`);
        }
      } catch (e: any) {
        console.error('[sync-email-stats] tiering failed (continuing):', e?.message);
      }
    }
  }

  for (const msg of res.items as GraphMessage[]) {
    scanned++;
    const fromAddr = msg.from?.emailAddress?.address?.toLowerCase();
    const ts = msg.sentDateTime || msg.receivedDateTime || null;
    if (!fromAddr || !ts) continue;

    const isOutbound = selfEmails.has(fromAddr);

    // Resolve every recipient (and the from) to a contact_id (if known)
    const recipientCids: string[] = [];
    for (const r of [...(msg.toRecipients || []), ...(msg.ccRecipients || [])]) {
      const addr = r.emailAddress?.address?.toLowerCase();
      if (!addr || selfEmails.has(addr)) continue;
      const cid = emailToContact.get(addr);
      if (cid) recipientCids.push(cid);
    }
    const fromCid = isOutbound ? null : emailToContact.get(fromAddr) || null;

    // ── Per-contact email_stats aggregation ──
    if (isOutbound) {
      for (const cid of recipientCids) {
        const b = getBucket(cid);
        b.emails_sent++;
        if (!b.last_outbound_at || new Date(ts) > new Date(b.last_outbound_at)) {
          b.last_outbound_at = ts;
          // Find this contact's email so we can exclude them from "cc'd alongside" list
          let focusEmail: string | undefined;
          for (const [addr, c] of emailToContact) { if (c === cid) { focusEmail = addr; break; } }
          b.last_outbound_cc_names = ccNamesFor(msg, focusEmail);
          b.last_outbound_subject = msg.subject || null;
        }
        bumpFirstSeen(b, ts);
        if (msg.conversationId) b.thread_ids.add(msg.conversationId);
        matched++;
      }
    } else if (fromCid) {
      const b = getBucket(fromCid);
      b.emails_received++;
      if (!b.last_inbound_at || new Date(ts) > new Date(b.last_inbound_at)) {
        b.last_inbound_at = ts;
        // Inbound: cc-list = everyone on the message except self + sender
        b.last_inbound_cc_names = ccNamesFor(msg, fromAddr);
        b.last_inbound_subject = msg.subject || null;
      }
      bumpFirstSeen(b, ts);
      if (msg.conversationId) b.thread_ids.add(msg.conversationId);
      matched++;
    }

    // ── Co-occurrence: every pair of (non-self) contacts on this message ──
    // Includes (sender ↔ each recipient) and (recipient ↔ each other recipient).
    const allCids = fromCid ? [fromCid, ...recipientCids] : recipientCids;
    const uniq = Array.from(new Set(allCids));
    const threadKey = msg.conversationId || msg.id || null;
    const isIntro = isIntroSubject(msg.subject);
    const cliqueSize = uniq.length;
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        addPair(uniq[i], uniq[j], threadKey, isIntro, cliqueSize);
      }
    }
  }

  // Upsert per contact
  const upserts = Array.from(buckets.entries()).map(([cid, b]) => ({
    contact_id: cid,
    user_id: user.id,
    emails_sent: b.emails_sent,
    emails_received: b.emails_received,
    last_inbound_at: b.last_inbound_at,
    last_outbound_at: b.last_outbound_at,
    last_inbound_cc_names: b.last_inbound_cc_names,
    last_outbound_cc_names: b.last_outbound_cc_names,
    last_inbound_subject: b.last_inbound_subject,
    last_outbound_subject: b.last_outbound_subject,
    first_seen_at: b.first_seen_at,
    thread_count: b.thread_ids.size,
    last_synced_at: new Date().toISOString(),
  }));

  // ── Auto-promote ALL email-discovered contacts ──
  // Anything that survived the noise filter (isNoiseEmail blocks noreply,
  // donotreply, newsletters, etc) is a real person — show it immediately.
  // The "review tray" was friction; new users need instant value out of the
  // box. They can always delete clutter later, but we don't make them gate
  // every single contact.
  const allBucketIds = Array.from(buckets.keys());
  if (allBucketIds.length > 0) {
    for (let i = 0; i < allBucketIds.length; i += 200) {
      const batch = allBucketIds.slice(i, i + 200);
      await supabase
        .from('contacts')
        .update({ is_promoted: true })
        .in('id', batch)
        .eq('user_id', user.id)
        .eq('is_promoted', false);
    }
  }

  // ── Self → contact direct edges ──
  // The graph was rendering every email-discovered contact as a disconnected
  // dot floating in the outer ring (no edges to anyone). For any contact you've
  // exchanged email with, write a direct edge from self → contact (source =
  // 'direct_email'). Now the graph shows YOU at the center with every email
  // contact radiating outward — labels stay visible, no more lonely outer ring.
  if (selfContactId && allBucketIds.length > 0) {
    const directEdges = allBucketIds.flatMap((cid) => [
      { user_id: user.id, from_contact_id: selfContactId!, to_contact_id: cid, source: 'direct_email' },
      { user_id: user.id, from_contact_id: cid, to_contact_id: selfContactId!, source: 'direct_email' },
    ]);
    for (let i = 0; i < directEdges.length; i += 500) {
      const batch = directEdges.slice(i, i + 500);
      const { error } = await supabase
        .from('connections')
        .upsert(batch, { onConflict: 'from_contact_id,to_contact_id', ignoreDuplicates: true });
      if (error) console.error('direct_email edges upsert failed:', error);
    }
  }

  // Chunk upserts to keep payload small
  let upserted = 0;
  for (let i = 0; i < upserts.length; i += 200) {
    const batch = upserts.slice(i, i + 200);
    const { error } = await supabase
      .from('email_stats')
      .upsert(batch, { onConflict: 'contact_id' });
    if (error) {
      console.error('email_stats upsert failed:', error);
    } else {
      upserted += batch.length;
    }
  }

  // ── Insert cc_co_occurred edges ──
  // Promote a pair when ANY of:
  //   (a) they co-occurred in ≥ 2 distinct threads (recurring contact = relationship), OR
  //   (b) they appeared together in an INTRO subject (single thread is enough —
  //       intros only happen once and they're the highest-value signal we have), OR
  //   (c) they appeared on a SMALL-CLIQUE thread (≤ 4 unique contacts). Small
  //       cliques are almost always intros / direct intros / project threads,
  //       even when the subject doesn't literally say "intro". This was the
  //       Liz-Mallen gap — she CC'd a new person in a 3-person thread with a
  //       generic subject; the old ≥2-threshold dropped it on the floor.
  //
  //   Mass CCs (newsletters, all-hands) have clique > 4 AND won't recur in
  //   distinct threads, so they still get filtered out.
  const SMALL_CLIQUE_MAX = 4;
  const ccEdges: { user_id: string; from_contact_id: string; to_contact_id: string; source: 'cc_co_occurred' }[] = [];
  for (const [k, threadSet] of pairThreads) {
    const minClique = pairMinClique.get(k) ?? Infinity;
    const passesThreshold =
      threadSet.size >= 2 ||
      introPairs.has(k) ||
      minClique <= SMALL_CLIQUE_MAX;
    if (!passesThreshold) continue;
    const [a, b] = k.split('|');
    ccEdges.push({ user_id: user.id, from_contact_id: a, to_contact_id: b, source: 'cc_co_occurred' });
    ccEdges.push({ user_id: user.id, from_contact_id: b, to_contact_id: a, source: 'cc_co_occurred' });
  }

  // Only insert pairs that aren't already known (manual / co_attended / suggestion).
  // Use ON CONFLICT DO NOTHING via the unique (from,to) constraint.
  let ccInserted = 0;
  if (ccEdges.length > 0) {
    for (let i = 0; i < ccEdges.length; i += 500) {
      const batch = ccEdges.slice(i, i + 500);
      const { error, count } = await supabase
        .from('connections')
        .upsert(batch, { onConflict: 'from_contact_id,to_contact_id', ignoreDuplicates: true, count: 'exact' });
      if (error) console.error('cc edges upsert failed:', error);
      else ccInserted += count || 0;
    }
  }

  // ── CC BACKFILL PASS ──
  // The per-message miner above can only pair contacts that both resolved
  // during the SAME sync batch. If contact B got created in an earlier sync
  // (e.g. via the unknown-emails pre-pass) but never appeared in a NEW
  // message after that, the A↔B pair is never re-evaluated and the edge
  // stays missing forever — even though A's email_stats row has B's name
  // sitting right there in last_inbound_cc_names.
  //
  // This pass closes the gap: walk every email_stats row for this user,
  // resolve each stored CC name against the contacts table (by email or by
  // display name), and create any missing cc_co_occurred edge. Cheap: one
  // SELECT + an in-memory loop + one batched UPSERT.
  const { data: allStats } = await supabase
    .from('email_stats')
    .select('contact_id, last_inbound_cc_names, last_outbound_cc_names')
    .eq('user_id', user.id);

  const backfillEdges: { user_id: string; from_contact_id: string; to_contact_id: string; source: 'cc_co_occurred' }[] = [];
  const seenPair = new Set<string>(); // dedupe pairs across rows in this pass
  for (const row of (allStats ?? []) as { contact_id: string; last_inbound_cc_names: string[] | null; last_outbound_cc_names: string[] | null }[]) {
    const ccNames = [...(row.last_inbound_cc_names || []), ...(row.last_outbound_cc_names || [])];
    if (ccNames.length === 0) continue;
    for (const raw of ccNames) {
      const norm = (raw || '').trim().toLowerCase();
      if (!norm) continue;
      let otherId: string | undefined;
      if (norm.includes('@')) otherId = emailToContact.get(norm);
      else otherId = nameToContact.get(norm);
      if (!otherId || otherId === row.contact_id) continue;
      const key = row.contact_id < otherId ? `${row.contact_id}|${otherId}` : `${otherId}|${row.contact_id}`;
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      backfillEdges.push(
        { user_id: user.id, from_contact_id: row.contact_id, to_contact_id: otherId, source: 'cc_co_occurred' },
        { user_id: user.id, from_contact_id: otherId, to_contact_id: row.contact_id, source: 'cc_co_occurred' },
      );
    }
  }

  let ccBackfillInserted = 0;
  if (backfillEdges.length > 0) {
    for (let i = 0; i < backfillEdges.length; i += 500) {
      const batch = backfillEdges.slice(i, i + 500);
      const { error, count } = await supabase
        .from('connections')
        .upsert(batch, { onConflict: 'from_contact_id,to_contact_id', ignoreDuplicates: true, count: 'exact' });
      if (error) console.error('cc backfill upsert failed:', error);
      else ccBackfillInserted += count || 0;
    }
  }

  // Persist the bidirectional cursor for the next chunk.
  if (newCursors.newest_seen || newCursors.backfill_oldest) {
    await supabase
      .from('user_settings')
      .update({ microsoft_messages_delta_link: JSON.stringify(newCursors), updated_at: new Date().toISOString() })
      .eq('user_id', user.id);
  }

  // Months of mail history indexed so far (for honest progress UX).
  let monthsCovered = 0;
  if (newCursors.backfill_oldest && newCursors.newest_seen) {
    const old = new Date(newCursors.backfill_oldest).getTime();
    const newt = new Date(newCursors.newest_seen).getTime();
    monthsCovered = Math.max(0, Math.round((newt - old) / (30 * 24 * 60 * 60 * 1000)));
  }
  // Percentage progress through the mailbox — only valid once we have
  // both a denominator and at least one indexed message.
  let progressPct: number | null = null;
  if (newCursors.total_count && (newCursors.scanned_total || 0) > 0) {
    const pct = Math.round((newCursors.scanned_total! / newCursors.total_count) * 100);
    progressPct = Math.min(100, Math.max(0, pct));
    if (newCursors.backfill_done) progressPct = 100;
  } else if (newCursors.backfill_done) {
    progressPct = 100;
  }

  return NextResponse.json({
    scanned,
    matched,
    contacts_with_stats: buckets.size,
    upserted,
    cc_pairs_inferred: pairThreads.size,
    cc_pairs_promoted: ccEdges.length / 2,
    cc_edges_inserted: ccInserted,
    cc_backfill_inserted: ccBackfillInserted,
    mode,
    has_more: !newCursors.backfill_done,
    backfill_done: !!newCursors.backfill_done,
    months_covered: monthsCovered,
    progress_pct: progressPct,
    total_mailbox: newCursors.total_count || null,
    scanned_total: newCursors.scanned_total || 0,
    oldest_indexed_at: newCursors.backfill_oldest || null,
    newest_indexed_at: newCursors.newest_seen || null,
  });
  } catch (e: any) {
    console.error('sync-email-stats failed:', e);
    return NextResponse.json({ error: e?.message || String(e), stack: e?.stack?.split('\n').slice(0, 5).join(' | ') }, { status: 500 });
  }
}
