'use client';

import { useState, useMemo, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, Trash2, Mail, AlertTriangle, Inbox, ArrowRight, Plus, X as XIcon } from 'lucide-react';
import { useCrmStore } from '@/store/useCrmStore';
import { useToastStore } from '@/components/Toast';
import { format, isPast, isToday, addDays, endOfWeek, isWithinInterval } from 'date-fns';
import { getOwedReplies, lastSignalDate } from '@/lib/healthScore';
import { nodeColor } from '@/lib/nodeColors';
import { differenceInDays } from 'date-fns';
import SharedHeader from './SharedHeader';
import FirstRunBanner from './FirstRunBanner';
import { useFirstRun, isFirstRunActive } from '@/lib/firstRunContext';

type BucketId = 'overdue' | 'today' | 'upcoming' | 'waiting' | 'completed';

const typeColor: Record<string, string> = {
  'follow-up': '#7c5cff', send: '#4285F4', meeting: '#00C9A7', other: '#71717A',
};
const typeLabel: Record<string, string> = {
  'follow-up': 'Follow-up', send: 'Send', meeting: 'Meeting', other: 'Other',
};

export default function TasksView() {
  const { contacts, toggleTask, deleteTask, addTask, setSelectedContact, activeProjectFilter } = useCrmStore();
  const addToast = useToastStore((s) => s.addToast);
  const firstRun = useFirstRun();
  // Bucket is initially null — we pick a smart default below once we know
  // which buckets have tasks (so new users + users with no overdue land on
  // a populated bucket, not a confusing empty "Overdue" view).
  const [activeBucket, setActiveBucket] = useState<BucketId | null>(null);
  const [bucketWasSet, setBucketWasSet] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [draft, setDraft] = useState<{ title: string; contactId: string; due: string; type: 'follow-up' | 'send' | 'meeting' | 'other'; projectId: string }>({
    title: '', contactId: '', due: '', type: 'other', projectId: '',
  });

  // Listen for "open-add-task" event from elsewhere (sidebar project + button)
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      setDraft((d) => ({ ...d, projectId: detail.projectId || '' }));
      setShowAdd(true);
    };
    window.addEventListener('open-add-task', onOpen);
    return () => window.removeEventListener('open-add-task', onOpen);
  }, []);
  const [saving, setSaving] = useState(false);

  const promotedContacts = useMemo(() =>
    contacts.filter((c) => !c.is_self && c.is_promoted !== false).sort((a, b) => a.name.localeCompare(b.name)),
    [contacts],
  );

  const submitTask = async () => {
    if (!draft.title.trim() || !draft.contactId || saving) return;
    setSaving(true);
    try {
      await addTask({
        title: draft.title.trim(),
        contact_id: draft.contactId,
        type: draft.type,
        due_date: draft.due || undefined,
        project_id: draft.projectId || undefined,
      });
      addToast({ message: 'Task added', type: 'success', icon: 'task' });
      setDraft({ title: '', contactId: '', due: '', type: 'other', projectId: '' });
      setShowAdd(false);
    } catch (e: any) {
      addToast({ message: 'Failed to add task: ' + e.message, type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const allTasks = useMemo(() => contacts.flatMap((c) => {
    // Per-contact color via the network-map sunset palette so the dot/chip
    // for "associated contact" on a task matches that contact's marble on
    // the graph. Cold = blue, fresh = orange-red — same gradient everywhere.
    const lastSig = lastSignalDate(c);
    const daysSince = lastSig ? differenceInDays(new Date(), lastSig) : 9999;
    const palettedColor = nodeColor(daysSince);
    return c.tasks
      .filter(() => !activeProjectFilter || c.tasks.some((tt) => tt.project_id === activeProjectFilter))
      .map((t) => ({
        ...t,
        contactName: c.name,
        contactColor: palettedColor,
        contactPhoto: c.photo,
        contactId: c.id,
        contactEmail: c.email,
      }));
  }).filter((t) => !activeProjectFilter || t.project_id === activeProjectFilter), [contacts, activeProjectFilter]);

  const now = new Date();
  const thisWeekEnd = endOfWeek(now);

  const overdue = useMemo(() => allTasks
    .filter((t) => !t.completed && t.due_date && isPast(new Date(t.due_date + 'T23:59:59')) && !isToday(new Date(t.due_date + 'T12:00:00')))
    .sort((a, b) => new Date(a.due_date!).getTime() - new Date(b.due_date!).getTime()), [allTasks]);

  const todayTasks = useMemo(() => allTasks
    .filter((t) => !t.completed && t.due_date && isToday(new Date(t.due_date + 'T12:00:00')))
    .sort((a, b) => a.title.localeCompare(b.title)), [allTasks]);

  const upcoming = useMemo(() => allTasks
    .filter((t) => !t.completed && t.due_date && isWithinInterval(new Date(t.due_date + 'T12:00:00'), { start: addDays(now, 1), end: addDays(thisWeekEnd, 14) }))
    .sort((a, b) => new Date(a.due_date!).getTime() - new Date(b.due_date!).getTime()), [allTasks, thisWeekEnd]);

  const someday = useMemo(() => allTasks
    .filter((t) => !t.completed && !t.due_date)
    .sort((a, b) => a.title.localeCompare(b.title)), [allTasks]);

  const completed = useMemo(() => allTasks
    .filter((t) => t.completed)
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')), [allTasks]);

  // Emails awaiting your reply — surfaced as "Waiting on me"
  const waiting = useMemo(() => getOwedReplies(contacts as any, 3, 24), [contacts]);

  const totalOpen = overdue.length + todayTasks.length + upcoming.length + someday.length;

  // Smart default: land on the first non-empty bucket so new users / users
  // with no overdue actually see their tasks instead of an empty 'Overdue' page.
  // Priority: overdue → today → upcoming → waiting → completed.
  useEffect(() => {
    if (bucketWasSet || activeBucket !== null) return;
    if (overdue.length > 0) setActiveBucket('overdue');
    else if (todayTasks.length > 0) setActiveBucket('today');
    else if (upcoming.length > 0) setActiveBucket('upcoming');
    else if (waiting.length > 0) setActiveBucket('waiting');
    else setActiveBucket('today'); // empty zen state
  }, [overdue.length, todayTasks.length, upcoming.length, waiting.length, activeBucket, bucketWasSet]);

  const selectBucket = (id: BucketId) => { setBucketWasSet(true); setActiveBucket(id); };

  const kpiTiles: { id: BucketId; label: string; count: number; accent: string }[] = [
    { id: 'overdue', label: 'Overdue', count: overdue.length, accent: '#ef4444' },
    { id: 'today', label: 'Today', count: todayTasks.length, accent: '#f5c542' },
    { id: 'upcoming', label: 'Upcoming', count: upcoming.length, accent: '#7c5cff' },
    { id: 'waiting', label: 'Waiting on me', count: waiting.length, accent: '#22d3ee' },
    { id: 'completed', label: 'Completed', count: completed.length, accent: '#10b981' },
  ];

  // Bucket the active selection into groups for swimlanes
  type TaskRow = typeof allTasks[number];
  const bucketGroups: { label: string; color: string; tasks: TaskRow[] }[] = useMemo(() => {
    if (activeBucket === 'overdue') return [{ label: 'Overdue', color: '#ef4444', tasks: overdue }];
    if (activeBucket === 'today') return [{ label: 'Today', color: '#f5c542', tasks: todayTasks }];
    if (activeBucket === 'upcoming') {
      const week = upcoming.filter((t) => isWithinInterval(new Date(t.due_date! + 'T12:00:00'), { start: addDays(now, 1), end: thisWeekEnd }));
      const later = upcoming.filter((t) => !week.includes(t));
      const sd = someday;
      return [
        { label: 'This week', color: '#7c5cff', tasks: week },
        { label: 'Later', color: '#a78bfa', tasks: later },
        { label: 'No date', color: '#71717A', tasks: sd },
      ].filter((g) => g.tasks.length > 0);
    }
    if (activeBucket === 'completed') return [{ label: 'Completed', color: '#10b981', tasks: completed.slice(0, 40) }];
    return [];
  }, [activeBucket, overdue, todayTasks, upcoming, someday, completed, thisWeekEnd]);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <SharedHeader
        title="Tasks"
        subtitle={totalOpen > 0 ? `${totalOpen} open ${totalOpen === 1 ? 'task' : 'tasks'}` : 'All caught up'}
        showAdd={true}
        onAdd={() => setShowAdd(true)}
      />

      <div className="flex-1 overflow-y-auto pb-24 md:pb-6">
        <div className="max-w-7xl mx-auto p-4 md:p-6 pt-2">

          {/* First-run progress — tasks rely on email_stats + meetings, so
              new users see an empty list while backfill runs. Banner uses
              the same unified progress shown on Home + the network graph
              so the user always knows what's happening. */}
          {isFirstRunActive(firstRun) && <FirstRunBanner info={firstRun} />}

          {/* Inline add-task form */}
          {showAdd && (
            <motion.div
              initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
              className="mb-5 rounded-xl border border-[var(--accent)]/25 p-4"
              style={{ background: 'linear-gradient(135deg, rgba(124,92,255,0.06), rgba(124,92,255,0.01) 60%)' }}>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--accent)] font-medium">New task</span>
                <button onClick={() => { setShowAdd(false); setDraft({ title: '', contactId: '', due: '', type: 'other', projectId: '' }); }}
                  className="ml-auto p-1 rounded-md hover:bg-[var(--hover-bg)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
                  <XIcon size={12} />
                </button>
              </div>
              <input
                autoFocus
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter' && draft.title.trim() && draft.contactId) submitTask(); }}
                placeholder="What needs doing?"
                className="w-full bg-transparent text-[14px] focus:outline-none placeholder:text-[var(--text-secondary)]/40 pb-2.5 border-b border-[var(--border)] mb-3"
              />
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={draft.contactId}
                  onChange={(e) => setDraft({ ...draft, contactId: e.target.value })}
                  className="px-2.5 py-1.5 rounded-md bg-[var(--input-bg)] border border-[var(--border)] text-[12px] focus:outline-none focus:border-[var(--accent)]/40">
                  <option value="">Select contact…</option>
                  {promotedContacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <select
                  value={draft.type}
                  onChange={(e) => setDraft({ ...draft, type: e.target.value as any })}
                  className="px-2.5 py-1.5 rounded-md bg-[var(--input-bg)] border border-[var(--border)] text-[12px] focus:outline-none focus:border-[var(--accent)]/40">
                  <option value="follow-up">Follow-up</option>
                  <option value="send">Send</option>
                  <option value="meeting">Meeting</option>
                  <option value="other">Other</option>
                </select>
                <input
                  type="date"
                  value={draft.due}
                  onChange={(e) => setDraft({ ...draft, due: e.target.value })}
                  className="px-2.5 py-1.5 rounded-md bg-[var(--input-bg)] border border-[var(--border)] text-[12px] focus:outline-none focus:border-[var(--accent)]/40"
                />
                <button
                  onClick={submitTask}
                  disabled={!draft.title.trim() || !draft.contactId || saving}
                  className="ml-auto px-3.5 py-1.5 rounded-md text-[12px] font-medium bg-[var(--accent)] text-white hover:bg-[var(--accent-light)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5">
                  {saving ? 'Adding…' : <><Plus size={11} strokeWidth={2.4} /> Add task</>}
                </button>
              </div>
            </motion.div>
          )}

          {/* KPI strip */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2.5 mb-5">
            {kpiTiles.map((k) => {
              const active = activeBucket === k.id;
              return (
                <button key={k.id} onClick={() => selectBucket(k.id)}
                  className="flex items-center gap-3 px-3.5 py-2.5 rounded-xl border transition-all text-left"
                  style={{
                    borderColor: active ? k.accent + '50' : 'var(--border)',
                    background: active
                      ? `linear-gradient(135deg, ${k.accent}15, ${k.accent}05 60%)`
                      : 'linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01))',
                    boxShadow: active
                      ? `inset 0 1px 0 rgba(255,255,255,0.06), 0 4px 14px -8px ${k.accent}40`
                      : 'inset 0 1px 0 rgba(255,255,255,0.04)',
                  }}>
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-secondary)]/80 truncate">{k.label}</p>
                  </div>
                  <span className="text-[18px] font-semibold tabular-nums" style={{ color: active ? k.accent : 'var(--text-primary)' }}>
                    {k.count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Bucket body */}
          {activeBucket === 'waiting' ? (
            <WaitingPanel waiting={waiting} onOpen={setSelectedContact} />
          ) : (
            <div className="space-y-6">
              {bucketGroups.length === 0 ? (
                <EmptyState bucket={activeBucket || 'today'} />
              ) : (
                bucketGroups.map((g) => (
                  <SwimLane key={g.label} label={g.label} color={g.color} tasks={g.tasks}
                    overdueIds={new Set(overdue.map((t) => t.id))}
                    onToggle={(t) => {
                      toggleTask(t.id, !t.completed);
                      if (!t.completed) addToast({ message: `Done: ${t.title}`, type: 'success', icon: 'task' });
                    }}
                    onDelete={(t) => { deleteTask(t.id); addToast({ message: 'Deleted', type: 'info', icon: 'delete' }); }}
                    onOpen={setSelectedContact} />
                ))
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// SwimLane — horizontal-grid bucket
// ──────────────────────────────────────────────────────────────────────────
function SwimLane({
  label, color, tasks, overdueIds, onToggle, onDelete, onOpen,
}: {
  label: string; color: string;
  tasks: any[];
  overdueIds: Set<string>;
  onToggle: (t: any) => void;
  onDelete: (t: any) => void;
  onOpen: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const VISIBLE = 8;
  const showAll = expanded || tasks.length <= VISIBLE;
  const visible = showAll ? tasks : tasks.slice(0, VISIBLE);
  const remaining = tasks.length - VISIBLE;

  return (
    <section>
      <div className="flex items-baseline gap-2 mb-2 px-1">
        <span className="w-1 h-3 rounded-full" style={{ backgroundColor: color }} />
        <h2 className="text-[11px] font-medium tracking-[0.08em] uppercase" style={{ color }}>
          {label}
        </h2>
        <span className="text-[10.5px] text-[var(--text-secondary)]/60 tabular-nums">{tasks.length}</span>
      </div>
      {tasks.length === 0 ? (
        <p className="text-[12px] text-[var(--text-secondary)]/40 px-1 py-3">Nothing here.</p>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            <AnimatePresence>
              {visible.map((t) => (
                <TaskCard key={t.id} task={t} accent={color} isOverdue={overdueIds.has(t.id)}
                  onToggle={() => onToggle(t)} onDelete={() => onDelete(t)} onOpen={() => onOpen(t.contactId)} />
              ))}
            </AnimatePresence>
          </div>
          {!showAll && remaining > 0 && (
            <button onClick={() => setExpanded(true)}
              className="mt-3 text-[11.5px] text-[var(--accent)] hover:text-[var(--accent-light)] transition-colors flex items-center gap-1 px-1">
              + {remaining} more <ArrowRight size={11} />
            </button>
          )}
        </>
      )}
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// TaskCard — contact-first card
// ──────────────────────────────────────────────────────────────────────────
function TaskCard({
  task, accent, isOverdue, onToggle, onDelete, onOpen,
}: {
  task: any; accent: string; isOverdue: boolean;
  onToggle: () => void; onDelete: () => void; onOpen: () => void;
}) {
  const due = task.due_date ? new Date(task.due_date + 'T12:00:00') : null;
  const typeKey = (task.type || 'other') as keyof typeof typeColor;
  const tCol = typeColor[typeKey] || typeColor.other;
  const tLabel = typeLabel[typeKey] || 'Other';

  return (
    <motion.div layout initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
      className="group rounded-xl border border-[var(--border)] p-3 flex flex-col gap-2 transition-all hover:border-[var(--accent)]/30"
      style={{
        background: 'linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.015))',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)',
      }}>

      {/* Header: avatar + name + actions */}
      <div className="flex items-center gap-2">
        <button onClick={onOpen} className="flex items-center gap-2 min-w-0 flex-1 text-left">
          {task.contactPhoto ? (
            <img src={task.contactPhoto} alt="" className="w-5 h-5 rounded-full object-cover flex-shrink-0" />
          ) : (
            <div className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-medium flex-shrink-0"
              style={{ backgroundColor: task.contactColor + '25', color: task.contactColor }}>
              {task.contactName.charAt(0)}
            </div>
          )}
          <span className="text-[11.5px] truncate text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
            {task.contactName}
          </span>
        </button>
        <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
          {task.contactEmail && (
            <a href={`mailto:${task.contactEmail}?subject=${encodeURIComponent(`Re: ${task.title}`)}`}
              onClick={(e) => e.stopPropagation()}
              className="p-1 hover:text-[var(--accent)] transition-colors" title="Email">
              <Mail size={11} />
            </a>
          )}
          <button onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="p-1 hover:text-red-400 transition-colors" title="Delete">
            <Trash2 size={11} />
          </button>
        </div>
      </div>

      {/* Body: checkbox + title (siblings, not nested buttons) */}
      <div className="flex items-start gap-2">
        <button onClick={onToggle}
          className={`w-[15px] h-[15px] mt-0.5 rounded-full border flex items-center justify-center flex-shrink-0 transition-all ${
            task.completed
              ? 'bg-[var(--teal)]/20 border-[var(--teal)]/40'
              : 'border-[var(--text-secondary)]/30 hover:border-[var(--accent)]'
          }`}>
          {task.completed && <Check size={8} className="text-[var(--teal)]" />}
        </button>
        <button onClick={onOpen} className="text-left flex-1">
          <p className={`text-[13px] leading-snug min-h-[34px] ${task.completed ? 'line-through opacity-40' : ''}`}>
            {task.title}
          </p>
        </button>
      </div>

      {/* Footer: type tag + due */}
      <div className="flex items-center justify-between gap-2 pt-1 border-t border-[var(--border)]/60">
        <span className="text-[10px] px-1.5 py-0.5 rounded"
          style={{ backgroundColor: tCol + '14', color: tCol + 'dd' }}>
          {tLabel}
        </span>
        {due ? (
          <span className={`text-[10.5px] tabular-nums flex items-center gap-1 ${isOverdue ? 'text-[#ef4444]' : 'text-[var(--text-secondary)]/70'}`}>
            {isOverdue && <AlertTriangle size={9} />}
            {format(due, 'MMM d')}
          </span>
        ) : (
          <span className="text-[10.5px] text-[var(--text-secondary)]/40">No date</span>
        )}
      </div>
    </motion.div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// WaitingPanel — emails awaiting your reply (single swimlane)
// ──────────────────────────────────────────────────────────────────────────
function WaitingPanel({ waiting, onOpen }: { waiting: any[]; onOpen: (id: string) => void }) {
  if (waiting.length === 0) {
    return (
      <div className="rounded-xl border border-[var(--border)] py-12 text-center">
        <Inbox size={20} className="text-[var(--text-secondary)]/30 mx-auto mb-2" />
        <p className="text-[13px] text-[var(--text-secondary)]/60">Inbox zero on replies — well done.</p>
      </div>
    );
  }
  return (
    <section>
      <div className="flex items-baseline gap-2 mb-2 px-1">
        <span className="w-1 h-3 rounded-full" style={{ backgroundColor: '#22d3ee' }} />
        <h2 className="text-[11px] font-medium tracking-[0.08em] uppercase text-[#22d3ee]">Awaiting your reply</h2>
        <span className="text-[10.5px] text-[var(--text-secondary)]/60 tabular-nums">{waiting.length}</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {waiting.map((c) => (
          <button key={c.id} onClick={() => onOpen(c.id)}
            className="text-left rounded-xl border border-[var(--border)] p-3 flex flex-col gap-2 transition-all hover:border-[#22d3ee]/40"
            style={{
              background: 'linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.015))',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)',
            }}>
            <div className="flex items-center gap-2">
              {c.photo ? (
                <img src={c.photo} alt="" className="w-6 h-6 rounded-full object-cover" />
              ) : (
                <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-medium"
                  style={(() => {
                    const ds = lastSignalDate(c); const d = ds ? differenceInDays(new Date(), ds) : 9999;
                    const col = nodeColor(d);
                    return { backgroundColor: col + '25', color: col };
                  })()}>
                  {c.name.charAt(0)}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-[12.5px] truncate">{c.name}</p>
                {c.company && <p className="text-[10.5px] text-[var(--text-secondary)]/60 truncate">{c.company}</p>}
              </div>
            </div>
            <p className="text-[11.5px] text-[var(--text-secondary)] leading-snug">
              Sent <span className="text-[var(--text-primary)] tabular-nums">{c.daysOwed}d</span> ago — they replied, you haven't.
            </p>
            <div className="flex items-center justify-between pt-1 border-t border-[var(--border)]/60">
              <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ backgroundColor: '#22d3ee14', color: '#22d3eedd' }}>
                Reply
              </span>
              <span className="text-[10.5px] text-[var(--text-secondary)]/70 tabular-nums">
                {format(c.lastInbound, 'MMM d')}
              </span>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────────────
function EmptyState({ bucket }: { bucket: BucketId }) {
  const text: Record<BucketId, string> = {
    overdue: 'No overdue tasks — nice.',
    today: 'Nothing due today.',
    upcoming: 'Nothing scheduled.',
    waiting: 'Inbox zero on replies.',
    completed: 'No completed tasks yet.',
  };
  return (
    <div className="rounded-xl border border-[var(--border)] py-12 text-center">
      <p className="text-[13px] text-[var(--text-secondary)]/60">{text[bucket]}</p>
    </div>
  );
}
