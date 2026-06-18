'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { motion, AnimatePresence } from 'framer-motion';
import Sidebar from '@/components/Sidebar';
import ContactPanel from '@/components/ContactPanel';
import VoiceInput from '@/components/VoiceInput';
import ContactListView from '@/components/ContactListView';
import TasksView from '@/components/TasksView';
import CalendarView from '@/components/CalendarView';
import HomeView from '@/components/HomeView';
import InboxView from '@/components/InboxView';
import DetailDrawer, { type DrawerType } from '@/components/DetailDrawer';
import Onboarding from '@/components/Onboarding';
import NotificationManager from '@/components/NotificationManager';
import CommandSearch from '@/components/CommandSearch';
import AskNetwork from '@/components/AskNetwork';
import ToastContainer from '@/components/Toast';
import InstallPrompt from '@/components/InstallPrompt';
import ProjectView from '@/components/ProjectView';
import OrbitLogo from '@/components/OrbitLogo';
import FirstRunSyncOverlay, { type SyncProgress } from '@/components/FirstRunSyncOverlay';
import EmailBackfillPill, { type BackfillStatus, type ChunkLog } from '@/components/EmailBackfillPill';
import { FirstRunProvider } from '@/lib/firstRunContext';
import { useCrmStore } from '@/store/useCrmStore';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { getStorage, setStorage } from '@/lib/storage';

const NetworkGraph = dynamic(() => import('@/components/NetworkGraph'), { ssr: false });

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);
  return isMobile;
}

export default function Home() {
  // appReady gates the cosmic boot shell. Goes true once auth/gate/store
  // have settled AND a grace period has elapsed so the dashboard, sidebar,
  // and any heavy first-paint work have actually rendered. Shell stays on
  // top of the app (z-index) and fades out once this flips.
  const [appReady, setAppReady] = useState(false);
  // activeView persists across reloads so refreshing on /tasks doesn't bounce
  // you to /home. Per-user key prevents bleed if two accounts share a device.
  // Hydrated in a useEffect once user is known (can't read user.id at init).
  const [activeView, setActiveView] = useState<string>('home');
  const [showOnboarding, setShowOnboarding] = useState(false);
  // True once the gating useEffect has decided what the user should see
  // (onboarding vs app). Until then we show a loading shell so the dashboard
  // never flashes for a frame before getting redirected to onboarding.
  const [gateResolved, setGateResolved] = useState(false);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [drawerType, setDrawerType] = useState<DrawerType | null>(null);
  // Background sync indicator — true while sync-graph + sync-email-stats are running
  // on the first or periodic sync. Surfaced as a banner in HomeView so the user
  // knows the app is "filling in" during the 30-60s OAuth-walk pause.
  const [backgroundSyncing, setBackgroundSyncing] = useState(false);
  // Rich per-stage progress for the first-run mapping experience. Drives the
  // FirstRunSyncOverlay's live counters ("Pulled 47 contacts ✓ … Found 27
  // meetings ✓ … Mining 156 connections…") and the celebratory reveal moment
  // when stage flips to 'done'. Only surfaces on FIRST-RUN sync — subsequent
  // 15-min polls still use the quiet `backgroundSyncing` boolean.
  const [syncProgress, setSyncProgress] = useState<SyncProgress>({
    stage: 'idle',
    counts: { contacts: 0, events: 0, emails_scanned: 0, connections: 0 },
    isFirstRun: false,
    startedAt: null,
  });
  // Persistent lifetime-backfill progress — survives past the first-run
  // overlay so the corner pill (EmailBackfillPill) can keep showing %
  // while the background loop walks the rest of the mailbox after reveal.
  const [backfillStatus, setBackfillStatus] = useState<BackfillStatus>({
    active: false,
    pct: null,
    monthsCovered: 0,
    scannedTotal: 0,
    totalMailbox: null,
    done: false,
    currentlyScanning: null,
    etaSeconds: null,
    chunkLog: [],
  });
  // Ref guards against the loop being spawned twice (safeSync's BG arm and
  // the always-on resume effect both call runEmailBackfill).
  const backfillRunningRef = useRef(false);
  // Run identity-resolution sweep once per session. Otherwise every 15-min
  // safeSync tick would burn another ~$0.03 / user re-judging the same pairs.
  const findMergesFiredRef = useRef(false);
  const { fetchAll, loading, contacts, events, selectedContactId, setSelectedContact, syncCalendar, calendarSyncing } = useCrmStore();
  const { user, loading: authLoading } = useAuth();
  // Provider connection state — read once on mount from user_settings so
  // firstRunProgress can weight signals only by what the user actually has.
  // Without this, Google-only / iCal-only / no-provider users get stuck at
  // misleading progress percentages forever (mail weight stays at 0/50,
  // banner sits at "50% Setting up your network" for users who literally
  // can't have mail data).
  const [providersInfo, setProvidersInfo] = useState({
    loaded: false,
    hasMicrosoft: false,
    hasGoogle: false,
    hasIcal: false,
    microsoftRevoked: false,  // set when a sync route returns 401 / refresh-token fails
    googleRevoked: false,
  });
  // providers fetch — refetched on focus + on 'orbit:providers-changed'
  // event so connecting an account in /settings reflects immediately on
  // /home without a full reload. Resets revoked flags too — if the user
  // just reconnected, the new token will succeed on the next sync.
  const fetchProvidersRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    if (!user) return;
    let aborted = false;
    fetchProvidersRef.current = async () => {
      try {
        const { data } = await supabase
          .from('user_settings')
          .select('microsoft_access_token, google_access_token, google_calendar_url, outlook_calendar_url, microsoft_messages_delta_link')
          .eq('user_id', user.id)
          .maybeSingle();
        if (aborted) return;
        setProvidersInfo({
          loaded: true,
          hasMicrosoft: !!data?.microsoft_access_token,
          hasGoogle: !!data?.google_access_token,
          hasIcal: !!(data?.google_calendar_url || data?.outlook_calendar_url),
          microsoftRevoked: false,
          googleRevoked: false,
        });
        if (data?.microsoft_messages_delta_link) {
          try {
            const cur = JSON.parse(data.microsoft_messages_delta_link);
            if (cur && (cur.backfill_done || cur.total_count || cur.scanned_total)) {
              setBackfillStatus((prev) => ({
                ...prev,
                done: !!cur.backfill_done,
                totalMailbox: cur.total_count ?? prev.totalMailbox,
                scannedTotal: cur.scanned_total ?? prev.scannedTotal,
              }));
            }
          } catch { /* malformed cursor, ignore */ }
        }
      } catch (e) {
        // Network error / supabase down — still mark loaded so the rest
        // of the UI doesn't sit in 'providers unknown' limbo. CTA will
        // show (no providers detected), which is the right thing to do
        // when we genuinely don't know.
        if (!aborted) setProvidersInfo((p) => ({ ...p, loaded: true }));
      }
    };
    fetchProvidersRef.current();
    const onFocus = () => { fetchProvidersRef.current(); };
    const onProvidersChanged = () => { fetchProvidersRef.current(); };
    window.addEventListener('focus', onFocus);
    window.addEventListener('orbit:providers-changed', onProvidersChanged);
    return () => {
      aborted = true;
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('orbit:providers-changed', onProvidersChanged);
    };
  }, [user]);

  // Unified first-run progress (0-100). Provider-aware: signals the user
  // can't have (mail for non-MS users, contacts for iCal-only users) drop
  // OUT of both the numerator and the denominator instead of dragging the
  // total down. A Google-only user with full contacts + events hits 100%
  // because mail weight (50) is excluded entirely.
  //
  // Per-signal denominators are kept low (contacts 30, events 20) so users
  // with smaller real-world networks still reach 100%. Mail uses the actual
  // scanned/total ratio.
  const promotedContactsCount = useMemo(
    () => contacts.filter((c) => !(c as any).is_self).length,
    [contacts],
  );
  // Effective provider availability — revoked providers are treated as
  // not connected so their weight drops out of firstRunProgress. Without
  // this, an MS-token-revoked user would see 'Setting up · 0%' forever
  // because mail can never tick up.
  const effMS = providersInfo.hasMicrosoft && !providersInfo.microsoftRevoked;
  const effGoogle = providersInfo.hasGoogle && !providersInfo.googleRevoked;
  const effIcal = providersInfo.hasIcal;

  const firstRunProgress = useMemo(() => {
    if (!providersInfo.loaded) return 0;
    const hasContactSource = effMS || effGoogle;
    const hasCalSource = effMS || effGoogle || effIcal;
    const hasMail = effMS;

    let scoreSum = 0;
    let totalWeight = 0;

    if (hasContactSource) {
      const contactScore = Math.min(30, promotedContactsCount) / 30;
      scoreSum += contactScore * 30;
      totalWeight += 30;
    }
    if (hasMail) {
      const mailRatio = backfillStatus.totalMailbox && backfillStatus.scannedTotal
        ? Math.min(1, backfillStatus.scannedTotal / backfillStatus.totalMailbox)
        : (backfillStatus.done ? 1 : 0);
      scoreSum += mailRatio * 50;
      totalWeight += 50;
    }
    if (hasCalSource) {
      const eventScore = Math.min(20, events.length) / 20;
      scoreSum += eventScore * 20;
      totalWeight += 20;
    }

    if (totalWeight === 0) return 0;        // no providers — banner handles via CTA
    return Math.max(0, Math.min(100, Math.round((scoreSum / totalWeight) * 100)));
  }, [providersInfo.loaded, effMS, effGoogle, effIcal, promotedContactsCount, events.length, backfillStatus.totalMailbox, backfillStatus.scannedTotal, backfillStatus.done]);
  const router = useRouter();
  const isMobile = useIsMobile();

  useEffect(() => {
    if (!authLoading && !user) router.push('/login');
  }, [user, authLoading, router]);

  // Hydrate activeView from localStorage once we know the user. Run before
  // any other navigation effects so we land on the persisted view first.
  const viewHydratedRef = useRef(false);
  useEffect(() => {
    if (!user || viewHydratedRef.current) return;
    viewHydratedRef.current = true;
    try {
      const saved = localStorage.getItem(`orbit-active-view-${user.id}`);
      if (saved) setActiveView(saved);
    } catch { /* localStorage blocked, fall back to home */ }
  }, [user]);

  // Persist activeView on every change. Guarded by viewHydratedRef so the
  // initial 'home' default doesn't overwrite a saved view before hydration.
  useEffect(() => {
    if (!user || !viewHydratedRef.current) return;
    try { localStorage.setItem(`orbit-active-view-${user.id}`, activeView); } catch {}
  }, [activeView, user]);

  useEffect(() => {
    if (!user) return;
    // Local-first boot: try IndexedDB cache first → render instantly. If hit,
    // skip the delta sync entirely if the cache is fresh (< 2 min old) —
    // the 15-min poll interval will handle the next refresh. This avoids
    // the visible "auto refresh" half-a-second after first paint that
    // happened because the delta result triggered a full store update +
    // cascading re-renders for every subscriber.
    //
    // If cache is older than 2 min, the delta fetch is deferred 1.5s so
    // the initial render gets a chance to settle before re-rendering.
    let aborted = false;
    let timer = 0;
    (async () => {
      const { bootFromCache, fetchAll } = useCrmStore.getState();
      const hit = await bootFromCache(user.id);
      if (aborted) return;
      if (hit) {
        const lastSyncedAt = useCrmStore.getState().lastSyncedAt;
        const ageMs = lastSyncedAt ? Date.now() - new Date(lastSyncedAt).getTime() : Infinity;
        const FRESH_MS = 2 * 60 * 1000;
        if (ageMs > FRESH_MS) {
          timer = window.setTimeout(() => {
            if (!aborted) fetchAll({ since: lastSyncedAt || undefined });
          }, 1500);
        }
      } else {
        await fetchAll();
      }
    })();
    return () => { aborted = true; if (timer) clearTimeout(timer); };
  }, [user, fetchAll]);

  // ── Auto-sync calendar: on mount + every 15 min ──
  // Runs both iCal sync AND MS Graph sync (if connected)
  // Persists last-sync timestamp per user so a reload within MIN_MOUNT_INTERVAL
  // is a no-op (production-grade: don't hammer external APIs on every nav).
  // The banner is shown ONLY for true first-run users (no stored timestamp);
  // every other sync runs silently in the background.
  useEffect(() => {
    if (!user) return;
    const SYNC_KEY = `orbit-last-sync-${user.id}`;
    const MIN_MOUNT_INTERVAL_MS = 5 * 60 * 1000;   // skip mount-time sync if last one was within 5 min
    let syncing = false;
    let aborted = false;     // set to true on unmount / user logout — guards async updates
    const briefedThisSession = new Set<string>();

    // Reusable backfill runner — used by safeSync (foreground burst) AND by
    // the always-on resume effect below. The ref guard prevents two loops
    // from racing on the cursor. Updates backfillStatus with chunk timing +
    // log so the pill / detail panel surface real ETA and feed.
    const runEmailBackfill = async (
      accessToken: string,
      opts: { maxChunks: number; isForegroundForOverlay?: boolean },
    ) => {
      if (backfillRunningRef.current) return;
      backfillRunningRef.current = true;
      try {
        let prevOldest: string | null = null;
        for (let i = 0; i < opts.maxChunks && !aborted; i++) {
          const t0 = Date.now();
          let json: any = null;
          try {
            const r = await fetch('/api/sync-email-stats', {
              method: 'POST',
              headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (!r.ok) {
              // 401 / 400 'Microsoft not connected' (after revocation):
              // mark MS as revoked so banner can prompt reconnect.
              const errText = await r.text().catch(() => '');
              if (r.status === 401 || /microsoft.*not.*connected|invalid_grant|refresh.*fail/i.test(errText)) {
                setProvidersInfo((p) => p.microsoftRevoked ? p : { ...p, microsoftRevoked: true });
              }
              break;
            }
            json = await r.json().catch(() => ({}));
          } catch { break; }
          const durationMs = Date.now() - t0;

          setBackfillStatus((prev) => {
            const chunk: ChunkLog = {
              index: (prev.chunkLog[0]?.index || 0) + 1,
              scanned: json.scanned || 0,
              fromDate: prevOldest || json.newest_indexed_at || null,
              toDate: json.oldest_indexed_at || null,
              durationMs,
              startedAt: new Date(t0).toISOString(),
            };
            const chunkLog = [chunk, ...prev.chunkLog].slice(0, 10);
            const avgMs = chunkLog.reduce((a, c) => a + c.durationMs, 0) / chunkLog.length;
            const remaining = (json.total_mailbox || 0) - (json.scanned_total || 0);
            const remainingChunks = remaining > 0 ? Math.ceil(remaining / 2000) : 0;
            const etaSeconds = !json.backfill_done && avgMs > 0 && remainingChunks > 0
              ? Math.round((avgMs * remainingChunks) / 1000)
              : null;
            return {
              active: !!json.has_more,
              pct: json.progress_pct ?? null,
              monthsCovered: json.months_covered || 0,
              scannedTotal: json.scanned_total || 0,
              totalMailbox: json.total_mailbox || null,
              done: !!json.backfill_done,
              currentlyScanning: json.oldest_indexed_at || null,
              etaSeconds,
              chunkLog,
            };
          });
          prevOldest = json.oldest_indexed_at || prevOldest;

          // First-run overlay's email stage shows the count growing.
          if (opts.isForegroundForOverlay && !aborted) {
            const contacts = useCrmStore.getState().contacts.filter((c) => !(c as any).is_self).length;
            setSyncProgress((s) => ({
              ...s,
              stage: 'mining',
              counts: { ...s.counts, contacts, emails_scanned: (s.counts.emails_scanned || 0) + (json.scanned || 0) },
              emailBackfill: {
                done: !json.has_more,
                months_covered: json.months_covered || 0,
                oldest_indexed_at: json.oldest_indexed_at || null,
              },
            }));
          }

          if (!json.has_more) break;
        }
      } finally {
        backfillRunningRef.current = false;
        if (!aborted) {
          await fetchAll({ since: useCrmStore.getState().lastSyncedAt || undefined });
        }
      }
    };

    const safeSync = async (opts: { showBanner?: boolean; isFirstRun?: boolean } = {}) => {
      if (syncing || aborted) return;
      // Skip while user is actively dictating — fetchAll re-renders the whole
      // graph, which interrupts the SpeechRecognition stream and feels like
      // the page froze. Reschedules on the next 15min tick.
      if ((window as any).__voiceRecording) return;
      syncing = true;
      if (opts.showBanner) setBackgroundSyncing(true);
      // First-run users see the FirstRunSyncOverlay — publish per-stage updates
      // so the live counter ticks up as each route returns. Subsequent polls
      // skip this and only flip the quiet `backgroundSyncing` banner.
      const firstRun = !!opts.isFirstRun;
      if (firstRun) {
        setSyncProgress({
          stage: 'calendar',
          counts: { contacts: 0, events: 0, emails_scanned: 0, connections: 0 },
          isFirstRun: true,
          startedAt: Date.now(),
        });
      }
      try {
        await syncCalendar();
        const { data: { session } } = await supabase.auth.getSession();
        const accessToken = session?.access_token;
        if (firstRun && !aborted) {
          const events = useCrmStore.getState().events.length;
          setSyncProgress((s) => ({ ...s, stage: 'contacts', counts: { ...s.counts, events } }));
        }
        // MS Graph sync (silent if not connected). Skip fetchAll if route
        // returned non-2xx so we don't re-render the world after a no-op.
        if (accessToken) {
          try {
            const r = await fetch('/api/sync-graph', {
              method: 'POST',
              headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone }),
            });
            if (r.ok && !aborted) {
              const json = await r.json().catch(() => ({}));
              // Detect per-provider auth failures inside the response —
              // sync-graph returns 200 OK with per-provider error fields,
              // so a generic !r.ok check would miss MS-revoked / Google-
              // revoked cases. Surface them via providersInfo so banner
              // can switch to a "Reconnect" CTA and firstRunProgress
              // excludes the dead provider from its weight.
              const looksRevoked = (err: string | undefined) =>
                !!err && /401|unauthorized|invalid_grant|invalid_refresh|refresh.*fail|consent|expired/i.test(err);
              const msErr = (json as any)?.microsoft?.error as string | undefined;
              const gErr = (json as any)?.google?.error as string | undefined;
              if (looksRevoked(msErr) || looksRevoked(gErr)) {
                setProvidersInfo((p) => ({
                  ...p,
                  microsoftRevoked: p.microsoftRevoked || looksRevoked(msErr),
                  googleRevoked: p.googleRevoked || looksRevoked(gErr),
                }));
              }
              await fetchAll({ since: useCrmStore.getState().lastSyncedAt || undefined });
              if (firstRun && !aborted) {
                const contacts = useCrmStore.getState().contacts.filter((c) => !(c as any).is_self).length;
                setSyncProgress((s) => ({ ...s, stage: 'email', counts: { ...s.counts, contacts } }));
              }
            }
          } catch (e) { /* graph not connected — silent */ }
        }

        // Email-exchange stats backfill — foreground burst (3 chunks ≈ 6K
        // msgs, ~90s) so the reveal isn't blocked, then a fire-and-forget
        // background loop walks the rest. The pill + detail panel surface
        // live progress; cursor persists in user_settings so anything not
        // finished resumes on the next mount.
        if (accessToken) {
          await runEmailBackfill(accessToken, { maxChunks: 3, isForegroundForOverlay: firstRun });
          // Fork the background continuation regardless — the ref guard in
          // runEmailBackfill makes this a no-op if foreground exhausted the
          // mailbox, and the backend returns has_more=false immediately when
          // backfill_done=true (one cheap chunk in the worst case).
          if (!aborted) {
            (async () => {
              await runEmailBackfill(accessToken, { maxChunks: 50 });
            })();
          }
        }

        // Calendar attendee mining: pairs people who meet together. Reads the
        // events table that sync-graph + sync-calendar already populated, so it
        // works with both Google Calendar (API) and iCal feeds — no Gmail scope
        // required. Auto-creates Discovered contacts for unknown attendees.
        if (accessToken) {
          try {
            const r = await fetch('/api/sync-calendar-pairs', {
              method: 'POST',
              headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (r.ok && !aborted) await fetchAll({ since: useCrmStore.getState().lastSyncedAt || undefined });
          } catch (e) { /* silent */ }
        }

        if (firstRun && !aborted) {
          const st = useCrmStore.getState();
          setSyncProgress((s) => ({
            ...s,
            stage: 'done',
            counts: {
              ...s.counts,
              contacts: st.contacts.filter((c) => !(c as any).is_self).length,
              events: st.events.length,
              // Each edge appears twice (a→b and b→a) so divide by 2 for the
              // human-facing "connections" count.
              connections: Math.round(st.contacts.reduce((sum, c) => sum + c.connections.length, 0) / 2),
            },
          }));
        }

        // ── Auto-run identity-resolution sweep ──
        // find-merges is what populates the Suggestions inbox with "this looks
        // like the same person" pairs. It used to be a dead endpoint (only
        // reachable by a manual button buried in Suggestions). Now we fire it
        // once per session after sync so users see duplicate-merge suggestions
        // without having to find the button. Fire-and-forget (~$0.03 / 60s).
        if (accessToken && !aborted && !findMergesFiredRef.current) {
          findMergesFiredRef.current = true;
          fetch('/api/find-merges', {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          }).catch(() => { /* silent — inbox will populate on next sync */ });
        }

        // ── Auto pre-meeting briefs: synthesize stale contacts in next-24h meetings ──
        if (accessToken) {
          try {
            const { events, contacts } = useCrmStore.getState();
            const now = new Date();
            const tomorrow = new Date(now); tomorrow.setHours(now.getHours() + 24);
            const STALE_MS = 7 * 24 * 60 * 60 * 1000;

            const contactIds = new Set<string>();
            for (const e of events) {
              const dStr = e.date + 'T' + (e.time || '12:00:00');
              const d = new Date(dStr);
              if (d < now || d > tomorrow) continue;
              if (e.contact_id) contactIds.add(e.contact_id);
              const attendees = (e as any).attendees as { email: string }[] | null;
              if (attendees) {
                for (const a of attendees) {
                  const c = contacts.find((c) => c.email?.toLowerCase() === (a.email || '').toLowerCase() && !c.is_self);
                  if (c) contactIds.add(c.id);
                }
              }
              // Title first-name match (fallback when no attendees)
              for (const c of contacts) {
                if (c.is_self) continue;
                const first = c.name.split(' ')[0].toLowerCase();
                if (first.length >= 4 && e.title.toLowerCase().includes(first)) contactIds.add(c.id);
              }
            }

            const targets = Array.from(contactIds).filter((id) => {
              if (briefedThisSession.has(id)) return false;
              const c = contacts.find((c) => c.id === id);
              if (!c) return false;
              const syntAt = (c as any).synthesized_at;
              if (!syntAt) return true;
              return Date.now() - new Date(syntAt).getTime() > STALE_MS;
            }).slice(0, 5); // cap cost to ~$0.10 per session

            // Fire all synth calls in parallel and ONE fetchAll at the end —
            // avoids 5 staggered fetchAll's that re-render the whole app mid-session
            // (was making the page look like it was refreshing every few seconds).
            if (targets.length > 0) {
              targets.forEach((id) => briefedThisSession.add(id));
              await Promise.allSettled(
                targets.map((id) =>
                  fetch('/api/synthesize-contact', {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ contactId: id }),
                  })
                )
              );
              if (!aborted) await fetchAll({ since: useCrmStore.getState().lastSyncedAt || undefined });
            }
          } catch (e) { /* silent */ }
        }
      } catch (e) { console.error('Auto-sync failed:', e); }
      syncing = false;
      try { localStorage.setItem(SYNC_KEY, String(Date.now())); } catch {}
      if (!aborted) setBackgroundSyncing(false);   // no setState after unmount
    };

    // On-mount sync: only run if it's been >MIN_MOUNT_INTERVAL_MS since last
    // sync. Bumped delay from 2s → 6s so safeSync's fetchAll cascade fires
    // well AFTER the boot shell has dismissed and the user has had a beat
    // to settle into the app. Was firing right after the shell went away,
    // reading as a 'second auto refresh.'
    const last = (() => { try { return Number(localStorage.getItem(SYNC_KEY)) || 0; } catch { return 0; } })();
    const isFirstRun = !last;
    const stale = Date.now() - last > MIN_MOUNT_INTERVAL_MS;
    // First-time users get safeSync RIGHT AWAY (800ms safety beat) so the
    // FirstRunSyncOverlay covers the empty dashboard from the start. The
    // 6-second delay was added for returning users to prevent a "second
    // auto refresh" right after their cached data renders — that doesn't
    // apply to first-runs (there's no cached data to compete with). Without
    // this split, brand-new users stare at empty cards for 6 seconds
    // before anything visibly happens.
    const initialTimer = stale
      ? setTimeout(() => safeSync({ showBanner: isFirstRun, isFirstRun }), isFirstRun ? 800 : 6000)
      : null;
    // 15-min interval: always silent (returning users never see the banner)
    const interval = setInterval(() => safeSync({ showBanner: false }), 15 * 60 * 1000);

    // Always-on backfill resume — same idea: defer until well after the
    // app is stable. Bumped from 8s → 12s so it doesn't pile on right
    // after safeSync's initial timer fires.
    const resumeTimer = setTimeout(async () => {
      if (aborted) return;
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const accessToken = session?.access_token;
        if (!accessToken) return;
        await runEmailBackfill(accessToken, { maxChunks: 50 });
      } catch {}
    }, 12000);

    return () => {
      aborted = true;
      if (initialTimer) clearTimeout(initialTimer);
      clearInterval(interval);
      clearTimeout(resumeTimer);
    };
  }, [user, syncCalendar, fetchAll]);

  useEffect(() => {
    if (loading || !user) return;
    // Onboarded? If no → show Onboarding. Re-runs when showOnboarding flips
    // false so the dashboard mounts the moment onboarding completes.
    let cancelled = false;
    (async () => {
      let onboarded = !!getStorage(`crm-onboarded-${user.id}`);
      if (!onboarded) {
        const { data } = await supabase
          .from('user_settings')
          .select('onboarded_at')
          .eq('user_id', user.id)
          .maybeSingle();
        if (cancelled) return;
        if (data?.onboarded_at) {
          setStorage(`crm-onboarded-${user.id}`, 'true');
          onboarded = true;
        }
      }
      if (!onboarded) {
        setShowOnboarding(true);
        return;
      }
      setGateResolved(true);
    })();
    return () => { cancelled = true; };
  }, [loading, user, router, showOnboarding]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selectedContactId) setSelectedContact(null);
        else if (drawerType) setDrawerType(null);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [selectedContactId, setSelectedContact, drawerType]);

  // Background pre-warm for heavy chunks — fire-and-forget, don't block
  // the shell. Skeletons in HomeView handle the loading state inline if
  // the chunks arrive after the shell dismisses.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const id = setTimeout(() => {
      void import('@/components/NetworkGraph');
      void import('@/components/HumanSilhouette');
    }, 100);
    return () => clearTimeout(id);
  }, []);

  // appReady gate: simple — flip true as soon as auth + gate + store
  // have all resolved, plus one RAF for the first paint. Nothing fancy.
  // Trying to wait for "everything" (chunks, paint, settle) ironically
  // created more visible jank because re-renders kept happening behind
  // a longer-lived shell.
  useEffect(() => {
    if (appReady) return;
    if (authLoading || !user || loading || !gateResolved) return;
    const raf = requestAnimationFrame(() => setAppReady(true));
    return () => cancelAnimationFrame(raf);
  }, [authLoading, user, loading, gateResolved, appReady]);

  // Drawer + ContactPanel are mutually exclusive: opening a contact closes the drawer
  useEffect(() => {
    if (selectedContactId && drawerType) setDrawerType(null);
  }, [selectedContactId, drawerType]);

  // Switching away from home closes the drawer
  useEffect(() => {
    if (activeView !== 'home' && drawerType) setDrawerType(null);
  }, [activeView, drawerType]);

  // Track the prior view so 'back' from Inbox returns where the user came from.
  // MUST stay above all early returns or React panics with hook-order mismatch.
  const [previousView, setPreviousView] = useState<string | null>(null);
  const handleNavigate = (view: string) => {
    if (view !== activeView) setPreviousView(activeView);
    setActiveView(view);
  };
  // Sidebar fires `request-add-task` when user clicks + on a project.
  // We navigate to Tasks, then re-fire as `open-add-task` so TasksView's
  // listener opens the form pre-filled with the projectId.
  useEffect(() => {
    const onAddTask = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      handleNavigate('tasks');
      // Give TasksView a tick to mount its listener
      setTimeout(() => window.dispatchEvent(new CustomEvent('open-add-task', { detail })), 80);
    };
    window.addEventListener('request-add-task', onAddTask);
    return () => window.removeEventListener('request-add-task', onAddTask);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Global 'open-inbox' event from any SharedHeader inbox button.
  useEffect(() => {
    const handler = () => handleNavigate('inbox');
    window.addEventListener('open-inbox', handler);
    return () => window.removeEventListener('open-inbox', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView]);

  // appReady is the master gate. Auth/store loading conditions feed into
  // it via the useEffect above (with a grace period for first paint).
  // While !appReady, the app still renders behind the shell so it can do
  // its mount work in parallel; the shell just sits on top via z-[1000].
  if (showOnboarding) {
    return <Onboarding onComplete={() => {
      setShowOnboarding(false);
      if (!user) return;
      setStorage(`crm-onboarded-${user.id}`, 'true');
      supabase
        .from('user_settings')
        .upsert(
          { user_id: user.id, onboarded_at: new Date().toISOString(), updated_at: new Date().toISOString() },
          { onConflict: 'user_id' },
        )
        .then(({ error }) => { if (error) console.error('[onboarding] persist onboarded_at failed:', error); });
    }} />;
  }

  // Only render the full app shell once auth + gate have resolved.
  // Until then, the boot shell covers everything anyway, so there's
  // nothing to see underneath.
  const appCanMount = !authLoading && !!user && gateResolved && !loading;

  // NOTE: do NOT extract this JSX into an inner function component — React
  // would treat the function as a new component on every render of Home,
  // unmounting + remounting the entire AppShell (incl. Sidebar) and
  // replaying every entry animation. Inline-only.
  const firstRunInfo = {
    progress: firstRunProgress,
    scannedTotal: backfillStatus.scannedTotal,
    totalMailbox: backfillStatus.totalMailbox,
    done: backfillStatus.done,
    contactsCount: promotedContactsCount,
    providersLoaded: providersInfo.loaded,
    // EFFECTIVE provider state — revoked counts as not connected so the
    // banner CTA / progress mode reflects reality.
    hasMicrosoft: effMS,
    hasGoogle: effGoogle,
    hasIcal: effIcal,
    microsoftRevoked: providersInfo.microsoftRevoked && providersInfo.hasMicrosoft,
    googleRevoked: providersInfo.googleRevoked && providersInfo.hasGoogle,
  };

  return appCanMount ? (
    <FirstRunProvider value={firstRunInfo}>
    <>
      <div className="h-screen w-screen overflow-hidden bg-[var(--bg-primary)] flex">
      {/* First-run mapping overlay — full-screen takeover ONLY for the
         initial sync after onboarding. Shows live stage progress + counts,
         then a celebration reveal. Subsequent 15-min poll syncs fall back
         to the quiet `backgroundSyncing` banner inside HomeView. */}
      <FirstRunSyncOverlay
        progress={syncProgress}
        onComplete={() => setSyncProgress((s) => ({ ...s, stage: 'idle' }))}
      />

      {/* Persistent corner pill — visible while the background mail-history
          backfill loop is still walking the mailbox after first-run reveal.
          Auto-hides 4s after backfill_done flips true. */}
      <EmailBackfillPill status={backfillStatus} />

      <Sidebar
        activeView={activeView}
        setActiveView={handleNavigate}
        onMobileMic={() => window.dispatchEvent(new Event('open-voice-input'))}
        onProjectClick={(id) => { setActiveProjectId(id); setActiveView('project'); }}
      />

      {/* CSS-only desktop/mobile split so first paint is correct on both —
          driving these with JS isMobile caused a visible 200px content
          shift on mobile on every page load. */}
      <div className="flex-1 min-w-0 flex md:ml-[200px] pb-[calc(52px+env(safe-area-inset-bottom,0px))] md:pb-0">
        {/* Main view. HomeView is kept mounted (CSS show/hide) so that
            Three.js HumanSilhouette doesn't re-initialize on every tab
            switch back to home — that re-init was the visible 'glitch'
            of the sidebar + silhouette popping in on each return. Other
            views still mount/unmount; they're lightweight. */}
        <main className="flex-1 min-w-0 h-full overflow-hidden flex flex-col">
          <div className={activeView === 'home' ? 'flex-1 flex flex-col h-full overflow-hidden' : 'hidden'}>
            <HomeView
              onNavigate={handleNavigate}
              onOpenDrawer={setDrawerType}
              backgroundSyncing={backgroundSyncing}
              isVisible={activeView === 'home'}
            />
          </div>
          {activeView === 'graph' && <NetworkGraph />}
          {activeView === 'contacts' && <ContactListView />}
          {activeView === 'tasks' && <TasksView />}
          {activeView === 'calendar' && <CalendarView />}
          {(activeView === 'inbox' || activeView === 'suggestions' || activeView === 'discovered') && (
            <InboxView
              defaultTab={activeView === 'discovered' ? 'discovered' : 'suggestions'}
              onBack={previousView ? () => setActiveView(previousView) : undefined}
            />
          )}
          {activeView === 'project' && activeProjectId && (
            <ProjectView projectId={activeProjectId} onBack={() => setActiveView('home')} />
          )}
        </main>

        {/* Docked contact panel — desktop only via CSS (hidden md:flex).
            AnimatePresence keeps the aside mounted during the exit spring so
            it slides out instead of snapping when selectedContactId clears
            (e.g. after a delete). */}
        <AnimatePresence>
          {selectedContactId && (
            <motion.aside
              key="contact-rail"
              initial={{ x: 40, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 40, opacity: 0 }}
              transition={{ type: 'spring', damping: 28, stiffness: 280 }}
              className="hidden md:flex flex-col flex-shrink-0 w-[420px] xl:w-[460px] border-l border-[var(--border)] bg-[var(--bg-surface)] overflow-y-auto"
            >
              <ContactPanel inline />
            </motion.aside>
          )}
        </AnimatePresence>

        {/* Detail drawer (Home only, when no contact selected) */}
        {drawerType && !selectedContactId && activeView === 'home' && (
          <DetailDrawer
            type={drawerType}
            onClose={() => setDrawerType(null)}
            onSelectContact={(id) => { setSelectedContact(id); setDrawerType(null); }}
          />
        )}
      </div>

      {/* Mobile contact panel — full overlay, hidden on md+ via CSS. */}
      <div className="md:hidden">
        <ContactPanel />
      </div>

      <VoiceInput />
      <ToastContainer />
      <NotificationManager />
      <CommandSearch onNavigate={setActiveView} onProjectClick={(id) => { setActiveProjectId(id); setActiveView('project'); }} />
      <AskNetwork />
      <InstallPrompt />
    </div>

    {/* Cosmic boot shell — snap-removal (no fade) once everything is
        ready. A fade would expose mid-mount work (chunks landing,
        Three.js painting first frame) and read as a glitchy 'second
        load.' Snap means the dashboard either is fully ready or the
        shell is still over it. */}
    {!appReady && (
      <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-[var(--bg-primary)]">
        <motion.div
          animate={{ opacity: [0.45, 1, 0.45] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
          className="w-10 h-10 rounded-lg bg-[var(--text-primary)] flex items-center justify-center"
        >
          <OrbitLogo size={20} className="text-[var(--bg-primary)]" />
        </motion.div>
      </div>
    )}
  </>
    </FirstRunProvider>
  ) : (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-[var(--bg-primary)]">
      <motion.div
        animate={{ opacity: [0.45, 1, 0.45] }}
        transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
        className="w-10 h-10 rounded-lg bg-[var(--text-primary)] flex items-center justify-center"
      >
        <OrbitLogo size={20} className="text-[var(--bg-primary)]" />
      </motion.div>
    </div>
  );
}
