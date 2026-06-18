'use client';

import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Loader2, ExternalLink, X, Sparkle, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useToastStore } from '@/components/Toast';
import { useCrmStore } from '@/store/useCrmStore';
import { formatDistanceToNowStrict, format } from 'date-fns';

interface ResearchCandidate {
  name: string;
  role?: string;
  company?: string;
  location?: string;
  linkedinUrl?: string;
  photoUrl?: string;
  sourceUrl: string;
  rationale: string;
  confidence: 'high' | 'medium' | 'low';
}

interface ResearchSignal {
  text: string;
  category: 'professional' | 'interest' | 'recent' | 'mutual' | 'personal' | 'context';
  source: string;
  sourceUrl: string;
}

interface ContactResearch {
  confirmed: ResearchCandidate;
  signals: ResearchSignal[];
  summary: string;
  prebrief: string;
  lastResearched: string;
}

interface ResearchSectionProps {
  contactId: string;
  contactName: string;
  research?: ContactResearch | null;
  isSelf?: boolean;
}

const categoryStyles: Record<ResearchSignal['category'], { color: string; label: string }> = {
  professional: { color: '#7c5cff', label: 'Work' },
  recent: { color: '#ef4444', label: 'Recent' },
  interest: { color: '#f5c542', label: 'Interest' },
  personal: { color: '#ec4899', label: 'Personal' },
  mutual: { color: '#10b981', label: 'Mutual' },
  context: { color: '#06b6d4', label: 'Context' },
};

export default function ResearchSection({ contactId, contactName, research, isSelf }: ResearchSectionProps) {
  // NOTE: do not put any early-return ABOVE these hooks. React tracks hook
  // ordering by call-count; an early-return before the hook list would
  // cause 'Rendered more hooks than during the previous render' (#310)
  // when isSelf flips on contact switch.
  const addToast = useToastStore((s) => s.addToast);
  const { fetchAll, contacts } = useCrmStore();
  // Pull the live contact for provenance — email_stats + connections + notes.
  // Falls back to undefined if the contact was just deleted; the provenance
  // card simply skips render in that case.
  const liveContact = contacts.find((c) => c.id === contactId);

  const [phase, setPhase] = useState<'idle' | 'candidates' | 'picking' | 'deep' | 'done'>(research ? 'done' : 'idle');
  const [candidates, setCandidates] = useState<ResearchCandidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showPrebrief, setShowPrebrief] = useState(false);
  // Which signal-category cards are expanded. Reset on contact change.
  const [expandedCats, setExpandedCats] = useState<Set<ResearchSignal['category']>>(new Set());
  // Per-signal expand state — keyed by `${category}-${index}`
  const [expandedSignals, setExpandedSignals] = useState<Set<string>>(new Set());
  // Per-talking-point expand state
  const [expandedPoints, setExpandedPoints] = useState<Set<number>>(new Set());
  // Auto-run discovery once per contact when there's no existing research.
  // Per-contact ref so swapping contacts re-evaluates without infinite loops.
  const autoRunFor = useRef<string | null>(null);
  // Stale-result guard: every in-flight request is tagged with the contact ID
  // it was issued for. If the user switches contacts while a request is in
  // flight, the late response is dropped instead of overwriting the new
  // contact's panel with the old contact's data.
  const inFlightFor = useRef<string | null>(null);

  // Reset all in-memory state when contact changes (and re-evaluate auto-run)
  useEffect(() => {
    setExpandedCats(new Set());
    setExpandedSignals(new Set());
    setExpandedPoints(new Set());
    setCandidates([]);
    setError(null);
    setPhase(research ? 'done' : 'idle');
    inFlightFor.current = null;
  }, [contactId, research]);

  const authHeader = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return { Authorization: `Bearer ${session?.access_token || ''}`, 'Content-Type': 'application/json' };
  };

  const runDiscovery = async () => {
    const issuedFor = contactId;
    inFlightFor.current = issuedFor;
    setError(null);
    setPhase('candidates');
    // Hard client timeout — if Gemini is melting (503 / >30s), the route can
    // hang up to its 60s maxDuration; we'd rather show an error sooner.
    const abort = new AbortController();
    const timeoutId = setTimeout(() => abort.abort(), 35_000);
    try {
      const headers = await authHeader();
      const res = await fetch('/api/research-contact/candidates', {
        method: 'POST', headers, body: JSON.stringify({ contactId: issuedFor }), signal: abort.signal,
      });
      clearTimeout(timeoutId);
      // Stale-guard: user switched contacts while this was in flight
      if (inFlightFor.current !== issuedFor) return;
      const data = await res.json();
      if (inFlightFor.current !== issuedFor) return;
      if (!res.ok) throw new Error(data.error || 'Research failed');
      if (!data.candidates || data.candidates.length === 0) {
        setError('No candidates found on the web. Try adding more info (company, email, or LinkedIn) to this contact.');
        setPhase('idle');
        return;
      }
      setCandidates(data.candidates);
      // Fast-path: server skipped web disambiguation because contact identity
      // was strong enough to synthesize a candidate directly. Go straight to deep.
      if (data.fastPath && data.candidates.length === 1) {
        runDeep(data.candidates[0]);
        return;
      }
      setPhase('picking');
    } catch (e: any) {
      clearTimeout(timeoutId);
      if (inFlightFor.current !== issuedFor) return;
      const msg = e?.name === 'AbortError' ? 'Search took too long — Gemini may be overloaded. Try again.' : e.message;
      setError(msg);
      setPhase('idle');
      addToast({ message: 'Research failed: ' + msg, type: 'error' });
    }
  };

  // Auto-run on mount / contact change when there's no research yet
  useEffect(() => {
    if (isSelf) return;
    if (research) return;
    if (autoRunFor.current === contactId) return;
    autoRunFor.current = contactId;
    runDiscovery();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId, isSelf]);

  // Safe to bail out NOW — every hook above has executed in every render
  if (isSelf) return null;

  const runDeep = async (candidate: ResearchCandidate) => {
    const issuedFor = contactId;
    inFlightFor.current = issuedFor;
    setError(null);
    setPhase('deep');
    const abort = new AbortController();
    const timeoutId = setTimeout(() => abort.abort(), 55_000);
    try {
      const headers = await authHeader();
      const res = await fetch('/api/research-contact/deep', {
        method: 'POST', headers, body: JSON.stringify({ contactId: issuedFor, candidate }), signal: abort.signal,
      });
      clearTimeout(timeoutId);
      if (inFlightFor.current !== issuedFor) return;
      const data = await res.json();
      if (inFlightFor.current !== issuedFor) return;
      if (!res.ok) throw new Error(data.error || 'Deep research failed');
      await fetchAll();
      if (inFlightFor.current !== issuedFor) return;
      setPhase('done');
      addToast({ message: 'Research complete', type: 'success' });
    } catch (e: any) {
      clearTimeout(timeoutId);
      if (inFlightFor.current !== issuedFor) return;
      const msg = e?.name === 'AbortError' ? 'Deep research took too long. Try again.' : e.message;
      setError(msg);
      setPhase('picking');
      addToast({ message: 'Deep research failed: ' + msg, type: 'error' });
    }
  };

  // ── Already researched: show results ──
  if (research && phase === 'done') {
    const c = research.confirmed;
    const order: ResearchSignal['category'][] = ['recent', 'professional', 'interest', 'personal', 'mutual', 'context'];
    const buckets = new Map<ResearchSignal['category'], ResearchSignal[]>();
    for (const s of research.signals) {
      const arr = buckets.get(s.category) || [];
      arr.push(s);
      buckets.set(s.category, arr);
    }
    const prebriefBullets = (research.prebrief || '')
      .split('\n')
      .map((l) => l.replace(/^[\s\-•\*]+/, '').trim())
      .filter(Boolean);

    // Glass-card style applied to every box for visual consistency
    const glassCard: React.CSSProperties = {
      background: 'linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01))',
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), 0 4px 14px -6px rgba(0,0,0,0.25)',
      backdropFilter: 'blur(10px)',
    };

    return (
      <div className="px-1 pt-2 pb-2 space-y-3">
        {/* Top metadata + Update button */}
        <div className="flex items-center justify-between px-1">
          <span className="text-[10.5px] uppercase tracking-[0.12em] text-[var(--text-secondary)]/70">
            Background · {formatDistanceToNowStrict(new Date(research.lastResearched), { addSuffix: true })}
          </span>
          <div className="flex items-center gap-3">
            <button onClick={() => { autoRunFor.current = null; runDiscovery(); }}
              className="text-[10.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
              Wrong person?
            </button>
            <button onClick={runDiscovery}
              className="text-[10.5px] font-medium text-[var(--accent)] hover:text-[var(--accent-light)] transition-colors inline-flex items-center gap-1">
              <RefreshCw size={10} /> Update
            </button>
          </div>
        </div>

        {/* HERO CARD — identity tile. One-sentence summary only, no Recent here. */}
        <motion.div
          initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}
          className="rounded-xl border border-[var(--border)] p-4" style={glassCard}>
          <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-secondary)]/70 mb-1.5">
            {c.role || 'Unknown role'}{c.company ? ` · ${c.company}` : ''}{c.location ? ` · ${c.location}` : ''}
          </div>
          {research.summary && (
            <p className="text-[13px] leading-relaxed text-[var(--text-primary)]/90">{research.summary}</p>
          )}
        </motion.div>

        {/* DISCOVERY ORIGIN — "How we found you". Built entirely from existing
            email_stats + connections; no schema changes. Renders only when
            we actually have provenance to show. */}
        {(() => {
          if (!liveContact) return null;
          const es = liveContact.email_stats;
          const bits: { label: string; value: string }[] = [];

          if (es?.first_seen_at) {
            const d = new Date(es.first_seen_at);
            if (!isNaN(d.getTime())) {
              bits.push({
                label: 'First in your inbox',
                value: `${format(d, 'MMM d, yyyy')} · ${formatDistanceToNowStrict(d, { addSuffix: true })}`,
              });
            }
          }

          const subj = es?.last_inbound_subject || es?.last_outbound_subject;
          if (subj) {
            bits.push({
              label: 'Recent thread',
              value: `"${subj.length > 80 ? subj.slice(0, 80) + '…' : subj}"`,
            });
          }

          if (es && (es.emails_sent || es.emails_received || es.thread_count)) {
            const parts = [
              es.thread_count ? `${es.thread_count} thread${es.thread_count === 1 ? '' : 's'}` : null,
              es.emails_sent ? `${es.emails_sent} sent` : null,
              es.emails_received ? `${es.emails_received} received` : null,
            ].filter(Boolean);
            if (parts.length) bits.push({ label: 'Volume', value: parts.join(' · ') });
          }

          const ccNames = (es?.last_inbound_cc_names || es?.last_outbound_cc_names || []).filter(Boolean).slice(0, 4);
          if (ccNames.length) {
            bits.push({
              label: 'On the thread',
              value: ccNames.join(', '),
            });
          }

          if (liveContact.connections.length > 0) {
            bits.push({
              label: 'Network',
              value: `Linked to ${liveContact.connections.length} ${liveContact.connections.length === 1 ? 'person' : 'people'} in your graph`,
            });
          }

          if (bits.length === 0) return null;

          return (
            <motion.div
              initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.03 }}
              className="rounded-xl border border-[var(--border)] p-4" style={glassCard}>
              <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-secondary)]/70 mb-2.5">
                How we found you
              </div>
              <div className="space-y-1.5">
                {bits.map((b, i) => (
                  <div key={i} className="flex items-baseline gap-2 text-[12px]">
                    <span className="text-[var(--text-secondary)] min-w-[78px] flex-shrink-0">{b.label}</span>
                    <span className="text-[var(--text-primary)]/90 leading-snug">{b.value}</span>
                  </div>
                ))}
              </div>
            </motion.div>
          );
        })()}

        {/* TALKING POINTS — own section, short headlines, click to expand full */}
        {prebriefBullets.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.05 }}
            className="rounded-xl border border-[var(--accent)]/30 p-4"
            style={{
              background: 'linear-gradient(180deg, rgba(124,92,255,0.10), rgba(124,92,255,0.03))',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 4px 14px -6px rgba(124,92,255,0.18)',
              backdropFilter: 'blur(10px)',
            }}>
            <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--accent)]/90 mb-3">Talking points</div>
            <div className="space-y-1">
              {prebriefBullets.slice(0, 8).map((b, i) => {
                const isOpen = expandedPoints.has(i);
                // Short headline = first clause (cut at comma/dash/period) or first 7 words
                const cutPunct = b.search(/[,.\-—:]/);
                const headline = cutPunct > 0 && cutPunct < 60
                  ? b.slice(0, cutPunct).trim()
                  : b.split(/\s+/).slice(0, 7).join(' ') + (b.split(/\s+/).length > 7 ? '…' : '');
                const showExpand = headline.length < b.length;
                return (
                  <button key={i} onClick={() => showExpand && setExpandedPoints((prev) => {
                    const n = new Set(prev); if (n.has(i)) n.delete(i); else n.add(i); return n;
                  })}
                    className={`w-full text-left flex items-baseline gap-2.5 px-1 py-1.5 rounded-md text-[12.5px] text-[var(--text-primary)]/90 leading-snug ${showExpand ? 'hover:bg-[var(--accent)]/8 cursor-pointer' : 'cursor-default'} transition-colors`}>
                    <span className="text-[var(--accent)]/60 leading-none flex-shrink-0">·</span>
                    <span className="flex-1">{isOpen ? b : headline}</span>
                  </button>
                );
              })}
            </div>
          </motion.div>
        )}

        {/* SIGNAL CATEGORIES — each is a click-to-expand glass card */}
        {order.map((cat, idx) => {
          const items = buckets.get(cat);
          if (!items || items.length === 0) return null;
          const style = categoryStyles[cat] || categoryStyles.context;
          const isOpen = expandedCats.has(cat);
          return (
            <motion.div
              key={cat}
              initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: 0.06 + idx * 0.03 }}
              className="rounded-xl border border-[var(--border)] overflow-hidden"
              style={glassCard}>
              <button
                onClick={() => setExpandedCats((prev) => {
                  const n = new Set(prev);
                  if (n.has(cat)) n.delete(cat); else n.add(cat);
                  return n;
                })}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-[var(--hover-bg)]/40 transition-colors text-left">
                <div className="flex items-center gap-2.5">
                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: style.color }} />
                  <span className="text-[11.5px] uppercase tracking-[0.1em] font-medium text-[var(--text-primary)]">{style.label}</span>
                  <span className="text-[11px] text-[var(--text-secondary)]/60 tabular-nums">{items.length}</span>
                </div>
                <motion.span animate={{ rotate: isOpen ? 90 : 0 }} transition={{ duration: 0.18 }} className="text-[var(--text-secondary)]/60">
                  <ChevronRight size={13} />
                </motion.span>
              </button>
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.22, ease: 'easeOut' }}
                    style={{ overflow: 'hidden' }}>
                    <div className="px-3 pb-3 pt-2 space-y-1.5 border-t border-[var(--border)]/60">
                      {items.map((s, i) => (
                        <a key={i} href={s.sourceUrl} target="_blank" rel="noopener noreferrer"
                          className="block rounded-lg border border-[var(--border)] hover:border-[var(--accent)]/40 transition-colors overflow-hidden"
                          style={{ background: 'rgba(255,255,255,0.02)' }}>
                          <div className="px-3 py-2.5">
                            <p className="text-[12.5px] text-[var(--text-primary)]/90 leading-snug whitespace-pre-wrap break-words">
                              {s.text}
                            </p>
                          </div>
                          <div className="flex items-center gap-1 px-3 py-1.5 border-t border-[var(--border)]/50 text-[10.5px] text-[var(--accent)]/80">
                            {s.source} <ExternalLink size={9} />
                          </div>
                        </a>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          );
        })}
      </div>
    );
  }

  // ── Picking phase ──
  if (phase === 'picking') {
    return (
      <div className="px-6 py-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-[11px] uppercase tracking-[0.12em] font-medium text-[var(--text-secondary)]">
            Is this {contactName}?
          </h3>
          <button onClick={() => { setPhase('idle'); setCandidates([]); }}
            className="text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
            <X size={11} />
          </button>
        </div>
        <p className="text-[11px] text-[var(--text-secondary)] mb-3">
          Pick the right person, or run again with more info.
        </p>
        <div className="space-y-1.5">
          {candidates.map((c, i) => (
            <button key={i} onClick={() => runDeep(c)}
              className="w-full text-left px-3 py-2.5 rounded-lg border border-[var(--border)] hover:border-[var(--accent)]/40 hover:bg-[var(--accent)]/5 transition-all">
              <div className="flex items-start gap-3">
                {c.photoUrl ? (
                  <img src={c.photoUrl} alt="" className="w-9 h-9 rounded-full object-cover flex-shrink-0" onError={(e) => (e.currentTarget.style.display = 'none')} />
                ) : (
                  <div className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-semibold bg-[var(--accent)]/10 text-[var(--accent)] flex-shrink-0">
                    {c.name.charAt(0)}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="text-[12.5px] font-medium truncate">{c.name}</p>
                    <span className="text-[8.5px] px-1.5 py-0.5 rounded uppercase tracking-wider font-medium"
                      style={{
                        backgroundColor: c.confidence === 'high' ? '#10b98118' : c.confidence === 'medium' ? '#f5c54218' : '#6b728018',
                        color: c.confidence === 'high' ? '#10b981' : c.confidence === 'medium' ? '#d97706' : '#6b7280',
                      }}>
                      {c.confidence}
                    </span>
                  </div>
                  <p className="text-[11px] text-[var(--text-secondary)] truncate">
                    {[c.role, c.company].filter(Boolean).join(' · ')}
                    {c.location && <span className="text-[var(--text-secondary)]/50"> · {c.location}</span>}
                  </p>
                  <p className="text-[10.5px] text-[var(--text-secondary)]/70 mt-1 leading-snug">{c.rationale}</p>
                  <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center gap-1 text-[10px] text-[var(--accent)]/80 hover:text-[var(--accent)] mt-1">
                    Source <ExternalLink size={9} />
                  </a>
                </div>
              </div>
            </button>
          ))}
          <button onClick={() => { setPhase('idle'); setCandidates([]); }}
            className="w-full text-center text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] py-2.5 transition-colors">
            None of these are them
          </button>
        </div>
      </div>
    );
  }

  // ── Loading phases ──
  if (phase === 'candidates' || phase === 'deep') {
    return (
      <div className="px-6 py-4">
        <div className="flex items-center gap-2.5 px-3 py-3 rounded-lg bg-[var(--accent)]/5 border border-[var(--accent)]/20">
          <Loader2 size={14} className="text-[var(--accent)] animate-spin" />
          <div>
            <p className="text-[12px] font-medium">
              {phase === 'candidates' ? 'Searching the web for matches...' : 'Running deep research...'}
            </p>
            <p className="text-[10px] text-[var(--text-secondary)]">
              {phase === 'candidates' ? 'Finding likely public identities' : 'This takes 15–30 seconds. Searching across LinkedIn, news, podcasts, blogs.'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ── Idle — auto-run is in flight or the previous run errored. Quiet retry surface. ──
  return (
    <div className="px-1 pt-2">
      {error ? (() => {
        const isQuota = /quota|429|exhausted/i.test(error);
        return (
          <div className="rounded-lg border border-[var(--border)] p-4">
            <p className="text-[12.5px] text-[var(--text-primary)]">
              {isQuota ? 'AI quota hit.' : `Couldn't pull a background for ${contactName.split(' ')[0]}.`}
            </p>
            <p className="text-[11.5px] text-[var(--text-secondary)] mt-1">
              {isQuota ? 'Try again in a bit, or top up Gemini/OpenAI billing for unlimited use.' : error}
            </p>
            <button onClick={runDiscovery}
              className="mt-3 px-3 py-1.5 rounded-md text-[12px] font-medium border border-[var(--border)] text-[var(--text-primary)] hover:border-[var(--accent)]/40 hover:bg-[var(--hover-bg)] transition-colors">
              Try again
            </button>
          </div>
        );
      })() : (
        <div className="flex items-center gap-2.5 px-1 text-[12.5px] text-[var(--text-secondary)]">
          <Loader2 size={13} className="animate-spin text-[var(--accent)]" />
          Looking up {contactName.split(' ')[0]} on the web…
        </div>
      )}
    </div>
  );
}
