// Rule-first, LLM-tiebreaker contact classifier.
//
// Walks each contact through 6 ordered steps. ~90% of contacts get a clean
// rule-based verdict (cheap, fast, predictable). Only the residual goes to
// Gemini Flash-Lite as a tiebreaker.
//
// Steps:
//   1. Newsletter/mass-send detector  -> drop
//   2. Role inbox (support@, info@, deals@, etc) -> drop
//   3. Direct evidence (you replied OR you co-attended a meeting) -> keep
//   4. Personal name pattern (firstname.lastname, multi-word name field) -> keep
//   5. Warm-intro (cc-edge with someone who has direct evidence) -> keep
//   6. LLM tiebreaker for everyone left

import { geminiAsk } from './gemini';

export interface TierInput {
  id: string;
  name: string | null;
  email: string | null;
  // Behavioral signals — optional because contacts from sync-graph (Outlook
  // contacts list) don't have these yet at import time. Default to 0 so the
  // rule pipeline can still run, with the LLM handling the residual.
  emails_sent?: number;
  emails_received?: number;
  co_attended_count?: number;
  cc_edges_count?: number;
}

export interface TierResult {
  id: string;
  tier: 'keep' | 'drop';
  step: string;
  reason: string;
}

// Mass-email platform domains — anything from these is automated by definition
const NEWSLETTER_DOMAINS = new Set([
  'substack.com', 'mailchimp.com', 'sendgrid.net', 'sendgrid.com',
  'mailerlite.com', 'klaviyo.com', 'ccsend.com', 'emailrelay.com',
  'hubspotemail.net', 'mailpoet.com', 'mailgun.org', 'awstrack.me',
  'mandrillapp.com', 'sendinblue.com', 'sendpulse.com', 'omnisend.com',
  'apileadgen.com', 'aptleasing.info', 'messages.wayup.com', 'fillout.com',
  'campaign-archive.com', 'list-manage.com', 'createsend.com',
  'bounce.email', 'em.mlsend.com', 'cmail19.com', 'cmail20.com',
  'rsgsv.net', 'app.salesloft.com',
]);

// Pure-role localparts — if email is `info@x.com`, `support@y.com`, etc., it's
// never an individual. Match exactly (lowercased localpart).
const ROLE_LOCALPARTS = new Set([
  'info', 'hello', 'hi', 'contact', 'contacts', 'support', 'sales', 'admin',
  'hr', 'recruiting', 'recruit', 'deals', 'dealflow', 'growth',
  'talent', 'legal', 'team', 'ops', 'operations', 'portfolio',
  'fund', 'crew', 'customer', 'customerservice', 'service', 'services',
  'tickets', 'ticket', 'booking', 'register', 'registration', 'manager',
  'scouting', 'scout', 'frontdesk', 'reception', 'research',
  'ceo.admin', 'founders', 'founder', 'notifications', 'alerts',
  'newsletter', 'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'submission', 'submissions', 'feedback', 'updates', 'help',
  'press', 'media', 'marketing', 'billing', 'invoices', 'accounts',
  'partners', 'investors', 'jobs', 'careers', 'engineering', 'design',
  'volunteerservices', 'graduate.studies', 'apply', 'beta', 'alpha',
  'downtown', 'centralregioniccs', 'centralregionnics', 'office',
  'frontoffice', 'mailroom', 'auth', 'verify', 'verification', 'orders',
  'order', 'shipping', 'shipments', 'returns', 'refund', 'refunds',
  'community', 'connect', 'social', 'events', 'event', 'webinars',
  'webinar', 'training', 'academy', 'learn', 'education', 'students',
]);

function localpart(email: string): string { return email.toLowerCase().split('@')[0]; }
function domain(email: string): string { return email.toLowerCase().split('@')[1] || ''; }

/** Cheap STRICT personal-name check. Only fires for the obvious cases —
 * firstname.lastname email patterns where confidence is very high.
 *
 * Previously also matched single 6+ char alphabetic locals ("ubereats",
 * "godaddy", "starbucks") and any 2-word name without a "Team/LLC/Inc"
 * suffix. That short-circuited brand contacts like "Uber Eats" /
 * "ubereats@uber.com" past the LLM — Step 4 would return KEEP because
 * "ubereats" matched the single-word regex and "Uber Eats" had 2 words
 * with no business indicator.
 *
 * Now: only the structural email patterns. The looser name-field heuristic
 * is delegated to the LLM, which actually knows what "Uber Eats" is. */
function hasPersonalNamePattern(name: string | null, email: string | null): boolean {
  if (!email) return false;
  const lp = localpart(email);
  // firstname.lastname (optional digits) — very strong signal
  if (/^[a-z]{2,}\.[a-z]{2,}\d{0,3}$/.test(lp)) return true;
  // firstname_lastname / firstname-lastname
  if (/^[a-z]{2,}[_-][a-z]{2,}$/.test(lp)) return true;
  // Don't trust single-word locals or name-field heuristics. Those let
  // brand names through. Let the LLM judge.
  return false;
}

function isNewsletterDomain(email: string | null): boolean {
  if (!email) return false;
  return NEWSLETTER_DOMAINS.has(domain(email));
}

function isRoleInbox(email: string | null): boolean {
  if (!email) return false;
  return ROLE_LOCALPARTS.has(localpart(email));
}

/** Single-contact rule check. Returns null if no rule fires (caller sends to LLM).
 *  Rule order matters: hard drops first (newsletter domain, role inbox), then
 *  permissive keeps (direct evidence, name pattern, warm intro), then the soft
 *  mass-inbound drop fallback for stuff that nothing else caught. */
export function tierByRules(contact: TierInput, hasWarmCcPartner: boolean): TierResult | null {
  // 1. Newsletter platform domains (substack, mailchimp, etc) - hard drop
  if (isNewsletterDomain(contact.email)) {
    return { id: contact.id, tier: 'drop', step: 'step-1-newsletter-domain', reason: `domain "${domain(contact.email!)}" is a known sender platform` };
  }

  // 2. Role inbox - hard drop
  if (isRoleInbox(contact.email)) {
    return { id: contact.id, tier: 'drop', step: 'step-2-role-inbox', reason: `"${localpart(contact.email!)}" is a role keyword` };
  }

  // 3. Direct evidence - keep (most authoritative signal)
  if ((contact.emails_sent ?? 0) >= 1) {
    return { id: contact.id, tier: 'keep', step: 'step-3-replied', reason: `emails_sent=${contact.emails_sent}` };
  }
  if ((contact.co_attended_count ?? 0) >= 1) {
    return { id: contact.id, tier: 'keep', step: 'step-3-co-attended', reason: `co_attended=${contact.co_attended_count}` };
  }

  // 4. Personal name pattern - keep (clear first/last name signal)
  if (hasPersonalNamePattern(contact.name, contact.email)) {
    return { id: contact.id, tier: 'keep', step: 'step-4-name-pattern', reason: 'name/email matches person pattern' };
  }

  // 5. Warm intro - keep (cc-edge with someone who has direct evidence)
  if (hasWarmCcPartner) {
    return { id: contact.id, tier: 'keep', step: 'step-5-warm-intro', reason: 'cc-edge with a contact who has direct evidence' };
  }

  // 6. Soft mass-inbound drop - only fires for contacts that survived all
  // KEEP rules. A REAL person with a personal-name pattern would have been
  // saved by step 4; only no-name-pattern repeat senders fall here.
  if ((contact.emails_received ?? 0) >= 5 && (contact.emails_sent ?? 0) === 0 && (contact.cc_edges_count ?? 0) === 0) {
    return { id: contact.id, tier: 'drop', step: 'step-6a-mass-inbound', reason: `${contact.emails_received} received, 0 sent, no cc-edges and no name pattern` };
  }

  // Falls through to LLM tiebreaker
  return null;
}

/** LLM tiebreaker for contacts where no rule decided. */
export async function classifyResidualWithLLM(contacts: TierInput[]): Promise<Map<string, TierResult>> {
  const results = new Map<string, TierResult>();
  if (contacts.length === 0) return results;
  const BATCH = 80;
  for (let i = 0; i < contacts.length; i += BATCH) {
    if (i > 0) await new Promise(r => setTimeout(r, 1200));
    const batch = contacts.slice(i, i + BATCH);
    const indexLines = batch.map((c, idx) => `[${idx}] name="${c.name || '?'}" email="${c.email || '?'}"`).join('\n');
    const prompt = `Is each contact a real, named human individual the user would want in their personal CRM?

You have broad general knowledge of brands, companies, apps, services, newsletters,
and software products. Use it. If a name is recognizable as a brand or service,
classify NOT a person — even if the email looks personal.

YES (person) — real, named human:
  - "Adam Dale" / adam.dale@ndm.ox.ac.uk
  - "Class Peter" / classpeter27@gmail.com  (real name even with digits suffix)
  - "Kanaya, Alka" / alka.kanaya@ucsf.edu
  - "ELLIE.SAPERSTEIN@GMAIL.COM" / ellie.saperstein@gmail.com  (caps + first.last is still a person)
  - "jordan.deane@chase.com" — a real employee at Chase

NO (not a person) — anything you recognize as a brand, product, service, company,
newsletter, app, institution, or department:
  - "Uber Eats" / "Uber One" / "Starbucks Rewards" — consumer brand products
  - "App Store Connect" / "Apple Developer" / "Apple Support" — Apple services
  - "Microsoft Store" / "Adobe Lightroom" / "GoDaddy Renewals" — software product brands
  - "Spotify" / "Netflix" / "Hulu" / "Disney+" — streaming brands
  - "LibertyMutualTeam" / "Chase Customer Satisfaction" / "Geico" — financial/insurance brands
  - "TLDR Newsletter" / "Morning Brew" / "Substack Reads" — newsletters
  - "Conference Services" / "NDM DPhil Clinical Medicine" / "Office Hub" — institutional roles
  - "Bloomberg Politics" / "NYT Cooking" / "Stratechery" — publications / writers' aliases

Rules of thumb when uncertain:
  - If the NAME field contains a recognizable brand/product word (Eats, Rewards,
    Connect, Plus, Pro, One, Direct, Premium, Store, Card, Wallet, Cloud, etc.)
    → almost always a brand
  - If the name reads like a department / institution / publication → not a person
  - If the email is from a known no-reply or relay domain (privaterelay.appleid.com,
    bounce.email, list-manage.com) → not a person
  - When you genuinely cannot tell → default to NOT a person. Personal CRMs are
    better off slightly aggressive than letting brands clutter the network.

Contacts:
${indexLines}`;
    try {
      const raw = await geminiAsk(prompt, {
        model: 'flash-lite',
        temperature: 0,
        thinkingBudget: 0,
        responseSchema: {
          type: 'object',
          properties: {
            verdicts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  index: { type: 'integer' },
                  is_person: { type: 'boolean' },
                  reason: { type: 'string' },
                },
                required: ['index', 'is_person', 'reason'],
              },
            },
          },
          required: ['verdicts'],
        },
      });
      const parsed = JSON.parse(raw || '{"verdicts":[]}');
      for (const v of parsed.verdicts as any[]) {
        if (typeof v.index !== 'number' || !batch[v.index]) continue;
        const c = batch[v.index];
        results.set(c.id, {
          id: c.id,
          tier: v.is_person ? 'keep' : 'drop',
          step: 'step-6-llm-' + (v.is_person ? 'person' : 'not-person'),
          reason: String(v.reason || '').slice(0, 200),
        });
      }
      // Fill any verdicts the LLM dropped from the response
      for (const c of batch) {
        if (!results.has(c.id)) {
          results.set(c.id, { id: c.id, tier: 'keep', step: 'step-6-llm-no-verdict', reason: 'LLM did not return a verdict; defaulting to keep' });
        }
      }
    } catch (e: any) {
      console.error('[tierContacts] LLM batch failed (defaulting to keep):', e?.message);
      for (const c of batch) {
        results.set(c.id, { id: c.id, tier: 'keep', step: 'step-6-llm-failed', reason: 'LLM batch error - kept by default' });
      }
    }
  }
  return results;
}

/**
 * Tier a batch of contacts using rules first, LLM only for the residual.
 *
 * @param contacts                 List to classify
 * @param contactsWithEvidence     Set of contact IDs that passed Step 3 (replied or co-attended)
 *                                 — needed to detect "warm-intro" partners in Step 5.
 *                                 Computed externally so caller can pass in their full network state.
 * @param ccPartnersByContact      Map: contact id -> array of contact ids it shares cc_edges with.
 *                                 If any of those partners is in contactsWithEvidence, the contact
 *                                 passes Step 5.
 */
export async function tierContacts(
  contacts: TierInput[],
  contactsWithEvidence: Set<string>,
  ccPartnersByContact: Map<string, string[]>,
): Promise<Map<string, TierResult>> {
  const results = new Map<string, TierResult>();
  const residual: TierInput[] = [];

  for (const c of contacts) {
    const partners = ccPartnersByContact.get(c.id) || [];
    const hasWarmCcPartner = partners.some((p) => contactsWithEvidence.has(p));
    const ruled = tierByRules(c, hasWarmCcPartner);
    if (ruled) results.set(c.id, ruled);
    else residual.push(c);
  }

  if (residual.length > 0) {
    const llmResults = await classifyResidualWithLLM(residual);
    for (const [k, v] of llmResults) results.set(k, v);
  }

  return results;
}
