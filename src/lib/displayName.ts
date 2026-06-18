/**
 * Turns a noisy stored `name` into something readable when the stored name
 * is itself an email or email-like local-part. Examples:
 *   "raghulk2u@gmail.com"        → "Raghulk2u"
 *   "joshua.ford@redesignhealth" → "Joshua Ford"
 *   "Sarah Alvi"                 → "Sarah Alvi"     (already clean)
 *   "OXF-SM Oxford Bus ..."      → "OXF-SM Oxford Bus ..." (untouched)
 */
export function displayName(name: string | null | undefined): string {
  if (!name) return '';
  const trimmed = name.trim();
  if (!trimmed) return '';

  // If the name contains an '@', it's an email — take the local-part.
  let bare = trimmed;
  if (bare.includes('@')) bare = bare.split('@')[0];

  // If the result is still email-shaped (dots, no spaces, all lowercase) — humanize it.
  const isEmailLocal =
    !bare.includes(' ') &&
    /^[a-z0-9._+-]+$/i.test(bare);

  if (isEmailLocal) {
    // first.last → "First Last"; flat handles stay capitalized (raghulk2u → Raghulk2u)
    const parts = bare.split(/[._-]+/).filter(Boolean);
    if (parts.length >= 2 && parts.every((p) => /^[a-z]+$/i.test(p))) {
      return parts.map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase()).join(' ');
    }
    return bare[0].toUpperCase() + bare.slice(1);
  }

  return trimmed;
}

/** Initial letter for avatar circles — based on the cleaned-up name. */
export function displayInitial(name: string | null | undefined): string {
  const d = displayName(name);
  return d.charAt(0).toUpperCase() || '?';
}
