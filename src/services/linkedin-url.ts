/**
 * Forme canonique d'une URL de profil LinkedIn : https://www.linkedin.com/in/<slug>.
 * Sert de clé de dédoublonnage pour les contacts sans email et de clé de
 * rapprochement avec la messagerie LinkedIn. Accepte une URL complète (avec
 * ou sans www, sous-domaine pays, paramètres), un domaine nu ou le slug seul.
 * Une valeur qui n'est pas un profil /in/ est rendue telle quelle (nettoyée).
 */
export function normalizeLinkedin(value: string | null | undefined): string | null {
  const s = (value ?? "").trim();
  if (!s) return null;
  if (!/[/.]/.test(s)) return `https://www.linkedin.com/in/${decodeSlug(s)}`; // slug seul
  const m = s.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  if (m) return `https://www.linkedin.com/in/${decodeSlug(m[1])}`;
  return s;
}

/** Slug d'un profil (« jean-dupont-123 »), ou null si ce n'est pas un profil /in/. */
export function linkedinSlug(value: string | null | undefined): string | null {
  const m = (normalizeLinkedin(value) ?? "").match(/\/in\/([^/]+)$/);
  return m ? m[1] : null;
}

function decodeSlug(slug: string): string {
  let out = slug;
  try {
    out = decodeURIComponent(slug);
  } catch {
    // slug mal encodé : on le garde tel quel
  }
  return out.replace(/\/+$/, "").toLowerCase();
}
