import { differenceInDays } from 'date-fns';

export interface HealthResult {
  score: number;       // 0-100
  label: string;       // "Strong", "Good", "Fading", "Cold"
  color: string;       // CSS color
  suggestion?: string; // Why you should reach out
}

/**
 * Best-effort "when did this relationship last show signal." Picks the most
 * recent of: meeting (last_contacted), inbound email reply, outbound email.
 * Outbound is weighted last because writing them doesn't prove they reciprocate.
 */
export function lastSignalDate(c: {
  last_contacted?: string | null;
  email_stats?: { last_inbound_at?: string | null; last_outbound_at?: string | null } | null;
}): Date | null {
  const dates: Date[] = [];
  if (c.last_contacted) dates.push(new Date(c.last_contacted));
  if (c.email_stats?.last_inbound_at) dates.push(new Date(c.email_stats.last_inbound_at));
  if (c.email_stats?.last_outbound_at) dates.push(new Date(c.email_stats.last_outbound_at));
  const valid = dates.filter((d) => !isNaN(d.getTime()));
  if (valid.length === 0) return null;
  return new Date(Math.max(...valid.map((d) => d.getTime())));
}

/**
 * Compute relationship health score for a contact.
 *
 * Factors:
 * - Recency: when was last interaction? (40% weight)
 * - Frequency: how many transcript entries / interactions? (25% weight)
 * - Depth: length/richness of notes (15% weight)
 * - Tasks: do you have active work with them? (10% weight)
 * - Connections: are they well-connected in your graph? (10% weight)
 *
 * Recency uses `last_contacted` *strictly* — no fallback to `created_at`. Bulk-imported
 * contacts with no interaction get 0 recency points (and a "Never contacted" suggestion)
 * instead of inheriting "Strong" status from their import date.
 */
export function computeHealthScore(contact: {
  notes: string;
  last_contacted?: string;
  created_at: string;
  tasks: { completed: boolean }[];
  connections: string[];
  tags?: string[];
  email_stats?: { emails_sent: number; emails_received: number; last_inbound_at?: string | null; last_outbound_at?: string | null; thread_count: number } | null;
}): HealthResult {
  const now = new Date();

  // ── Recency (40 pts) ── uses the MOST RECENT signal across meetings + email
  const lastDate = lastSignalDate(contact);
  const daysSince = lastDate ? differenceInDays(now, lastDate) : Infinity;
  let recencyScore: number;
  if (!isFinite(daysSince)) recencyScore = 0;
  else if (daysSince <= 3) recencyScore = 40;
  else if (daysSince <= 7) recencyScore = 35;
  else if (daysSince <= 14) recencyScore = 28;
  else if (daysSince <= 30) recencyScore = 18;
  else if (daysSince <= 60) recencyScore = 8;
  else recencyScore = Math.max(0, 4 - Math.floor(daysSince / 30));

  // ── Frequency (25 pts) — transcript entries + email exchange volume
  const transcriptCount = (contact.notes.match(/\[\w{3} \d{1,2}\]/g) || []).length;
  const emailVolume =
    (contact.email_stats?.emails_received || 0) +
    Math.floor((contact.email_stats?.emails_sent || 0) / 2);  // outbound counts half (it's not proof of relationship)
  const frequencyScore = Math.min(25, transcriptCount * 5 + Math.min(20, Math.round(Math.log2(1 + emailVolume) * 5)));

  // ── Depth (15 pts) — notes richness ──
  const notesLength = contact.notes.length;
  let depthScore: number;
  if (notesLength > 500) depthScore = 15;
  else if (notesLength > 200) depthScore = 12;
  else if (notesLength > 50) depthScore = 8;
  else if (notesLength > 0) depthScore = 4;
  else depthScore = 0;

  // ── Tasks (10 pts) ──
  const pendingTasks = contact.tasks.filter((t) => !t.completed).length;
  const completedTasks = contact.tasks.filter((t) => t.completed).length;
  const taskScore = Math.min(10, pendingTasks * 3 + completedTasks * 2);

  // ── Connections (10 pts) ──
  const connScore = Math.min(10, contact.connections.length * 3);

  const score = Math.min(100, recencyScore + frequencyScore + depthScore + taskScore + connScore);

  // Label + color
  let label: string;
  let color: string;
  if (score >= 75) { label = 'Strong'; color = '#059669'; }     // emerald-600 (dark green)
  else if (score >= 50) { label = 'Good'; color = '#22c55e'; }   // green-500 (bright green)
  else if (score >= 25) { label = 'Fading'; color = '#f5c542'; } // amber
  else { label = 'Cold'; color = '#ef4444'; }                    // red

  // Suggestion
  let suggestion: string | undefined;
  if (!isFinite(daysSince)) {
    if (depthScore > 0 || pendingTasks > 0) suggestion = 'Never contacted — start the relationship';
    // else: bulk-imported with no signal at all — no suggestion (would be noise)
  } else if (daysSince > 30 && score < 50) {
    suggestion = `Haven't connected in ${daysSince} days`;
  } else if (pendingTasks > 0 && daysSince > 7) {
    suggestion = `${pendingTasks} pending task${pendingTasks > 1 ? 's' : ''} to follow up on`;
  } else if (daysSince > 14) {
    suggestion = `It's been ${daysSince} days — might be worth a check-in`;
  }

  return { score, label, color, suggestion };
}

/**
 * Get top contacts to reach out to today.
 * Prioritizes: high decay rate + pending tasks + recent connections going quiet.
 */
export function getDailyReachOuts(contacts: {
  id: string;
  name: string;
  company?: string;
  color?: string;
  photo?: string;
  notes: string;
  last_contacted?: string;
  created_at: string;
  tasks: { completed: boolean; title: string }[];
  connections: string[];
  tags?: string[];
  is_self?: boolean;
  is_promoted?: boolean;
  email_stats?: { emails_sent: number; emails_received: number; last_inbound_at?: string | null; last_outbound_at?: string | null; thread_count: number } | null;
}[], limit = 5) {
  const scored = contacts
    .filter((c) => !c.is_self && c.is_promoted !== false)
    .map((c) => {
      const health = computeHealthScore(c);
      const last = lastSignalDate(c);
      const daysSince = last ? differenceInDays(new Date(), last) : Infinity;
      const hasTranscripts = /\[\w{3} \d{1,2}\]/.test(c.notes);
      const hasEmailHistory = (c.email_stats?.emails_received || 0) > 0;
      const hasSignal = hasTranscripts || hasEmailHistory;
      const hasPendingTasks = c.tasks.some((t) => !t.completed);

      // Three relationship-action archetypes covered:
      //   "Thanks / touch base"  — met very recently (1-6d), no follow-up.
      //   "Going quiet"          — sweet-spot 7-30d, freshest issue.
      //   "Edge of cold"         — 30-90d, declining priority (90+ = Reconnect).
      // All three add up to a real 'people you should reach out to' list.
      let urgency = 0;
      if (isFinite(daysSince) && hasSignal) {
        if (daysSince >= 1 && daysSince <= 6) urgency = 35;          // just met — thanks/touch base
        else if (daysSince >= 7 && daysSince <= 14) urgency = 50;    // freshest going quiet
        else if (daysSince > 14 && daysSince <= 30) urgency = 40;    // going quiet this month
        else if (daysSince > 30 && daysSince <= 60) urgency = 22;    // borderline
        else if (daysSince > 60 && daysSince <= 90) urgency = 10;    // edge of cold
        // > 90: 0 — these belong in Reconnect drawer
      }
      if (hasPendingTasks && isFinite(daysSince) && daysSince >= 3) urgency += 20;
      if (health.score < 40 && hasSignal && isFinite(daysSince) && daysSince <= 90) urgency += 8;
      if (!isFinite(daysSince) && hasPendingTasks) urgency = 15;

      return { ...c, health, urgency, daysSince: isFinite(daysSince) ? daysSince : 9999 };
    })
    .filter((c) => c.urgency > 0)
    // Sort by urgency DESC, then by daysSince ASC (when tied, fresher wins —
    // 'just went cold' beats 'long going cold' at the same urgency band)
    .sort((a, b) => b.urgency - a.urgency || a.daysSince - b.daysSince)
    .slice(0, limit);

  return scored;
}

/**
 * Owed replies: people who wrote to you AFTER you wrote them and you haven't
 * responded in 3+ days. Sorted by recency (most recent inbound first) so the
 * list reads like an inbox.
 */
export function getOwedReplies(contacts: {
  id: string; name: string; company?: string; color?: string; photo?: string;
  is_self?: boolean; is_promoted?: boolean;
  email_stats?: { emails_sent: number; emails_received: number; last_inbound_at?: string | null; last_outbound_at?: string | null } | null;
}[], minDays = 3, limit = 50) {
  const now = Date.now();
  return contacts
    .filter((c) => !c.is_self && c.is_promoted !== false)
    .map((c) => {
      const s = c.email_stats;
      if (!s || !s.last_inbound_at) return null;
      const lastIn = new Date(s.last_inbound_at).getTime();
      const lastOut = s.last_outbound_at ? new Date(s.last_outbound_at).getTime() : 0;
      if (lastIn <= lastOut) return null;                  // you've already replied since
      const daysOwed = Math.floor((now - lastIn) / 86400000);
      if (daysOwed < minDays) return null;
      if ((s.emails_received || 0) < 1) return null;
      return { ...c, daysOwed, lastInbound: new Date(lastIn), emailsReceived: s.emails_received };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.lastInbound.getTime() - a.lastInbound.getTime())   // most recent at top
    .slice(0, limit);
}

/**
 * Awaiting their reply: emails YOU sent where they haven't responded yet.
 * Covers cold outreach (no prior inbound) + silent follow-ups (used to reply,
 * now ghosted). Sorted by recency (most recent send at top, oldest cold pitch
 * at bottom).
 */
export function getAwaitingReply(contacts: {
  id: string; name: string; company?: string; color?: string; photo?: string;
  is_self?: boolean; is_promoted?: boolean;
  email_stats?: { emails_sent: number; emails_received: number; last_inbound_at?: string | null; last_outbound_at?: string | null } | null;
}[], minDays = 3, limit = 50) {
  const now = Date.now();
  return contacts
    .filter((c) => !c.is_self)   // include unpromoted: cold outreach to discovered contacts counts
    .map((c) => {
      const s = c.email_stats;
      if (!s || !s.last_outbound_at) return null;
      const lastOut = new Date(s.last_outbound_at).getTime();
      const lastIn = s.last_inbound_at ? new Date(s.last_inbound_at).getTime() : 0;
      if (lastIn >= lastOut) return null;                  // they've already replied since
      const daysWaiting = Math.floor((now - lastOut) / 86400000);
      if (daysWaiting < minDays) return null;
      const everReplied = (s.emails_received || 0) >= 1;
      return {
        ...c,
        daysWaiting,
        lastOutbound: new Date(lastOut),
        emailsSent: s.emails_sent,
        everReplied,                  // true = follow-up, false = cold (never responded)
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.lastOutbound.getTime() - a.lastOutbound.getTime())   // most recent send at top
    .slice(0, limit);
}

/**
 * Compute overall network health + AI insights.
 */
/**
 * Compute potential introductions: pairs (A, B) who don't know each other but share a mutual contact (via).
 * Returns top N intro paths ordered by mutual count.
 */
export function getIntroPaths(allContacts: {
  id: string;
  name: string;
  company?: string;
  color?: string;
  photo?: string;
  connections: string[];
  is_self?: boolean;
}[], limit = 50) {
  const contacts = allContacts.filter((c) => !c.is_self);
  const byId = new Map(contacts.map((c) => [c.id, c]));
  const introPaths: { from: typeof contacts[0]; to: typeof contacts[0]; via: typeof contacts[0][] }[] = [];
  const seenPairs = new Set<string>();

  for (const via of contacts) {
    // For each pair of via's connections, if they don't know each other, it's an intro path
    const conns = via.connections.filter((id) => byId.has(id));
    for (let i = 0; i < conns.length; i++) {
      for (let j = i + 1; j < conns.length; j++) {
        const a = byId.get(conns[i])!;
        const b = byId.get(conns[j])!;
        // Already connected? skip
        if (a.connections.includes(b.id) || b.connections.includes(a.id)) continue;
        const pairKey = [a.id, b.id].sort().join(':');
        if (seenPairs.has(pairKey)) {
          // Add another via to existing path
          const existing = introPaths.find((p) =>
            (p.from.id === a.id && p.to.id === b.id) || (p.from.id === b.id && p.to.id === a.id)
          );
          if (existing && !existing.via.find((v) => v.id === via.id)) existing.via.push(via);
        } else {
          seenPairs.add(pairKey);
          introPaths.push({ from: a, to: b, via: [via] });
        }
      }
    }
  }
  return introPaths.sort((a, b) => b.via.length - a.via.length).slice(0, limit);
}

export function getNetworkInsights(allContacts: {
  id: string;
  name: string;
  notes: string;
  last_contacted?: string;
  created_at: string;
  tasks: { completed: boolean }[];
  connections: string[];
  tags?: string[];
  is_self?: boolean;
  is_promoted?: boolean;
}[]) {
  // Insights and health metrics only count promoted contacts
  const contacts = allContacts.filter((c) => !c.is_self && c.is_promoted !== false);
  if (contacts.length === 0) return { score: 0, label: 'Empty', color: '#888', strength: 0, engagement: 0, reachability: 0, insights: [] };

  const now = new Date();
  const scores = contacts.map(c => computeHealthScore(c));
  const avgScore = Math.round(scores.reduce((s, h) => s + h.score, 0) / scores.length);

  // Strength: % of contacts that are Strong or Good
  const strongCount = scores.filter(h => h.score >= 50).length;
  const strength = Math.round((strongCount / contacts.length) * 100);

  // Engagement: % of contacts interacted with in last 30 days. Strict — no created_at fallback.
  const recentCount = contacts.filter(c => {
    if (!c.last_contacted) return false;
    return differenceInDays(now, new Date(c.last_contacted)) <= 30;
  }).length;
  const engagement = Math.round((recentCount / contacts.length) * 100);

  // Reachability: % of contacts with email, phone, or substantial notes
  const reachable = contacts.filter(c =>
    (c as any).email || (c as any).phone || c.notes.length > 50
  ).length;
  const reachability = Math.round((reachable / contacts.length) * 100);

  // Label
  let label: string;
  let color: string;
  if (avgScore >= 75) { label = 'Excellent'; color = '#06b6d4'; }
  else if (avgScore >= 50) { label = 'Good'; color = '#22d3ee'; }
  else if (avgScore >= 25) { label = 'Needs Work'; color = '#f5c542'; }
  else { label = 'Critical'; color = '#ef4444'; }

  // AI Insights
  const insights: { icon: string; text: string; color: string }[] = [];

  // Weak connections needing attention
  const weakCount = scores.filter(h => h.score < 25).length;
  if (weakCount > 0) insights.push({ icon: 'alert', text: `${weakCount} weak connections need attention`, color: '#f5c542' });

  // Stale contacts (14+ days since LAST CONTACT — not since import).
  const staleCount = contacts.filter(c => {
    if (!c.last_contacted) return false; // never-contacted ≠ going quiet; it's a separate problem
    return differenceInDays(now, new Date(c.last_contacted)) >= 14;
  }).length;
  if (staleCount > 0) insights.push({ icon: 'clock', text: `${staleCount} contacts going quiet`, color: '#ef4444' });

  // Potential introductions (contacts with mutual connections)
  const connectionSets = new Map(contacts.map(c => [c.id, new Set(c.connections)]));
  let introCount = 0;
  const checked = new Set<string>();
  for (const c of contacts) {
    for (const connId of c.connections) {
      const key = [c.id, connId].sort().join(':');
      if (checked.has(key)) continue;
      checked.add(key);
      const connConns = connectionSets.get(connId);
      if (!connConns) continue;
      // If c and connId share mutual connections, there are intro opportunities
      for (const mutualId of c.connections) {
        if (mutualId !== connId && connConns.has(mutualId)) { introCount++; break; }
      }
    }
  }
  if (introCount > 0) insights.push({ icon: 'users', text: `${introCount} potential introductions`, color: '#06b6d4' });

  // Pending tasks
  const totalPending = contacts.reduce((s, c) => s + c.tasks.filter(t => !t.completed).length, 0);
  if (totalPending > 0) insights.push({ icon: 'tasks', text: `${totalPending} pending tasks across network`, color: '#6366f1' });

  // Growing network
  const recentlyAdded = contacts.filter(c => differenceInDays(now, new Date(c.created_at)) <= 7).length;
  if (recentlyAdded > 0) insights.push({ icon: 'trending', text: `${recentlyAdded} new connections this week`, color: '#10b981' });

  return { score: avgScore, label, color, strength, engagement, reachability, insights };
}

/**
 * Recurring contacts — people you meet on a cadence. Cadence = ≥3 calendar
 * events together in the last 90 days. Higher event count ranks higher.
 *
 * Used as a calendar-native replacement for email-driven tiles when the user
 * doesn't have email sync (Google-only signup, etc.). The signal is honest:
 * you actually keep blocking time with this person.
 */
export function getRecurringContacts(
  contacts: { id: string; name: string; company?: string; color?: string; photo?: string; is_self?: boolean; is_promoted?: boolean }[],
  events: { contact_id?: string; date: string }[],
  limit = 50,
) {
  const now = new Date();
  const ninetyDaysAgo = new Date(now);
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  // Count events per contact within the 90-day window.
  const countByContact = new Map<string, number>();
  for (const e of events) {
    if (!e.contact_id || !e.date) continue;
    const d = new Date(e.date);
    if (isNaN(d.getTime())) continue;
    if (d < ninetyDaysAgo || d > now) continue;
    countByContact.set(e.contact_id, (countByContact.get(e.contact_id) || 0) + 1);
  }

  return contacts
    .filter((c) => !c.is_self && c.is_promoted !== false)
    .map((c) => ({ ...c, meetingCount: countByContact.get(c.id) || 0 }))
    .filter((c) => c.meetingCount >= 3)
    .sort((a, b) => b.meetingCount - a.meetingCount)
    .slice(0, limit);
}

/**
 * New this month — contacts whose FIRST meeting with you was within the past
 * 30 days. Uses earliest linked calendar event as the relationship start
 * proxy. Falls back to first_seen_at from email_stats if no events.
 *
 * Sorted by most-recently-met first (the freshest faces at the top).
 */
export function getNewThisMonth(
  contacts: {
    id: string; name: string; company?: string; color?: string; photo?: string;
    is_self?: boolean; is_promoted?: boolean;
    email_stats?: { first_seen_at?: string | null } | null;
  }[],
  events: { contact_id?: string; date: string }[],
  limit = 50,
) {
  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  // Map contact_id → earliest event date.
  const earliest = new Map<string, Date>();
  for (const e of events) {
    if (!e.contact_id || !e.date) continue;
    const d = new Date(e.date);
    if (isNaN(d.getTime())) continue;
    const cur = earliest.get(e.contact_id);
    if (!cur || d < cur) earliest.set(e.contact_id, d);
  }

  return contacts
    .filter((c) => !c.is_self && c.is_promoted !== false)
    .map((c) => {
      const firstEvent = earliest.get(c.id);
      const firstEmail = c.email_stats?.first_seen_at ? new Date(c.email_stats.first_seen_at) : null;
      const validEmail = firstEmail && !isNaN(firstEmail.getTime()) ? firstEmail : null;
      // Pick whichever is older — email first-seen often precedes the first meeting.
      const firstSeen = firstEvent && validEmail ? (firstEvent < validEmail ? firstEvent : validEmail)
        : firstEvent || validEmail;
      return { ...c, firstSeen };
    })
    .filter((c): c is typeof c & { firstSeen: Date } => !!c.firstSeen && c.firstSeen >= thirtyDaysAgo && c.firstSeen <= now)
    .sort((a, b) => b.firstSeen.getTime() - a.firstSeen.getTime())
    .slice(0, limit);
}
