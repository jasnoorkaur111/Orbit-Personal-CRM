'use client';

import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, User, CheckSquare, Calendar, Network, ArrowRight, FolderOpen } from 'lucide-react';
import { useCrmStore } from '@/store/useCrmStore';
import { format } from 'date-fns';

interface CommandSearchProps {
  onNavigate: (view: string) => void;
  onProjectClick?: (projectId: string) => void;
}

export default function CommandSearch({ onNavigate, onProjectClick }: CommandSearchProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { contacts, events, projects, setSelectedContact } = useCrmStore();

  // Cmd+K to toggle
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen(prev => !prev);
        setQuery('');
        setSelectedIndex(0);
      }
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Focus input when opened
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  // Build results
  const results: { id: string; type: string; icon: any; title: string; subtitle?: string; action: () => void }[] = [];

  if (query.trim()) {
    const q = query.toLowerCase();

    // Contacts
    contacts
      .filter(c => c.name.toLowerCase().includes(q) || c.company?.toLowerCase().includes(q) || c.notes.toLowerCase().includes(q))
      .slice(0, 5)
      .forEach(c => {
        results.push({
          id: c.id,
          type: 'Contact',
          icon: User,
          title: c.name,
          subtitle: c.company || undefined,
          action: () => { setSelectedContact(c.id); onNavigate('graph'); setOpen(false); },
        });
      });

    // Tasks
    contacts.flatMap(c => c.tasks.filter(t => !t.completed).map(t => ({ ...t, contactName: c.name, contactId: c.id })))
      .filter(t => t.title.toLowerCase().includes(q) || t.contactName.toLowerCase().includes(q))
      .slice(0, 4)
      .forEach(t => {
        results.push({
          id: t.id,
          type: 'Task',
          icon: CheckSquare,
          title: t.title,
          subtitle: t.contactName + (t.due_date ? ` · ${format(new Date(t.due_date + 'T12:00:00'), 'MMM d')}` : ''),
          action: () => { setSelectedContact(t.contactId); onNavigate('graph'); setOpen(false); },
        });
      });

    // Events
    events
      .filter(e => e.title.toLowerCase().includes(q))
      .slice(0, 3)
      .forEach(e => {
        results.push({
          id: e.id,
          type: 'Event',
          icon: Calendar,
          title: e.title,
          subtitle: format(new Date(e.date + 'T12:00:00'), 'MMM d') + (e.time ? ` at ${e.time}` : ''),
          action: () => { onNavigate('calendar'); setOpen(false); },
        });
      });

    // Projects
    projects
      .filter(p => p.name.toLowerCase().includes(q) || p.description?.toLowerCase().includes(q))
      .slice(0, 3)
      .forEach(p => {
        results.push({
          id: p.id,
          type: 'Project',
          icon: FolderOpen,
          title: p.name,
          subtitle: `${p.contactIds.length} contacts · ${p.status}`,
          action: () => { onProjectClick?.(p.id); setOpen(false); },
        });
      });
  } else {
    // Quick actions when no query
    results.push(
      { id: 'nav-graph', type: 'Navigate', icon: Network, title: 'Network Map', action: () => { onNavigate('graph'); setOpen(false); } },
      { id: 'nav-contacts', type: 'Navigate', icon: User, title: 'Contacts', action: () => { onNavigate('contacts'); setOpen(false); } },
      { id: 'nav-tasks', type: 'Navigate', icon: CheckSquare, title: 'Tasks', action: () => { onNavigate('tasks'); setOpen(false); } },
      { id: 'nav-calendar', type: 'Navigate', icon: Calendar, title: 'Calendar', action: () => { onNavigate('calendar'); setOpen(false); } },
    );
  }

  // Keyboard navigation
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(0, i - 1));
    } else if (e.key === 'Enter' && results[selectedIndex]) {
      results[selectedIndex].action();
    }
  };

  if (!open) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[100] flex items-start justify-center pt-[20vh]"
      >
        {/* Backdrop */}
        <div className="absolute inset-0 bg-black/40 backdrop-blur-[6px]" onClick={() => setOpen(false)} />

        {/* Search panel */}
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
          className="relative w-full md:w-[480px] max-w-[90vw] glass-card overflow-hidden shadow-[0_20px_60px_rgba(0,0,0,0.5)]"
        >
          {/* Input */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)]">
            <Search size={14} className="text-[var(--text-secondary)]/50 flex-shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search..."
              className="flex-1 bg-transparent text-sm focus:outline-none placeholder:text-[var(--text-secondary)]/40"
            />
            <span className="text-[8px] text-[var(--text-secondary)]/40 tracking-wider">ESC</span>
          </div>

          {/* Results */}
          <div className="max-h-[300px] overflow-y-auto py-1">
            {results.length === 0 && query.trim() && (
              <p className="text-xs text-[var(--text-secondary)]/40 text-center py-10">No results</p>
            )}
            {results.map((result, i) => (
              <button
                key={result.id}
                onClick={result.action}
                onMouseEnter={() => setSelectedIndex(i)}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors shimmer-hover ${
                  i === selectedIndex ? 'bg-[var(--hover-bg)]' : ''
                }`}
              >
                <result.icon size={14} className={i === selectedIndex ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]/50'} strokeWidth={1.5} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{result.title}</p>
                  {result.subtitle && (
                    <p className="text-[10px] text-[var(--text-secondary)]/50 truncate">{result.subtitle}</p>
                  )}
                </div>
                <span className="text-[9px] text-[var(--text-secondary)]/30 flex-shrink-0">{result.type}</span>
              </button>
            ))}
          </div>

          {/* Footer */}
          <div className="px-4 py-2 border-t border-[var(--border)] flex items-center gap-4 text-[8px] text-[var(--text-secondary)]/30 tracking-wider">
            <span>↑↓ navigate</span>
            <span>↵ select</span>
            <span>esc close</span>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
