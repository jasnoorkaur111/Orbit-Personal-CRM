'use client';

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2, Check, X } from 'lucide-react';

/**
 * Persistent corner pill that surfaces the lifetime mail-history backfill.
 * Shown whenever there's resumable work in the cursor — so the user always
 * sees that scanning is happening (or queued), not just during the first-
 * run reveal. Click expands a detail panel with ETA and chunk feed.
 *
 * Auto-hides 4s after backfill_done flips true.
 */

export interface ChunkLog {
  index: number;
  scanned: number;
  fromDate: string | null;  // newest message in chunk
  toDate: string | null;    // oldest message in chunk (cursor advances here)
  durationMs: number;
  startedAt: string;
}

export interface BackfillStatus {
  active: boolean;
  pct: number | null;
  monthsCovered: number;
  scannedTotal: number;
  totalMailbox: number | null;
  done: boolean;
  currentlyScanning: string | null;  // backfill_oldest from latest chunk
  etaSeconds: number | null;
  chunkLog: ChunkLog[];               // newest first, capped at 10
}

interface Props {
  status: BackfillStatus;
}

function fmtMonthYear(iso: string | null): string {
  if (!iso) return '…';
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  } catch { return '…'; }
}

function fmtEta(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return '…';
  if (seconds < 60) return `~${seconds}s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `~${m} min`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `~${h}h ${mm}m`;
}

export default function EmailBackfillPill({ status }: Props) {
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Once the pill becomes visible it stays visible — at 100% it sticks
  // around as a permanent "full mail history indexed" confirmation. Only
  // hidden in the initial pre-first-chunk state when we don't yet know
  // whether there's work to do.
  useEffect(() => {
    if (status.active || status.done) setVisible(true);
  }, [status.active, status.done]);

  if (!visible) return null;

  const pct = status.done ? 100 : status.pct;
  const remainingMessages = status.totalMailbox && status.scannedTotal != null
    ? Math.max(0, status.totalMailbox - status.scannedTotal)
    : null;

  const monthsLabel = status.monthsCovered <= 0
    ? 'most recent'
    : status.monthsCovered < 12
      ? `${status.monthsCovered}mo back`
      : `${(status.monthsCovered / 12).toFixed(1).replace(/\.0$/, '')}yr back`;

  return (
    <>
      {/* ─── Pill (always rendered when visible; doubles as expand trigger) ─── */}
      <AnimatePresence>
        <motion.button
          key="email-backfill-pill"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
          onClick={() => setExpanded((e) => !e)}
          className="fixed bottom-[calc(72px+env(safe-area-inset-bottom,0px))] md:bottom-6 right-4 md:right-6 z-[150] flex items-center gap-2.5 pl-2.5 pr-3 py-1.5 rounded-full shadow-lg hover:scale-[1.03] active:scale-[0.97] transition-transform cursor-pointer"
          style={{
            background: 'color-mix(in srgb, var(--bg-surface) 92%, transparent)',
            backdropFilter: 'blur(8px)',
            border: '1px solid color-mix(in srgb, var(--accent) 18%, transparent)',
          }}
        >
          {status.done ? (
            <div className="w-4 h-4 rounded-full bg-[#10b981]/20 flex items-center justify-center">
              <Check size={9} className="text-[#10b981]" strokeWidth={3} />
            </div>
          ) : (
            <Loader2 size={12} className="animate-spin text-[var(--accent)]" />
          )}
          <div className="flex flex-col leading-tight text-left">
            <div className="text-[11px] font-medium text-[var(--text-primary)]">
              {status.done ? 'Full mail history indexed' : 'Indexing mail history'}
            </div>
            {!status.done && (
              <div className="text-[9.5px] text-[var(--text-secondary)]/80 tabular-nums">
                {monthsLabel}{pct !== null ? ` · ${pct}%` : ''}
              </div>
            )}
          </div>
          {!status.done && pct !== null && (
            <div className="w-10 h-1 rounded-full overflow-hidden ml-1" style={{ background: 'color-mix(in srgb, var(--accent) 18%, transparent)' }}>
              <motion.div
                className="h-full rounded-full"
                style={{ background: 'var(--accent)' }}
                animate={{ width: `${pct}%` }}
                transition={{ duration: 0.4, ease: 'easeOut' }}
              />
            </div>
          )}
        </motion.button>
      </AnimatePresence>

      {/* ─── Detail panel (toggled by click) ─── */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            key="email-backfill-detail"
            initial={{ opacity: 0, y: 10, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.96 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="fixed bottom-[calc(128px+env(safe-area-inset-bottom,0px))] md:bottom-20 right-4 md:right-6 z-[151] w-[360px] max-w-[calc(100vw-2rem)] rounded-2xl shadow-2xl overflow-hidden"
            style={{
              background: 'var(--bg-surface)',
              border: '1px solid color-mix(in srgb, var(--accent) 18%, transparent)',
            }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 pt-3.5 pb-2.5">
              <div className="flex items-center gap-2">
                {status.done
                  ? <Check size={14} className="text-[#10b981]" strokeWidth={2.5} />
                  : <Loader2 size={14} className="animate-spin text-[var(--accent)]" />
                }
                <span className="text-[12.5px] font-semibold tracking-tight text-[var(--text-primary)]">
                  Mail history backfill
                </span>
              </div>
              <button
                onClick={() => setExpanded(false)}
                className="text-[var(--text-secondary)]/60 hover:text-[var(--text-primary)] transition-colors"
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </div>

            {/* Big number row */}
            <div className="px-4 pb-3">
              <div className="flex items-baseline gap-1.5">
                <span className="text-[26px] font-bold tabular-nums leading-none text-[var(--text-primary)]">
                  {(status.scannedTotal || 0).toLocaleString()}
                </span>
                <span className="text-[12px] text-[var(--text-secondary)]/70 tabular-nums">
                  {status.totalMailbox ? `/ ${status.totalMailbox.toLocaleString()} messages` : 'messages indexed'}
                </span>
              </div>
              {!status.done && remainingMessages !== null && (
                <div className="text-[11px] text-[var(--text-secondary)]/70 mt-0.5 tabular-nums">
                  {remainingMessages.toLocaleString()} to go
                  {status.etaSeconds !== null && ` · ${fmtEta(status.etaSeconds)} remaining`}
                </div>
              )}
              {status.done && (
                <div className="text-[11px] text-[#10b981]/90 mt-0.5">
                  Complete. Full mailbox scanned.
                </div>
              )}
            </div>

            {/* Progress bar */}
            <div className="px-4">
              <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: 'color-mix(in srgb, var(--accent) 14%, transparent)' }}>
                <motion.div
                  className="h-full rounded-full"
                  style={{ background: 'var(--accent)' }}
                  animate={{ width: `${pct || 0}%` }}
                  transition={{ duration: 0.5, ease: 'easeOut' }}
                />
              </div>
            </div>

            {/* Currently scanning */}
            {!status.done && status.currentlyScanning && (
              <div className="px-4 pt-3 pb-1 flex items-center justify-between">
                <span className="text-[10.5px] uppercase tracking-[0.1em] text-[var(--text-secondary)]/60">
                  Currently scanning
                </span>
                <span className="text-[11.5px] text-[var(--text-primary)] tabular-nums">
                  {fmtMonthYear(status.currentlyScanning)}
                </span>
              </div>
            )}

            {/* Live chunk feed */}
            {status.chunkLog.length > 0 && (
              <div className="px-4 pt-3 pb-4">
                <div className="text-[10.5px] uppercase tracking-[0.1em] text-[var(--text-secondary)]/60 mb-2">
                  Recent chunks
                </div>
                <div className="space-y-1">
                  {status.chunkLog.slice(0, 5).map((c) => (
                    <div key={c.index} className="flex items-center gap-2 text-[10.5px] tabular-nums">
                      <span className="text-[var(--text-secondary)]/60 w-8 shrink-0">#{c.index}</span>
                      <span className="text-[var(--text-primary)] w-14 shrink-0">{c.scanned.toLocaleString()} msgs</span>
                      <span className="text-[var(--text-secondary)]/70 flex-1 min-w-0 truncate">
                        {fmtMonthYear(c.fromDate)} → {fmtMonthYear(c.toDate)}
                      </span>
                      <span className="text-[var(--text-secondary)]/50 shrink-0">
                        {(c.durationMs / 1000).toFixed(1)}s
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Helpful footer */}
            {!status.done && (
              <div className="px-4 pb-3 pt-0.5 text-[10px] text-[var(--text-secondary)]/55 leading-relaxed border-t" style={{ borderColor: 'color-mix(in srgb, var(--text-secondary) 12%, transparent)' }}>
                <div className="pt-2.5">
                  Indexing continues in the background. Keep using the app.
                  Contacts light up as their email history surfaces.
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
