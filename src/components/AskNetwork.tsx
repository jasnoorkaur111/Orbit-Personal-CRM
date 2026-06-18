'use client';

import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowUp, Loader2, X } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useCrmStore } from '@/store/useCrmStore';

type Match = { contactId: string; reason: string };
type Turn =
  | { role: 'user'; text: string }
  | { role: 'ai'; intro: string; matches: Match[] }
  | { role: 'ai-error'; text: string };

const PLACEHOLDERS = [
  'Who do I know in NYC working in AI?',
  'Top 3 cold contacts I should reach out to?',
  "Who speaks Spanish?",
  "Who's worked at YC startups?",
];

/**
 * Sleek conversational floating panel — opens on ⌘J.
 * No header, no labels — just an input and a chat thread that grows under it.
 */
export default function AskNetwork() {
  const { contacts, setSelectedContact } = useCrmStore();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [placeholder, setPlaceholder] = useState(PLACEHOLDERS[0]);
  const inputRef = useRef<HTMLInputElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  const contactsById = new Map(contacts.map((c) => [c.id, c]));

  // ⌘J toggles. esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('open-ask-network', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('open-ask-network', onOpen);
    };
  }, [open]);

  // Focus input when opening; pick a fresh placeholder each time
  useEffect(() => {
    if (open) {
      setPlaceholder(PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)]);
      setTimeout(() => inputRef.current?.focus(), 60);
    }
  }, [open]);

  // Auto-scroll thread to bottom when new turns arrive
  useEffect(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [turns, loading]);

  const ask = async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed || loading) return;
    setTurns((t) => [...t, { role: 'user', text: trimmed }]);
    setQuery('');
    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/ask-network', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token || ''}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) {
        setTurns((t) => [...t, { role: 'ai-error', text: data?.error || 'Something went wrong.' }]);
      } else {
        setTurns((t) => [...t, { role: 'ai', intro: data.intro || '', matches: data.matches || [] }]);
      }
    } catch (e: any) {
      setTurns((t) => [...t, { role: 'ai-error', text: e?.message || 'Network error.' }]);
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    ask(query);
  };

  const openContact = (id: string) => {
    setSelectedContact(id);
    setOpen(false);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="ask-bg"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-[200] bg-black/30 backdrop-blur-sm flex items-end sm:items-center justify-center pb-6 sm:pb-0 px-3"
        >
          <motion.div
            key="ask-panel"
            initial={{ opacity: 0, y: 20, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.98 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[520px] rounded-3xl bg-[var(--bg-surface)] flex flex-col overflow-hidden"
            style={{
              border: '1px solid var(--border)',
              boxShadow:
                'inset 0 1px 0 rgba(255,255,255,0.05), ' +
                '0 30px 80px -20px rgba(0,0,0,0.55)',
              maxHeight: 'min(72vh, 640px)',
            }}
          >
            {/* Thread (only shown when there are turns) */}
            {turns.length > 0 && (
              <div ref={threadRef} className="flex-1 overflow-y-auto px-5 pt-5 pb-1 space-y-4">
                {turns.map((turn, i) => {
                  if (turn.role === 'user') {
                    return (
                      <div key={i} className="flex justify-end">
                        <div className="max-w-[80%] px-3 py-1.5 text-[13px] leading-snug text-[var(--text-primary)]/90">
                          {turn.text}
                        </div>
                      </div>
                    );
                  }
                  if (turn.role === 'ai-error') {
                    return (
                      <div key={i} className="px-1 text-[12.5px] text-[var(--text-secondary)] italic">
                        {turn.text}
                      </div>
                    );
                  }
                  return (
                    <div key={i} className="space-y-2">
                      {turn.intro && (
                        <div className="text-[13px] text-[var(--text-primary)] leading-snug px-1">
                          {turn.intro}
                        </div>
                      )}
                      {turn.matches.length > 0 && (
                        <div className="space-y-0.5">
                          {turn.matches.map((m) => {
                            const c = contactsById.get(m.contactId);
                            if (!c) return null;
                            return (
                              <button key={m.contactId} onClick={() => openContact(m.contactId)}
                                className="w-full flex items-center gap-3 px-2.5 py-2 rounded-xl hover:bg-[var(--hover-bg)] transition-colors text-left group">
                                {c.photo ? (
                                  <img src={c.photo} alt="" className="w-7 h-7 rounded-full object-cover flex-shrink-0" />
                                ) : (
                                  <div className="w-7 h-7 rounded-full flex items-center justify-center text-[10.5px] font-medium flex-shrink-0"
                                    style={{ backgroundColor: (c.color || '#7c5cff') + '24', color: c.color || '#7c5cff' }}>
                                    {c.name.charAt(0)}
                                  </div>
                                )}
                                <div className="flex-1 min-w-0">
                                  <p className="text-[13px] font-medium truncate leading-tight">{c.name}</p>
                                  <p className="text-[11.5px] text-[var(--text-secondary)] truncate leading-tight mt-0.5">{m.reason}</p>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
                {loading && (
                  <div className="flex items-center gap-2 px-1 text-[12.5px] text-[var(--text-secondary)]">
                    <Loader2 size={12} className="animate-spin text-[var(--accent)]" />
                    thinking…
                  </div>
                )}
              </div>
            )}

            {/* Input row — always at bottom */}
            <form onSubmit={onSubmit}
              className={`flex items-center gap-2 px-4 py-3.5 ${turns.length > 0 ? 'border-t border-[var(--border)]/60' : ''}`}>
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={placeholder}
                disabled={loading}
                className="flex-1 bg-transparent text-[14px] focus:outline-none placeholder:text-[var(--text-secondary)]/45 disabled:opacity-50"
                // Override the global input:focus lavender ring from globals.css —
                // we don't want any box-shadow on this borderless input
                style={{ boxShadow: 'none' }}
              />
              <button
                type="submit"
                disabled={!query.trim() || loading}
                className="w-7 h-7 rounded-full flex items-center justify-center transition-all"
                style={{
                  background: query.trim() && !loading ? 'var(--accent)' : 'var(--input-bg)',
                  color: query.trim() && !loading ? 'white' : 'var(--text-secondary)',
                  opacity: query.trim() && !loading ? 1 : 0.4,
                }}
              >
                {loading ? <Loader2 size={12} className="animate-spin" /> : <ArrowUp size={13} strokeWidth={2.4} />}
              </button>
              <button type="button" onClick={() => setOpen(false)}
                className="w-7 h-7 rounded-full flex items-center justify-center text-[var(--text-secondary)]/40 hover:text-[var(--text-primary)] hover:bg-[var(--hover-bg)] transition-colors">
                <X size={12} />
              </button>
            </form>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
