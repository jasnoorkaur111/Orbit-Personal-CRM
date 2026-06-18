'use client';

import { useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { Search, ArrowUpDown, Download, CheckSquare, Users as UsersIcon, LayoutGrid, List as ListIcon } from 'lucide-react';
import { useCrmStore } from '@/store/useCrmStore';
import { format, differenceInDays } from 'date-fns';
import { computeHealthScore } from '@/lib/healthScore';
import { displayName, displayInitial } from '@/lib/displayName';
import SharedHeader from './SharedHeader';

type SortBy = 'recent' | 'strongest' | 'cold' | 'connected' | 'name';
type ViewMode = 'card' | 'list';

export default function ContactListView() {
  const { contacts, setSelectedContact, projects, activeProjectFilter, addContact } = useCrmStore();
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('recent');
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    if (typeof window === 'undefined') return 'card';
    return (localStorage.getItem('people-view-mode') as ViewMode) || 'card';
  });
  const setViewModePersist = (m: ViewMode) => {
    setViewMode(m);
    try { localStorage.setItem('people-view-mode', m); } catch {}
  };

  const exportCSV = () => {
    const headers = ['Name', 'Company', 'Role', 'Email', 'Phone', 'LinkedIn', 'Tags', 'Projects', 'Notes', 'Connections', 'Pending Tasks', 'Created'];
    const rows = contacts.map((c) => [
      c.name, c.company || '', c.role || '', c.email || '', c.phone || '', c.linkedin || '',
      (c.tags || []).join('; '),
      projects.filter((p) => p.contactIds.includes(c.id)).map((p) => p.name).join('; '),
      c.notes.replace(/\n/g, ' ').replace(/"/g, '""'), c.connections.length,
      c.tasks.filter((t) => !t.completed).length, format(new Date(c.created_at), 'yyyy-MM-dd'),
    ]);
    const csv = [headers, ...rows].map((r) => r.map((v) => `"${v}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `contacts-${format(new Date(), 'yyyy-MM-dd')}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const activeProject = activeProjectFilter ? projects.find((p) => p.id === activeProjectFilter) : null;

  // Pick the freshest REAL interaction signal — returns null when there isn't
  // one, so "never contacted" people sink to the bottom of Recent / Cold sorts
  // instead of riding their created_at to the top.
  const lastTouchOf = (c: typeof contacts[number]): number | null => {
    const candidates: number[] = [];
    if (c.last_contacted) candidates.push(new Date(c.last_contacted).getTime());
    if (c.email_stats?.last_inbound_at) candidates.push(new Date(c.email_stats.last_inbound_at).getTime());
    if (c.email_stats?.last_outbound_at) candidates.push(new Date(c.email_stats.last_outbound_at).getTime());
    return candidates.length ? Math.max(...candidates) : null;
  };

  const enriched = useMemo(() => {
    return contacts
      .filter((c) => !c.is_self && c.is_promoted !== false)
      .filter((c) => { if (activeProject) return activeProject.contactIds.includes(c.id); return true; })
      .filter((c) => !search.trim() || c.name.toLowerCase().includes(search.toLowerCase()) || c.company?.toLowerCase().includes(search.toLowerCase()) || c.notes.toLowerCase().includes(search.toLowerCase()))
      .map((c) => {
        const health = computeHealthScore(c);
        const pending = c.tasks.filter((t) => !t.completed).length;
        const lastTouch = lastTouchOf(c);  // null when never contacted
        const daysSince = lastTouch != null ? Math.floor((Date.now() - lastTouch) / 86400000) : null;
        const threadCount = c.email_stats?.thread_count || 0;
        const emails = (c.email_stats?.emails_sent || 0) + (c.email_stats?.emails_received || 0);
        const ccNames = c.email_stats?.last_inbound_cc_names?.length
          ? c.email_stats.last_inbound_cc_names
          : (c.email_stats?.last_outbound_cc_names || []);
        return { ...c, health, pending, lastTouch, daysSince, threadCount, emails, ccNames };
      })
      .sort((a, b) => {
        switch (sortBy) {
          case 'name':
            return a.name.localeCompare(b.name);
          case 'strongest':
            // Volume-based; people with zero email signal sink
            return (b.emails - a.emails) || (b.threadCount - a.threadCount);
          case 'cold': {
            // Oldest real-contact first; never-contacted sinks to the bottom
            // (can't "reconnect" with someone you never contacted)
            if (a.lastTouch == null && b.lastTouch == null) return 0;
            if (a.lastTouch == null) return 1;
            if (b.lastTouch == null) return -1;
            return a.lastTouch - b.lastTouch;
          }
          case 'connected':
            return b.connections.length - a.connections.length;
          default: {
            // 'recent' — most-recent real touch first; never-contacted at the bottom
            if (a.lastTouch == null && b.lastTouch == null) return a.name.localeCompare(b.name);
            if (a.lastTouch == null) return 1;
            if (b.lastTouch == null) return -1;
            return b.lastTouch - a.lastTouch;
          }
        }
      });
  }, [contacts, search, sortBy, activeProject]);

  const handleAddContact = () => {
    const name = prompt('Contact name:');
    if (name?.trim()) addContact({ name: name.trim() });
  };

  // Recency phrasing — short and human
  const recencyLine = (daysSince: number) => {
    if (daysSince <= 0) return 'today';
    if (daysSince === 1) return 'yesterday';
    if (daysSince < 7) return `${daysSince}d ago`;
    if (daysSince < 30) return `${Math.floor(daysSince / 7)}w ago`;
    if (daysSince < 365) return `${Math.floor(daysSince / 30)}mo ago`;
    return `${Math.floor(daysSince / 365)}y ago`;
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <SharedHeader
        title="People"
        subtitle={`${contacts.filter(c => c.is_promoted !== false && !c.is_self).length} in your network · ${contacts.filter(c => c.is_promoted === false).length} discovered`}
        onAdd={handleAddContact}
        addLabel="Add contact"
      />
      <div className="flex-1 overflow-y-auto pb-24 md:pb-6">
        <div className="px-4 md:px-6 pt-1">
          {/* Filter strip */}
          <div className="flex items-center gap-2 mb-4">
            <div className="relative flex-1 max-w-sm">
              <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-secondary)]" />
              <input
                value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter by name, company..."
                className="w-full bg-[var(--input-bg)] pl-9 pr-3 py-2 text-sm rounded-lg border border-[var(--border)]
                         focus:outline-none focus:border-[var(--accent)]/40 transition-colors placeholder:text-[var(--text-secondary)]"
              />
            </div>
            <div className="flex items-center gap-1 text-[var(--text-secondary)] px-2 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)]">
              <ArrowUpDown size={11} />
              <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)}
                className="bg-transparent text-xs focus:outline-none cursor-pointer pr-1">
                <option value="recent">Recent</option>
                <option value="strongest">Strongest</option>
                <option value="cold">Going cold</option>
                <option value="connected">Most connected</option>
                <option value="name">A → Z</option>
              </select>
            </div>
            {/* View toggle */}
            <div className="flex items-center bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg p-0.5">
              <button onClick={() => setViewModePersist('card')}
                className={`p-1.5 rounded-md transition-colors ${viewMode === 'card' ? 'bg-[var(--input-bg)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
                title="Card view">
                <LayoutGrid size={12} />
              </button>
              <button onClick={() => setViewModePersist('list')}
                className={`p-1.5 rounded-md transition-colors ${viewMode === 'list' ? 'bg-[var(--input-bg)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
                title="List view">
                <ListIcon size={12} />
              </button>
            </div>
            <button onClick={exportCSV} className="p-2 hover:bg-[var(--hover-bg)] rounded-lg transition-colors text-[var(--text-secondary)] border border-[var(--border)] bg-[var(--bg-surface)]" title="Export CSV">
              <Download size={13} />
            </button>
          </div>

          {/* Count */}
          <div className="text-xs text-[var(--text-secondary)] mb-3">
            {enriched.length} {enriched.length === 1 ? 'person' : 'people'}
            {sortBy !== 'recent' && (
              <span className="ml-2 opacity-60">
                ranked by {sortBy === 'strongest' ? 'email volume' : sortBy === 'cold' ? 'days since contact' : sortBy === 'connected' ? 'network connections' : 'name'}
              </span>
            )}
          </div>

          {/* ─── CARD VIEW ─── */}
          {viewMode === 'card' && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
            {enriched.map((c, i) => {
              // Mouse-tracking spotlight (uses .glass-card::before CSS vars)
              const handleMove = (e: React.MouseEvent<HTMLButtonElement>) => {
                const r = e.currentTarget.getBoundingClientRect();
                e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`);
                e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`);
              };
              return (
                <motion.button
                  key={c.id}
                  initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i * 0.012, 0.25), duration: 0.22 }}
                  onClick={() => setSelectedContact(c.id)}
                  onMouseMove={handleMove}
                  className="glass-card text-left p-4 group"
                >
                  {/* Header row: avatar + name + health dot + volume */}
                  <div className="flex items-start gap-3 mb-2.5">
                    <div className="relative flex-shrink-0">
                      {c.photo ? (
                        <img src={c.photo} alt="" className="w-11 h-11 rounded-full object-cover"
                          style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.06), 0 2px 8px -2px rgba(0,0,0,0.25)' }} />
                      ) : (
                        <div className="w-11 h-11 rounded-full flex items-center justify-center text-[14px] font-semibold"
                          style={{
                            background: `linear-gradient(135deg, ${c.color || '#7c5cff'}28, ${c.color || '#7c5cff'}10)`,
                            color: c.color || '#7c5cff',
                            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), inset 0 0 0 1px rgba(255,255,255,0.04), 0 2px 8px -2px rgba(0,0,0,0.2)',
                          }}>
                          {displayInitial(c.name)}
                        </div>
                      )}
                      {/* Health dot sits on the avatar corner like a status pip */}
                      <span title={`${c.health.label} · ${c.health.score}`}
                        className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full"
                        style={{
                          backgroundColor: c.health.color,
                          boxShadow: '0 0 0 2px var(--bg-surface)',
                        }} />
                    </div>
                    <div className="flex-1 min-w-0 pt-0.5">
                      <p className="text-[13.5px] font-medium truncate leading-tight tracking-tight">{displayName(c.name)}</p>
                      {(c.role || c.company) && (
                        <p className="text-[11px] text-[var(--text-secondary)] truncate mt-1 leading-tight">
                          {[c.role, c.company].filter(Boolean).join(' · ')}
                        </p>
                      )}
                    </div>
                    {c.emails > 0 && (
                      <span className="text-[10px] text-[var(--text-secondary)]/70 tabular-nums flex-shrink-0 pt-1">
                        ↔ {c.threadCount || c.emails}
                      </span>
                    )}
                  </div>

                  {/* Recency line */}
                  <p className="text-[11.5px] text-[var(--text-secondary)] leading-snug">
                    {c.daysSince != null
                      ? <>Last touch <span className="text-[var(--text-primary)]">{recencyLine(c.daysSince)}</span></>
                      : <span className="text-[var(--text-secondary)]/45">Never contacted</span>}
                  </p>

                  {/* CC preview */}
                  {c.ccNames.length > 0 && (
                    <p className="text-[11px] text-[var(--text-secondary)]/85 mt-1.5 leading-snug flex items-baseline gap-1.5">
                      <UsersIcon size={9} className="flex-shrink-0 translate-y-[1px] text-[var(--text-secondary)]/50" />
                      <span className="truncate">
                        with {c.ccNames.slice(0, 2).join(' · ')}
                        {c.ccNames.length > 2 && <span className="text-[var(--text-secondary)]/50"> +{c.ccNames.length - 2}</span>}
                      </span>
                    </p>
                  )}

                  {/* Footer: only pending tasks. Tags live in the DB as internal
                      metadata (powering filter chips at top + Ask search) but aren't
                      rendered on the card — kept clean and consistent. */}
                  {c.pending > 0 && (
                    <div className="flex items-center justify-end mt-3">
                      <span className="inline-flex items-center gap-1 text-[10px] tabular-nums" style={{ color: 'var(--accent)' }}>
                        <CheckSquare size={9} /> {c.pending} {c.pending === 1 ? 'task' : 'tasks'}
                      </span>
                    </div>
                  )}
                </motion.button>
              );
            })}
          </div>
          )}

          {/* ─── LIST VIEW ─── compact, sleek, hairline rows */}
          {viewMode === 'list' && (
            <div className="rounded-xl border border-[var(--border)] overflow-hidden bg-[var(--bg-surface)]/40 backdrop-blur-xl">
              {enriched.map((c, i) => (
                <motion.button
                  key={c.id}
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                  transition={{ delay: Math.min(i * 0.008, 0.2), duration: 0.15 }}
                  onClick={() => setSelectedContact(c.id)}
                  className="w-full grid grid-cols-[auto_minmax(0,1.4fr)_minmax(0,1.6fr)_minmax(0,1.4fr)_auto] gap-4 items-center px-4 py-2.5 text-left transition-colors hover:bg-[var(--hover-bg)]/60 border-b border-[var(--border)] last:border-b-0"
                >
                  {/* Avatar w/ health pip */}
                  <div className="relative flex-shrink-0">
                    {c.photo ? (
                      <img src={c.photo} alt="" className="w-8 h-8 rounded-full object-cover" />
                    ) : (
                      <div className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-semibold"
                        style={{
                          background: `linear-gradient(135deg, ${c.color || '#7c5cff'}28, ${c.color || '#7c5cff'}10)`,
                          color: c.color || '#7c5cff',
                          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
                        }}>
                        {displayInitial(c.name)}
                      </div>
                    )}
                    <span title={`${c.health.label} · ${c.health.score}`}
                      className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full"
                      style={{
                        backgroundColor: c.health.color,
                        boxShadow: '0 0 0 1.5px var(--bg-surface)',
                      }} />
                  </div>

                  {/* Name + role */}
                  <div className="min-w-0">
                    <p className="text-[12.5px] font-medium truncate leading-tight tracking-tight">{displayName(c.name)}</p>
                    {c.role && (
                      <p className="text-[10.5px] text-[var(--text-secondary)] truncate mt-0.5 leading-tight">{c.role}</p>
                    )}
                  </div>

                  {/* Company + CC preview */}
                  <div className="min-w-0">
                    {c.company ? (
                      <p className="text-[11.5px] text-[var(--text-secondary)] truncate leading-tight">{c.company}</p>
                    ) : (
                      <span className="text-[11px] text-[var(--text-secondary)]/30">—</span>
                    )}
                    {c.ccNames.length > 0 && (
                      <p className="text-[10px] text-[var(--text-secondary)]/65 truncate mt-0.5 leading-tight flex items-center gap-1">
                        <UsersIcon size={8} className="text-[var(--text-secondary)]/50 flex-shrink-0" />
                        {c.ccNames.slice(0, 2).join(' · ')}{c.ccNames.length > 2 ? ` +${c.ccNames.length - 2}` : ''}
                      </p>
                    )}
                  </div>

                  {/* Recency + volume */}
                  <div className="min-w-0 text-right">
                    <p className="text-[11px] text-[var(--text-primary)]/90 tabular-nums truncate leading-tight">
                      {c.daysSince != null ? recencyLine(c.daysSince) : <span className="text-[var(--text-secondary)]/40">never</span>}
                    </p>
                    {c.emails > 0 && (
                      <p className="text-[10px] text-[var(--text-secondary)]/65 tabular-nums mt-0.5 leading-tight">
                        ↔ {c.threadCount || c.emails}
                      </p>
                    )}
                  </div>

                  {/* Tasks pill (or invisible spacer for alignment) */}
                  <div className="w-12 text-right flex-shrink-0">
                    {c.pending > 0 ? (
                      <span className="inline-flex items-center gap-1 text-[10px] tabular-nums" style={{ color: 'var(--accent)' }}>
                        <CheckSquare size={9} /> {c.pending}
                      </span>
                    ) : (
                      <span className="text-[10px] text-[var(--text-secondary)]/25">—</span>
                    )}
                  </div>
                </motion.button>
              ))}
            </div>
          )}

          {enriched.length === 0 && (
            <p className="text-center text-[var(--text-secondary)] py-20 text-sm">
              {contacts.length === 0 ? 'No contacts yet — use voice to add one' : 'No results'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
