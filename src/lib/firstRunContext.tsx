'use client';

import { createContext, useContext, ReactNode } from 'react';

/**
 * Unified first-run state — single source of truth for "how much of this
 * user's network has been mapped." Consumed by HomeView's banner,
 * NetworkGraph's empty state, TasksView/InboxView empty states, anywhere
 * else that needs to communicate progress to a new user.
 *
 * Computed once in page.tsx (from contacts.length + events.length +
 * backfillStatus) and pushed through Context so every view sees the same
 * numbers without prop-drilling.
 */

export interface FirstRunInfo {
  /** 0-100. Weighted across signals the user actually has, NOT a fixed
   *  formula — provider-aware so Google-only / iCal-only users don't get
   *  stuck at 50% because mail can never tick up. */
  progress: number;
  scannedTotal: number;
  totalMailbox: number | null;
  /** True once the lifetime mail backfill has exhausted the mailbox.
   *  When true, hide all first-run UI — user is fully set up. */
  done: boolean;
  contactsCount: number;
  /** Whether the providers query has resolved. False during the first ~100
   *  ms of every load while user_settings is being fetched. Use this to
   *  suppress the banner until we know what the user has connected — without
   *  it the CTA briefly flashes for everyone. */
  providersLoaded: boolean;
  /** EFFECTIVE provider availability — token present AND not revoked.
   *  Revoked providers (recent 401 from sync routes) count as disconnected
   *  so a user whose MS token was revoked server-side doesn't get stuck
   *  on "Setting up · 0%" because mail can never tick up. */
  hasMicrosoft: boolean;
  hasGoogle: boolean;
  hasIcal: boolean;
  /** True when the corresponding token *exists* in user_settings but a
   *  recent sync returned 401 / refresh failed. Used to surface a
   *  "Reconnect Microsoft" nudge instead of a generic 'connect' CTA. */
  microsoftRevoked: boolean;
  googleRevoked: boolean;
}

const FirstRunContext = createContext<FirstRunInfo>({
  progress: 100,
  scannedTotal: 0,
  totalMailbox: null,
  done: true,
  contactsCount: 0,
  providersLoaded: true,
  hasMicrosoft: false,
  hasGoogle: false,
  hasIcal: false,
  microsoftRevoked: false,
  googleRevoked: false,
});

export function FirstRunProvider({ value, children }: { value: FirstRunInfo; children: ReactNode }) {
  return <FirstRunContext.Provider value={value}>{children}</FirstRunContext.Provider>;
}

export function useFirstRun(): FirstRunInfo {
  return useContext(FirstRunContext);
}

/** True when the user has NO sync providers connected. Banner becomes a
 *  "Connect a provider" CTA instead of a progress bar. */
export function hasAnyProvider(info: FirstRunInfo): boolean {
  return info.hasMicrosoft || info.hasGoogle || info.hasIcal;
}

/**
 * Convenience predicate — true when the user is meaningfully mid-first-run.
 *
 * Decision tree:
 *   1. Providers not loaded yet → hide (prevents CTA flash on every load)
 *   2. Mail backfill done (from cursor, hydrated immediately on boot for
 *      returning users) → hide
 *   3. No providers connected → CTA mode if <3 contacts, else hide
 *      (user with no providers but manual contacts isn't really first-run)
 *   4. Has providers AND progress < 95 → show (progress mode)
 *
 * Notable: NO contactsCount-based escape hatch. The contactsCount ≥ 15
 * trick was masking a real bug — returning users mid-backfill should
 * actually see the banner. Done flag is hydrated from the cursor at boot
 * so returning users with completed backfill bail at step 2.
 */
export function isFirstRunActive(info: FirstRunInfo): boolean {
  if (!info.providersLoaded) return false;
  // No working providers AND a token was revoked → force-show CTA so the
  // user knows sync stopped. Without this branch, a returning MS user
  // whose token was revoked server-side would see no banner (done=true
  // from cursor) — they'd silently stop getting new mail/calendar data
  // with no way to know until they noticed missing items.
  if (!hasAnyProvider(info)) {
    if (info.microsoftRevoked || info.googleRevoked) return true;
    return info.contactsCount < 3;
  }
  if (info.done) return false;
  return info.progress < 95;
}
