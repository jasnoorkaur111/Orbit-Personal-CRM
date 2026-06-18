/**
 * Rules for filtering out non-personal email addresses before we import them as
 * contacts. Three independent checks, composed by `isNoiseEmail`:
 *
 *   isRolePrefixEmail(email)            — role/shared inbox (hello@, info@, support@…)
 *   isPurelyTransactionalDomain(email)  — domain that only sends system mail (substack, sendgrid…)
 *   isMixedUseSenderDomain(email)       — domain with both system AND personal mail (stripe, github…)
 *
 * Final composition:
 *   - role prefix anywhere                              → noise
 *   - purely-transactional domain (any local part)      → noise
 *   - mixed-use domain BUT local part is role-prefix    → noise
 *   - mixed-use domain with personal-looking local part → NOT noise (real employee)
 */

const ROLE_PREFIXES = new Set([
  // Generic shared inboxes
  'hello', 'hi', 'hey', 'info', 'contact', 'inquiries', 'inquiry',
  'team', 'office', 'admin', 'staff', 'people',
  'support', 'help', 'helpdesk', 'service', 'customerservice',
  'sales', 'marketing', 'press', 'media', 'pr',
  // Transactional / no-reply
  'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'reply', 'replies',
  'notifications', 'notification', 'notify', 'notice', 'notices',
  'alerts', 'alert', 'updates', 'update', 'news', 'newsletter', 'digest',
  'mailer', 'mailer-daemon', 'postmaster', 'system', 'robot', 'bot', 'daemon',
  'automated', 'automation', 'auto',
  // Commerce / billing
  'billing', 'payments', 'payment', 'receipt', 'receipts', 'orders', 'order',
  'invoice', 'invoices', 'accounts', 'account',
  // Auth / security
  'security', 'verify', 'verification', 'confirm', 'confirmation',
  'login', 'auth', 'onboarding', 'welcome', 'invites', 'invite', 'invitations', 'invitation',
  // Community / events / education admin
  'community', 'members', 'member', 'event', 'events',
  'admissions', 'gradapply', 'enrollment', 'registrar',
  // Studio booking / reservations
  'booking', 'reservation', 'reservations', 'nomad', 'solidcore',
]);

// Local-part SUBSTRING patterns — catch compound noise like
// "messaging-digest-noreply@linkedin.com" that exact-match misses.
const ROLE_SUBSTRING_PATTERNS: RegExp[] = [
  /noreply/, /no[._-]?reply/, /donotreply/, /do[._-]?not[._-]?reply/,
  /mailer[-_]daemon/, /\bmailer\b/, /automated/,
  /\bnotif(?:y|ication)\b/, /\balerts?\b/, /\breminders?\b/,
  /\bdigest\b/, /\bnewsletters?\b/, /broadcast/, /marketing/, /promo/,
  /invitations?/, /\binvoice\b/, /\bstatement\b/, /\breceipt\b/, /verification/,
  /hit-reply/, /reply\+/, /reply-/,
  /^business\d+/,                  // mindbodyonline.com studio reservations
  /^ugc[a-z]*$/, /[a-z]+ugc[a-z]*$/, // UGC creator cold outreach
];

/**
 * Domains where 100% of outgoing mail is transactional/bulk — no real human
 * has a personal mailbox here. Always noise regardless of local part.
 */
const PURELY_TRANSACTIONAL_DOMAINS = new Set([
  // Newsletter platforms (the platform sends on behalf of authors)
  'substack.com', 'beehiiv.com', 'convertkit.com', 'mailchimp.com',
  'mailerlite.com', 'aweber.com',
  // ESPs
  'sendgrid.net', 'sendgrid.com', 'sparkpost.com', 'mailgun.com',
  'amazonses.com', 'ses.amazonaws.com', 'braze.com', 'customer.io',
  'emarsys.net', 'cmail19.com', 'cmail20.com',
  // Newsletter publications
  'tldr.tech', 'tldrnewsletter.com', 'hacker.news', 'healthtechpigeon.com',
  // Event-platform infra (lu.ma's organizer + per-user calendar bots — never humans)
  'luma-mail.com',
  // Fax-to-email gateways
  'fax.plus', 'efax.com', 'srfax.com', 'metrofax.com',
  // Studio booking SaaS — every email is a class reminder / receipt
  'mindbodyonline.com', 'mariana-tek.com', 'punchpass.com',
  'wellnessliving.com', 'acuityscheduling.com', 'setmore.com',
  'squarespacescheduling.com', 'booksy.com', 'fresha.com', 'vagaro.com',
  'gymmaster.com', 'glofox.com', 'solidcore.co',
  // Security infra
  'cloud-protect.net',
]);

/**
 * Domains with BOTH system senders AND real human employees. Only noise when
 * the local part is also a role prefix (notifications@stripe.com is noise;
 * neelmajumdar@stripe.com is a real person).
 */
const MIXED_USE_SENDER_DOMAINS = new Set([
  // SaaS notification senders
  'stripe.com', 'framer.com', 'figma.com', 'loom.com', 'notion.com',
  'notion.so', 'posthog.com', 'github.com', 'gitlab.com', 'linear.app',
  'asana.com', 'atlassian.com', 'slack.com', 'airtable.com',
  // Calendar / event platforms
  'calendly.com', 'cal.com', 'lu.ma', 'eventbrite.com', 'partiful.com',
  'meetup.com', 'hopin.com', 'airmeet.com', 'whova.com',
  // Conferencing
  'zoom.us',
  // Big platforms where employees use firstname.lastname@ — they have real
  // employees but most contact-creating mail from these domains is system
  // notifications. The display-name + local-part real-person override
  // (handled in isNoiseEmail below) rescues actual employees.
  'linkedin.com', 'google.com', 'microsoft.com', 'paypal.com',
  'apple.com', 'amazon.com', 'coinbase.com', 'chase.com',
  'salesforce.com', 'hubspot.com',
]);

// Display-name patterns: an email whose contact-card NAME matches one of
// these is almost certainly a notification / cold-outreach / institution,
// regardless of email shape. INTENTIONALLY MINIMAL — only structural patterns
// (bracketed names, "via X", clear suffix words like LLC/Inc/Newsletter).
// Brand-name detection is delegated to the LLM tier-classifier in
// src/lib/tierContacts.ts, which uses its general knowledge instead of a
// hand-maintained list we'd have to update every time a new brand appears.
const NOISE_NAME_PATTERNS: RegExp[] = [
  /^\s*\[/,                                   // "[solidcore]" / "[brand] City"
  /\sfrom\s[A-Z0-9][A-Za-z0-9]+\s*$/,         // "Alex from F6S", "Emma from Lemlist"
  /via (LinkedIn|Google( [A-Z][a-z]+)?|Outlook|Calendly|Cal\.com|Microsoft|Zoom|Eventbrite|Lu\.ma)\b/i,
  // Structural company-suffix / role-noun words. NOT a brand name list — these
  // are generic indicators ("Acme LLC", "Customer Services", "Daily Digest")
  // that don't depend on us knowing specific brands.
  /\b(LLC|Inc\.?|Ltd|Co\.?|Corp|Foundation|Fund|Capital|Ventures|Partners|Combinator|Team|Newsletter|Customer Services?|Office|Admissions|Fellowship|Daily|Weekly|Digest|News|Alerts?|Notifications?|Reminders?|Updates?|Briefings?|Reports?|Vetting Services?|Partner Center|Bank|Bureau|Department|Ministry|Agency|Verification|Residency|University|College|School|Schools|Academy|Institute|Graduate Studies?|Undergraduate|Studio|Studios|Gym|Fitness|Wellness|Spa|Salon|Cafe|Restaurant|Hotel)\b/i,
];

export function isRolePrefixEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const local = email.toLowerCase().split('@')[0];
  if (!local) return false;
  // Strip +tag suffix
  const bare = local.split('+')[0];
  if (ROLE_PREFIXES.has(bare)) return true;
  // Substring patterns — catch "messaging-digest-noreply", "no.reply.alerts" etc
  for (const re of ROLE_SUBSTRING_PATTERNS) {
    if (re.test(bare)) return true;
  }
  return false;
}

/** Display-name pattern check — for "[brackets]", "via LinkedIn", "Studios" etc. */
export function isNoiseDisplayName(name: string | null | undefined): boolean {
  if (!name) return false;
  for (const re of NOISE_NAME_PATTERNS) {
    if (re.test(name)) return true;
  }
  return false;
}

/** Real-person override: if the contact's first or last name (>=4 chars)
 * appears in the email local part, they're a real human regardless of
 * what platform domain they work at. Catches jordan.deane@chase.com etc. */
function localContainsName(email: string, name: string | null | undefined): boolean {
  if (!name) return false;
  const local = email.toLowerCase().split('@')[0];
  if (!local) return false;
  const parts = name.trim().toLowerCase().split(/\s+/);
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (first && first.length >= 4 && local.includes(first)) return true;
  if (last && last !== first && last.length >= 4 && local.includes(last)) return true;
  return false;
}

function getDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const parts = email.toLowerCase().split('@');
  return parts.length === 2 ? parts[1] : null;
}

function domainMatchesSet(domain: string, set: Set<string>): boolean {
  if (set.has(domain)) return true;
  for (const d of set) {
    if (domain.endsWith('.' + d)) return true;
  }
  return false;
}

export function isPurelyTransactionalDomain(email: string | null | undefined): boolean {
  const domain = getDomain(email);
  return !!domain && domainMatchesSet(domain, PURELY_TRANSACTIONAL_DOMAINS);
}

export function isMixedUseSenderDomain(email: string | null | undefined): boolean {
  const domain = getDomain(email);
  return !!domain && domainMatchesSet(domain, MIXED_USE_SENDER_DOMAINS);
}

/**
 * Final yes/no: is this email noise that should never become a personal contact?
 *
 * Ordering matters:
 *   1. Real-person local-part override   → NOT noise (jordan.deane@chase.com)
 *   2. Display name is a noise pattern   → noise ([solidcore], "via LinkedIn")
 *   3. Role-prefix or role-substring     → noise
 *   4. Purely-transactional domain       → noise (mindbodyonline, sendgrid)
 *   5. Mixed-use domain w/o name in local → noise (notifications@stripe.com)
 *   6. Otherwise                         → NOT noise
 */
export function isNoiseEmail(email: string | null | undefined, name?: string | null): boolean {
  if (!email) return false;
  const haveName = !!(name && name.trim());
  // (1) Real-person override beats everything. The brand-vs-person judgment
  //     for ambiguous names (e.g. "App Store Connect") is delegated to the
  //     LLM tier classifier downstream — this function only handles the
  //     CHEAP deterministic cases.
  if (haveName && localContainsName(email, name)) return false;
  // (2) Display-name structural patterns ([brackets], "via X", LLC/Newsletter…)
  if (haveName && isNoiseDisplayName(name)) return true;
  // (3) Role-prefix / role-substring in local part (noreply@, support@…)
  if (isRolePrefixEmail(email)) return true;
  // (4) Pure transactional domain (substack.com, sendgrid.com…)
  if (isPurelyTransactionalDomain(email)) return true;
  // (5) Mixed-use domain (stripe.com, github.com…): noise only when name was
  //     provided AND step (1) didn't rescue them.
  if (haveName && isMixedUseSenderDomain(email)) return true;
  // (6) Apple "Hide My Email" relay — only used by apps/brands sending to a
  //     user. Real people never send personal mail FROM these.
  const domain = email.toLowerCase().split('@')[1];
  if (domain === 'privaterelay.appleid.com') return true;
  return false;
}
