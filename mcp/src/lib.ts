/**
 * Pure functions (no network, no MCP): compact responses, CSV building and
 * reading, contact filtering and pagination, date conversion. Testable alone.
 */

// --- Compact responses ----------------------------------------------------------

/**
 * Deep copy without empty fields (null, "", empty array or object): in a
 * response, a missing field means empty. false and 0 are kept, and so are array
 * items (their position may matter).
 */
export function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => compact(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const c = compact(v);
      if (c === null || c === undefined || c === "") continue;
      if (typeof c === "object" && Object.keys(c).length === 0) continue;
      out[k] = c;
    }
    return out as T;
  }
  return value;
}

/** Copy of a row without its zero counters (except `keep`): a missing counter means 0. */
export function omitZeros(row: Record<string, unknown>, keep: string[] = []): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([k, v]) => v !== 0 || keep.includes(k)));
}

// A/B test stats from GET /api/campaigns, meaningless without an A/B test.
const AB_KEYS = ["subject_b", "ab_test", "contacted_a", "replied_a", "reply_rate_a", "contacted_b", "replied_b", "reply_rate_b"];

/** list_campaigns row: zero counters and rates omitted, A/B stats only with an A/B test. */
export function campaignSummary(campaign: Record<string, unknown>): Record<string, unknown> {
  const row = campaign.ab_test ? campaign : Object.fromEntries(Object.entries(campaign).filter(([k]) => !AB_KEYS.includes(k)));
  return omitZeros(row, ["steps", "contacts"]);
}

// --- Values -------------------------------------------------------------------

/** Cell text: null/undefined → "", object → JSON, anything else → String. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Epoch ms → ISO 8601 (UTC); empty if missing or unreadable. */
export function isoOrEmpty(value: unknown): string {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? new Date(n).toISOString() : "";
}

/** A contact's custom fields: `extra` arrives as a JSON string (or object, or null). */
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

// Timestamp keys (epoch ms) that newer tools return as ISO 8601.
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
  "now",
  "opens_at",
  "closes_at",
  "earliest_at",
]);

/**
 * Deep copy where epoch ms timestamps (known keys) become ISO 8601 UTC strings,
 * safer for a model to read than an integer.
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
 * Serializes rows as RFC 4180 CSV: a field is quoted if it contains the
 * delimiter, a quote or a newline (quotes doubled); lines end with CRLF.
 */
export function toCsv(columns: string[], rows: Array<Record<string, string>>, delimiter = ","): string {
  const field = (v: string) => (v.includes(delimiter) || /["\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [columns.map(field).join(delimiter)];
  for (const row of rows) lines.push(columns.map((c) => field(row[c] ?? "")).join(delimiter));
  return lines.join("\r\n") + "\r\n";
}

/** Column name as the app normalizes it on import (lowercase snake_case). */
export function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/** A {{key}} template variable only allows letters, digits and _. */
const KEY_RE = /^[\p{L}\p{N}_]+$/u;

/** Columns known to the app's import; any other becomes a variable. */
export const KNOWN_IMPORT_COLUMNS = ["email", "first_name", "last_name", "company", "linkedin"];

/**
 * Builds the import CSV from contact objects: keys normalized like the app,
 * columns = union of keys (known first, then in order of appearance), non-text
 * values converted to text.
 */
export function buildImportCsv(contacts: Array<Record<string, unknown>>): { csv: string; columns: string[]; rows: number } {
  if (!contacts.length) throw new Error("contacts[] is empty");
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
      // Two keys normalizing alike ("Email" and "email"): the first non-empty one wins.
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
      `Invalid field name(s): ${[...invalid].map((k) => `"${k}"`).join(", ")} — letters, digits and _ only (spaces and hyphens become _).`
    );
  }
  if (!present.has("email") && !present.has("linkedin")) {
    throw new Error("No contact has an \"email\" or \"linkedin\" (profile URL) field: the app requires one of them.");
  }
  const columns = [...KNOWN_IMPORT_COLUMNS.filter((k) => present.has(k)), ...extraColumns];
  return { csv: toCsv(columns, rows), columns, rows: rows.length };
}

/**
 * Validates campaign_vars (fields attached to the enrollment rather than the
 * contact) against the import columns; returns normalized names.
 */
export function checkCampaignVars(campaignVars: string[] | undefined, columns: string[]): string[] {
  const names = [...new Set((campaignVars ?? []).map(normalizeKey).filter(Boolean))];
  const reserved = names.filter((k) => KNOWN_IMPORT_COLUMNS.includes(k));
  if (reserved.length) {
    throw new Error(`campaign_vars: ${reserved.join(", ")} are contact fields, not campaign variables.`);
  }
  const unknown = names.filter((k) => !columns.includes(k));
  if (unknown.length) throw new Error(`campaign_vars: field(s) missing from the contacts: ${unknown.join(", ")}.`);
  return names;
}

/**
 * Decodes a CSV file: UTF-8 (BOM stripped), else Windows-1252, the encoding of
 * French Excel "CSV (semicolon-separated)" exports.
 */
export function decodeCsvBytes(bytes: Uint8Array): { text: string; encoding: "utf-8" | "windows-1252" } {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "windows-1252" };
  }
}

// --- Campaign contacts --------------------------------------------------------

/** Row of GET /api/campaigns/:id/contacts (free-form beyond these fields). */
export type CampaignContactRow = Record<string, unknown> & { cc_id: number; status: string };

/**
 * list_campaign_contacts row: custom fields as objects (extra = the contact's,
 * vars = this campaign enrollment's), zero visit counters omitted.
 */
export function contactSummary(row: CampaignContactRow): Record<string, unknown> {
  return { ...omitZeros(row, ["current_step"]), extra: parseExtra(row.extra), vars: parseExtra(row.vars) };
}

/** Lowercase without accents, for lenient search ("helene" finds "Hélène"). */
function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * Filters by status(es) and substring (case- and accent-insensitive) on email,
 * first name, last name, "first last", company and LinkedIn URL.
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

/** A page of a list: total (after filtering), returned count, offset, items. */
export function paginate<T>(rows: T[], offset = 0, limit = 100): { total: number; returned: number; offset: number; items: T[] } {
  const items = rows.slice(offset, offset + limit);
  return { total: rows.length, returned: items.length, offset, items };
}

/** A campaign's "held" contacts, by ascending cc_id, limited to the first N. */
export function pickHeld(rows: CampaignContactRow[], limit?: number): CampaignContactRow[] {
  const held = rows.filter((r) => r.status === "held").sort((a, b) => a.cc_id - b.cc_id);
  return limit === undefined ? held : held.slice(0, limit);
}

/** Fixed export columns, in order; `extra` keys follow. */
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
 * Flattens a campaign's contacts for export: fixed columns (ISO dates), then one
 * column per custom field: `extra`, and `vars` taking precedence as at send time
 * (prefixed extra_ on collision with a fixed column).
 */
export function exportTable(rows: Array<Record<string, unknown>>): { columns: string[]; rows: Array<Record<string, string>> } {
  const columnOf = new Map<string, string>(); // extra key → column name
  const taken = new Set(EXPORT_COLUMNS);
  const extraColumns: string[] = [];
  const out = rows.map((r) => {
    const row: Record<string, string> = {};
    for (const c of EXPORT_COLUMNS) row[c] = EXPORT_DATE_COLUMNS.has(c) ? isoOrEmpty(r[c]) : cellText(r[c]);
    for (const [key, value] of Object.entries({ ...parseExtra(r.extra), ...parseExtra(r.vars) })) {
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

/** Import report: the error list is truncated so it doesn't flood the context. */
export function summarizeImport(report: unknown, maxErrors = 30): unknown {
  if (report && typeof report === "object" && Array.isArray((report as { errors?: unknown }).errors)) {
    const errors = (report as { errors: unknown[] }).errors;
    if (errors.length > maxErrors) {
      return { ...(report as object), errors: errors.slice(0, maxErrors), errors_total: errors.length, errors_truncated: true };
    }
  }
  return report;
}
