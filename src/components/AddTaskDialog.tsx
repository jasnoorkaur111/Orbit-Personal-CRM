'use client';

import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Loader2, Check } from 'lucide-react';
import { useCrmStore } from '@/store/useCrmStore';
import { useToastStore } from '@/components/Toast';

/**
 * In-app "Add task" modal. Styled to match CommandSearch (cmd+J) — same
 * glass-card chrome, top-aligned, neutral focus rings (no lavender
 * outlines). Renders only when `open` is true. Esc closes, Enter
 * submits when the form is valid. Shows an inline "Task added" check
 * for ~900ms after submit before closing so the action visibly lands.
 */

interface Props {
  open: boolean;
  onClose: () => void;
  initialContactId?: string;
}

export default function AddTaskDialog({ open, onClose, initialContactId }: Props) {
  const { contacts, addTask } = useCrmStore();
  const addToast = useToastStore((s) => s.addToast);

  const [draft, setDraft] = useState({
    title: '',
    contactId: initialContactId || '',
    type: 'other' as 'follow-up' | 'send' | 'meeting' | 'other',
    due: '',
  });
  const [saving, setSaving] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  // Reset when re-opened so a fresh modal starts blank.
  useEffect(() => {
    if (open) {
      setDraft({ title: '', contactId: initialContactId || '', type: 'other', due: '' });
      setConfirmed(false);
    }
  }, [open, initialContactId]);

  const promotedContacts = useMemo(
    () => contacts.filter((c) => !c.is_self && c.is_promoted !== false).sort((a, b) => a.name.localeCompare(b.name)),
    [contacts],
  );

  const canSubmit = draft.title.trim().length > 0 && !!draft.contactId && !saving && !confirmed;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      await addTask({
        title: draft.title.trim(),
        contact_id: draft.contactId,
        type: draft.type,
        due_date: draft.due || undefined,
      });
      // Inline confirmation — show the green check for ~900ms so the user
      // sees the action land. Toast still fires for the global notification
      // queue (sidebar nav badge etc).
      setSaving(false);
      setConfirmed(true);
      addToast({ message: 'Task added', type: 'success', icon: 'task' });
      setTimeout(() => { onClose(); }, 900);
    } catch (e: any) {
      setSaving(false);
      addToast({ message: 'Failed to add task: ' + (e?.message || String(e)), type: 'error' });
    }
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSubmit) { e.preventDefault(); submit(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, canSubmit]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="add-task-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[480] flex items-start justify-center pt-[18vh] px-4"
        >
          {/* Backdrop — same treatment as CommandSearch */}
          <div className="absolute inset-0 bg-black/40 backdrop-blur-[6px]" onClick={onClose} />

          {/* Card */}
          <motion.div
            key="add-task-card"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            className="relative w-full md:w-[460px] max-w-[90vw] glass-card overflow-hidden shadow-[0_20px_60px_rgba(0,0,0,0.5)]"
          >
            {confirmed ? (
              // Confirmation state — sit on the green check for 900ms then close.
              <div className="flex flex-col items-center justify-center px-6 py-8">
                <motion.div
                  initial={{ scale: 0.6, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                  className="w-10 h-10 rounded-full flex items-center justify-center mb-3"
                  style={{ background: 'color-mix(in srgb, #10b981 18%, transparent)' }}
                >
                  <Check size={18} strokeWidth={2.5} style={{ color: '#10b981' }} />
                </motion.div>
                <p className="text-[13px] font-medium text-[var(--text-primary)]">Task added</p>
              </div>
            ) : (
              <>
                {/* Title input — top, like CommandSearch's query bar */}
                <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)]">
                  <Plus size={14} className="text-[var(--text-secondary)]/50 flex-shrink-0" strokeWidth={1.8} />
                  <input
                    autoFocus
                    value={draft.title}
                    onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) submit(); }}
                    placeholder="What needs doing?"
                    className="flex-1 bg-transparent text-sm focus:outline-none placeholder:text-[var(--text-secondary)]/40"
                  />
                  <span className="text-[8px] text-[var(--text-secondary)]/40 tracking-wider">ESC</span>
                </div>

                {/* Field rows — neutral, no purple focus rings */}
                <div className="px-4 py-3 space-y-2.5">
                  <FieldRow label="Contact">
                    <select
                      value={draft.contactId}
                      onChange={(e) => setDraft({ ...draft, contactId: e.target.value })}
                      className="flex-1 bg-transparent text-[12.5px] focus:outline-none text-right text-[var(--text-primary)]"
                    >
                      <option value="">Select…</option>
                      {promotedContacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </FieldRow>
                  <FieldRow label="Type">
                    <select
                      value={draft.type}
                      onChange={(e) => setDraft({ ...draft, type: e.target.value as any })}
                      className="flex-1 bg-transparent text-[12.5px] focus:outline-none text-right text-[var(--text-primary)]"
                    >
                      <option value="follow-up">Follow-up</option>
                      <option value="send">Send</option>
                      <option value="meeting">Meeting</option>
                      <option value="other">Other</option>
                    </select>
                  </FieldRow>
                  <FieldRow label="Due">
                    <input
                      type="date"
                      value={draft.due}
                      onChange={(e) => setDraft({ ...draft, due: e.target.value })}
                      className="bg-transparent text-[12.5px] focus:outline-none text-right text-[var(--text-primary)]"
                    />
                  </FieldRow>
                </div>

                {/* Footer — neutral submit, no purple bg */}
                <div className="flex items-center justify-between px-4 py-2.5 border-t border-[var(--border)] bg-[var(--hover-bg)]/40">
                  <span className="text-[10px] text-[var(--text-secondary)]/60 tracking-wider">
                    {canSubmit ? '⌘↵ to add' : draft.title.trim() ? 'Pick a contact' : 'Type a title'}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={onClose}
                      className="px-3 py-1 rounded-md text-[11.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--hover-bg)] transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={submit}
                      disabled={!canSubmit}
                      className="px-3 py-1 rounded-md text-[11.5px] font-medium flex items-center gap-1.5 transition-colors disabled:opacity-35 disabled:cursor-not-allowed"
                      style={{
                        background: canSubmit ? 'var(--text-primary)' : 'var(--hover-bg)',
                        color: canSubmit ? 'var(--bg-primary)' : 'var(--text-secondary)',
                      }}
                    >
                      {saving ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} strokeWidth={2.4} />}
                      {saving ? 'Adding…' : 'Add task'}
                    </button>
                  </div>
                </div>
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 min-h-[26px]">
      <span className="text-[11.5px] text-[var(--text-secondary)]">{label}</span>
      <div className="flex items-center min-w-0">{children}</div>
    </div>
  );
}
