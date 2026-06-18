'use client';

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, ArrowRight, Loader2 } from 'lucide-react';
import OrbitLogo from '@/components/OrbitLogo';

/**
 * First-run sync overlay — full-screen takeover that turns the 30-60s
 * background sync into the most magical moment of personal CRM:
 *   1) Live stage progress with growing counts ("Pulled 47 contacts ✓")
 *   2) When stage = 'done', a 3-4s celebration reveal with ticking numbers
 *      ("147 people. 234 connections. 27 meetings.") + CTA into the app.
 *
 * Subsequent 15-min poll syncs don't show this — they use the quiet
 * `backgroundSyncing` banner inside HomeView. Triggered via
 * progress.isFirstRun, set by safeSync in page.tsx.
 */

export type SyncStage = 'idle' | 'calendar' | 'contacts' | 'email' | 'mining' | 'done';

export interface SyncProgress {
  stage: SyncStage;
  counts: {
    contacts: number;
    events: number;
    emails_scanned: number;
    connections: number;
  };
  // Lifetime mail backfill — populated by the looped sync-email-stats calls.
  // months_covered grows as the cursor walks backward toward the oldest message.
  emailBackfill?: {
    done: boolean;
    months_covered: number;
    oldest_indexed_at: string | null;
  };
  isFirstRun: boolean;
  startedAt: number | null;
}

interface Props {
  progress: SyncProgress;
  onComplete: () => void;
}

// Stages in order with the copy + percentage they're worth.
const STAGES: { id: Exclude<SyncStage, 'idle' | 'done'>; label: string; pct: number }[] = [
  { id: 'calendar', label: 'Reading your calendar',     pct: 22 },
  { id: 'contacts', label: 'Importing your contacts',   pct: 48 },
  { id: 'email',    label: 'Scanning recent emails',    pct: 75 },
  { id: 'mining',   label: 'Mapping connections',       pct: 95 },
];

export default function FirstRunSyncOverlay({ progress, onComplete }: Props) {
  // After progress.stage becomes 'done', we switch to a 'reveal' phase locally
  // so we can keep the overlay up for the celebration animation even after
  // the parent's sync finishes.
  const [phase, setPhase] = useState<'hidden' | 'syncing' | 'reveal'>('hidden');

  useEffect(() => {
    if (!progress.isFirstRun) {
      setPhase('hidden');
      return;
    }
    if (progress.stage === 'idle' && phase !== 'reveal') {
      setPhase('hidden');
    } else if (progress.stage === 'done' && phase !== 'reveal') {
      setPhase('reveal');
    } else if (progress.stage !== 'idle' && progress.stage !== 'done') {
      setPhase('syncing');
    }
  }, [progress.stage, progress.isFirstRun, phase]);

  if (phase === 'hidden') return null;

  return (
    <AnimatePresence>
      <motion.div
        key="firstrun-overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.3 }}
        className="fixed inset-0 z-[400] flex items-center justify-center"
        style={{
          background: 'color-mix(in srgb, var(--bg-surface) 96%, transparent)',
          backdropFilter: 'blur(12px)',
        }}
      >
        {phase === 'syncing' && <SyncingView progress={progress} />}
        {phase === 'reveal' && (
          <RevealView
            counts={progress.counts}
            onContinue={() => { setPhase('hidden'); onComplete(); }}
          />
        )}
      </motion.div>
    </AnimatePresence>
  );
}

// ─── Live stages + counts during sync ──────────────────────────────────
function SyncingView({ progress }: { progress: SyncProgress }) {
  const currentIdx = STAGES.findIndex((s) => s.id === progress.stage);
  // Stage-based percentage — derived from the slowest completed stage plus
  // a small bump for "in-progress." Honest because it maps to real backend
  // milestones, not wall-clock time.
  const targetPct =
    currentIdx === -1
      ? 0
      : Math.min(95, STAGES[currentIdx].pct);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="w-full max-w-md px-8 text-center"
    >
      <div className="flex items-center justify-center gap-2 mb-10">
        <OrbitLogo size={18} className="text-[var(--text-primary)]" />
        <span className="text-[10px] font-semibold text-[var(--text-secondary)]" style={{ letterSpacing: '0.2em' }}>ORBIT</span>
      </div>

      <h1 className="text-[20px] font-semibold tracking-tight mb-1">Mapping your network</h1>
      <p className="text-[12.5px] text-[var(--text-secondary)] mb-8">
        First sync usually takes 30–60 seconds.
      </p>

      {/* Stage list with growing counts */}
      <div className="space-y-2.5 text-left mb-8">
        {STAGES.map((stage, i) => {
          const status: 'done' | 'active' | 'pending' =
            currentIdx > i ? 'done' : currentIdx === i ? 'active' : 'pending';
          const count = stageCount(stage.id, progress.counts);
          const subline = stage.id === 'email' && status !== 'pending'
            ? backfillCopy(progress.emailBackfill)
            : null;
          return (
            <motion.div
              key={stage.id}
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: status === 'pending' ? 0.35 : 1, x: 0 }}
              transition={{ duration: 0.2 }}
              className="flex items-start gap-3"
            >
              <div className="w-5 h-5 flex items-center justify-center flex-shrink-0 mt-0.5">
                {status === 'done' && (
                  <div className="w-5 h-5 rounded-full bg-[#10b981]/20 flex items-center justify-center">
                    <Check size={11} className="text-[#10b981]" />
                  </div>
                )}
                {status === 'active' && <Loader2 size={13} className="animate-spin text-[var(--accent)]" />}
                {status === 'pending' && <div className="w-1.5 h-1.5 rounded-full bg-[var(--text-secondary)]/40" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] text-[var(--text-primary)] flex-1">{stage.label}</span>
                  {count !== null && (
                    <motion.span
                      key={count}
                      initial={{ opacity: 0, y: -2 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="text-[12px] text-[var(--text-secondary)] tabular-nums"
                    >
                      {count.toLocaleString()}
                    </motion.span>
                  )}
                </div>
                {subline && (
                  <motion.div
                    key={subline}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="text-[10.5px] text-[var(--text-secondary)]/70 mt-0.5"
                  >
                    {subline}
                  </motion.div>
                )}
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* Progress bar — stage-based percentage, eases smoothly between stages */}
      <div className="w-full h-1 rounded-full overflow-hidden mb-2" style={{ background: 'color-mix(in srgb, var(--accent) 12%, transparent)' }}>
        <motion.div
          className="h-full rounded-full"
          style={{ background: 'var(--accent)' }}
          animate={{ width: `${targetPct}%` }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
        />
      </div>
      <div className="text-[11px] tabular-nums text-[var(--accent)]/80">
        {targetPct}%
      </div>
    </motion.div>
  );
}

// Return the count for the given stage, or null if it's not surfaceable yet.
function stageCount(id: SyncStage, c: SyncProgress['counts']): number | null {
  switch (id) {
    case 'calendar': return c.events > 0 ? c.events : null;
    case 'contacts': return c.contacts > 0 ? c.contacts : null;
    case 'email':    return c.emails_scanned > 0 ? c.emails_scanned : null;
    case 'mining':   return c.connections > 0 ? c.connections : null;
    default:         return null;
  }
}

// Sub-line under the "email" stage that surfaces the lifetime backfill progress.
// Months covered grows as the cursor walks backward through the mailbox; once
// backfill_done flips, we say "all caught up".
function backfillCopy(b: SyncProgress['emailBackfill']): string | null {
  if (!b) return null;
  if (b.done) return 'Full history indexed';
  if (b.months_covered <= 0) return 'Indexing most recent…';
  if (b.months_covered < 12) return `Indexing back ${b.months_covered}mo…`;
  const years = (b.months_covered / 12).toFixed(1).replace(/\.0$/, '');
  return `Indexing back ${years}yr…`;
}

// ─── Reveal moment ─────────────────────────────────────────────────────
function RevealView({ counts, onContinue }: { counts: SyncProgress['counts']; onContinue: () => void }) {
  // Tick the numbers up from 0 → final. Cheap requestAnimationFrame loop,
  // ~700ms ease-out. Numbers are tabular so the layout doesn't jitter.
  const [shown, setShown] = useState({ contacts: 0, connections: 0, events: 0 });
  useEffect(() => {
    const start = performance.now();
    const DURATION = 800;
    const ease = (t: number) => 1 - Math.pow(1 - t, 3);
    let raf = 0;
    const tick = (ts: number) => {
      const t = Math.min(1, (ts - start) / DURATION);
      const e = ease(t);
      setShown({
        contacts: Math.round(counts.contacts * e),
        connections: Math.round(counts.connections * e),
        events: Math.round(counts.events * e),
      });
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [counts.contacts, counts.connections, counts.events]);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className="w-full max-w-md px-8 text-center"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.85 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ delay: 0.1, duration: 0.5 }}
        className="w-14 h-14 mx-auto mb-8 rounded-full flex items-center justify-center"
        style={{
          background: 'radial-gradient(circle at 35% 30%, var(--accent), color-mix(in srgb, var(--accent) 55%, #000))',
          boxShadow: '0 0 40px color-mix(in srgb, var(--accent) 45%, transparent)',
        }}
      >
        <Check size={26} strokeWidth={2.5} className="text-white" />
      </motion.div>

      <motion.h1
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2, duration: 0.4 }}
        className="text-[22px] font-semibold tracking-tight mb-1"
      >
        We mapped your network.
      </motion.h1>
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.35, duration: 0.4 }}
        className="text-[12.5px] text-[var(--text-secondary)] mb-10"
      >
        Here&apos;s what we found in your calendar and email.
      </motion.p>

      {/* Three big numbers */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.45, duration: 0.5 }}
        className="grid grid-cols-3 gap-4 mb-12"
      >
        <Stat label="People" value={shown.contacts} />
        <Stat label="Connections" value={shown.connections} />
        <Stat label="Meetings" value={shown.events} />
      </motion.div>

      <motion.button
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.7, duration: 0.4 }}
        onClick={onContinue}
        className="inline-flex items-center gap-1.5 px-6 py-3 rounded-full bg-[var(--accent)] text-white text-[13px] font-medium
                   hover:scale-[1.03] active:scale-[0.97] transition-transform"
      >
        Open my network <ArrowRight size={13} />
      </motion.button>
    </motion.div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div
        className="text-[32px] font-bold tabular-nums leading-none mb-1"
        style={{
          background: 'linear-gradient(180deg, var(--text-primary), color-mix(in srgb, var(--text-primary) 65%, transparent))',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
        }}
      >
        {value.toLocaleString()}
      </div>
      <div className="text-[10.5px] uppercase tracking-[0.12em] text-[var(--text-secondary)]/70">
        {label}
      </div>
    </div>
  );
}
