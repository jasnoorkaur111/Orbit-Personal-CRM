// Sunset palette — warm fresh contacts → deep navy cold contacts. Color is
// the primary recency indicator on the network graph, replacing the random
// 9-color rotation that made the graph feel chaotic.
//
// Mapping is continuous (linear RGB interp between stops) so a contact
// drifting from 14d → 18d → 25d transitions smoothly through the gradient
// rather than snapping between buckets.

const STOPS: { days: number; hex: string }[] = [
  { days: 0,   hex: '#ff5a3c' },  // strong + fresh
  { days: 14,  hex: '#ffa257' },  // recent
  { days: 45,  hex: '#ffcd80' },  // regular / fading
  { days: 120, hex: '#6aa1ff' },  // stale — bumped saturation (was #5b8bd9)
  { days: 365, hex: '#4576c4' },  // cold — much bluer + brighter (was #2a3e5c navy mud)
];

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/**
 * Color for a contact node, derived purely from days-since-last-touch.
 * Returns a hex string suitable for canvas fillStyle / radial-gradient stops.
 *
 *   - 0d   → bright orange-red  (strong + fresh)
 *   - 14d  → warm amber         (recent)
 *   - 45d  → soft gold          (regular / fading)
 *   - 120d → medium blue        (stale)
 *   - 365d → deep navy          (cold)
 *
 * Pass daysAgo = Infinity (or very large) for never-contacted → cold navy.
 */
export function nodeColor(daysAgo: number): string {
  if (!Number.isFinite(daysAgo)) return STOPS[STOPS.length - 1].hex;
  const d = Math.max(0, daysAgo);

  // Find the bracketing stops
  let lo = STOPS[0];
  let hi = STOPS[STOPS.length - 1];
  for (let i = 0; i < STOPS.length - 1; i++) {
    if (d >= STOPS[i].days && d <= STOPS[i + 1].days) {
      lo = STOPS[i]; hi = STOPS[i + 1];
      break;
    }
  }
  if (d >= hi.days) return hi.hex;
  if (d <= lo.days) return lo.hex;

  const t = (d - lo.days) / (hi.days - lo.days);
  const [r1, g1, b1] = hexToRgb(lo.hex);
  const [r2, g2, b2] = hexToRgb(hi.hex);
  return rgbToHex(
    r1 + (r2 - r1) * t,
    g1 + (g2 - g1) * t,
    b1 + (b2 - b1) * t,
  );
}

/**
 * Tags that explicitly mark a contact as important — the firm-domain
 * matcher auto-populates 'investor' for known VC domains, plus a handful
 * of conventional CRM roles. Tag match is one of several importance
 * signals; see isImportant() below.
 */
const IMPORTANT_TAGS = new Set(['investor', 'vc', 'angel', 'partner', 'customer', 'founder', 'ceo', 'client']);

export interface AttentionFlag {
  /** This contact is one you should pay extra attention to (tag, high-
   *  touch relationship, recurring meetings, substantive notes, or
   *  manually added to a project). Drives brighter + larger halo. */
  important: boolean;
  /** Tooltip copy — explains WHY this node has a halo. */
  reason: string;
}

/**
 * "Important" = anyone meaningful, not just specifically-tagged contacts.
 * Triggers on any of:
 *   - An explicit important tag
 *   - High-touch email relationship (20+ messages or 5+ threads)
 *   - Recurring meetings (3+ co-attended events)
 *   - Substantive user notes (50+ chars — signal the user cares)
 *   - Manually added to any project (explicit "tracking" signal)
 */
function isImportant(opts: {
  tags: string[];
  emailsSent: number;
  emailsReceived: number;
  threadCount: number;
  meetingCount: number;
  notesLength: number;
  inProject: boolean;
}): { important: boolean; tagLabel: string | null } {
  const importantTag = opts.tags.find((t) => IMPORTANT_TAGS.has(t.toLowerCase()));
  if (importantTag) return { important: true, tagLabel: capitalize(importantTag) };

  const highTouch = (opts.emailsSent + opts.emailsReceived) >= 20 || opts.threadCount >= 5;
  const recurringMeetings = opts.meetingCount >= 3;
  const hasNotes = opts.notesLength >= 50;
  const tracked = opts.inProject;

  return {
    important: highTouch || recurringMeetings || hasNotes || tracked,
    tagLabel: null,
  };
}

/**
 * "Needs attention" detection for the network graph halo + tooltip.
 * Returns a structured flag when the contact deserves a yellow halo,
 * or null when they don't. Four triggers (checked in priority order):
 *
 *   1. Owed reply — they emailed you, you haven't responded in 3+ days
 *   2. Post-meeting follow-up — you've met them, it's been 2-14d, and
 *      you haven't followed up via email
 *   3. Important + going quiet — important contact AND 14-120d quiet
 *   4. Fading regular — was a regular contact, 15-45d quiet, no task
 *
 * Returns null when none apply. The 'important' flag on the result is
 * set whenever the contact passes isImportant() — drives a brighter +
 * larger halo regardless of which trigger fired.
 */
export function needsAttention(opts: {
  daysAgo: number;
  lastInboundAt: string | null | undefined;
  lastOutboundAt: string | null | undefined;
  emailsSent: number;
  emailsReceived: number;
  threadCount: number;
  meetingCount: number;
  notesLength: number;
  inProject: boolean;
  hasOpenTask: boolean;
  tags: string[] | null | undefined;
}): AttentionFlag | null {
  const tags = opts.tags || [];
  const { important, tagLabel } = isImportant({
    tags,
    emailsSent: opts.emailsSent,
    emailsReceived: opts.emailsReceived,
    threadCount: opts.threadCount,
    meetingCount: opts.meetingCount,
    notesLength: opts.notesLength,
    inProject: opts.inProject,
  });

  // 1. Owed reply — highest priority. They wrote to you AFTER your last
  //    outbound, it's been ≥3d, and you actually have email history.
  if (opts.lastInboundAt && opts.emailsReceived >= 1) {
    const lastIn = new Date(opts.lastInboundAt).getTime();
    const lastOut = opts.lastOutboundAt ? new Date(opts.lastOutboundAt).getTime() : 0;
    if (lastIn > lastOut) {
      const daysOwed = Math.floor((Date.now() - lastIn) / 86400000);
      if (daysOwed >= 3) {
        return {
          important,
          reason: tagLabel
            ? `${tagLabel} — owed reply (${daysOwed}d)`
            : `Owed reply (${daysOwed}d)`,
        };
      }
    }
  }

  // 2. Post-meeting follow-up — you've met them and it's been 2-14d.
  //    Suppressed if you've emailed them in the last 3 days (= you've
  //    already followed up). Even brand-new contacts with one meeting
  //    get flagged so the user remembers to send the thank-you / next-
  //    step. Skipped when an open task already nudges.
  if (!opts.hasOpenTask && opts.meetingCount >= 1 && opts.daysAgo >= 2 && opts.daysAgo <= 14) {
    const lastOut = opts.lastOutboundAt ? new Date(opts.lastOutboundAt).getTime() : 0;
    const daysSinceLastOut = lastOut ? Math.floor((Date.now() - lastOut) / 86400000) : Infinity;
    if (daysSinceLastOut > 3) {
      return {
        important,
        reason: tagLabel
          ? `${tagLabel} — follow up after meeting (${opts.daysAgo}d)`
          : `Follow up after meeting (${opts.daysAgo}d)`,
      };
    }
  }

  // 3. Important + going quiet. Wider window than fading-regular because
  //    we want to nudge VIP relationships at any sign of drift.
  if (important && opts.daysAgo >= 14 && opts.daysAgo <= 120) {
    return {
      important: true,
      reason: tagLabel
        ? `${tagLabel} — going quiet (${opts.daysAgo}d)`
        : `Going quiet (${opts.daysAgo}d)`,
    };
  }

  // 4. Fading regular — was a real recurring contact and they've gone
  //    15-45d quiet. Skipped when an open task already nudges.
  if (!opts.hasOpenTask) {
    const wasRegular = opts.threadCount >= 2 || opts.meetingCount >= 2;
    if (wasRegular && opts.daysAgo >= 15 && opts.daysAgo <= 45) {
      return {
        important,
        reason: `Check in with them (${opts.daysAgo}d quiet)`,
      };
    }
  }

  return null;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
