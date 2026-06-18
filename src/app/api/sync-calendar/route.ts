import { NextRequest, NextResponse } from 'next/server';
import ICAL from 'ical.js';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 60;

interface CalendarFeed {
  url: string;
  source: string;
}

function parseIcalEvents(icalData: string, source: string, timezone: string = 'America/Detroit') {
  const jcalData = ICAL.parse(icalData);
  const comp = new ICAL.Component(jcalData);
  const vevents = comp.getAllSubcomponents('vevent');

  // Events for DB storage: 6 months back, 6 months ahead
  const storageStart = new Date();
  storageStart.setMonth(storageStart.getMonth() - 6);
  const sixMonthsAhead = new Date();
  sixMonthsAhead.setMonth(sixMonthsAhead.getMonth() + 6);
  // Full history for contact name scanning: 2 years back
  const historyStart = new Date();
  historyStart.setFullYear(historyStart.getFullYear() - 2);

  const events: {
    title: string;
    date: string;
    time: string | null;
    end_time?: string | null;
    description: string | null;
    source: string;
    external_id: string;
    organizer_email?: string | null;
    attendees?: { name: string; email: string }[];
    forStorage?: boolean;
  }[] = [];

  // Helper to extract attendees once per master event
  const extractAttendees = (vevent: any) => {
    const attendeeProps = vevent.getAllProperties('attendee');
    const attendees: { name: string; email: string }[] = [];
    for (const att of attendeeProps) {
      const email = String(att.getFirstValue() || '').replace('mailto:', '').toLowerCase();
      const name = String(att.getParameter('cn') || '');
      if (email && !email.includes('calendar.google') && !email.includes('resource.calendar')) {
        attendees.push({ name: name || email.split('@')[0], email });
      }
    }
    return attendees;
  };

  // Helper to format an ICAL.Time instance into (dateStr, timeStr|null)
  const formatTime = (icalTime: any) => {
    const isAllDay = icalTime.isDate;
    if (isAllDay) {
      return {
        dateStr: `${icalTime.year}-${String(icalTime.month).padStart(2, '0')}-${String(icalTime.day).padStart(2, '0')}`,
        timeStr: null as string | null,
      };
    }
    const jsDate = icalTime.toJSDate();
    return {
      dateStr: jsDate.toLocaleDateString('en-CA', { timeZone: timezone }),
      timeStr: jsDate.toLocaleTimeString('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }),
    };
  };

  for (const vevent of vevents) {
    try {
      const event = new ICAL.Event(vevent);
      if (!event.startDate) continue;

      const title = event.summary || 'Untitled';
      // Skip cancelled events — they're noise that Outlook keeps in feed
      if (/^cancell?ed event:/i.test(title.trim())) continue;

      const attendees = extractAttendees(vevent);

      // ORGANIZER — even Outlook keeps this when ATTENDEE is stripped
      let organizerEmail: string | null = null;
      try {
        const orgProp = vevent.getFirstProperty('organizer');
        if (orgProp) {
          organizerEmail = String(orgProp.getFirstValue() || '').replace(/^mailto:/i, '').toLowerCase() || null;
          if (!organizerEmail) organizerEmail = null;
        }
      } catch {}

      const baseData = {
        title,
        description: event.description || null,
        source,
        attendees: attendees.length > 0 ? attendees : undefined,
        organizer_email: organizerEmail,
      };

      // END time (only for non-all-day timed events)
      const endTimeFor = (icalTime: any): string | null => {
        if (!icalTime || icalTime.isDate) return null;
        const jsDate = icalTime.toJSDate();
        return jsDate.toLocaleTimeString('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false });
      };

      if (event.isRecurring()) {
        // Expand recurring events. Each instance gets its own external_id: ${uid}_${YYYY-MM-DD}
        const iterator = event.iterator();
        let next;
        let safetyCount = 0;
        while ((next = iterator.next()) && safetyCount < 500) {
          safetyCount++;
          const jsNext = next.toJSDate();
          if (jsNext > sixMonthsAhead) break;
          if (jsNext < historyStart) continue;

          const { dateStr, timeStr } = formatTime(next);
          const checkDate = new Date(dateStr + 'T12:00:00');
          if (checkDate < historyStart || checkDate > sixMonthsAhead) continue;

          events.push({
            ...baseData,
            date: dateStr,
            time: timeStr,
            end_time: endTimeFor(event.endDate),
            external_id: `${event.uid}_${dateStr}`,
            forStorage: checkDate >= storageStart,
          });
        }
      } else {
        const { dateStr, timeStr } = formatTime(event.startDate);
        const checkDate = new Date(dateStr + 'T12:00:00');
        if (checkDate < historyStart || checkDate > sixMonthsAhead) continue;
        events.push({
          ...baseData,
          date: dateStr,
          time: timeStr,
          end_time: endTimeFor(event.endDate),
          external_id: event.uid,
          forStorage: checkDate >= storageStart,
        });
      }
    } catch {
      continue;
    }
  }

  return events;
}

export async function GET(request: NextRequest) {
  // Authenticate the user from the Authorization header
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const token = authHeader.replace('Bearer ', '');

  // Create a Supabase client with the user's token
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${token}` } } }
  );

  // Verify the user
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Get the user's calendar settings
  const { data: settings } = await supabase
    .from('user_settings')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  // iCal is now a FALLBACK — only pull a provider's iCal if the corresponding OAuth API isn't connected.
  // This prevents duplicate ingestion when both API + iCal are present.
  const hasGoogleOAuth = !!(settings?.google_access_token);
  const hasMicrosoftOAuth = !!(settings?.microsoft_access_token);

  const feeds: CalendarFeed[] = [];

  if (!hasGoogleOAuth) {
    if (settings?.google_calendar_url) {
      feeds.push({ url: settings.google_calendar_url, source: 'google_calendar' });
    } else if (process.env.GOOGLE_CALENDAR_ICAL_URL) {
      feeds.push({ url: process.env.GOOGLE_CALENDAR_ICAL_URL, source: 'google_calendar' });
    }
  }
  if (!hasMicrosoftOAuth) {
    if (settings?.outlook_calendar_url) {
      feeds.push({ url: settings.outlook_calendar_url, source: 'outlook_calendar' });
    } else if (process.env.OUTLOOK_CALENDAR_ICAL_URL) {
      feeds.push({ url: process.env.OUTLOOK_CALENDAR_ICAL_URL, source: 'outlook_calendar' });
    }
  }

  if (feeds.length === 0) {
    // Not an error — both providers covered by OAuth APIs (the preferred path)
    return NextResponse.json({ synced: [], note: 'iCal sync skipped — both providers covered by OAuth API sync.' });
  }

  try {
    const results: { source: string; count: number; contactsDiscovered?: number }[] = [];

    for (const feed of feeds) {
      const response = await fetch(feed.url);
      const icalData = await response.text();
      const url = new URL(request.url);
      // Settings (manual override) wins over device-detected (query param)
      const tz = settings?.timezone || url.searchParams.get('tz') || 'America/Detroit';
      const events = parseIcalEvents(icalData, feed.source, tz);

      // Only store recent events (6 months back, 6 months forward)
      const storageEvents = events.filter(e => e.forStorage);

      // ── DIFF-BASED SYNC: only insert events with new external_ids ──
      // Fetch existing external_ids for this user+source
      const { data: existingEvents } = await supabase
        .from('events')
        .select('external_id')
        .eq('source', feed.source)
        .eq('user_id', user.id);

      const existingExternalIds = new Set((existingEvents || []).map(e => e.external_id).filter(Boolean));

      // Only insert NEW events. User edits and deletions are preserved.
      const newEvents = storageEvents.filter(e => e.external_id && !existingExternalIds.has(e.external_id));

      let inserted = 0;
      for (let i = 0; i < newEvents.length; i += 100) {
        const batch = newEvents.slice(i, i + 100).map(({ attendees, forStorage, ...e }) => ({
          ...e,
          user_id: user.id,
          attendees: attendees && attendees.length > 0 ? attendees : null,
        }));
        const { error: insertError } = await supabase.from('events').insert(batch);
        if (insertError) {
          console.error('Event insert error:', insertError, 'batch index:', i);
        } else {
          inserted += batch.length;
        }
      }

      results.push({ source: feed.source, count: storageEvents.length, contactsDiscovered: inserted });
    }

    return NextResponse.json({ synced: results });
  } catch (error: any) {
    console.error('Calendar sync error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
