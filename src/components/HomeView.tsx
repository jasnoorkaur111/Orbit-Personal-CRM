'use client';

import { useMemo, useState } from 'react';
import AddTaskDialog from './AddTaskDialog';
import FirstRunBanner from './FirstRunBanner';
import { useFirstRun, isFirstRunActive } from '@/lib/firstRunContext';
import dynamic from 'next/dynamic';
import { motion } from 'framer-motion';

// Three.js can't SSR — dynamic-imported with no SSR.
// Skeleton placeholder during load (matches column width so layout doesn't jump).
const HumanSilhouette = dynamic(() => import('./HumanSilhouette'), {
  ssr: false,
  loading: () => <div className="w-full h-full" />,
});
import {
  MessageCircle, Repeat, Star, Zap, Users,
  AlertTriangle, Clock as ClockIcon, CheckSquare, ArrowRight,
  Activity, UserPlus, Mic, TrendingUp, Reply, Send, Calendar as CalendarIcon,
} from 'lucide-react';
import { useCrmStore } from '@/store/useCrmStore';
import { useAuth } from '@/lib/auth';
import SharedHeader from './SharedHeader';
import NetworkPreview from './NetworkPreview';
import {
  computeHealthScore, getDailyReachOuts, getNetworkInsights, getOwedReplies, getAwaitingReply,
  getRecurringContacts, getNewThisMonth,
} from '@/lib/healthScore';
import { nodeColor } from '@/lib/nodeColors';
import {
  differenceInDays, format, isToday, isTomorrow, addDays,
  formatDistanceToNowStrict, eachDayOfInterval, subDays, isSameDay,
} from 'date-fns';

type DrawerType = 'reach-out' | 'reconnect' | 'opportunities' | 'health' | 'intros' | 'owed-replies' | 'awaiting-reply' | 'recurring' | 'new-this-month';

interface HomeViewProps {
  onNavigate: (view: string) => void;
  onOpenDrawer?: (type: DrawerType) => void;
  /** True while the background calendar+email sync is running. Shows a banner so
   *  first-run users don't think the empty Home is broken during the 30-60s pause. */
  backgroundSyncing?: boolean;
  /** True when home is the active view. HomeView stays mounted across tab
   *  switches (CSS hide) so Three.js doesn't re-init, but we pause the
   *  particle render loop when home isn't visible — otherwise the silhouette
   *  burns ~5% CPU every frame on every page. */
  isVisible?: boolean;
}

type UpcomingItem = {
  id: string; title: string; date: Date; time?: string;
  contactId?: string; contactName?: string; contactColor?: string;
  type: 'event' | 'task';
};

type ActivityItem = {
  id: string; icon: typeof UserPlus; color: string;
  text: string; sub?: string; date: Date; contactId?: string;
};

export default function HomeView({ onNavigate, onOpenDrawer, backgroundSyncing, isVisible = true }: HomeViewProps) {
  const firstRun = useFirstRun();
  const { contacts, events, setSelectedContact } = useCrmStore();
  const { user } = useAuth();

  const [showAddTask, setShowAddTask] = useState(false);
  const handleAdd = () => setShowAddTask(true);

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  }, []);

  const firstName = (
    ((user?.user_metadata as { full_name?: string } | undefined)?.full_name) ||
    user?.email ||
    ''
  ).split(/[ @]/)[0] || 'there';
  const displayName = firstName.charAt(0).toUpperCase() + firstName.slice(1);

  const now = new Date();
  const safeDate = (d?: string | null) => {
    if (!d) return new Date();
    const p = new Date(d);
    return isNaN(p.getTime()) ? new Date() : p;
  };

  // ── Action card sources ──
  // Full list for the true count, sliced subset for avatar previews.
  const reachOutsAll = useMemo(() => getDailyReachOuts(contacts, 999), [contacts]);
  const reachOutsTotal = reachOutsAll.length;
  const reachOuts = useMemo(() => reachOutsAll.slice(0, 6), [reachOutsAll]);
  const owedReplies = useMemo(() => getOwedReplies(contacts, 3, 100), [contacts]);
  const awaitingReply = useMemo(() => getAwaitingReply(contacts, 3, 100), [contacts]);

  // Calendar-native tiles for users without an email feed. The signal swap:
  // when no contact has any email_stats activity, the home dashboard's
  // "Owed / Awaiting" pair (both email-derived) reads as permanently empty.
  // We replace with "Recurring contacts" + "New this month", both computed
  // from calendar event data the user actually has.
  const hasEmailSignal = useMemo(
    () => contacts.some((c) => c.email_stats && ((c.email_stats.emails_sent || 0) > 0 || (c.email_stats.emails_received || 0) > 0)),
    [contacts],
  );
  const recurring = useMemo(() => getRecurringContacts(contacts, events, 100), [contacts, events]);
  const newThisMonth = useMemo(() => getNewThisMonth(contacts, events, 100), [contacts, events]);

  // Stale = relationships gone quiet. Sort by most-recently fading first so the
  // freshest issues read at the top (Sarah 14d > Bob 200d).
  const stale = useMemo(
    () => contacts
      .filter((c) =>
        !c.is_self && c.is_promoted !== false && c.last_contacted &&
        differenceInDays(now, safeDate(c.last_contacted)) >= 14
      )
      .sort((a, b) =>
        safeDate(b.last_contacted).getTime() - safeDate(a.last_contacted).getTime()
      ),
    [contacts]
  );

  // Opportunities = warm contacts with no open task. Highest-health first.
  const opportunities = useMemo(
    () => contacts
      .filter((c) => !c.is_self && c.is_promoted !== false)
      .map((c) => ({ ...c, health: computeHealthScore(c) }))
      .filter((c) =>
        c.health.score >= 70 &&
        c.connections.length >= 3 &&
        c.tasks.filter((t) => !t.completed).length === 0
      )
      .sort((a, b) => b.health.score - a.health.score),
    [contacts]
  );

  // ── Network health ──
  const insights = useMemo(() => getNetworkInsights(contacts), [contacts]);

  // ── TODAY hero — top 3 reach-outs + tasks due today/overdue + meetings today ──
  const todayStr = format(now, 'yyyy-MM-dd');
  const heroReach = useMemo(() => reachOutsAll.slice(0, 3), [reachOutsAll]);
  const heroTasks = useMemo(() => {
    const items: { id: string; title: string; due?: string; contactId: string; contactName: string }[] = [];
    for (const c of contacts) {
      if (c.is_self || c.is_promoted === false) continue;
      for (const t of c.tasks || []) {
        if (t.completed) continue;
        if (t.due_date && t.due_date <= todayStr) {
          items.push({ id: t.id, title: t.title, due: t.due_date, contactId: c.id, contactName: c.name });
        }
      }
    }
    return items.sort((a, b) => (a.due || '').localeCompare(b.due || '')).slice(0, 4);
  }, [contacts, todayStr]);
  // ── Merged-from-Insights: charts, rankings, distribution, tags ──
  const enriched = useMemo(
    () => contacts.filter((c) => !c.is_self && c.is_promoted !== false).map((c) => ({ ...c, health: computeHealthScore(c) })),
    [contacts],
  );
  const growth = useMemo(() => {
    const days = eachDayOfInterval({ start: subDays(now, 29), end: now });
    return days.map((d) => ({ date: d, count: contacts.filter((c) => safeDate(c.created_at) <= d).length }));
  }, [contacts]);
  const activity30 = useMemo(() => {
    const days = eachDayOfInterval({ start: subDays(now, 29), end: now });
    return days.map((d) => ({ date: d, count: events.filter((e) => isSameDay(safeDate(e.date + 'T12:00:00'), d)).length }));
  }, [events]);
  const distribution = useMemo(() => {
    const buckets = { Strong: 0, Good: 0, Fading: 0, Cold: 0 };
    enriched.forEach((c) => { buckets[c.health.label as keyof typeof buckets]++; });
    const total = enriched.length || 1;
    return [
      { label: 'Strong', count: buckets.Strong, color: '#06b6d4', pct: (buckets.Strong / total) * 100 },
      { label: 'Good',   count: buckets.Good,   color: '#22d3ee', pct: (buckets.Good   / total) * 100 },
      { label: 'Fading', count: buckets.Fading, color: '#f5c542', pct: (buckets.Fading / total) * 100 },
      { label: 'Cold',   count: buckets.Cold,   color: '#ef4444', pct: (buckets.Cold   / total) * 100 },
    ];
  }, [enriched]);
  const topTags = useMemo(() => {
    const counts: Record<string, number> = {};
    contacts.forEach((c) => (c.tags || []).forEach((t) => { counts[t] = (counts[t] || 0) + 1; }));
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [contacts]);
  const strongest = useMemo(() => [...enriched].sort((a, b) => b.health.score - a.health.score).slice(0, 5), [enriched]);
  const goingCold = useMemo(() => [...enriched].filter((c) => c.health.score < 50).sort((a, b) => a.health.score - b.health.score).slice(0, 5), [enriched]);
  const mostConnected = useMemo(
    () => [...enriched].sort((a, b) => b.connections.length - a.connections.length).slice(0, 5).filter((c) => c.connections.length > 0),
    [enriched],
  );
  const sparkPath = (points: { count: number }[], w: number, h: number) => {
    if (points.length === 0) return '';
    const max = Math.max(...points.map((p) => p.count), 1);
    const min = Math.min(...points.map((p) => p.count));
    const range = max - min || 1;
    return points.map((p, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = h - ((p.count - min) / range) * h;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  };

  // ── Upcoming (7-day window) ──
  const upcoming = useMemo<UpcomingItem[]>(() => {
    const items: UpcomingItem[] = [];
    events.forEach((e) => {
      const d = safeDate(e.date + 'T12:00:00');
      if (d >= now && d <= addDays(now, 7)) {
        const c = contacts.find((x) => x.id === e.contact_id);
        items.push({
          id: 'e-' + e.id, title: e.title, date: d, time: e.time,
          contactName: c?.name, contactColor: c?.color, type: 'event',
          contactId: e.contact_id,
        });
      }
    });
    contacts.forEach((c) => {
      c.tasks.forEach((t) => {
        if (t.completed || !t.due_date) return;
        const d = safeDate(t.due_date + 'T12:00:00');
        if (d >= now && d <= addDays(now, 7)) {
          items.push({
            id: 't-' + t.id, title: t.title, date: d,
            contactName: c.name, contactColor: c.color, type: 'task',
            contactId: c.id,
          });
        }
      });
    });
    return items.sort((a, b) => a.date.getTime() - b.date.getTime()).slice(0, 4);
  }, [contacts, events]);

  // ── Recent activity (last 14 days) ──
  const activityPalette = ['#7c5cff', '#22d3ee', '#f5c542', '#10b981', '#ec4899', '#f97316'];
  const hashStr = (s: string) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  };
  const recentActivity = useMemo<ActivityItem[]>(() => {
    const items: ActivityItem[] = [];
    contacts.forEach((c) => {
      const created = safeDate(c.created_at);
      if (differenceInDays(now, created) <= 14) {
        items.push({
          id: 'add-' + c.id, icon: UserPlus,
          color: activityPalette[hashStr(c.id) % activityPalette.length],
          text: c.name, sub: 'Added to network', date: created, contactId: c.id,
        });
      }
      // Tasks: both ADDED and COMPLETED — chronological feed of all task touches
      c.tasks.forEach((t) => {
        const tCreated = safeDate(t.created_at);
        if (differenceInDays(now, tCreated) <= 14) {
          items.push({
            id: 'task-add-' + t.id, icon: CheckSquare, color: '#7c5cff',
            text: c.name, sub: `Task · ${t.title}`,
            date: tCreated, contactId: c.id,
          });
        }
        if (t.completed) {
          // Use created_at as a proxy when there's no completed_at on the row
          const dCompleted = safeDate(t.created_at);
          if (differenceInDays(now, dCompleted) <= 14) {
            items.push({
              id: 'task-done-' + t.id, icon: CheckSquare, color: '#10b981',
              text: c.name, sub: `Done · ${t.title}`,
              date: dCompleted, contactId: c.id,
            });
          }
        }
      });
    });
    // Events: include both inferred conversations AND added meetings/calendar events.
    // Sort by when the event was ADDED to Orbit (created_at), NOT when the event
    // was scheduled (e.date) — otherwise calendar imports backfilled from last
    // week sort into the middle of the feed dated last week, looking "all over
    // the place" even though you just added them.
    events.forEach((e) => {
      const addedAt = (e as any).created_at ? safeDate((e as any).created_at) : safeDate(e.date + 'T12:00:00');
      if (differenceInDays(now, addedAt) > 14) return;
      const c = contacts.find((x) => x.id === e.contact_id);
      let sub = '';
      let color = '#7c5cff';
      if (e.source === 'interaction') { sub = `Conversation · ${e.title}`; color = '#7c5cff'; }
      else if (e.source === 'manual') { sub = `Meeting · ${e.title}`; color = '#22d3ee'; }
      else if (e.source === 'google_calendar' || e.source === 'outlook_calendar') { sub = `Calendar · ${e.title}`; color = '#06b6d4'; }
      else return;     // skip task-as-event surrogates etc
      items.push({
        id: 'evt-' + e.id, icon: MessageCircle, color,
        text: c?.name || e.title, sub, date: addedAt, contactId: e.contact_id,
      });
    });
    return items.sort((a, b) => b.date.getTime() - a.date.getTime());
  }, [contacts, events]);

  // ── Top insight for the gradient banner ──
  const heroInsight = useMemo(() => {
    // Priority: intros > stale > weak > pending > new
    const byPriority = ['users', 'clock', 'alert', 'tasks', 'trending'];
    const sorted = [...insights.insights].sort(
      (a, b) => byPriority.indexOf(a.icon) - byPriority.indexOf(b.icon)
    );
    return sorted[0];
  }, [insights]);

  const fmtDay = (d: Date) =>
    isToday(d) ? 'Today' : isTomorrow(d) ? 'Tomorrow' : format(d, 'EEE, MMM d');

  // ── Empty state for brand new users ──
  if (contacts.length === 0) {
    return (
      <div className="h-full overflow-y-auto flex flex-col">
        <AddTaskDialog open={showAddTask} onClose={() => setShowAddTask(false)} />
        <SharedHeader title={`${greeting}, ${displayName}`} subtitle="Let's get started" onAdd={handleAdd} addLabel="Add task" />
        <div className="max-w-[640px] mx-auto px-5 md:px-8 py-16 md:py-24 text-center">
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: [0.2, 0, 0, 1] }}
          >
            <h1 className="text-3xl font-semibold tracking-tight mb-2">
              Welcome, {displayName}
            </h1>
            <p className="text-[14px] text-[var(--text-secondary)] mb-10 max-w-[400px] mx-auto leading-relaxed">
              Your network starts here. Add your first contact by voice, or import from Google or LinkedIn.
            </p>

            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <button
                onClick={() => window.dispatchEvent(new Event('open-voice-input'))}
                className="btn-lavender flex items-center justify-center gap-2 px-5 py-3 rounded-xl font-medium text-[13px] btn-press"
              >
                <Mic size={14} /> Capture by voice
              </button>
              <button
                onClick={() => onNavigate('contacts')}
                className="flex items-center justify-center gap-2 px-5 py-3 rounded-xl glass-card text-[13px] hover-pop"
              >
                <UserPlus size={14} /> Add manually
              </button>
            </div>
          </motion.div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <AddTaskDialog open={showAddTask} onClose={() => setShowAddTask(false)} />
      <SharedHeader
        title={`${greeting}, ${displayName}`}
        subtitle="Here's what's happening in your network today"
        onAdd={handleAdd}
        addLabel="Add task"
        leftAdornment={
          <div className="w-[72px] h-[72px] -my-2"
            style={{ filter: 'drop-shadow(0 4px 12px rgba(124,92,255,0.18))' }}>
            <HumanSilhouette particleCount={800} showAmbient={false} active={isVisible} />
          </div>
        }
      />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[1480px] mx-auto px-5 md:px-7 pb-8">

          {/* Unified first-run banner — replaces the generic 'syncing'
              banner. Reads the same FirstRunInfo used by NetworkGraph
              and other view empty states. Auto-hides at 95%+. */}
          {isFirstRunActive(firstRun) && <FirstRunBanner info={firstRun} />}

          {/* ── TODAY HERO · BENTO ── 2x2: Next mtg (lg, glow) · Reach out · Tasks · Date masthead */}
          {(heroReach.length > 0 || heroTasks.length > 0 || upcoming.length > 0) && (
              <div className="mb-5">
                <div className="grid grid-cols-1 md:grid-cols-[1.4fr_1fr_1fr] gap-3">

                  {/* LEFT · UPCOMING (calendar + tasks within 7d) */}
                  <div className="rounded-xl border border-[var(--accent)]/25 px-4 py-3.5 flex flex-col"
                    style={{
                      background: 'linear-gradient(135deg, rgba(124,92,255,0.08), rgba(124,92,255,0.01) 60%)',
                      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), 0 4px 18px -8px rgba(124,92,255,0.18)',
                    }}>
                    <div className="flex items-baseline justify-between mb-2">
                      <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-secondary)]/80">Upcoming</span>
                      <button onClick={() => onNavigate('calendar')}
                        className="text-[10px] text-[var(--accent)] hover:text-[var(--accent-light)] transition-colors flex items-center gap-1">
                        Calendar <ArrowRight size={10} />
                      </button>
                    </div>
                    {upcoming.length === 0 ? (
                      <p className="text-[12px] text-[var(--text-secondary)]/50">Nothing scheduled this week.</p>
                    ) : (
                      <div className="space-y-0.5">
                        {upcoming.slice(0, 3).map((item) => (
                          <button key={item.id}
                            onClick={() => item.contactId && setSelectedContact(item.contactId)}
                            className="w-full flex items-center gap-2 px-1 py-1 rounded-md hover:bg-[var(--hover-bg)] transition-colors text-left">
                            <div className="w-0.5 h-7 rounded-full flex-shrink-0"
                              style={{ backgroundColor: item.contactColor || (item.type === 'task' ? '#f5c542' : '#7c5cff') }} />
                            <div className="flex-1 min-w-0">
                              <p className="text-[12px] truncate leading-tight">{item.title}</p>
                              <p className="text-[10px] text-[var(--text-secondary)]/70 mt-0.5 truncate">
                                {fmtDay(item.date)}{item.time ? ` · ${item.time.slice(0, 5)}` : ''}
                                {item.contactName ? ` · ${item.contactName}` : ''}
                              </p>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* MIDDLE · REACH OUT (compact, top 3) */}
                  <div className="rounded-xl border border-[var(--border)] px-4 py-3.5 flex flex-col"
                    style={{
                      background: 'linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01))',
                      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
                    }}>
                    <div className="flex items-baseline justify-between mb-2">
                      <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-secondary)]/80">Reach out</span>
                      <span className="text-[10px] text-[var(--text-secondary)]/60 tabular-nums">{reachOutsTotal}</span>
                    </div>
                    {heroReach.length === 0 ? (
                      <p className="text-[12px] text-[var(--text-secondary)]/50">No one urgent.</p>
                    ) : (
                      <div className="space-y-0.5">
                        {heroReach.map((c: any) => (
                          <button key={c.id} onClick={() => setSelectedContact(c.id)}
                            className="w-full flex items-center gap-2 px-1 py-1 rounded-md hover:bg-[var(--hover-bg)] transition-colors text-left">
                            {c.photo ? (
                              <img src={c.photo} className="w-5 h-5 rounded-full object-cover flex-shrink-0" alt="" />
                            ) : (
                              <div className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-medium border border-[var(--border)] text-[var(--text-secondary)] flex-shrink-0">{c.name.charAt(0)}</div>
                            )}
                            <span className="text-[12px] truncate flex-1">{c.name}</span>
                            <span className="text-[10px] text-[var(--text-secondary)]/70 tabular-nums flex-shrink-0">{c.daysSince === 9999 ? '—' : `${c.daysSince}d`}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* RIGHT · TASKS DUE */}
                  <div className="rounded-xl border border-[var(--border)] px-4 py-3.5 flex flex-col"
                    style={{
                      background: 'linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01))',
                      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
                    }}>
                    <div className="flex items-baseline justify-between mb-2">
                      <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-secondary)]/80">Due today</span>
                      <span className="text-[10px] text-[var(--text-secondary)]/60 tabular-nums">{heroTasks.length}</span>
                    </div>
                    {heroTasks.length === 0 ? (
                      <p className="text-[12px] text-[var(--text-secondary)]/50">All clear.</p>
                    ) : (
                      <div className="space-y-0.5">
                        {heroTasks.map((t) => (
                          <button key={t.id} onClick={() => setSelectedContact(t.contactId)}
                            className="w-full text-left flex items-baseline gap-2 px-1 py-1 rounded-md hover:bg-[var(--hover-bg)] transition-colors">
                            <span className="text-[10px] text-[var(--text-secondary)]/60 leading-none mt-[2px]">☐</span>
                            <span className="text-[12px] truncate flex-1">{t.title}</span>
                            {t.due && t.due < todayStr && <span className="text-[10px] text-[#ef4444]/80 flex-shrink-0">!</span>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                </div>
              </div>
            )}

          {/* ── DASHBOARD BENTO ──
             Row 1:  Map (span 8) | Owed (top) / Awaiting (bottom) stacked in span 4
             Row 2:  Strongest | Most Connected | Recent Activity (4/4/4)
             Network Health removed per request (accessible via Insights drawer). */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5">

            {/* ─── ROW 1 ─── */}
            <div className="lg:col-span-8 min-w-0">
              <NetworkPreview contacts={contacts} onOpen={() => onNavigate('graph')} height={260} />
            </div>

            {/* Right column — two stacked tiles, summed to map's 260px.
               Email users see reply-driven tiles; calendar-only users see
               cadence-driven tiles built from event history. */}
            <div className="lg:col-span-4 grid grid-rows-2 gap-3.5 min-w-0" style={{ minHeight: 260 }}>
              {hasEmailSignal ? (
                <>
                  <ActionCard
                    icon={Reply}
                    /* Yellow — same hue as the network-map "needs attention"
                       halo. Owed-replies are the canonical attention trigger;
                       card icon and graph halo should read as one signal. */
                    color="#ffc850"
                    count={owedReplies.length}
                    label={owedReplies.length === 1 ? 'reply you owe' : 'replies you owe'}
                    avatars={owedReplies.map((c: any) => ({ ...c, daysSinceForColor: c.daysOwed }))}
                    onClick={() => onOpenDrawer?.('owed-replies')}
                  />
                  <ActionCard
                    icon={Send}
                    /* Cool blue — matches the network-map "stale" palette
                       stop. Awaiting-reply contacts are in a holding pattern,
                       not urgent, so they read as cool not warm. */
                    color="#6aa1ff"
                    count={awaitingReply.length}
                    label={awaitingReply.length === 1 ? 'awaiting reply' : 'awaiting replies'}
                    avatars={awaitingReply.map((c: any) => ({ ...c, daysSinceForColor: c.daysWaiting }))}
                    onClick={() => onOpenDrawer?.('awaiting-reply')}
                  />
                </>
              ) : (
                <>
                  <ActionCard
                    icon={Repeat}
                    color="#06b6d4"
                    count={recurring.length}
                    label={recurring.length === 1 ? 'recurring contact' : 'recurring contacts'}
                    avatars={recurring}
                    onClick={() => onOpenDrawer?.('recurring')}
                  />
                  <ActionCard
                    icon={UserPlus}
                    color="#10b981"
                    count={newThisMonth.length}
                    label={newThisMonth.length === 1 ? 'new this month' : 'new this month'}
                    avatars={newThisMonth}
                    onClick={() => onOpenDrawer?.('new-this-month')}
                  />
                </>
              )}
            </div>

            {/* ─── ROW 2 — three equal glass tiles ─── */}
            <div className="lg:col-span-12 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5 auto-rows-fr">
              {enriched.length > 0 && (
                <>
                  <RankingCard title="Strongest" contacts={strongest} onClick={setSelectedContact} colorMode="health" />
                  <RankingCard title="Most connected" contacts={mostConnected} onClick={setSelectedContact} colorMode="contact" countLabel="links" countMode="connections" />
                </>
              )}
              <RecentActivityCard items={recentActivity} onOpen={setSelectedContact} contactsById={new Map(contacts.map((c) => [c.id, c]))} />
            </div>

          </div>

        </div>
      </div>
    </div>
  );
}

// Compact ranking card for the merged Insights sections
function RankingCard({
  title, contacts, onClick, colorMode, countLabel, countMode, emptyText,
}: {
  title: string;
  contacts: any[];
  onClick: (id: string) => void;
  colorMode: 'health' | 'contact';
  countLabel?: string;
  countMode?: 'connections';
  emptyText?: string;
}) {
  return (
    <div className="glass-card p-5 h-full flex flex-col" onMouseMove={spotlightMove}>
      <h2 className="text-[11px] uppercase tracking-[0.12em] font-medium text-[var(--text-secondary)] mb-3">{title}</h2>
      {contacts.length === 0 ? (
        <p className="text-[11.5px] text-[var(--text-secondary)]/60 py-4 text-center">{emptyText || 'Nothing here yet'}</p>
      ) : (
        <div className="space-y-1">
          {contacts.map((c) => {
            const color = colorMode === 'health' ? (c.health?.color || '#06b6d4') : (c.color || '#06b6d4');
            const right = countMode === 'connections' ? `${c.connections.length} ${countLabel || ''}` : `${c.health?.score ?? ''}`;
            return (
              <button key={c.id} onClick={() => onClick(c.id)}
                className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-[var(--hover-bg)] transition-colors text-left">
                {c.photo ? (
                  <img src={c.photo} alt="" className="w-7 h-7 rounded-full object-cover flex-shrink-0" />
                ) : (
                  <div className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-semibold flex-shrink-0 border border-[var(--border)] text-[var(--text-secondary)]">
                    {c.name.charAt(0)}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] truncate font-medium">{c.name}</p>
                  {c.company && <p className="text-[10px] text-[var(--text-secondary)] truncate">{c.company}</p>}
                </div>
                <span className="text-[10.5px] font-medium tabular-nums" style={{ color }}>{right}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Mouse-tracking spotlight handler — wires up .glass-card::before lavender glow
function spotlightMove(e: React.MouseEvent<HTMLElement>) {
  const r = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`);
  e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`);
}

// ─────────────────────────────────────────────
// RecentActivityCard — matches RankingCard row format
// ─────────────────────────────────────────────
function RecentActivityCard({
  items, onOpen, contactsById,
}: {
  items: ActivityItem[];
  onOpen: (id: string) => void;
  contactsById: Map<string, { id: string; name: string; photo?: string; color?: string }>;
}) {
  return (
    <div className="glass-card p-5 h-full flex flex-col" onMouseMove={spotlightMove}>
      <h2 className="text-[11px] uppercase tracking-[0.12em] font-medium text-[var(--text-secondary)] mb-3">
        Recent activity
      </h2>
      {items.length === 0 ? (
        <p className="text-[11.5px] text-[var(--text-secondary)]/60 py-4 text-center">Nothing recent</p>
      ) : (
        // ~5 rows visible (each row ≈ 42px incl. gap); rest scrolls inside the card
        <div className="space-y-1 overflow-y-auto -mr-2 pr-2" style={{ maxHeight: 210 }}>
          {items.map((item) => {
            const c = item.contactId ? contactsById.get(item.contactId) : undefined;
            return (
              <button
                key={item.id}
                onClick={() => item.contactId && onOpen(item.contactId)}
                className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-[var(--hover-bg)] transition-colors text-left"
              >
                {c?.photo ? (
                  <img src={c.photo} alt="" className="w-7 h-7 rounded-full object-cover flex-shrink-0" />
                ) : (
                  <div className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-semibold flex-shrink-0 border border-[var(--border)] text-[var(--text-secondary)]">
                    {(c?.name || item.text).charAt(0)}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] truncate font-medium">{item.text}</p>
                  {item.sub && (
                    <p className="text-[10px] text-[var(--text-secondary)] truncate">{item.sub}</p>
                  )}
                </div>
                <span className="text-[10.5px] font-medium tabular-nums text-[var(--text-secondary)]/70 flex-shrink-0">
                  {formatDistanceToNowStrict(item.date, { addSuffix: false })}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// ActionCard — mockup-style: label-first, icon top-left, number top-right
// ─────────────────────────────────────────────

interface ActionCardProps {
  icon: typeof MessageCircle;
  color: string;
  count: number;
  label: string;
  /** Optional per-avatar overrides — daysOwed (owed-reply card) or
   *  daysAwaited (awaiting-reply card). When set on an avatar, the ring
   *  color is computed from that, not from the parent card color. Keeps
   *  the avatar ring consistent with the network-map sunset palette. */
  avatars: { id: string; name: string; photo?: string; color?: string; daysSinceForColor?: number }[];
  onClick: () => void;
}

function ActionCard({ icon: Icon, color, count, label, avatars, onClick }: ActionCardProps) {
  return (
    <button
      onClick={onClick}
      onMouseMove={spotlightMove}
      className="glass-card shimmer-hover text-left p-5 flex flex-col gap-3.5 group h-full min-h-[120px] relative"
    >
      <div className="flex items-start justify-between">
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center"
          style={{ backgroundColor: color + '1f', color }}
        >
          <Icon size={17} strokeWidth={1.8} fill={Icon === Star ? color : 'transparent'} />
        </div>
        <ArrowRight size={13} className="text-[var(--text-secondary)]/40 group-hover:text-[var(--text-primary)] group-hover:translate-x-0.5 transition-all" />
      </div>
      <p className="text-[15px] leading-snug" style={{ color: 'var(--text-primary)' }}>
        <span className="font-semibold tracking-tight" style={{ color }}>{count}</span>
        <span className="font-medium"> {label}</span>
      </p>
      <div className="mt-auto">
        {avatars.length > 0 ? (
          <div className="flex items-center -space-x-1.5">
            {avatars.slice(0, 4).map((c) => {
              // Avatar ring color: per-contact recency from the network-map
              // palette when daysSinceForColor is supplied, else fall back to
              // the card's accent color. Keeps tiles visually aligned with
              // the graph — a contact's marble is the same color wherever it
              // shows up.
              const ringColor = typeof c.daysSinceForColor === 'number' ? nodeColor(c.daysSinceForColor) : color;
              return c.photo ? (
                <img
                  key={c.id} src={c.photo} alt=""
                  className="w-6 h-6 rounded-full ring-2 ring-[var(--bg-surface)] object-cover"
                />
              ) : (
                <div
                  key={c.id}
                  className="w-6 h-6 rounded-full ring-2 ring-[var(--bg-surface)] flex items-center justify-center text-[9px] font-semibold"
                  style={{ backgroundColor: ringColor + '24', color: ringColor }}
                >
                  {c.name.charAt(0)}
                </div>
              );
            })}
            {avatars.length > 4 && (
              <span className="text-[10px] text-[var(--text-secondary)] pl-3 self-center">
                +{avatars.length - 4}
              </span>
            )}
          </div>
        ) : (
          <span className="text-[10px] text-[var(--text-secondary)]/40">All caught up</span>
        )}
      </div>
    </button>
  );
}

// ─────────────────────────────────────────────
// AIInsightBanner — full-width purple gradient hero
// ─────────────────────────────────────────────

interface AIInsightBannerProps {
  insight?: { icon: string; text: string; color: string };
  onAction: () => void;
  insightCount: number;
}

function AIInsightBanner({ insight, onAction, insightCount }: AIInsightBannerProps) {
  return (
    <button
      onClick={onAction}
      className="relative w-full overflow-hidden rounded-2xl text-left px-5 py-4 md:px-6 md:py-5 group transition-all hover:shadow-[0_8px_24px_rgba(124,92,255,0.15)]"
      style={{
        background: 'linear-gradient(120deg, #efeaff 0%, #e9e1ff 60%, #ddd0ff 100%)',
        border: '1px solid rgba(124, 92, 255, 0.18)',
      }}
    >
      {/* Subtle lavender wash */}
      <div className="absolute -top-20 -right-10 w-56 h-56 rounded-full opacity-50 pointer-events-none" style={{
        background: 'radial-gradient(circle, rgba(167,139,250,0.18) 0%, transparent 65%)',
      }} />

      <div className="relative flex items-center gap-4">
        <div className="hidden sm:flex w-10 h-10 rounded-xl items-center justify-center flex-shrink-0"
          style={{ backgroundColor: 'rgba(124,92,255,0.12)', color: '#7c5cff' }}>
          <Zap size={15} strokeWidth={2.2} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-[9.5px] uppercase tracking-[0.18em] font-medium" style={{ color: '#7c5cff' }}>
              AI insight
            </span>
            {insightCount > 0 && (
              <span className="text-[9px] text-[var(--text-secondary)] tracking-wider">· {insightCount} this week</span>
            )}
          </div>
          <p className="text-[var(--text-primary)] text-[13.5px] md:text-[14.5px] font-medium leading-snug">
            {insight
              ? insight.text
              : 'Keep logging interactions — insights unlock as your network grows.'}
          </p>
        </div>

        <div className="flex-shrink-0 btn-lavender flex items-center gap-1.5 px-3.5 py-2 rounded-full text-[11.5px] font-medium transition-transform group-hover:translate-x-0.5 duration-200">
          Show me how <ArrowRight size={12} strokeWidth={2.4} />
        </div>
      </div>
    </button>
  );
}
