'use client';

import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Clock, CheckSquare, MessageCircle, UserPlus, AlertCircle, FolderOpen, Plus, X, ArrowRight, TrendingUp } from 'lucide-react';
import { useCrmStore } from '@/store/useCrmStore';
import { format, differenceInDays, differenceInHours, isToday, isThisWeek, subDays } from 'date-fns';

interface ActivityFeedProps {
  onContactClick: (id: string) => void;
  onSearchFocus?: () => void;
  onProjectClick?: (projectId: string) => void;
}

export default function ActivityFeed({ onContactClick, onSearchFocus, onProjectClick }: ActivityFeedProps) {
  const { contacts, events, projects, addProject, setSelectedContact } = useCrmStore();
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');

  const safeDate = (d: string | undefined | null) => {
    if (!d) return new Date();
    const parsed = new Date(d);
    return isNaN(parsed.getTime()) ? new Date() : parsed;
  };

  // ── Smart summaries ──
  const summaries = useMemo(() => {
    const now = new Date();
    const blocks: { id: string; label: string; summary: string; detail?: string; icon: any; color: string; action?: () => void }[] = [];

    // Today's snapshot
    const todayContacts = contacts.filter((c) => isToday(safeDate(c.created_at)));
    const todayCompleted = contacts.flatMap((c) => c.tasks.filter((t) => t.completed && isToday(safeDate(t.created_at))));
    const todayInteractions = events.filter((e) => e.source === 'interaction' && isToday(safeDate(e.date + 'T12:00:00')));

    if (todayContacts.length > 0 || todayCompleted.length > 0 || todayInteractions.length > 0) {
      const parts = [];
      if (todayContacts.length > 0) parts.push(`${todayContacts.length} new contact${todayContacts.length > 1 ? 's' : ''}`);
      if (todayCompleted.length > 0) parts.push(`${todayCompleted.length} task${todayCompleted.length > 1 ? 's' : ''} done`);
      if (todayInteractions.length > 0) parts.push(`${todayInteractions.length} conversation${todayInteractions.length > 1 ? 's' : ''}`);
      blocks.push({
        id: 'today',
        label: 'Today',
        summary: parts.join(', '),
        icon: TrendingUp,
        color: 'var(--accent)',
      });
    }

    // Overdue tasks
    const overdueTasks = contacts.flatMap((c) =>
      c.tasks.filter((t) => !t.completed && t.due_date && new Date(t.due_date + 'T23:59:59') < now && !isToday(new Date(t.due_date + 'T12:00:00')))
        .map((t) => ({ ...t, contactName: c.name, contactId: c.id }))
    );
    if (overdueTasks.length > 0) {
      const names = [...new Set(overdueTasks.map((t) => t.contactName))].slice(0, 3);
      blocks.push({
        id: 'overdue',
        label: 'Overdue',
        summary: `${overdueTasks.length} task${overdueTasks.length > 1 ? 's' : ''} past due`,
        detail: names.join(', ') + (names.length < overdueTasks.length ? ` +${overdueTasks.length - names.length}` : ''),
        icon: Clock,
        color: 'var(--danger)',
        action: () => onContactClick('tasks'),
      });
    }

    // Due today
    const dueToday = contacts.flatMap((c) =>
      c.tasks.filter((t) => !t.completed && t.due_date && isToday(new Date(t.due_date + 'T12:00:00')))
        .map((t) => ({ ...t, contactName: c.name }))
    );
    if (dueToday.length > 0) {
      blocks.push({
        id: 'due-today',
        label: 'Due today',
        summary: dueToday.map((t) => t.title).slice(0, 2).join(', ') + (dueToday.length > 2 ? ` +${dueToday.length - 2}` : ''),
        detail: dueToday.map((t) => t.contactName).slice(0, 2).join(', '),
        icon: CheckSquare,
        color: 'var(--gold)',
        action: () => onContactClick('tasks'),
      });
    }

    // This week's activity
    const weekContacts = contacts.filter((c) => isThisWeek(safeDate(c.created_at)) && !isToday(safeDate(c.created_at)));
    const weekInteractions = events.filter((e) => e.source === 'interaction' && isThisWeek(safeDate(e.date + 'T12:00:00')) && !isToday(safeDate(e.date + 'T12:00:00')));
    const weekCompleted = contacts.flatMap((c) => c.tasks.filter((t) => t.completed && isThisWeek(safeDate(t.created_at)) && !isToday(safeDate(t.created_at))));

    if (weekContacts.length > 0 || weekInteractions.length > 0 || weekCompleted.length > 0) {
      const parts = [];
      if (weekContacts.length > 0) parts.push(`${weekContacts.length} added`);
      if (weekCompleted.length > 0) parts.push(`${weekCompleted.length} completed`);
      if (weekInteractions.length > 0) parts.push(`${weekInteractions.length} logged`);
      blocks.push({
        id: 'this-week',
        label: 'This week',
        summary: parts.join(' · '),
        icon: MessageCircle,
        color: 'var(--teal)',
      });
    }

    // Reconnect — previously-touched contacts going quiet. Skip never-contacted rows.
    const stale = contacts
      .filter((c) => c.last_contacted)
      .map((c) => ({ ...c, daysSince: differenceInDays(now, safeDate(c.last_contacted)) }))
      .filter((c) => c.daysSince >= 14)
      .sort((a, b) => b.daysSince - a.daysSince);

    if (stale.length > 0) {
      const names = stale.slice(0, 3).map((c) => c.name);
      blocks.push({
        id: 'reconnect',
        label: 'Reconnect',
        summary: `${stale.length} contact${stale.length > 1 ? 's' : ''} going quiet`,
        detail: names.join(', '),
        icon: AlertCircle,
        color: 'var(--text-secondary)',
      });
    }

    return blocks;
  }, [contacts, events]);

  // Recent contacts
  const recentContacts = useMemo(() =>
    [...contacts].sort((a, b) => safeDate(b.created_at).getTime() - safeDate(a.created_at).getTime()).slice(0, 6),
    [contacts]
  );

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Search */}
      <div className="px-4 pt-4 pb-2">
        <button
          onClick={() => { onSearchFocus?.(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true })); }}
          className="w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-[var(--text-secondary)]/50 hover:text-[var(--text-secondary)] hover:bg-[var(--hover-bg)] transition-colors shimmer-hover text-left"
        >
          <Search size={13} strokeWidth={1.5} />
          <span className="text-[12px]">Search</span>
          <span className="ml-auto text-[9px] text-[var(--text-secondary)]/30 tracking-wider">⌘K</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4">

        {/* ── Summary blocks ── */}
        {summaries.length > 0 && (
          <div className="mb-5 space-y-1">
            {summaries.map((block) => {
              const Icon = block.icon;
              return (
                <button
                  key={block.id}
                  onClick={block.action}
                  className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-[var(--hover-bg)] transition-all card-hover shimmer-hover group"
                >
                  <div className="flex items-center gap-2 mb-0.5">
                    <Icon size={11} style={{ color: block.color }} strokeWidth={1.5} className="opacity-60" />
                    <span className="text-[10px] font-medium tracking-[0.08em]" style={{ color: block.color }}>{block.label}</span>
                  </div>
                  <p className="text-[12px] text-[var(--text-primary)] leading-relaxed">{block.summary}</p>
                  {block.detail && (
                    <p className="text-[10px] text-[var(--text-secondary)]/50 mt-0.5">{block.detail}</p>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* ── Projects ── */}
        {(projects.filter((p) => p.status === 'active').length > 0 || showNewProject) && (
          <div className="mb-5">
            <div className="flex items-center justify-between mb-2 px-1">
              <h3 className="text-[10px] font-medium tracking-[0.1em] text-[var(--text-secondary)]/50">Projects</h3>
              <button onClick={() => setShowNewProject(!showNewProject)}
                className="text-[10px] text-[var(--accent)]/60 hover:text-[var(--accent)] transition-colors">
                {showNewProject ? 'Cancel' : '+ New'}
              </button>
            </div>

            <AnimatePresence>
              {showNewProject && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden mb-1.5">
                  <input value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newProjectName.trim()) { addProject({ name: newProjectName.trim() }); setNewProjectName(''); setShowNewProject(false); }
                      if (e.key === 'Escape') { setShowNewProject(false); setNewProjectName(''); }
                    }}
                    placeholder="Project name..."
                    className="w-full bg-transparent border-b border-[var(--border)] px-3 py-2 text-xs focus:outline-none focus:border-[var(--accent)]/30 transition-colors" autoFocus />
                </motion.div>
              )}
            </AnimatePresence>

            <div className="space-y-0.5">
              {projects.filter((p) => p.status === 'active').map((project) => {
                const taskCount = contacts.flatMap((c) => c.tasks).filter((t) => t.project_id === project.id && !t.completed).length;
                return (
                  <button key={project.id} onClick={() => onProjectClick?.(project.id)}
                    className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-[var(--hover-bg)] transition-colors shimmer-hover text-left">
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: project.color || '#6c63ff' }} />
                    <span className="text-[12px] flex-1 truncate">{project.name}</span>
                    <span className="text-[9px] text-[var(--text-secondary)]/40">
                      {project.contactIds.length}{taskCount > 0 ? ` · ${taskCount}` : ''}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {projects.filter((p) => p.status === 'active').length === 0 && !showNewProject && (
          <div className="mb-5">
            <button onClick={() => setShowNewProject(true)}
              className="w-full flex items-center gap-2.5 px-3 py-3 rounded-lg border border-dashed border-[var(--border)] hover:border-[var(--accent)]/20 hover:bg-[var(--hover-bg)] transition-all card-hover shimmer-hover text-left">
              <FolderOpen size={13} className="text-[var(--text-secondary)]/40" />
              <div>
                <p className="text-[12px]">Create a project</p>
                <p className="text-[10px] text-[var(--text-secondary)]/40">Group contacts, tasks & events</p>
              </div>
            </button>
          </div>
        )}

        <div className="divider mb-4" />

        {/* ── People ── */}
        <div>
          <div className="flex items-center justify-between mb-2 px-1">
            <h3 className="text-[10px] font-medium tracking-[0.1em] text-[var(--text-secondary)]/50">
              People
            </h3>
            <button onClick={() => onContactClick('contacts')} className="text-[10px] text-[var(--accent)]/60 hover:text-[var(--accent)] transition-colors flex items-center gap-0.5">
              All <ArrowRight size={9} />
            </button>
          </div>
          <div className="space-y-0.5">
            {recentContacts.map((contact) => {
              const pending = contact.tasks.filter((t) => !t.completed).length;
              const lastNote = contact.notes?.split('\n')[0]?.slice(0, 60);
              return (
                <button key={contact.id} onClick={() => setSelectedContact(contact.id)}
                  className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-[var(--hover-bg)] transition-colors shimmer-hover text-left">
                  {contact.photo ? (
                    <img src={contact.photo} alt="" className="w-7 h-7 rounded-full object-cover flex-shrink-0" />
                  ) : (
                    <div className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-semibold flex-shrink-0"
                      style={{ backgroundColor: (contact.color || '#6c63ff') + '0c', color: contact.color || '#6c63ff' }}>
                      {contact.name.charAt(0)}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-[12px] font-medium truncate">{contact.name}</p>
                    <p className="text-[10px] text-[var(--text-secondary)]/40 truncate">
                      {contact.company || lastNote || ''}
                    </p>
                  </div>
                  {pending > 0 && (
                    <span className="text-[9px] text-[var(--gold)]/60">{pending}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
