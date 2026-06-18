'use client';

import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, X, Clock, RefreshCw, ArrowRight, Inbox, Loader2, Zap, Link2, CheckSquare, Square } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useCrmStore } from '@/store/useCrmStore';
import { useToastStore } from '@/components/Toast';
import SharedHeader from './SharedHeader';
import { displayName, displayInitial } from '@/lib/displayName';

interface Suggestion {
  id: string;
  from_contact_id: string;
  to_contact_id: string;
  confidence: number;
  suggested_type: string | null;
  evidence_summary: string | null;
  evidence_count: number;
  status: 'pending' | 'accepted' | 'rejected' | 'snoozed';
  created_at: string;
}

interface MergeSuggestion {
  id: string;
  canonical_id: string;
  duplicate_id: string;
  confidence: number;
  reasoning: string;
  status: 'pending' | 'accepted' | 'rejected';
}

const typeColor: Record<string, string> = {
  coworker: '#7c5cff',
  collaborator: '#22d3ee',
  client: '#10b981',
  investor: '#f5c542',
  friend: '#ec4899',
  family: '#f97316',
  mutual_friend: '#a78bfa',
  weak: '#94a3b8',
};

export default function SuggestionsInbox() {
  const { contacts, addConnection, mergeContacts } = useCrmStore();
  const addToast = useToastStore((s) => s.addToast);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [merges, setMerges] = useState<MergeSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [findingMerges, setFindingMerges] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkRunning, setBulkRunning] = useState(false);

  const contactsById = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts]);

  const load = async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }
    const [{ data: conns }, { data: mergeRows }] = await Promise.all([
      supabase.from('connection_suggestions').select('*')
        .eq('user_id', user.id).eq('status', 'pending')
        .order('confidence', { ascending: false }),
      supabase.from('merge_suggestions').select('*')
        .eq('user_id', user.id).eq('status', 'pending')
        .order('confidence', { ascending: false }),
    ]);
    setSuggestions(conns || []);
    setMerges(mergeRows || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  // Run identity-resolution sweep (LLM-judged merge suggestions)
  const findMerges = async () => {
    setFindingMerges(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/find-merges', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token || ''}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      addToast({ message: `Found ${data.inserted || 0} likely merges from ${data.candidates || 0} candidates`, type: 'success' });
      await load();
    } catch (e: any) {
      addToast({ message: 'Merge scan failed: ' + e.message, type: 'error' });
    }
    setFindingMerges(false);
  };

  const acceptMerge = async (m: MergeSuggestion) => {
    try {
      await mergeContacts(m.canonical_id, m.duplicate_id);
      await supabase.from('merge_suggestions')
        .update({ status: 'accepted', decided_at: new Date().toISOString() })
        .eq('id', m.id);
      setMerges((prev) => prev.filter((x) => x.id !== m.id));
      addToast({ message: 'Merged', type: 'success' });
      window.dispatchEvent(new Event('inbox-count-changed'));
    } catch (e: any) {
      addToast({ message: 'Merge failed: ' + e.message, type: 'error' });
    }
  };

  const rejectMerge = async (m: MergeSuggestion) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { addToast({ message: 'Not signed in', type: 'error' }); return; }
    const [a, b] = [m.canonical_id, m.duplicate_id].sort();
    const [dismissRes, updateRes] = await Promise.all([
      supabase.from('dismissed_merges').upsert(
        { user_id: user.id, contact_a_id: a, contact_b_id: b },
        { onConflict: 'user_id,contact_a_id,contact_b_id', ignoreDuplicates: true }
      ),
      supabase.from('merge_suggestions')
        .update({ status: 'rejected', decided_at: new Date().toISOString() })
        .eq('id', m.id),
    ]);
    if (dismissRes.error || updateRes.error) {
      console.error('rejectMerge failed', { dismiss: dismissRes.error, update: updateRes.error });
      addToast({ message: `Dismiss failed: ${(dismissRes.error || updateRes.error)?.message}`, type: 'error' });
      return;
    }
    setMerges((prev) => prev.filter((x) => x.id !== m.id));
    addToast({ message: 'Dismissed — won\'t suggest again', type: 'info' });
    window.dispatchEvent(new Event('inbox-count-changed'));
  };

  const [enriching, setEnriching] = useState(false);

  // FAST path — runs suggestions on whatever is already enriched. ~10-15 sec.
  const generate = async () => {
    setGenerating(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const headers = { Authorization: `Bearer ${session?.access_token || ''}`, 'Content-Type': 'application/json' };
      const res = await fetch('/api/suggest-connections', { method: 'POST', headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Suggestion generation failed');
      addToast({ message: `Found ${data.suggestions || 0} new suggestions`, type: 'success' });
      await load();
    } catch (e: any) {
      addToast({ message: 'Failed: ' + e.message, type: 'error' });
    }
    setGenerating(false);
  };

  // SLOW path — enrich 100 unenriched events (~3 min). Click multiple times to chip away.
  const enrichBatch = async () => {
    setEnriching(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const headers = { Authorization: `Bearer ${session?.access_token || ''}`, 'Content-Type': 'application/json' };
      const res = await fetch('/api/enrich-events', {
        method: 'POST', headers, body: JSON.stringify({ onlyMissing: true, limit: 100 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Enrichment failed');
      addToast({ message: `Enriched ${data.enriched || 0} events — click Find new to use the new data`, type: 'success' });
    } catch (e: any) {
      addToast({ message: 'Enrichment failed: ' + e.message, type: 'error' });
    }
    setEnriching(false);
  };

  const accept = async (s: Suggestion) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    // addConnection writes the row AND triggers a store refresh; calling
    // fetchAll() here on top of that caused double re-renders ("refreshes
    // every 2 sec" feel). Drop the explicit fetchAll.
    await addConnection(s.from_contact_id, s.to_contact_id, 'suggestion_accepted');
    // Surface UPDATE errors — silent failure here means the suggestion stays
    // pending in the DB and reappears every login.
    const { error: updateErr } = await supabase.from('connection_suggestions')
      .update({ status: 'accepted', decided_at: new Date().toISOString() })
      .eq('id', s.id);
    if (updateErr) {
      console.error('accept: status update failed', updateErr);
      addToast({ message: `Saved connection but couldn't mark accepted: ${updateErr.message}`, type: 'error' });
      return;
    }
    setSuggestions((prev) => prev.filter((x) => x.id !== s.id));
    setSelected((prev) => { const n = new Set(prev); n.delete(s.id); return n; });
    addToast({ message: 'Connection added', type: 'success' });
    window.dispatchEvent(new Event('inbox-count-changed'));
  };

  const reject = async (s: Suggestion) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { addToast({ message: 'Not signed in', type: 'error' }); return; }
    // Tombstone + mark rejected. Surface errors — the old version Promise.all'd
    // both and swallowed any RLS / FK / constraint failure, so dismissals
    // silently no-op'd and the same pair kept reappearing on regenerate.
    const [dismissRes, updateRes] = await Promise.all([
      supabase.from('dismissed_pairs').upsert(
        { user_id: user.id, contact_a_id: s.from_contact_id, contact_b_id: s.to_contact_id },
        { onConflict: 'user_id,contact_a_id,contact_b_id', ignoreDuplicates: true }
      ),
      supabase.from('connection_suggestions')
        .update({ status: 'rejected', decided_at: new Date().toISOString() })
        .eq('id', s.id),
    ]);
    if (dismissRes.error || updateRes.error) {
      console.error('reject failed', { dismiss: dismissRes.error, update: updateRes.error });
      addToast({ message: `Dismiss failed: ${(dismissRes.error || updateRes.error)?.message}`, type: 'error' });
      return;
    }
    setSuggestions((prev) => prev.filter((x) => x.id !== s.id));
    addToast({ message: 'Dismissed — won\'t suggest again', type: 'info' });
    window.dispatchEvent(new Event('inbox-count-changed'));
  };

  const snooze = async (s: Suggestion) => {
    const { error } = await supabase.from('connection_suggestions')
      .update({ status: 'snoozed', decided_at: new Date().toISOString() })
      .eq('id', s.id);
    if (error) {
      console.error('snooze failed', error);
      addToast({ message: `Snooze failed: ${error.message}`, type: 'error' });
      return;
    }
    setSuggestions((prev) => prev.filter((x) => x.id !== s.id));
    setSelected((prev) => { const n = new Set(prev); n.delete(s.id); return n; });
    addToast({ message: 'Snoozed', type: 'info' });
    window.dispatchEvent(new Event('inbox-count-changed'));
  };

  // ── Bulk actions ──
  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const selectAll = () => setSelected(new Set(suggestions.map((s) => s.id)));
  const clearSelection = () => setSelected(new Set());

  // Bulk accept: sequential to avoid hammering the store. Connection writes are
  // cheap (one row each) so this is fast enough; the win is that the UI only
  // updates the suggestions list at the end, not after every single accept.
  const acceptMany = async (ids: string[]) => {
    if (ids.length === 0) return;
    setBulkRunning(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setBulkRunning(false); return; }
    const targets = suggestions.filter((s) => ids.includes(s.id));
    let ok = 0; let failed = 0;
    for (const s of targets) {
      try {
        await addConnection(s.from_contact_id, s.to_contact_id, 'suggestion_accepted');
        const { error } = await supabase.from('connection_suggestions')
          .update({ status: 'accepted', decided_at: new Date().toISOString() })
          .eq('id', s.id);
        if (error) { failed++; console.error('bulk accept update failed', error); }
        else ok++;
      } catch (e) { failed++; console.error('bulk accept failed', e); }
    }
    // Remove the ones we successfully marked accepted; leave failures in place so user can retry
    if (ok > 0) setSuggestions((prev) => prev.filter((x) => !ids.includes(x.id)));
    setSelected(new Set());
    addToast({
      message: failed > 0 ? `${ok} accepted, ${failed} failed` : `${ok} ${ok === 1 ? 'connection' : 'connections'} added`,
      type: failed > 0 ? 'error' : 'success',
    });
    window.dispatchEvent(new Event('inbox-count-changed'));
    setBulkRunning(false);
  };
  const dismissMany = async (ids: string[]) => {
    if (ids.length === 0) return;
    setBulkRunning(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setBulkRunning(false); return; }
    const targets = suggestions.filter((s) => ids.includes(s.id));
    // Tombstone the pairs so future generate runs don't resurface them
    const tombstones = targets.map((s) => ({
      user_id: user.id, contact_a_id: s.from_contact_id, contact_b_id: s.to_contact_id,
    }));
    const [{ error: dErr }, { error: uErr }] = await Promise.all([
      supabase.from('dismissed_pairs').upsert(tombstones, {
        onConflict: 'user_id,contact_a_id,contact_b_id', ignoreDuplicates: true,
      }),
      supabase.from('connection_suggestions')
        .update({ status: 'rejected', decided_at: new Date().toISOString() })
        .in('id', ids),
    ]);
    if (dErr || uErr) {
      console.error('bulk dismiss failed', { dErr, uErr });
      addToast({ message: `Dismiss failed: ${(dErr || uErr)?.message}`, type: 'error' });
      setBulkRunning(false);
      return;
    }
    setSuggestions((prev) => prev.filter((x) => !ids.includes(x.id)));
    setSelected(new Set());
    addToast({ message: `${ids.length} dismissed`, type: 'info' });
    window.dispatchEvent(new Event('inbox-count-changed'));
    setBulkRunning(false);
  };

  const Avatar = ({ id, size = 32 }: { id: string; size?: number }) => {
    const c = contactsById.get(id);
    if (!c) return <div className="bg-[var(--border)] rounded-full" style={{ width: size, height: size }} />;
    return c.photo ? (
      <img src={c.photo} alt="" className="rounded-full object-cover" style={{ width: size, height: size }} />
    ) : (
      <div className="rounded-full flex items-center justify-center font-semibold"
        style={{
          width: size, height: size,
          backgroundColor: (c.color || '#7c5cff') + '24',
          color: c.color || '#7c5cff',
          fontSize: size * 0.4,
        }}>
        {displayInitial(c.name)}
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <SharedHeader
        title="Suggestions"
        subtitle={`${merges.length} ${merges.length === 1 ? 'merge' : 'merges'} · ${suggestions.length} ${suggestions.length === 1 ? 'connection' : 'connections'} to review`}
        showAdd={false}
        right={
          <div className="flex items-center gap-1.5">
            <button
              onClick={findMerges}
              disabled={findingMerges || generating || enriching}
              className="flex items-center gap-1.5 px-3 py-2 rounded-full border border-[var(--border)] hover:border-[var(--accent)]/40 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
              title="Find duplicate contacts (same person, multiple records)"
            >
              {findingMerges ? <Loader2 size={11} className="animate-spin" /> : <Link2 size={11} />}
              {findingMerges ? 'Scanning…' : 'Find merges'}
            </button>
            <button
              onClick={enrichBatch}
              disabled={enriching || generating || findingMerges}
              className="flex items-center gap-1.5 px-3 py-2 rounded-full border border-[var(--border)] hover:border-[var(--accent)]/40 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
              title="Run LLM enrichment on 100 unenriched events (~3 min)"
            >
              {enriching ? <Loader2 size={11} className="animate-spin" /> : <Zap size={11} />}
              {enriching ? 'Reading…' : 'Read 100 events'}
            </button>
            <button
              onClick={generate}
              disabled={generating || enriching || findingMerges}
              className="flex items-center gap-1.5 px-3 py-2 rounded-full bg-[var(--bg-surface)] border border-[var(--border)] hover:border-[var(--accent)]/40 text-[12px] font-medium transition-colors disabled:opacity-50"
              title="Judge pairs from already-enriched events"
            >
              {generating ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              {generating ? 'Judging…' : 'Find connections'}
            </button>
          </div>
        }
      />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[800px] mx-auto px-5 md:px-8 pb-10">

          {loading ? (
            <div className="flex items-center justify-center py-20 text-[var(--text-secondary)]">
              <Loader2 size={18} className="animate-spin" />
            </div>
          ) : (merges.length === 0 && suggestions.length === 0) ? (
            <div className="text-center py-16">
              <div className="w-12 h-12 rounded-full bg-[var(--accent)]/10 flex items-center justify-center mx-auto mb-3">
                <Inbox size={20} className="text-[var(--accent)]" />
              </div>
              <h2 className="text-[15px] font-medium mb-1">No suggestions to review</h2>
              <p className="text-[12.5px] text-[var(--text-secondary)] max-w-[360px] mx-auto">
                Run "Find new" to scan your calendar and notes for likely connections between your contacts.
              </p>
              <button
                onClick={generate}
                disabled={generating}
                className="btn-lavender mt-5 inline-flex items-center gap-2 px-4 py-2.5 rounded-full text-[13px] font-medium disabled:opacity-50"
              >
                {generating ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                {generating ? 'Scanning…' : 'Find new suggestions'}
              </button>
            </div>
          ) : (
            <div className="space-y-5 pt-2">
              {/* ── Merge suggestions (identity resolution) ── */}
              {merges.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-2 px-1">
                    <Link2 size={12} className="text-[var(--accent)]" />
                    <h2 className="text-[11px] uppercase tracking-[0.12em] font-medium text-[var(--text-secondary)]">
                      Likely duplicates · {merges.length}
                    </h2>
                  </div>
                  <div className="space-y-2.5">
                    <AnimatePresence>
                      {merges.map((m) => {
                        const a = contactsById.get(m.canonical_id);
                        const b = contactsById.get(m.duplicate_id);
                        if (!a || !b) return null;
                        return (
                          <motion.div
                            key={m.id} layout
                            initial={{ opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, x: -12, transition: { duration: 0.15 } }}
                            className="glass-card p-4 flex items-center gap-4"
                          >
                            <div className="flex items-center gap-2 flex-shrink-0">
                              <Avatar id={m.canonical_id} />
                              <Link2 size={11} className="text-[var(--accent)]/60" />
                              <Avatar id={m.duplicate_id} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                                <p className="text-[13.5px] font-medium truncate">
                                  {displayName(a.name)} <span className="text-[var(--text-secondary)] font-normal">←</span> {displayName(b.name)}
                                </p>
                                <span className="text-[10px] text-[var(--text-secondary)]">{m.confidence}%</span>
                              </div>
                              <p className="text-[11.5px] text-[var(--text-secondary)] leading-snug">{m.reasoning}</p>
                              <p className="text-[10px] text-[var(--text-secondary)]/60 mt-0.5">
                                Keep: {a.email || displayName(a.name)} · Merge in: {b.email || displayName(b.name)}
                              </p>
                            </div>
                            <div className="flex items-center gap-1 flex-shrink-0">
                              <button onClick={() => rejectMerge(m)}
                                className="p-2 rounded-lg hover:bg-[var(--danger)]/10 hover:text-[var(--danger)] text-[var(--text-secondary)] transition-colors"
                                title="Not the same person"><X size={14} /></button>
                              <button onClick={() => acceptMerge(m)}
                                className="p-2 rounded-lg bg-[var(--accent)]/10 hover:bg-[var(--accent)]/20 text-[var(--accent)] transition-colors"
                                title="Merge into the first row"><Check size={14} strokeWidth={2.4} /></button>
                            </div>
                          </motion.div>
                        );
                      })}
                    </AnimatePresence>
                  </div>
                </div>
              )}

              {/* ── Connection suggestions ── */}
              {suggestions.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2 px-1">
                    <h2 className="text-[11px] uppercase tracking-[0.12em] font-medium text-[var(--text-secondary)]">
                      Connection suggestions · {suggestions.length}
                    </h2>
                    <div className="flex items-center gap-2">
                      {selected.size === 0 ? (
                        <>
                          <button onClick={selectAll}
                            className="text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
                            Select all
                          </button>
                          <span className="text-[var(--text-secondary)]/30">·</span>
                          <button
                            onClick={() => acceptMany(suggestions.map((s) => s.id))}
                            disabled={bulkRunning}
                            className="text-[11px] text-[var(--accent)] hover:text-[var(--accent-light)] transition-colors disabled:opacity-50 flex items-center gap-1">
                            {bulkRunning && <Loader2 size={11} className="animate-spin" />}
                            Accept all
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="text-[11px] text-[var(--text-secondary)] tabular-nums">{selected.size} selected</span>
                          <button onClick={clearSelection} className="text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
                            Clear
                          </button>
                          <button
                            onClick={() => dismissMany(Array.from(selected))}
                            disabled={bulkRunning}
                            className="text-[11px] text-[var(--text-secondary)] hover:text-[var(--danger)] transition-colors disabled:opacity-50">
                            Dismiss
                          </button>
                          <button
                            onClick={() => acceptMany(Array.from(selected))}
                            disabled={bulkRunning}
                            className="px-2.5 py-1 rounded-md bg-[var(--accent)]/15 hover:bg-[var(--accent)]/25 text-[11px] text-[var(--accent)] transition-colors disabled:opacity-50 flex items-center gap-1">
                            {bulkRunning ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} strokeWidth={2.4} />}
                            Accept {selected.size}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="space-y-2.5">
                    <AnimatePresence>
                {suggestions.map((s) => {
                  const a = contactsById.get(s.from_contact_id);
                  const b = contactsById.get(s.to_contact_id);
                  if (!a || !b) return null;
                  const tColor = typeColor[s.suggested_type || 'weak'] || '#94a3b8';
                  const isSel = selected.has(s.id);
                  return (
                    <motion.div
                      key={s.id}
                      layout
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, x: -12, transition: { duration: 0.15 } }}
                      className={`glass-card p-4 flex items-center gap-4 transition-colors ${isSel ? 'ring-1 ring-[var(--accent)]/40' : ''}`}
                    >
                      {/* Select checkbox */}
                      <button onClick={() => toggleSelect(s.id)}
                        className="flex-shrink-0 text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors"
                        title={isSel ? 'Deselect' : 'Select'}>
                        {isSel ? <CheckSquare size={15} className="text-[var(--accent)]" /> : <Square size={15} />}
                      </button>

                      {/* Pair */}
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <Avatar id={s.from_contact_id} />
                        <ArrowRight size={12} className="text-[var(--text-secondary)]/40" />
                        <Avatar id={s.to_contact_id} />
                      </div>

                      {/* Detail */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <p className="text-[13.5px] font-medium truncate">{displayName(a.name)} <span className="text-[var(--text-secondary)] font-normal">+</span> {displayName(b.name)}</p>
                          <span className="text-[9.5px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded"
                            style={{ backgroundColor: tColor + '18', color: tColor }}>
                            {(s.suggested_type || 'weak').replace('_', ' ')}
                          </span>
                          <span className="text-[10px] text-[var(--text-secondary)]">{s.confidence}%</span>
                        </div>
                        {s.evidence_summary && (
                          <p className="text-[11.5px] text-[var(--text-secondary)] leading-snug">{s.evidence_summary}</p>
                        )}
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button
                          onClick={() => reject(s)}
                          className="p-2 rounded-lg hover:bg-[var(--danger)]/10 hover:text-[var(--danger)] text-[var(--text-secondary)] transition-colors"
                          title="Dismiss (won't suggest again)"
                        >
                          <X size={14} />
                        </button>
                        <button
                          onClick={() => snooze(s)}
                          className="p-2 rounded-lg hover:bg-[var(--hover-bg)] text-[var(--text-secondary)] transition-colors"
                          title="Snooze"
                        >
                          <Clock size={13} />
                        </button>
                        <button
                          onClick={() => accept(s)}
                          className="p-2 rounded-lg bg-[var(--accent)]/10 hover:bg-[var(--accent)]/20 text-[var(--accent)] transition-colors"
                          title="Accept"
                        >
                          <Check size={14} strokeWidth={2.4} />
                        </button>
                      </div>
                    </motion.div>
                  );
                })}
                    </AnimatePresence>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
