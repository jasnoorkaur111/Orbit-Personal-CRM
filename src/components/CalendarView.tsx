'use client';

import { useState, useMemo, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, Plus, X, RefreshCw } from 'lucide-react';
import { useCrmStore } from '@/store/useCrmStore';
import {
  format, startOfMonth, endOfMonth, startOfWeek, endOfWeek,
  addMonths, subMonths, addWeeks, subWeeks, eachDayOfInterval, isSameMonth, isToday, isSameDay,
  differenceInDays, differenceInMinutes,
} from 'date-fns';
import SharedHeader from './SharedHeader';

type ViewMode = 'month' | 'week';

const HOUR_HEIGHT = 48; // px per hour row
const DAY_START = 7;    // 7am
const DAY_END = 22;     // 10pm (exclusive — last visible row is 9pm-10pm)

// Source styling — used everywhere events render
const sourceStyle: Record<string, { bg: string; fg: string; label: string }> = {
  google_calendar:  { bg: '#1a73e818', fg: '#1a73e8', label: 'Google' },
  outlook_calendar: { bg: '#0078d418', fg: '#0078d4', label: 'Outlook' },
  interaction:      { bg: '#10b98118', fg: '#10b981', label: 'Conversation' },
  manual:           { bg: '#7c5cff18', fg: '#7c5cff', label: 'Manual' },
  task:             { bg: '#f5c54218', fg: '#d97706', label: 'Task' },
};

export default function CalendarView() {
  const { events, contacts, addEvent, deleteEvent, syncCalendar, calendarSyncing } = useCrmStore();
  const [viewMode, setViewMode] = useState<ViewMode>('week');
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [showAddEvent, setShowAddEvent] = useState(false);
  const [newEvent, setNewEvent] = useState({ title: '', time: '', contactId: '' });
  const [nowMinutes, setNowMinutes] = useState(0); // for "now" line

  // Tick "now" line every minute
  useEffect(() => {
    const tick = () => {
      const n = new Date();
      setNowMinutes(n.getHours() * 60 + n.getMinutes());
    };
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, []);

  // ── Days for current view ──
  const days = useMemo(() => {
    if (viewMode === 'month') {
      return eachDayOfInterval({ start: startOfWeek(startOfMonth(currentDate)), end: endOfWeek(endOfMonth(currentDate)) });
    }
    return eachDayOfInterval({ start: startOfWeek(currentDate), end: endOfWeek(currentDate) });
  }, [currentDate, viewMode]);

  const miniDays = useMemo(
    () => eachDayOfInterval({ start: startOfWeek(startOfMonth(currentDate)), end: endOfWeek(endOfMonth(currentDate)) }),
    [currentDate]
  );

  // Tasks rendered as events (used in MONTH view + selected-day detail only —
  // week view shows tasks as a single per-day count badge, not in the time grid)
  const taskEvents = useMemo(() => contacts.flatMap((c) =>
    c.tasks
      .filter((t) => t.due_date && !t.completed)
      .map((t) => ({
        id: 'task-' + t.id,
        title: t.title,
        date: t.due_date!,
        time: null as string | null,
        contact_id: c.id,
        contactName: c.name,
        contactColor: c.color,
        isTask: true,
        source: 'task',
      }))
  ), [contacts]);

  // Combine events + tasks, attach contact name/color
  const allEvents = useMemo(() => [
    ...events.map((e) => {
      const c = contacts.find((x) => x.id === e.contact_id);
      return { ...e, contactName: c?.name, contactColor: c?.color, isTask: false };
    }),
    ...taskEvents,
  ], [events, contacts, taskEvents]);

  // Real calendar events only (no tasks) — feeds the WEEK time-grid
  const realEvents = useMemo(() => events.map((e) => {
    const c = contacts.find((x) => x.id === e.contact_id);
    return { ...e, contactName: c?.name, contactColor: c?.color, isTask: false };
  }), [events, contacts]);

  // Tasks-per-day count (week view shows this as a "N due" badge next to the date)
  const tasksPerDay = useMemo(() => {
    const m: Record<string, number> = {};
    for (const t of taskEvents) m[t.date] = (m[t.date] || 0) + 1;
    return m;
  }, [taskEvents]);

  // ── Events for a given day ──
  const eventsForDay = (day: Date) =>
    allEvents.filter((e) => isSameDay(new Date(e.date + 'T12:00:00'), day));

  // ── Upcoming (right rail) ──
  const upcoming = useMemo(() => {
    const now = new Date();
    return allEvents
      .map((e) => ({ ...e, dateObj: new Date(e.date + 'T12:00:00') }))
      .filter((e) => e.dateObj >= now)
      .sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime())
      .slice(0, 6);
  }, [allEvents]);

  // ── Scheduling insight ──
  const insight = useMemo(() => {
    const now = new Date();
    const next7 = allEvents.filter((e) => {
      const d = new Date(e.date + 'T12:00:00');
      return d >= now && differenceInDays(d, now) <= 7;
    });
    if (next7.length === 0) return 'Your week looks open — good time to schedule reach-outs.';
    const counts: Record<string, number> = {};
    next7.forEach((e) => { counts[e.date] = (counts[e.date] || 0) + 1; });
    const busiest = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (busiest[1] >= 3) {
      return `${format(new Date(busiest[0] + 'T12:00:00'), 'EEEE')} is packed — ${busiest[1]} events.`;
    }
    return `${next7.length} ${next7.length === 1 ? 'event' : 'events'} this week.`;
  }, [allEvents]);

  const handleAddEvent = async () => {
    if (!newEvent.title || !selectedDate) return;
    await addEvent({
      title: newEvent.title,
      date: format(selectedDate, 'yyyy-MM-dd'),
      time: newEvent.time || undefined,
      contact_id: newEvent.contactId || undefined,
    });
    setNewEvent({ title: '', time: '', contactId: '' });
    setShowAddEvent(false);
  };

  const goPrev = () => setCurrentDate(viewMode === 'month' ? subMonths(currentDate, 1) : subWeeks(currentDate, 1));
  const goNext = () => setCurrentDate(viewMode === 'month' ? addMonths(currentDate, 1) : addWeeks(currentDate, 1));

  const headerLabel = viewMode === 'month'
    ? format(currentDate, 'MMMM yyyy')
    : `${format(startOfWeek(currentDate), 'MMM d')} – ${format(endOfWeek(currentDate), 'MMM d, yyyy')}`;

  const HOURS = Array.from({ length: DAY_END - DAY_START }, (_, i) => DAY_START + i); // 7..21

  // Parse time string "HH:MM:SS" → minutes since midnight
  const timeToMinutes = (t: string | null | undefined) => {
    if (!t) return null;
    const [h, m] = t.split(':').map(Number);
    return h * 60 + (m || 0);
  };

  // ── Side-by-side overlap layout (Google-Cal-style) ──
  // Greedy: sort by start, place each event in the leftmost column that
  // doesn't already contain an overlapping event. Returns one record per
  // event with { col, totalCols } so it can be positioned at
  // left = col/totalCols, width = 1/totalCols.
  type Laid = { e: any; startMin: number; endMin: number; col: number; totalCols: number };
  const layoutDay = (dayEvents: any[]): Laid[] => {
    const items = dayEvents
      .map((e) => {
        const s = timeToMinutes(e.time);
        if (s == null) return null;
        const eEnd = timeToMinutes((e as any).end_time);
        const end = eEnd && eEnd > s ? eEnd : s + 30;
        return { e, startMin: s, endMin: end };
      })
      .filter((x): x is { e: any; startMin: number; endMin: number } => !!x)
      .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

    const result: Laid[] = [];
    let cluster: { item: typeof items[number]; col: number }[] = [];
    let clusterEnd = -1;

    const flush = () => {
      if (cluster.length === 0) return;
      const total = Math.max(...cluster.map((c) => c.col)) + 1;
      for (const c of cluster) result.push({ ...c.item, col: c.col, totalCols: total });
      cluster = [];
      clusterEnd = -1;
    };

    for (const item of items) {
      if (clusterEnd !== -1 && item.startMin >= clusterEnd) flush();
      // Find leftmost col not currently busy at item.startMin
      const busy = new Set<number>();
      for (const c of cluster) if (c.item.endMin > item.startMin) busy.add(c.col);
      let col = 0;
      while (busy.has(col)) col++;
      cluster.push({ item, col });
      clusterEnd = Math.max(clusterEnd, item.endMin);
    }
    flush();
    return result;
  };

  // Auto-scroll the week-view time grid to current time on mount + when
  // switching back into week view (puts "now" near the top of the visible area)
  const weekScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (viewMode !== 'week') return;
    const el = weekScrollRef.current;
    if (!el) return;
    const targetMin = nowMinutes - DAY_START * 60 - 120; // 2hrs of context above
    const topPx = (targetMin / 60) * HOUR_HEIGHT;
    el.scrollTop = Math.max(0, topPx);
  }, [viewMode]); // deliberately not depending on nowMinutes — only on mode change

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <SharedHeader
        title="Calendar"
        subtitle={`${allEvents.length} events · ${events.length} from calendar feeds`}
        showAdd={false}
      />
      <div className="flex flex-1 overflow-hidden">
        {/* Main column */}
        <div className="flex-1 overflow-y-auto pb-24 md:pb-6">
          <div className="max-w-[1100px] mx-auto p-4 md:p-6 pt-1">
            {/* Top toolbar */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <h2 className="text-[15px] font-medium tracking-tight">{headerLabel}</h2>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="flex items-center bg-[var(--input-bg)] rounded-lg p-0.5 border border-[var(--border)]">
                  {(['month', 'week'] as ViewMode[]).map((m) => (
                    <button key={m} onClick={() => setViewMode(m)}
                      className={`px-2.5 py-1 text-[11px] rounded-md capitalize transition-all ${
                        viewMode === m ? 'bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-secondary)]'
                      }`}>
                      {m}
                    </button>
                  ))}
                </div>
                <button onClick={goPrev} className="p-1.5 hover:bg-[var(--hover-bg)] rounded-lg transition-colors">
                  <ChevronLeft size={14} />
                </button>
                <button onClick={() => setCurrentDate(new Date())}
                  className="px-2.5 py-1 text-[11px] rounded-lg border border-[var(--border)] hover:border-[var(--accent)]/40 transition-colors">
                  Today
                </button>
                <button onClick={goNext} className="p-1.5 hover:bg-[var(--hover-bg)] rounded-lg transition-colors">
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>

            {/* ─── MONTH VIEW ─── */}
            {viewMode === 'month' && (
              <div className="rounded-xl overflow-hidden border border-[var(--border)] bg-[var(--bg-surface)]">
                <div className="grid grid-cols-7 border-b border-[var(--border)]">
                  {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
                    <div key={d} className="text-center text-[10px] uppercase tracking-wider text-[var(--text-secondary)] py-2 border-r border-[var(--border)] last:border-r-0">
                      {d}
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-7">
                  {days.map((day, i) => {
                    const dayEvents = eventsForDay(day);
                    const isSelected = selectedDate && isSameDay(day, selectedDate);
                    const isCurrentMonth = isSameMonth(day, currentDate);
                    return (
                      <div key={i} onClick={() => setSelectedDate(day)}
                        className={`min-h-[88px] p-1.5 cursor-pointer transition-colors border-r border-b border-[var(--border)] last:border-r-0 ${
                          isSelected ? 'bg-[var(--accent)]/8' : 'hover:bg-[var(--hover-bg)]'
                        } ${!isCurrentMonth ? 'opacity-40' : ''}`}>
                        <div className="flex items-center justify-end mb-1">
                          <span className={`text-[11px] font-medium ${
                            isToday(day)
                              ? 'w-5 h-5 rounded-full bg-[var(--accent)] text-white flex items-center justify-center'
                              : 'text-[var(--text-primary)]'
                          }`}>
                            {format(day, 'd')}
                          </span>
                        </div>
                        <div className="space-y-0.5">
                          {dayEvents.slice(0, 3).map((e) => {
                            const s = sourceStyle[e.source] || sourceStyle.manual;
                            return (
                              <div key={e.id} className="text-[10px] px-1.5 py-0.5 rounded truncate font-medium"
                                style={{ backgroundColor: s.bg, color: s.fg }}>
                                {e.time ? `${e.time.slice(0, 5)} ` : ''}{e.title}
                              </div>
                            );
                          })}
                          {dayEvents.length > 3 && (
                            <span className="text-[9.5px] text-[var(--text-secondary)] pl-1">+{dayEvents.length - 3} more</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ─── WEEK VIEW — Google Cal style with overlap layout ─── */}
            {viewMode === 'week' && (
              <div className="rounded-xl overflow-hidden border border-[var(--border)] bg-[var(--bg-surface)] flex flex-col"
                style={{ maxHeight: 'calc(100vh - 200px)' }}>
                {/* Sticky day headers */}
                <div className="grid grid-cols-[56px_repeat(7,1fr)] border-b border-[var(--border)] bg-[var(--bg-surface)] flex-shrink-0">
                  <div />
                  {days.map((day, i) => {
                    const today = isToday(day);
                    const taskCount = tasksPerDay[format(day, 'yyyy-MM-dd')] || 0;
                    return (
                      <button key={i} onClick={() => setSelectedDate(day)}
                        className={`py-2.5 text-center border-l border-[var(--border)] transition-colors ${today ? 'bg-[var(--accent)]/4' : 'hover:bg-[var(--hover-bg)]'}`}>
                        <div className={`text-[10px] uppercase tracking-wider font-medium ${today ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'}`}>
                          {format(day, 'EEE')}
                        </div>
                        <div className={`mt-1 text-[18px] font-semibold leading-none ${
                          today
                            ? 'mx-auto w-8 h-8 rounded-full bg-[var(--accent)] text-white flex items-center justify-center text-[15px]'
                            : 'text-[var(--text-primary)]'
                        }`}>
                          {format(day, 'd')}
                        </div>
                        {taskCount > 0 && (
                          <div className="mt-1 text-[9.5px] text-[#d97706] tabular-nums">{taskCount} task{taskCount === 1 ? '' : 's'}</div>
                        )}
                      </button>
                    );
                  })}
                </div>

                {/* All-day strip — only for REAL all-day events (no time) from calendar feeds.
                    Tasks no longer appear here; they're shown as a count badge in the header. */}
                {(() => {
                  const hasAllDay = days.some((d) => realEvents.some((e) => isSameDay(new Date(e.date + 'T12:00:00'), d) && !e.time));
                  if (!hasAllDay) return null;
                  const MAX_VISIBLE = 2;
                  return (
                    <div className="grid grid-cols-[56px_repeat(7,1fr)] border-b border-[var(--border)] bg-[var(--bg-surface)] flex-shrink-0">
                      <div className="text-[8.5px] uppercase tracking-wider text-[var(--text-secondary)] flex items-center justify-end pr-1.5 py-1.5">
                        all day
                      </div>
                      {days.map((day, i) => {
                        const allDay = realEvents.filter((e) => isSameDay(new Date(e.date + 'T12:00:00'), day) && !e.time);
                        const visible = allDay.slice(0, MAX_VISIBLE);
                        const extra = allDay.length - visible.length;
                        const today = isToday(day);
                        return (
                          // `min-w-0` is critical — without it, a long all-day
                          // event title stretches its grid cell wider than 1fr
                          // and pushes neighbours out of alignment with the
                          // headers above. `overflow-hidden` ensures the chip's
                          // truncate actually clips.
                          <div key={i} className={`border-l border-[var(--border)] p-1 space-y-0.5 min-w-0 overflow-hidden ${today ? 'bg-[var(--accent)]/3' : ''}`}>
                            {visible.map((e) => {
                              const s = sourceStyle[e.source] || sourceStyle.manual;
                              return (
                                <div key={e.id} className="text-[10px] px-1.5 py-0.5 rounded truncate font-medium block w-full"
                                  style={{ backgroundColor: s.bg, color: s.fg }}
                                  title={e.title}>
                                  {e.title}
                                </div>
                              );
                            })}
                            {extra > 0 && (
                              <button onClick={() => setSelectedDate(day)}
                                className="text-[9.5px] text-[var(--text-secondary)]/70 hover:text-[var(--accent)] pl-1">
                                +{extra} more
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}

                {/* Scrollable time grid */}
                <div ref={weekScrollRef} className="flex-1 overflow-y-auto">
                  <div className="relative grid grid-cols-[56px_repeat(7,1fr)]" style={{ minHeight: HOURS.length * HOUR_HEIGHT }}>
                    {/* Hour labels column */}
                    <div className="border-r border-[var(--border)]">
                      {HOURS.map((hr) => (
                        <div key={hr} className="text-[10px] text-[var(--text-secondary)] text-right pr-2 -mt-1.5 tabular-nums"
                          style={{ height: HOUR_HEIGHT }}>
                          {hr === 12 ? '12 PM' : hr > 12 ? `${hr - 12} PM` : `${hr} AM`}
                        </div>
                      ))}
                    </div>

                    {/* 7 day columns */}
                    {days.map((day, i) => {
                      const dayTimed = realEvents.filter((e) => isSameDay(new Date(e.date + 'T12:00:00'), day) && !!e.time);
                      const laid = layoutDay(dayTimed);
                      const today = isToday(day);
                      return (
                        <div key={i} className={`relative border-l border-[var(--border)] cursor-pointer ${today ? 'bg-[var(--accent)]/3' : ''}`}
                          onClick={() => setSelectedDate(day)}>
                          {/* Hour cell lines */}
                          {HOURS.map((hr) => (
                            <div key={hr} className="border-b border-[var(--border)]/50 hover:bg-[var(--hover-bg)]/40 transition-colors"
                              style={{ height: HOUR_HEIGHT }} />
                          ))}

                          {/* Today: current-time line (today column only, full width within it) */}
                          {today && (() => {
                            const topPx = ((nowMinutes - DAY_START * 60) / 60) * HOUR_HEIGHT;
                            if (topPx < 0 || topPx > HOURS.length * HOUR_HEIGHT) return null;
                            return (
                              <div className="absolute left-0 right-0 pointer-events-none z-30" style={{ top: topPx - 1 }}>
                                <div className="h-[1.5px] bg-[#ef4444]" />
                                <div className="absolute -left-1.5 -top-[4px] w-2.5 h-2.5 rounded-full bg-[#ef4444] shadow-[0_0_0_2px_var(--bg-surface)]" />
                              </div>
                            );
                          })()}

                          {/* Timed events with side-by-side overlap layout */}
                          {laid.map(({ e, startMin, endMin, col, totalCols }) => {
                            const top = ((startMin - DAY_START * 60) / 60) * HOUR_HEIGHT;
                            if (top < 0 || top > HOURS.length * HOUR_HEIGHT) return null;
                            const durationMin = endMin - startMin;
                            const heightPx = Math.max(22, (durationMin / 60) * HOUR_HEIGHT - 2);
                            const s = sourceStyle[e.source] || sourceStyle.manual;
                            const widthPct = 100 / totalCols;
                            const showEndTime = durationMin >= 45;
                            const isShort = heightPx < 36;
                            return (
                              <div key={e.id}
                                className="absolute rounded-md cursor-pointer hover:shadow-md hover:z-20 transition-all z-10 overflow-hidden"
                                style={{
                                  top: top + 1,
                                  height: heightPx,
                                  left: `calc(${col * widthPct}% + 2px)`,
                                  width: `calc(${widthPct}% - 4px)`,
                                  backgroundColor: s.bg,
                                  borderLeft: `3px solid ${s.fg}`,
                                  padding: isShort ? '2px 6px' : '4px 6px',
                                }}
                                title={`${e.title} · ${e.time?.slice(0, 5)}${(e as any).end_time ? '-' + (e as any).end_time.slice(0, 5) : ''}${e.contactName ? ' · ' + e.contactName : ''}`}>
                                <div className="leading-tight" style={{ color: s.fg }}>
                                  <div className={`font-medium truncate ${isShort ? 'text-[10px]' : 'text-[11px]'}`}>
                                    {e.title}
                                  </div>
                                  {!isShort && showEndTime && (
                                    <div className="text-[9.5px] opacity-75 mt-0.5 tabular-nums truncate">
                                      {e.time?.slice(0, 5)}{(e as any).end_time ? `–${(e as any).end_time.slice(0, 5)}` : ''}
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* Selected date detail */}
            {selectedDate && (
              <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                className="mt-5 rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-[13px] font-medium">{format(selectedDate, 'EEEE, MMMM d')}</h3>
                  <button onClick={() => setShowAddEvent(!showAddEvent)}
                    className="flex items-center gap-1 text-[11px] text-[var(--accent)] hover:text-[var(--accent-light)] transition-colors">
                    <Plus size={11} /> Add event
                  </button>
                </div>

                {showAddEvent && (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
                    className="mb-3 rounded-lg p-3 space-y-2 bg-[var(--input-bg)]">
                    <input value={newEvent.title} onChange={(e) => setNewEvent({ ...newEvent, title: e.target.value })}
                      placeholder="Event title..."
                      className="w-full px-2.5 py-1.5 rounded-md bg-[var(--bg-surface)] border border-[var(--border)] text-[12px] focus:outline-none focus:border-[var(--accent)]" />
                    <div className="flex gap-2">
                      <input type="time" value={newEvent.time} onChange={(e) => setNewEvent({ ...newEvent, time: e.target.value })}
                        className="px-2 py-1.5 rounded-md bg-[var(--bg-surface)] border border-[var(--border)] text-[12px] focus:outline-none focus:border-[var(--accent)]" />
                      <select value={newEvent.contactId} onChange={(e) => setNewEvent({ ...newEvent, contactId: e.target.value })}
                        className="flex-1 px-2 py-1.5 rounded-md bg-[var(--bg-surface)] border border-[var(--border)] text-[12px] focus:outline-none focus:border-[var(--accent)]">
                        <option value="">No linked contact</option>
                        {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </div>
                    <button onClick={handleAddEvent} className="btn-lavender w-full py-2 rounded-md text-[12px] font-medium">Add event</button>
                  </motion.div>
                )}

                <div className="space-y-1.5">
                  {eventsForDay(selectedDate).map((e) => {
                    const s = sourceStyle[e.source] || sourceStyle.manual;
                    return (
                      <div key={e.id} className="flex items-center justify-between rounded-lg p-2 group hover:bg-[var(--hover-bg)] transition-colors">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-1 h-8 rounded-full flex-shrink-0" style={{ backgroundColor: s.fg }} />
                          <div className="min-w-0">
                            <p className="text-[12.5px] truncate">{e.title}</p>
                            <p className="text-[10px] text-[var(--text-secondary)] mt-0.5">
                              <span style={{ color: s.fg }}>{s.label}</span>
                              {e.time && ` · ${e.time.slice(0, 5)}`}
                              {e.contactName && ` · ${e.contactName}`}
                            </p>
                          </div>
                        </div>
                        {!(e as any).isTask && e.source !== 'google_calendar' && e.source !== 'outlook_calendar' && (
                          <button onClick={() => deleteEvent(e.id)}
                            className="opacity-0 group-hover:opacity-100 p-1 hover:text-[var(--danger)] transition-all">
                            <X size={12} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                  {eventsForDay(selectedDate).length === 0 && (
                    <p className="text-[11.5px] text-[var(--text-secondary)] text-center py-3">No events for this day</p>
                  )}
                </div>
              </motion.div>
            )}
          </div>
        </div>

        {/* Right rail */}
        <aside className="hidden lg:flex flex-col w-[260px] border-l border-[var(--border)] overflow-y-auto p-4 gap-3 bg-[var(--bg-surface)]/40">
          {/* Mini calendar */}
          <div className="glass-card p-4">
            <h3 className="text-[10px] uppercase tracking-[0.12em] font-medium text-[var(--text-secondary)] mb-2">
              {format(currentDate, 'MMM yyyy')}
            </h3>
            <div className="grid grid-cols-7 gap-0.5 mb-1">
              {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
                <div key={i} className="text-center text-[8.5px] text-[var(--text-secondary)] py-0.5">{d}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-0.5">
              {miniDays.map((day, i) => {
                const hasEvents = eventsForDay(day).length > 0;
                return (
                  <button key={i} onClick={() => { setCurrentDate(day); setSelectedDate(day); }}
                    className={`relative aspect-square text-[10px] rounded transition-colors ${
                      isToday(day)
                        ? 'bg-[var(--accent)] text-white font-semibold'
                        : isSameMonth(day, currentDate) ? 'hover:bg-[var(--hover-bg)]' : 'opacity-30 hover:opacity-60'
                    }`}>
                    {format(day, 'd')}
                    {hasEvents && !isToday(day) && (
                      <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-[var(--accent)]" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Upcoming */}
          <div className="glass-card p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-[10px] uppercase tracking-[0.12em] font-medium text-[var(--text-secondary)]">Upcoming</h3>
              <button onClick={() => syncCalendar()} disabled={calendarSyncing}
                className="flex items-center gap-1 text-[10px] text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors disabled:opacity-50"
                title="Sync calendar feeds">
                <RefreshCw size={10} className={calendarSyncing ? 'animate-spin' : ''} />
                {calendarSyncing ? 'Syncing' : 'Sync'}
              </button>
            </div>
            {upcoming.length === 0 ? (
              <p className="text-[11px] text-[var(--text-secondary)]/50 py-3 text-center">No upcoming events</p>
            ) : (
              <div className="space-y-1">
                {upcoming.map((e) => {
                  const s = sourceStyle[e.source] || sourceStyle.manual;
                  return (
                    <div key={e.id} className="flex items-start gap-2">
                      <div className="w-0.5 h-9 rounded-full flex-shrink-0 mt-0.5" style={{ backgroundColor: s.fg }} />
                      <div className="flex-1 min-w-0">
                        <p className="text-[11.5px] truncate leading-tight">{e.title}</p>
                        <p className="text-[9.5px] text-[var(--text-secondary)] mt-0.5 truncate">
                          {format(e.dateObj, 'EEE, MMM d')}{e.time ? ` · ${e.time.slice(0, 5)}` : ''}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Scheduling insight */}
          <div className="glass-card p-4">
            <h3 className="text-[10px] uppercase tracking-[0.12em] font-medium text-[var(--text-secondary)] mb-2">Insight</h3>
            <p className="text-[11.5px] text-[var(--text-primary)]/85 leading-relaxed">{insight}</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
