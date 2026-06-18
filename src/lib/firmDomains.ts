// Investor / accelerator firm domain → metadata mapping.
//
// Used by sync-graph to auto-tag contacts when their email domain matches
// a known VC/PE/accelerator. This gives Ask-network a real "is this person
// an investor?" signal without having to web-research every contact.
//
// Match policy: exact domain only. Subdomains (e.g. `careers.a16z.com`)
// are not matched — those usually go to recruiters, not partners.
//
// Coverage is biased to active US VCs, top global firms, and the bigger
// accelerators. Long tail can be added as users surface gaps.

export type FirmType = 'investor' | 'accelerator' | 'angel-platform';

export interface FirmInfo {
  name: string;     // canonical firm name (used for contact.company)
  type: FirmType;
  tags: string[];   // auto-applied to contact.tags
}

const FIRM_DOMAINS: Record<string, FirmInfo> = {
  // ── Tier-1 VCs (US) ────────────────────────────────────────────────
  'a16z.com':                { name: 'Andreessen Horowitz',  type: 'investor', tags: ['investor', 'vc'] },
  'andreessenhorowitz.com':  { name: 'Andreessen Horowitz',  type: 'investor', tags: ['investor', 'vc'] },
  'sequoiacap.com':          { name: 'Sequoia Capital',      type: 'investor', tags: ['investor', 'vc'] },
  'kpcb.com':                { name: 'Kleiner Perkins',      type: 'investor', tags: ['investor', 'vc'] },
  'kleinerperkins.com':      { name: 'Kleiner Perkins',      type: 'investor', tags: ['investor', 'vc'] },
  'accel.com':               { name: 'Accel',                type: 'investor', tags: ['investor', 'vc'] },
  'greylock.com':            { name: 'Greylock',             type: 'investor', tags: ['investor', 'vc'] },
  'benchmark.com':           { name: 'Benchmark',            type: 'investor', tags: ['investor', 'vc'] },
  'firstround.com':          { name: 'First Round Capital',  type: 'investor', tags: ['investor', 'vc'] },
  'foundersfund.com':        { name: 'Founders Fund',        type: 'investor', tags: ['investor', 'vc'] },
  'generalcatalyst.com':     { name: 'General Catalyst',     type: 'investor', tags: ['investor', 'vc'] },
  'bvp.com':                 { name: 'Bessemer Venture Partners', type: 'investor', tags: ['investor', 'vc'] },
  'bessemer.com':            { name: 'Bessemer Venture Partners', type: 'investor', tags: ['investor', 'vc'] },
  'lsvp.com':                { name: 'Lightspeed Venture Partners', type: 'investor', tags: ['investor', 'vc'] },
  'lightspeed.com':          { name: 'Lightspeed Venture Partners', type: 'investor', tags: ['investor', 'vc'] },
  'indexventures.com':       { name: 'Index Ventures',       type: 'investor', tags: ['investor', 'vc'] },
  'nea.com':                 { name: 'NEA',                  type: 'investor', tags: ['investor', 'vc'] },
  'khoslaventures.com':      { name: 'Khosla Ventures',      type: 'investor', tags: ['investor', 'vc'] },
  'usv.com':                 { name: 'Union Square Ventures', type: 'investor', tags: ['investor', 'vc'] },
  'ivp.com':                 { name: 'IVP',                  type: 'investor', tags: ['investor', 'vc'] },
  'sparkcapital.com':        { name: 'Spark Capital',        type: 'investor', tags: ['investor', 'vc'] },
  'trueventures.com':        { name: 'True Ventures',        type: 'investor', tags: ['investor', 'vc'] },
  'foundationcap.com':       { name: 'Foundation Capital',   type: 'investor', tags: ['investor', 'vc'] },
  'foundationcapital.com':   { name: 'Foundation Capital',   type: 'investor', tags: ['investor', 'vc'] },
  'battery.com':             { name: 'Battery Ventures',     type: 'investor', tags: ['investor', 'vc'] },
  'redpoint.com':            { name: 'Redpoint Ventures',    type: 'investor', tags: ['investor', 'vc'] },
  'menlovc.com':             { name: 'Menlo Ventures',       type: 'investor', tags: ['investor', 'vc'] },
  'craftventures.com':       { name: 'Craft Ventures',       type: 'investor', tags: ['investor', 'vc'] },
  'thrivecapital.com':       { name: 'Thrive Capital',       type: 'investor', tags: ['investor', 'vc'] },
  'gv.com':                  { name: 'GV (Google Ventures)', type: 'investor', tags: ['investor', 'vc'] },
  'm12.vc':                  { name: 'M12 (Microsoft Ventures)', type: 'investor', tags: ['investor', 'vc'] },
  'salesforceventures.com':  { name: 'Salesforce Ventures',  type: 'investor', tags: ['investor', 'vc'] },
  'inovia.vc':               { name: 'Inovia Capital',       type: 'investor', tags: ['investor', 'vc'] },
  'inreach.vc':              { name: 'InReach Ventures',     type: 'investor', tags: ['investor', 'vc'] },

  // ── Growth / late-stage ────────────────────────────────────────────
  'insightpartners.com':     { name: 'Insight Partners',     type: 'investor', tags: ['investor', 'growth'] },
  'tcv.com':                 { name: 'TCV',                  type: 'investor', tags: ['investor', 'growth'] },
  'tigerglobal.com':         { name: 'Tiger Global',         type: 'investor', tags: ['investor', 'growth'] },
  'coatue.com':              { name: 'Coatue',               type: 'investor', tags: ['investor', 'growth'] },
  'durable.com':             { name: 'Durable Capital',      type: 'investor', tags: ['investor', 'growth'] },
  'd1capital.com':           { name: 'D1 Capital',           type: 'investor', tags: ['investor', 'growth'] },
  'silverlake.com':          { name: 'Silver Lake',          type: 'investor', tags: ['investor', 'growth', 'pe'] },
  'altimeter.com':           { name: 'Altimeter Capital',    type: 'investor', tags: ['investor', 'growth'] },

  // ── Seed-focused funds ─────────────────────────────────────────────
  'initialized.com':         { name: 'Initialized Capital',  type: 'investor', tags: ['investor', 'seed'] },
  '1517fund.com':            { name: '1517 Fund',            type: 'investor', tags: ['investor', 'seed'] },
  'floodgate.com':           { name: 'Floodgate',            type: 'investor', tags: ['investor', 'seed'] },
  'upfront.com':             { name: 'Upfront Ventures',     type: 'investor', tags: ['investor', 'seed'] },
  'cowboy.vc':               { name: 'Cowboy Ventures',      type: 'investor', tags: ['investor', 'seed'] },
  'cowboyventures.com':      { name: 'Cowboy Ventures',      type: 'investor', tags: ['investor', 'seed'] },
  'wing.vc':                 { name: 'Wing Venture Capital', type: 'investor', tags: ['investor', 'seed'] },
  'pear.vc':                 { name: 'Pear VC',              type: 'investor', tags: ['investor', 'seed'] },
  'hustlefund.vc':           { name: 'Hustle Fund',          type: 'investor', tags: ['investor', 'seed'] },
  'somacapital.com':         { name: 'Soma Capital',         type: 'investor', tags: ['investor', 'seed'] },
  'longjourney.vc':          { name: 'Long Journey Ventures', type: 'investor', tags: ['investor', 'seed'] },
  'susaventures.com':        { name: 'Susa Ventures',        type: 'investor', tags: ['investor', 'seed'] },
  'slow.co':                 { name: 'Slow Ventures',        type: 'investor', tags: ['investor', 'seed'] },
  'pacecapital.com':         { name: 'Pace Capital',         type: 'investor', tags: ['investor', 'seed'] },
  'reachcapital.com':        { name: 'Reach Capital',        type: 'investor', tags: ['investor', 'seed'] },
  'precursorvc.com':         { name: 'Precursor Ventures',   type: 'investor', tags: ['investor', 'seed'] },
  'precursor.vc':            { name: 'Precursor Ventures',   type: 'investor', tags: ['investor', 'seed'] },
  'southparkcommons.com':    { name: 'South Park Commons',   type: 'investor', tags: ['investor', 'seed'] },
  'craftorbital.com':        { name: 'Orbital VC',           type: 'investor', tags: ['investor', 'seed'] },
  'collabfund.com':          { name: 'Collaborative Fund',   type: 'investor', tags: ['investor', 'seed'] },
  'forerunnerventures.com':  { name: 'Forerunner Ventures',  type: 'investor', tags: ['investor', 'seed'] },
  'lererhippeau.com':        { name: 'Lerer Hippeau',        type: 'investor', tags: ['investor', 'seed'] },
  'fika.vc':                 { name: 'Fika Ventures',        type: 'investor', tags: ['investor', 'seed'] },
  'mucker.com':              { name: 'Mucker Capital',       type: 'investor', tags: ['investor', 'seed'] },
  'baseline.vc':             { name: 'Baseline Ventures',    type: 'investor', tags: ['investor', 'seed'] },
  'crv.com':                 { name: 'CRV',                  type: 'investor', tags: ['investor', 'vc'] },
  'felicis.com':             { name: 'Felicis',              type: 'investor', tags: ['investor', 'vc'] },
  'flybridge.com':           { name: 'Flybridge',            type: 'investor', tags: ['investor', 'seed'] },
  'haystack.vc':             { name: 'Haystack',             type: 'investor', tags: ['investor', 'seed'] },
  'wildwoodventures.com':    { name: 'Wildwood Ventures',    type: 'investor', tags: ['investor', 'seed'] },

  // ── Sector-focused VCs ─────────────────────────────────────────────
  'gccatalyst.com':          { name: 'Greycroft',            type: 'investor', tags: ['investor', 'vc'] },
  'greycroft.com':           { name: 'Greycroft',            type: 'investor', tags: ['investor', 'vc'] },
  'norwestvp.com':           { name: 'Norwest Venture Partners', type: 'investor', tags: ['investor', 'vc'] },
  'oakhc.com':               { name: 'Oak HC/FT',            type: 'investor', tags: ['investor', 'healthcare', 'fintech'] },
  'flarecap.com':            { name: 'Flare Capital',        type: 'investor', tags: ['investor', 'healthcare'] },
  'omers.com':               { name: 'OMERS Ventures',       type: 'investor', tags: ['investor', 'vc'] },
  'roivant.com':             { name: 'Roivant',              type: 'investor', tags: ['investor', 'biotech'] },
  'arch.com':                { name: 'ARCH Venture Partners', type: 'investor', tags: ['investor', 'biotech'] },
  'thirdrock.com':           { name: 'Third Rock Ventures',  type: 'investor', tags: ['investor', 'biotech'] },
  'flagshippioneering.com':  { name: 'Flagship Pioneering',  type: 'investor', tags: ['investor', 'biotech'] },

  // ── Accelerators ───────────────────────────────────────────────────
  'ycombinator.com':         { name: 'Y Combinator',         type: 'accelerator', tags: ['investor', 'accelerator'] },
  '500.co':                  { name: '500 Global',           type: 'accelerator', tags: ['investor', 'accelerator'] },
  'techstars.com':           { name: 'Techstars',            type: 'accelerator', tags: ['investor', 'accelerator'] },
  'launchhouse.com':         { name: 'Launch House',         type: 'accelerator', tags: ['investor', 'accelerator'] },
  'onpitchfest.com':         { name: 'On Pitch',             type: 'accelerator', tags: ['accelerator'] },
  'masschallenge.org':       { name: 'MassChallenge',        type: 'accelerator', tags: ['accelerator'] },
  'antler.co':               { name: 'Antler',               type: 'accelerator', tags: ['investor', 'accelerator'] },
  'entrepreneurfirst.com':   { name: 'Entrepreneur First',   type: 'accelerator', tags: ['accelerator'] },
  'plugandplaytechcenter.com': { name: 'Plug and Play',      type: 'accelerator', tags: ['accelerator'] },

  // ── Angel platforms ────────────────────────────────────────────────
  'angel.co':                { name: 'AngelList',            type: 'angel-platform', tags: ['investor', 'angel'] },
  'rolling.fun':             { name: 'Rolling Fun',          type: 'angel-platform', tags: ['investor', 'angel'] },

  // ── International ──────────────────────────────────────────────────
  'atomico.com':             { name: 'Atomico',              type: 'investor', tags: ['investor', 'vc', 'europe'] },
  'balderton.com':            { name: 'Balderton Capital',   type: 'investor', tags: ['investor', 'vc', 'europe'] },
  'creandum.com':            { name: 'Creandum',             type: 'investor', tags: ['investor', 'vc', 'europe'] },
  'northzone.com':           { name: 'Northzone',            type: 'investor', tags: ['investor', 'vc', 'europe'] },
  'accel-india.com':         { name: 'Accel India',          type: 'investor', tags: ['investor', 'vc', 'india'] },
  'matrixpartners.in':       { name: 'Matrix Partners India', type: 'investor', tags: ['investor', 'vc', 'india'] },
  'matrixpartners.com':      { name: 'Matrix Partners',      type: 'investor', tags: ['investor', 'vc'] },
  'nexusvp.com':             { name: 'Nexus Venture Partners', type: 'investor', tags: ['investor', 'vc'] },
};

/**
 * Look up a firm by an email or bare domain. Returns null if no match.
 * Subdomains like `careers.a16z.com` deliberately do NOT match — those
 * usually route to recruiters rather than partners.
 */
export function lookupFirmByEmail(email: string | null | undefined): FirmInfo | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  const domain = email.slice(at + 1).toLowerCase().trim();
  return FIRM_DOMAINS[domain] || null;
}

export function isInvestorDomain(email: string | null | undefined): boolean {
  const firm = lookupFirmByEmail(email);
  return !!firm && (firm.tags.includes('investor') || firm.tags.includes('angel'));
}
