/**
 * Canonical LinkedIn profile URL: https://www.linkedin.com/in/<slug>. Dedup key for contacts
 * without email and matching key against the LinkedIn inbox.
 * Accepts a full URL (with or without www, country subdomain, parameters), a bare domain or the
 * slug alone. A value that isn't an /in/ profile is returned as is (cleaned).
 */
export function normalizeLinkedin(value: string | null | undefined): string | null {
  const s = (value ?? "").trim();
  if (!s) return null;
  if (!/[/.]/.test(s)) return `https://www.linkedin.com/in/${decodeSlug(s)}`; // slug only
  const m = s.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  if (m) return `https://www.linkedin.com/in/${decodeSlug(m[1])}`;
  return s;
}

/** A profile's slug (« jean-dupont-123 »), or null if not an /in/ profile. */
export function linkedinSlug(value: string | null | undefined): string | null {
  const m = (normalizeLinkedin(value) ?? "").match(/\/in\/([^/]+)$/);
  return m ? m[1] : null;
}

function decodeSlug(slug: string): string {
  let out = slug;
  try {
    out = decodeURIComponent(slug);
  } catch {
    // badly encoded slug: keep it as is
  }
  return out.replace(/\/+$/, "").toLowerCase();
}
