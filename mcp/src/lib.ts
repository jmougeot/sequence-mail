/**
 * Fonctions pures du serveur MCP (ni réseau, ni MCP) : construction et lecture
 * de CSV, filtres et pagination des contacts, conversion des dates. Testables
 * isolément.
 */

// --- Valeurs ------------------------------------------------------------------

/** Texte d'une cellule : null/undefined → "", objet → JSON, le reste → String. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Epoch ms → ISO 8601 (UTC) ; vide si absent ou illisible. */
export function isoOrEmpty(value: unknown): string {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? new Date(n).toISOString() : "";
}

/** Champs personnalisés d'un contact : `extra` arrive en chaîne JSON (ou objet, ou null). */
export function parseExtra(extra: unknown): Record<string, unknown> {
  let v = extra;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return {};
    }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

// Clés horodatées (epoch ms) que les tools récents rendent en ISO 8601.
const DATE_KEYS = new Set([
  "at",
  "date",
  "since",
  "sent_at",
  "replied_at",
  "reply_at",
  "next_send_at",
  "last_visit_at",
  "created_at",
  "updated_at",
  "checked_at",
  "last_seen_at",
  "last_inbox_at",
  "paused_until",
  "next_allowed_at",
  "warmup_started_at",
]);

/**
 * Copie profonde où les horodatages epoch ms (clés connues) deviennent des
 * chaînes ISO 8601 UTC — plus sûr à lire pour un modèle qu'un entier.
 */
export function isoDates<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => isoDates(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = DATE_KEYS.has(k) && typeof v === "number" && v > 1e11 && v < 1e14 ? new Date(v).toISOString() : isoDates(v);
    }
    return out as T;
  }
  return value;
}

// --- CSV (RFC 4180) -----------------------------------------------------------

/**
 * Sérialise des lignes en CSV RFC 4180 : un champ est mis entre guillemets s'il
 * contient le séparateur, un guillemet ou un retour ligne (guillemets doublés),
 * lignes terminées par CRLF.
 */
export function toCsv(columns: string[], rows: Array<Record<string, string>>, delimiter = ","): string {
  const field = (v: string) => (v.includes(delimiter) || /["\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [columns.map(field).join(delimiter)];
  for (const row of rows) lines.push(columns.map((c) => field(row[c] ?? "")).join(delimiter));
  return lines.join("\r\n") + "\r\n";
}

/** Nom de colonne tel que l'app le normalise à l'import (snake_case minuscule). */
export function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/** Une variable de template {{clé}} n'accepte que lettres, chiffres et _. */
const KEY_RE = /^[\p{L}\p{N}_]+$/u;

/** Colonnes reconnues par l'import de l'app ; toute autre devient une variable. */
export const KNOWN_IMPORT_COLUMNS = ["email", "first_name", "last_name", "company", "linkedin"];

/**
 * Construit le CSV d'import à partir d'objets contacts : clés normalisées comme
 * l'app, colonnes = union des clés (connues d'abord, puis dans l'ordre
 * d'apparition), valeurs non textuelles converties en texte.
 */
export function buildImportCsv(contacts: Array<Record<string, unknown>>): { csv: string; columns: string[]; rows: number } {
  if (!contacts.length) throw new Error("contacts[] est vide");
  const present = new Set<string>();
  const extraColumns: string[] = [];
  const invalid = new Set<string>();
  const rows = contacts.map((contact) => {
    const row: Record<string, string> = {};
    for (const [rawKey, rawValue] of Object.entries(contact ?? {})) {
      const key = normalizeKey(rawKey);
      if (!KEY_RE.test(key)) {
        invalid.add(rawKey);
        continue;
      }
      const value = cellText(rawValue);
      // Deux clés qui se normalisent pareil (« Email » et « email ») : la première non vide gagne.
      if (!(key in row) || (!row[key] && value)) row[key] = value;
      if (!present.has(key)) {
        present.add(key);
        if (!KNOWN_IMPORT_COLUMNS.includes(key)) extraColumns.push(key);
      }
    }
    return row;
  });
  if (invalid.size) {
    throw new Error(
      `Nom(s) de champ invalide(s) : ${[...invalid].map((k) => `« ${k} »`).join(", ")} — lettres, chiffres et _ uniquement (espaces et tirets deviennent _).`
    );
  }
  if (!present.has("email") && !present.has("linkedin")) {
    throw new Error("Aucun contact n'a de champ « email » ni « linkedin » (URL du profil) : l'app exige l'un des deux.");
  }
  const columns = [...KNOWN_IMPORT_COLUMNS.filter((k) => present.has(k)), ...extraColumns];
  return { csv: toCsv(columns, rows), columns, rows: rows.length };
}

/**
 * Décode un fichier CSV : UTF-8 (BOM retiré), sinon Windows-1252 — l'encodage
 * des exports Excel français « CSV (séparateur : point-virgule) ».
 */
export function decodeCsvBytes(bytes: Uint8Array): { text: string; encoding: "utf-8" | "windows-1252" } {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "windows-1252" };
  }
}

// --- Contacts d'une campagne --------------------------------------------------

/** Ligne de GET /api/campaigns/:id/contacts (forme libre au-delà de ces champs). */
export type CampaignContactRow = Record<string, unknown> & { cc_id: number; status: string };

/** Minuscules sans accents, pour une recherche tolérante (« helene » trouve « Hélène »). */
function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * Filtre par statut(s) et par sous-chaîne (casse et accents ignorés) sur email,
 * prénom, nom, « prénom nom », société et URL LinkedIn.
 */
export function filterContacts<T extends Record<string, unknown>>(
  rows: T[],
  opts: { status?: string | string[]; search?: string }
): T[] {
  const statuses = opts.status === undefined ? null : new Set(Array.isArray(opts.status) ? opts.status : [opts.status]);
  const needle = opts.search?.trim() ? fold(opts.search.trim()) : null;
  return rows.filter((r) => {
    if (statuses && !statuses.has(String(r.status))) return false;
    if (needle) {
      const fullName = [r.first_name, r.last_name].filter((x) => typeof x === "string" && x).join(" ");
      const fields = [r.email, r.first_name, r.last_name, fullName, r.company, r.linkedin];
      if (!fields.some((f) => typeof f === "string" && fold(f).includes(needle))) return false;
    }
    return true;
  });
}

/** Page d'une liste : total (après filtre), nombre rendu, décalage, éléments. */
export function paginate<T>(rows: T[], offset = 0, limit = 100): { total: number; returned: number; offset: number; items: T[] } {
  const items = rows.slice(offset, offset + limit);
  return { total: rows.length, returned: items.length, offset, items };
}

/** Contacts « held » d'une campagne, par cc_id croissant, limités aux N premiers. */
export function pickHeld(rows: CampaignContactRow[], limit?: number): CampaignContactRow[] {
  const held = rows.filter((r) => r.status === "held").sort((a, b) => a.cc_id - b.cc_id);
  return limit === undefined ? held : held.slice(0, limit);
}

/** Colonnes fixes de l'export, dans l'ordre ; les clés de `extra` suivent. */
export const EXPORT_COLUMNS = [
  "email",
  "first_name",
  "last_name",
  "company",
  "linkedin",
  "status",
  "current_step",
  "variant",
  "sender",
  "li_sender",
  "replied_at",
  "next_send_at",
  "visit_count",
  "error",
];
const EXPORT_DATE_COLUMNS = new Set(["replied_at", "next_send_at"]);

/**
 * Aplatit les contacts d'une campagne pour l'export : colonnes fixes (dates en
 * ISO), puis une colonne par clé de `extra` (préfixée extra_ si elle entre en
 * collision avec une colonne fixe).
 */
export function exportTable(rows: Array<Record<string, unknown>>): { columns: string[]; rows: Array<Record<string, string>> } {
  const columnOf = new Map<string, string>(); // clé extra → nom de colonne
  const taken = new Set(EXPORT_COLUMNS);
  const extraColumns: string[] = [];
  const out = rows.map((r) => {
    const row: Record<string, string> = {};
    for (const c of EXPORT_COLUMNS) row[c] = EXPORT_DATE_COLUMNS.has(c) ? isoOrEmpty(r[c]) : cellText(r[c]);
    for (const [key, value] of Object.entries(parseExtra(r.extra))) {
      let col = columnOf.get(key);
      if (!col) {
        col = key;
        while (taken.has(col)) col = `extra_${col}`;
        taken.add(col);
        columnOf.set(key, col);
        extraColumns.push(col);
      }
      row[col] = cellText(value);
    }
    return row;
  });
  return { columns: [...EXPORT_COLUMNS, ...extraColumns], rows: out };
}

/** Rapport d'import : la liste d'erreurs est tronquée pour ne pas noyer le contexte. */
export function summarizeImport(report: unknown, maxErrors = 30): unknown {
  if (report && typeof report === "object" && Array.isArray((report as { errors?: unknown }).errors)) {
    const errors = (report as { errors: unknown[] }).errors;
    if (errors.length > maxErrors) {
      return { ...(report as object), errors: errors.slice(0, maxErrors), errors_total: errors.length, errors_truncated: true };
    }
  }
  return report;
}
