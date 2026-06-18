'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { Loader2, Link2, ArrowRight } from 'lucide-react';
import Link from 'next/link';
import type { FirstRunInfo } from '@/lib/firstRunContext';
import { hasAnyProvider } from '@/lib/firstRunContext';

/**
 * First-run banner — two modes depending on whether the user has any sync
 * providers connected:
 *
 *   1. Progress mode (any of MS/Google/iCal connected) — slim accent-tinted
 *      strip with live counts and the unified firstRunProgress.
 *
 *   2. CTA mode (nothing connected) — prompt the user to go to Settings and
 *      connect a provider. No progress bar (there's nothing to sync), no
 *      misleading "Setting up your network" copy.
 *
 * Auto-hides when progress is >= 95 (= effectively done; tail-end backfill
 * happens silently via the corner pill).
 */

interface Props {
  info: FirstRunInfo;
}

export default function FirstRunBanner({ info }: Props) {
  // Visibility is gated by the caller via isFirstRunActive(). Here we just
  // pick CTA vs progress mode based on provider state. A revoked-token
  // user gets a slightly different CTA copy than a never-connected one —
  // tells them which provider to reconnect.
  const noProviders = !hasAnyProvider(info);
  const reconnectTarget = info.microsoftRevoked ? 'Microsoft' : info.googleRevoked ? 'Google' : null;
  const isReconnect = noProviders && !!reconnectTarget;
  return (
    <AnimatePresence>
      {/* CTA mode (first-time connect OR reconnect after revocation) */}
      {noProviders && (
        <motion.div
          key="first-run-cta"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
          className="mb-3 flex items-center gap-3 px-3.5 py-2.5 rounded-xl"
          style={{
            background: 'color-mix(in srgb, var(--accent) 8%, transparent)',
            border: '1px solid color-mix(in srgb, var(--accent) 22%, transparent)',
          }}
        >
          <Link2 size={13} className="text-[var(--accent)] shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-[12.5px] font-medium text-[var(--text-primary)] truncate">
              {isReconnect
                ? `${reconnectTarget} access expired — reconnect to keep syncing`
                : 'Connect a provider to map your network'}
            </div>
            <div className="text-[10.5px] text-[var(--text-secondary)]/80 mt-0.5 truncate">
              {isReconnect
                ? 'Your existing data stays. Sign in again to resume calendar and mail sync.'
                : 'Microsoft or Google pulls in your calendar, contacts, and email. Takes 30 seconds.'}
            </div>
          </div>
          <Link
            href="/settings"
            className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-[11.5px] font-medium"
            style={{ background: 'var(--text-primary)', color: 'var(--bg-primary)' }}
          >
            {isReconnect ? 'Reconnect' : 'Connect'} <ArrowRight size={11} />
          </Link>
        </motion.div>
      )}

      {/* Progress mode */}
      {!noProviders && (
        <motion.div
          key="first-run-banner"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
          className="mb-3 flex items-center gap-3 px-3.5 py-2.5 rounded-xl"
          style={{
            background: 'color-mix(in srgb, var(--accent) 8%, transparent)',
            border: '1px solid color-mix(in srgb, var(--accent) 22%, transparent)',
          }}
        >
          <Loader2 size={13} className="animate-spin text-[var(--accent)] shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-[12.5px] font-medium text-[var(--text-primary)] truncate">
              Setting up your network · {info.progress}%
            </div>
            <div className="text-[10.5px] text-[var(--text-secondary)]/80 mt-0.5 tabular-nums truncate">
              {detailLine(info)}
            </div>
          </div>
          <div className="hidden sm:block w-28 h-1 rounded-full overflow-hidden" style={{ background: 'color-mix(in srgb, var(--accent) 14%, transparent)' }}>
            <motion.div
              className="h-full rounded-full"
              style={{ background: 'var(--accent)' }}
              animate={{ width: `${info.progress}%` }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
            />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function detailLine(info: FirstRunInfo): string {
  const parts: string[] = [];
  if (info.contactsCount > 0) parts.push(`${info.contactsCount} contact${info.contactsCount === 1 ? '' : 's'}`);
  if (info.scannedTotal > 0) {
    parts.push(
      info.totalMailbox
        ? `${info.scannedTotal.toLocaleString()} / ${info.totalMailbox.toLocaleString()} messages scanned`
        : `${info.scannedTotal.toLocaleString()} messages scanned`,
    );
  }
  if (parts.length === 0) {
    return info.hasMicrosoft
      ? 'Pulling your calendar, contacts, and email — 30–60 seconds.'
      : 'Pulling your calendar and contacts — usually 30–60 seconds.';
  }
  const tail = info.hasMicrosoft ? ' · full mail history takes 2–5 minutes' : '';
  return parts.join(' · ') + tail;
}
