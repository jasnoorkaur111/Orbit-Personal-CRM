// Mines calendar event attendees into co_attended edges. Mirrors the CC topology
// mining in sync-email-stats: every event with ≥2 known attendees is a clique;
// each pair that co-occurs in ≥2 distinct events (or 1 intro-titled event)
// becomes an edge. Unknown attendees are bootstrapped as Discovered contacts so
// they aren't silently dropped. Uses the events table that sync-graph and
// sync-calendar already populate — no extra OAuth scope needed.

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isNoiseEmail } from '@/lib/noiseEmails';

export const maxDuration = 60;

function isIntroTitle(title: string | undefined | null): boolean {
  if (!title) return false;
  const s = title.toLowerCase();
  return (
    /\bintro(duction)?\b/.test(s) ||
    /\bconnect(ing)?\b/.test(s) ||
    /\b(meet|meeting) [a-z]+\b/.test(s) ||
    /\s[x×]\s/.test(s) ||
    /\bhandoff\b/.test(s) ||
    /\bwarm intro\b/.test(s)
  );
}

interface Attendee { name?: string; email?: string }
interface EventRow {
  id: string;
  title: string | null;
  attendees: Attendee[] | null;
  organizer_email: string | null;
}

export async function POST(request: NextRequest) {
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

  // Load contacts → email map + self aliases
  const { data: contactRows } = await supabase
    .from('contacts')
    .select('id, email, email_aliases, is_self')
    .eq('user_id', user.id);

  const emailToContact = new Map<string, string>();
  const selfEmails = new Set<string>();
  let selfContactId: string | null = null;
  for (const c of (contactRows as { id: string; email: string | null; email_aliases: string[] | null; is_self: boolean | null }[]) || []) {
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
  }

  // Pull last 12 months of events
  const since = new Date();
  since.setMonth(since.getMonth() - 12);
  const sinceDate = since.toISOString().slice(0, 10);

  const { data: events } = await supabase
    .from('events')
    .select('id, title, attendees, organizer_email')
    .eq('user_id', user.id)
    .gte('date', sinceDate);

  const evList = (events as EventRow[] | null) || [];

  // ── Pre-pass: bootstrap Discovered contacts for unknown attendees ──
  const unknownEmails = new Map<string, string>();
  for (const ev of evList) {
    for (const a of ev.attendees || []) {
      const addr = a.email?.toLowerCase();
      if (!addr || selfEmails.has(addr) || emailToContact.has(addr) || isNoiseEmail(addr, a.name)) continue;
      const cur = unknownEmails.get(addr);
      const nm = a.name?.trim();
      if (!cur || cur === addr) unknownEmails.set(addr, nm || addr);
    }
    const orgAddr = ev.organizer_email?.toLowerCase();
    if (orgAddr && !selfEmails.has(orgAddr) && !emailToContact.has(orgAddr) && !unknownEmails.has(orgAddr) && !isNoiseEmail(orgAddr)) {
      unknownEmails.set(orgAddr, orgAddr);
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
    for (let i = 0; i < newRows.length; i += 100) {
      const batch = newRows.slice(i, i + 100);
      const { data: inserted, error } = await supabase
        .from('contacts')
        .insert(batch)
        .select('id, email');
      if (error) {
        console.error('Discovered-attendee insert failed:', error);
        continue;
      }
      for (const row of (inserted || []) as { id: string; email: string | null }[]) {
        if (row.email) emailToContact.set(row.email.toLowerCase(), row.id);
      }
    }
  }

  // ── Build pair counts: each event with ≥2 known attendees is a clique ──
  // Skip very large meetings (>15 attendees) — those are conferences / town halls,
  // not relationship signal.
  const pairEvents = new Map<string, Set<string>>(); // 'a|b' → set of event ids
  const introPairs = new Set<string>();
  const pairKey = (a: string, b: string) => a < b ? `${a}|${b}` : `${b}|${a}`;
  // Track contacts you've personally met (you were on the same calendar event)
  // so we can write self → contact direct edges. Without these the graph
  // shows attendees as floating dots disconnected from "You".
  const directAttendeeIds = new Set<string>();

  for (const ev of evList) {
    const cids = new Set<string>();
    for (const a of ev.attendees || []) {
      const addr = a.email?.toLowerCase();
      if (!addr || selfEmails.has(addr)) continue;
      const cid = emailToContact.get(addr);
      if (cid) cids.add(cid);
    }
    const orgAddr = ev.organizer_email?.toLowerCase();
    if (orgAddr && !selfEmails.has(orgAddr)) {
      const cid = emailToContact.get(orgAddr);
      if (cid) cids.add(cid);
    }
    // Every contact you co-attended with is a direct connection to you,
    // regardless of meeting size (yes, even town halls — you were there)
    for (const cid of cids) directAttendeeIds.add(cid);
    if (cids.size < 2 || cids.size > 15) continue;

    const isIntro = isIntroTitle(ev.title);
    const arr = Array.from(cids);
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const k = pairKey(arr[i], arr[j]);
        let s = pairEvents.get(k);
        if (!s) { s = new Set(); pairEvents.set(k, s); }
        s.add(ev.id);
        if (isIntro) introPairs.add(k);
      }
    }
  }

  // ── Materialize co_attended edges ──
  // Promote when: ≥2 distinct events together OR intro-titled (single event enough).
  const newEdges: { user_id: string; from_contact_id: string; to_contact_id: string; source: 'co_attended' }[] = [];
  for (const [k, evSet] of pairEvents) {
    if (evSet.size < 2 && !introPairs.has(k)) continue;
    const [a, b] = k.split('|');
    newEdges.push({ user_id: user.id, from_contact_id: a, to_contact_id: b, source: 'co_attended' });
    newEdges.push({ user_id: user.id, from_contact_id: b, to_contact_id: a, source: 'co_attended' });
  }

  // Skip edges that already exist (any source)
  const { data: existingEdges } = await supabase
    .from('connections')
    .select('from_contact_id, to_contact_id')
    .eq('user_id', user.id);
  const existingSet = new Set((existingEdges || []).map((e) => `${e.from_contact_id}|${e.to_contact_id}`));
  const toInsert = newEdges.filter((e) => !existingSet.has(`${e.from_contact_id}|${e.to_contact_id}`));

  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += 200) {
    const batch = toInsert.slice(i, i + 200);
    const { error } = await supabase.from('connections').insert(batch);
    if (error) {
      console.error('co_attended edge insert failed:', error);
    } else {
      inserted += batch.length;
    }
  }

  // ── Self → attendee direct edges ──
  // Anyone you've shared a calendar event with is a direct connection. Pull
  // them into the graph as a spoke off "You" so they don't float as isolated
  // dots. Upsert with ignoreDuplicates so re-runs are cheap and don't shadow
  // existing manual edges.
  if (selfContactId && directAttendeeIds.size > 0) {
    const directEdges = Array.from(directAttendeeIds).flatMap((cid) => [
      { user_id: user.id, from_contact_id: selfContactId!, to_contact_id: cid, source: 'direct_meeting' },
      { user_id: user.id, from_contact_id: cid, to_contact_id: selfContactId!, source: 'direct_meeting' },
    ]);
    for (let i = 0; i < directEdges.length; i += 500) {
      const batch = directEdges.slice(i, i + 500);
      const { error } = await supabase
        .from('connections')
        .upsert(batch, { onConflict: 'from_contact_id,to_contact_id', ignoreDuplicates: true });
      if (error) console.error('direct_meeting edge upsert failed:', error);
    }
  }

  return NextResponse.json({
    events_scanned: evList.length,
    discovered_contacts_created: unknownEmails.size,
    pairs_found: pairEvents.size,
    edges_inserted: inserted,
  });
}
