'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { Users, Calendar, CheckSquare, Network, Settings, Mic, FolderOpen, Plus, X, Clock, AlertCircle, Home, Activity, Inbox, ChevronDown } from 'lucide-react';
import { useCrmStore } from '@/store/useCrmStore';
import { supabase } from '@/lib/supabase';
import ThemeToggle from '@/components/ThemeToggle';
import OrbitLogo from '@/components/OrbitLogo';
import { differenceInDays, eachDayOfInterval, subDays, isSameDay } from 'date-fns';
import { getDailyReachOuts } from '@/lib/healthScore';

interface SidebarProps {
  activeView: string;
  setActiveView: (view: string) => void;
  onMobileMic?: () => void;
  onProjectClick?: (projectId: string) => void;
}

export default function Sidebar({ activeView, setActiveView, onMobileMic, onProjectClick }: SidebarProps) {
  const { contacts, events, projects, addProject, setSelectedContact } = useCrmStore();
  const router = useRouter();
  const totalPendingTasks = contacts.reduce(
    (acc, c) => acc + c.tasks.filter((t) => !t.completed).length, 0
  );

  const [draftCount, setDraftCount] = useState(0);
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');

  // Collapse/expand state for sidebar sections — persisted so user choice
  // sticks across reloads. Default CLOSED so the sidebar reads as a clean
  // table of contents until the user opts to expand a section.
  const [reachOutOpen, setReachOutOpen] = useState(() => {
    if (typeof window === 'undefined') return false;
    const v = localStorage.getItem('sidebar-reach-out-open-v2');
    return v === '1';
  });
  const [projectsOpen, setProjectsOpen] = useState(() => {
    if (typeof window === 'undefined') return false;
    const v = localStorage.getItem('sidebar-projects-open-v2');
    return v === '1';
  });
  const toggleReachOut = () => setReachOutOpen((v) => { try { localStorage.setItem('sidebar-reach-out-open-v2', v ? '0' : '1'); } catch {} return !v; });
  const toggleProjects = () => setProjectsOpen((v) => { try { localStorage.setItem('sidebar-projects-open-v2', v ? '0' : '1'); } catch {} return !v; });

  useEffect(() => {
    const check = () => {
      try { setDraftCount(JSON.parse(localStorage.getItem('crm-voice-drafts') || '[]').length); } catch { setDraftCount(0); }
    };
    check();
    const interval = setInterval(check, 2000);
    return () => clearInterval(interval);
  }, []);

  const [pendingSuggestions, setPendingSuggestions] = useState(0);
  useEffect(() => {
    let cancel = false;
    const fetchCount = async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;
        const { count } = await supabase
          .from('connection_suggestions')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .eq('status', 'pending');
        if (!cancel) setPendingSuggestions(count || 0);
      } catch {}
    };
    fetchCount();
    const interval = setInterval(fetchCount, 60_000);
    return () => { cancel = true; clearInterval(interval); };
  }, []);

  const discoveredCount = contacts.filter((c) => c.is_promoted === false).length;
  // Combined Inbox badge — Suggestions + Discovered are both "review and act"
  const inboxBadge = discoveredCount + pendingSuggestions;

  const navItems = [
    { id: 'home', icon: Home, label: 'Home' },
    { id: 'graph', icon: Network, label: 'Network' },
    { id: 'contacts', icon: Users, label: 'People' },
    { id: 'tasks', icon: CheckSquare, label: 'Tasks', badge: totalPendingTasks },
    { id: 'calendar', icon: Calendar, label: 'Calendar' },
    // Inbox: moved to the top-right of every page via the SharedHeader inbox icon.
    // Insights: merged into the Home view.
  ];

  const activeProjects = projects.filter((p) => p.status === 'active');

  // Smart stats
  const stats = useMemo(() => {
    const now = new Date();
    const safeDate = (d: string | undefined | null) => {
      if (!d) return new Date();
      const p = new Date(d);
      return isNaN(p.getTime()) ? new Date() : p;
    };

    const overdue = contacts.flatMap((c) =>
      c.tasks.filter((t) => !t.completed && t.due_date && new Date(t.due_date + 'T23:59:59') < now)
    ).length;

    // Stale = previously-contacted but going quiet. Never-contacted ≠ stale.
    const stale = contacts.filter((c) => {
      if (!c.last_contacted) return false;
      return differenceInDays(now, safeDate(c.last_contacted)) >= 14;
    }).length;

    return { total: contacts.length, overdue, stale };
  }, [contacts]);

  // Full ranked list so we can show the true count; sidebar renders the top 5.
  const reachOutsAll = useMemo(() => getDailyReachOuts(contacts, 999), [contacts]);
  const reachOuts = useMemo(() => reachOutsAll.slice(0, 5), [reachOutsAll]);
  const reachOutsTotal = reachOutsAll.length;

  // ── 14-day activity sparkline ──
  const activitySpark = useMemo(() => {
    const days = eachDayOfInterval({ start: subDays(new Date(), 13), end: new Date() });
    const safeDate = (d: string | undefined | null) => {
      if (!d) return new Date();
      const p = new Date(d);
      return isNaN(p.getTime()) ? new Date() : p;
    };
    return days.map((d) => {
      const added = contacts.filter((c) => isSameDay(safeDate(c.created_at), d)).length;
      const evts = events.filter((e) => isSameDay(safeDate(e.date + 'T12:00:00'), d)).length;
      const tasksDone = contacts.flatMap((c) => c.tasks).filter((t) => t.completed && isSameDay(safeDate(t.created_at), d)).length;
      return { date: d, value: added + evts + tasksDone };
    });
  }, [contacts, events]);

  const activityTotal = activitySpark.reduce((s, p) => s + p.value, 0);

  const sparkPath = useMemo(() => {
    const w = 140;
    const h = 32;
    const max = Math.max(...activitySpark.map((p) => p.value), 1);
    return activitySpark.map((p, i) => {
      const x = (i / Math.max(activitySpark.length - 1, 1)) * w;
      const y = h - (p.value / max) * h;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  }, [activitySpark]);

  const sparkArea = sparkPath ? `${sparkPath} L 140,32 L 0,32 Z` : '';

  return (
    <>
      {/* Desktop sidebar — no entry animation. The slide-in from x:-200
          played every time anything caused the AppShell to remount, which
          read as a constant glitch. Sidebar should just be there. */}
      <aside
        className="hidden md:flex fixed left-0 top-0 h-full w-[200px] z-30 flex-col
                   bg-[var(--bg-surface)] border-r border-[var(--border)]"
      >
        {/* Logo */}
        <div className="flex items-center gap-2.5 px-5 py-5">
          <div className="w-7 h-7 rounded-lg bg-[var(--text-primary)] flex items-center justify-center hover-pop">
            <OrbitLogo size={16} className="text-[var(--bg-primary)]" />
          </div>
          <div>
            <p className="text-sm font-semibold tracking-tight">Orbit</p>
            <p className="text-[9px] text-[var(--text-secondary)]">Network CRM</p>
          </div>
        </div>

        {/* Navigation */}
        <nav className="px-3 mb-4">
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveView(item.id)}
              className={`relative w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm btn-press shimmer-hover transition-all duration-200 ${
                activeView === item.id
                  ? 'bg-[var(--text-primary)]/10 text-[var(--text-primary)] font-medium'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--hover-bg)]'
              }`}
            >
              {activeView === item.id && (
                <motion.div layoutId="sidebarActive" className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full bg-[var(--text-primary)]"
                  transition={{ type: 'spring', stiffness: 400, damping: 30 }} />
              )}
              <item.icon size={16} strokeWidth={activeView === item.id ? 2 : 1.5} />
              <span>{item.label}</span>
              {item.badge ? (
                <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--accent)]/15 text-[var(--accent)] font-medium">
                  {item.badge}
                </span>
              ) : null}
            </button>
          ))}
        </nav>

        <div className="divider mx-5" />

        {/* Smart-alerts strip removed (overdue / to reconnect) — too noisy */}

        {/* Daily reach-outs — click header to collapse */}
        {reachOuts.length > 0 && (
          <div className="px-3 py-4">
            <button
              onClick={toggleReachOut}
              className="w-full flex items-center justify-between gap-1.5 px-3 mb-3 group"
            >
              <span className="flex items-center gap-1.5">
                <ChevronDown
                  size={10}
                  className={`text-[var(--text-secondary)]/60 transition-transform duration-200 ${reachOutOpen ? '' : '-rotate-90'}`}
                />
                <span className="text-[10px] font-medium text-[var(--text-secondary)] tracking-[0.1em] group-hover:text-[var(--text-primary)] transition-colors">REACH OUT</span>
              </span>
              <span className="text-[10px] text-[var(--text-secondary)]/60 tabular-nums">{reachOutsTotal}</span>
            </button>
            <AnimatePresence initial={false}>
              {reachOutOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                  className="overflow-hidden"
                >
                  <div className="space-y-0.5">
                    {reachOuts.map((c) => (
                      <button key={c.id} onClick={() => setSelectedContact(c.id)}
                        className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs hover:bg-[var(--hover-bg)] transition-colors">
                        {c.photo ? (
                          <img src={c.photo} alt="" className="w-6 h-6 rounded-full object-cover flex-shrink-0" />
                        ) : (
                          <div className="w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-medium flex-shrink-0 border border-[var(--border)] text-[var(--text-secondary)]">
                            {c.name.charAt(0)}
                          </div>
                        )}
                        <div className="flex-1 min-w-0 text-left">
                          <p className="text-[12px] truncate leading-tight">{c.name}</p>
                          <p className="text-[10px] text-[var(--text-secondary)] truncate mt-0.5">{c.health.suggestion || `${c.daysSince}d ago`}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {/* Projects — click header to collapse */}
        {reachOuts.length > 0 && <div className="divider mx-5" />}
        <div className="px-3 py-4">
          <div className="flex items-center justify-between px-3 mb-3 group">
            <button onClick={toggleProjects} className="flex items-center gap-1.5 flex-1 text-left">
              <ChevronDown
                size={10}
                className={`text-[var(--text-secondary)]/60 transition-transform duration-200 ${projectsOpen ? '' : '-rotate-90'}`}
              />
              <span className="text-[10px] font-medium text-[var(--text-secondary)] tracking-[0.1em] group-hover:text-[var(--text-primary)] transition-colors">PROJECTS</span>
              {activeProjects.length > 0 && (
                <span className="ml-1 text-[10px] text-[var(--text-secondary)]/60 tabular-nums">{activeProjects.length}</span>
              )}
            </button>
            <button onClick={() => setShowNewProject(!showNewProject)} className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
              {showNewProject ? <X size={12} /> : <Plus size={12} />}
            </button>
          </div>

          <AnimatePresence>
            {showNewProject && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden px-3 mb-1">
                <input value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newProjectName.trim()) { addProject({ name: newProjectName.trim() }); setNewProjectName(''); setShowNewProject(false); }
                    if (e.key === 'Escape') { setShowNewProject(false); setNewProjectName(''); }
                  }}
                  placeholder="Project name..."
                  className="w-full bg-transparent border-b border-[var(--border)] px-0 py-1.5 text-xs focus:outline-none focus:border-[var(--accent)]/40 transition-colors" autoFocus />
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence initial={false}>
            {projectsOpen && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                className="overflow-hidden"
              >
                {activeProjects.map((project) => {
                  const taskCount = contacts.flatMap((c) => c.tasks).filter((t) => t.project_id === project.id && !t.completed).length;
                  return (
                    <div key={project.id} className="group/proj relative">
                      <button onClick={() => onProjectClick?.(project.id)}
                        className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--hover-bg)] transition-colors btn-press shimmer-hover">
                        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: project.color || '#6c63ff' }} />
                        <span className="truncate text-xs flex-1 text-left">{project.name}</span>
                        {/* Per-project quick actions — visible on hover */}
                        <span className="flex items-center gap-0.5 opacity-0 group-hover/proj:opacity-100 transition-opacity">
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={(e) => {
                              e.stopPropagation();
                              window.dispatchEvent(new CustomEvent('request-add-task', { detail: { projectId: project.id } }));
                            }}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); window.dispatchEvent(new CustomEvent('request-add-task', { detail: { projectId: project.id } })); } }}
                            title="Add task"
                            className="w-5 h-5 rounded inline-flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors"
                          >
                            <Plus size={10} />
                          </span>
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={(e) => {
                              e.stopPropagation();
                              window.dispatchEvent(new CustomEvent('open-voice-for-project', { detail: { projectId: project.id, projectName: project.name } }));
                            }}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); window.dispatchEvent(new CustomEvent('open-voice-for-project', { detail: { projectId: project.id, projectName: project.name } })); } }}
                            title="Voice note for this project"
                            className="w-5 h-5 rounded inline-flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors"
                          >
                            <Mic size={10} />
                          </span>
                        </span>
                        {taskCount > 0 ? (
                          <span className="ml-1 text-[10px] text-[var(--accent)] tabular-nums">{taskCount}t</span>
                        ) : (
                          <span className="ml-1 text-[10px] text-[var(--text-secondary)]/60 tabular-nums">{project.contactIds.length}</span>
                        )}
                      </button>
                    </div>
                  );
                })}
                {activeProjects.length === 0 && !showNewProject && (
                  <button onClick={() => setShowNewProject(true)}
                    className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--hover-bg)] transition-colors shimmer-hover">
                    <FolderOpen size={13} /> New project
                  </button>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Bottom — stats + actions */}
        <div className="mt-auto border-t border-[var(--border)]">
          {/* Activity sparkline */}
          <div className="px-5 py-3.5">
            <div className="flex items-end justify-between mb-1.5">
              <div>
                <p className="text-[9px] text-[var(--text-secondary)] tracking-[0.12em] mb-1 uppercase">Activity</p>
                <p className="text-2xl font-semibold tracking-tight leading-none">{activityTotal}</p>
                <p className="text-[9px] text-[var(--text-secondary)] mt-0.5">last 14 days</p>
              </div>
              <span className="text-[9px] text-[var(--text-secondary)]/60">{stats.total} contacts</span>
            </div>
            <svg viewBox="0 0 140 32" preserveAspectRatio="none" className="w-full h-[32px] mt-1.5">
              <defs>
                <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
                  <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
                </linearGradient>
              </defs>
              {sparkArea && <path d={sparkArea} fill="url(#sparkGrad)" />}
              {sparkPath && <path d={sparkPath} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />}
            </svg>
          </div>

          <div className="px-3 pb-3 flex items-center justify-end gap-0.5">
            <ThemeToggle />
            <button
              onClick={() => router.push('/settings')}
              className="flex items-center justify-center py-2 px-2.5 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--hover-bg)] transition-colors shimmer-hover btn-press"
              title="Settings"
            >
              <Settings size={14} />
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile bottom tab bar — unchanged */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-30 bg-[var(--bg-primary)]/90 backdrop-blur-2xl border-t border-[var(--border)]"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 8px)' }}>
        <div className="flex items-center justify-around px-2 pt-2 pb-1">
          {navItems.slice(0, 2).map((item) => (
            <button key={item.id} onClick={() => setActiveView(item.id)}
              className={`relative flex flex-col items-center gap-0.5 px-4 py-1.5 min-w-[56px] transition-all ${
                activeView === item.id ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]/50'
              }`}>
              <item.icon size={20} strokeWidth={activeView === item.id ? 2 : 1.5} />
              <span className="text-[9px] font-medium tracking-wide">{item.label}</span>
              {item.badge ? <span className="absolute top-0 right-2 w-3.5 h-3.5 bg-[var(--accent)] rounded-full text-[7px] flex items-center justify-center font-bold text-[var(--bg-primary)]">{item.badge > 9 ? '9+' : item.badge}</span> : null}
            </button>
          ))}
          <button onClick={onMobileMic} className="relative -mt-5 w-12 h-12 rounded-full bg-[var(--accent)] flex items-center justify-center shadow-[0_0_20px_rgba(6,182,212,0.15)]">
            <Mic size={20} className="text-[var(--bg-primary)]" />
            {draftCount > 0 && <span className="absolute -top-1 -right-1 w-4 h-4 bg-[var(--teal)] rounded-full text-[7px] flex items-center justify-center font-bold text-[var(--bg-primary)] z-20">{draftCount}</span>}
          </button>
          {navItems.slice(2).map((item) => (
            <button key={item.id} onClick={() => setActiveView(item.id)}
              className={`relative flex flex-col items-center gap-0.5 px-4 py-1.5 min-w-[56px] transition-all ${
                activeView === item.id ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]/50'
              }`}>
              <item.icon size={20} strokeWidth={activeView === item.id ? 2 : 1.5} />
              <span className="text-[9px] font-medium tracking-wide">{item.label}</span>
              {item.badge ? <span className="absolute top-0 right-2 w-3.5 h-3.5 bg-[var(--accent)] rounded-full text-[7px] flex items-center justify-center font-bold text-[var(--bg-primary)]">{item.badge > 9 ? '9+' : item.badge}</span> : null}
            </button>
          ))}
        </div>
      </nav>
    </>
  );
}
