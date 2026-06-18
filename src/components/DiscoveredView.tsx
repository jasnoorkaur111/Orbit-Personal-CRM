'use client';

import { useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { Check, Trash2, Search, Mail, MailOpen, X } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useCrmStore } from '@/store/useCrmStore';
import { useToastStore } from '@/components/Toast';
import { formatDistanceToNowStrict } from 'date-fns';
import { displayName, displayInitial } from '@/lib/displayName';
import SharedHeader from './SharedHeader';
import { useConfirm } from './ConfirmDialog';

export default function DiscoveredView() {
  const { contacts, fetchAll, setSelectedContact, deleteContact } = useCrmStore();
  const addToast = useToastStore((s) => s.addToast);
  const confirm = useConfirm();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const candidates = useMemo(() => {
    return contacts
      .filter((c) => c.is_promoted === false)
      .filter((c) =>
        !search.trim() ||
        c.name.toLowerCase().includes(search.toLowerCase()) ||
        c.email?.toLowerCase().includes(search.toLowerCase()) ||
        c.company?.toLowerCase().includes(search.toLowerCase())
      )
      .sort((a, b) => {
        const aR = a.email_stats?.emails_received ?? 0;
        const bR = b.email_stats?.emails_received ?? 0;
        if (aR !== bR) return bR - aR;
        const aS = a.email_stats?.emails_sent ?? 0;
        const bS = b.email_stats?.emails_sent ?? 0;
        return bS - aS;
      });
  }, [contacts, search]);

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    if (selected.size === candidates.length) setSelected(new Set());
    else setSelected(new Set(candidates.map((c) => c.id)));
  };

  const promoteSelected = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    await supabase.from('contacts').update({ is_promoted: true }).in('id', Array.from(selected));
    await fetchAll();
    addToast({ message: `Promoted ${selected.size} ${selected.size === 1 ? 'contact' : 'contacts'} to your network`, type: 'success' });
    setSelected(new Set());
    setBusy(false);
  };

  const deleteSelected = async () => {
    if (selected.size === 0) return;
    const ok = await confirm({
      title: `Delete ${selected.size} discovered ${selected.size === 1 ? 'contact' : 'contacts'}?`,
      description: 'They will be permanently removed from your network. This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    let deleted = 0; let failed = 0;
    for (const id of selected) {
      try { await deleteContact(id); deleted += 1; }
      catch { failed += 1; }
    }
    await fetchAll();
    if (failed === 0) {
      addToast({ message: `Deleted ${deleted}`, type: 'info' });
    } else {
      addToast({
        message: deleted === 0
          ? `Delete failed for all ${failed} contacts`
          : `Deleted ${deleted}, ${failed} failed`,
        type: failed === 0 ? 'info' : 'error',
      });
    }
    setSelected(new Set());
    setBusy(false);
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <SharedHeader
        title="Discovered"
        subtitle={`${candidates.length} ${candidates.length === 1 ? 'candidate' : 'candidates'} from auto-discovery · promote real ones, delete the rest`}
        showAdd={false}
      />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[960px] mx-auto px-5 md:px-7 pt-2 pb-10">
          {/* Filter + bulk actions strip */}
          <div className="flex items-center gap-2 mb-4">
            <div className="relative flex-1 max-w-sm">
              <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-secondary)]" />
              <input
                value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter by name, email, company…"
                className="w-full bg-[var(--input-bg)] pl-9 pr-3 py-2 text-sm rounded-lg border border-[var(--border)] focus:outline-none focus:border-[var(--accent)]/40 transition-colors placeholder:text-[var(--text-secondary)]"
              />
            </div>
            <div className="flex-1" />
            {selected.size > 0 && (
              <>
                <span className="text-[12px] text-[var(--text-secondary)]">{selected.size} selected</span>
                <button
                  onClick={promoteSelected} disabled={busy}
                  className="btn-lavender flex items-center gap-1.5 px-3 py-2 rounded-full text-[12px] font-medium disabled:opacity-50"
                >
                  <Check size={12} /> Promote
                </button>
                <button
                  onClick={deleteSelected} disabled={busy}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-full border border-[var(--border)] text-[12px] text-[var(--danger)] hover:bg-[var(--danger)]/10 disabled:opacity-50"
                >
                  <Trash2 size={12} /> Delete
                </button>
                <button
                  onClick={() => setSelected(new Set())}
                  className="p-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  title="Clear selection"
                >
                  <X size={13} />
                </button>
              </>
            )}
          </div>

          {/* Header row */}
          <div className="grid grid-cols-[24px_minmax(0,2fr)_minmax(0,2fr)_120px_120px] gap-3 px-3 py-2 text-[10px] uppercase tracking-[0.12em] text-[var(--text-secondary)] border-b border-[var(--border)] sticky top-0 bg-[var(--bg-primary)]/90 backdrop-blur-2xl z-10">
            <button onClick={toggleAll} className="flex items-center justify-center">
              <input type="checkbox"
                checked={candidates.length > 0 && selected.size === candidates.length}
                onChange={toggleAll}
                className="accent-[var(--accent)]" />
            </button>
            <span>Person</span>
            <span>Email</span>
            <span>Inbound / Outbound</span>
            <span className="text-right">Last reply</span>
          </div>

          {candidates.map((c, i) => {
            const sent = c.email_stats?.emails_sent ?? 0;
            const recv = c.email_stats?.emails_received ?? 0;
            const lastIn = c.email_stats?.last_inbound_at;
            const isSel = selected.has(c.id);
            return (
              <motion.div
                key={c.id}
                initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                transition={{ delay: Math.min(i * 0.01, 0.2) }}
                className={`grid grid-cols-[24px_minmax(0,2fr)_minmax(0,2fr)_120px_120px] gap-3 items-center px-3 py-2.5 border-b border-[var(--border)] transition-colors ${isSel ? 'bg-[var(--accent)]/8' : 'hover:bg-[var(--hover-bg)]'}`}
              >
                <input type="checkbox" checked={isSel} onChange={() => toggleOne(c.id)} className="accent-[var(--accent)]" />
                <button onClick={() => setSelectedContact(c.id)} className="flex items-center gap-2.5 min-w-0 text-left">
                  <div className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold flex-shrink-0"
                    style={{ backgroundColor: (c.color || '#94a3b8') + '20', color: c.color || '#94a3b8' }}>
                    {displayInitial(c.name)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium truncate">{displayName(c.name)}</p>
                    {c.company && <p className="text-[10.5px] text-[var(--text-secondary)] truncate">{c.company}</p>}
                  </div>
                </button>
                <span className="text-[11.5px] text-[var(--text-secondary)] truncate">{c.email || '—'}</span>
                <span className="text-[11px] flex items-center gap-2">
                  {recv > 0 ? (
                    <span className="text-[var(--accent)] flex items-center gap-1" title="Replies received">
                      <MailOpen size={11} /> {recv}
                    </span>
                  ) : null}
                  {sent > 0 ? (
                    <span className="text-[var(--text-secondary)] flex items-center gap-1" title="Sent by you">
                      <Mail size={11} /> {sent}
                    </span>
                  ) : null}
                  {recv === 0 && sent === 0 ? <span className="text-[var(--text-secondary)]/40">—</span> : null}
                </span>
                <span className="text-[10.5px] text-[var(--text-secondary)] text-right">
                  {lastIn ? formatDistanceToNowStrict(new Date(lastIn), { addSuffix: true }) : '—'}
                </span>
              </motion.div>
            );
          })}

          {candidates.length === 0 && (
            <div className="text-center py-20 text-[var(--text-secondary)]">
              <p className="text-sm">All caught up — no candidates to review.</p>
              <p className="text-[12px] mt-1.5 opacity-60">New auto-imports will land here.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
