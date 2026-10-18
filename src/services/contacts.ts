import { parse } from "csv-parse/sync";
import { resolveMx } from "node:dns/promises";
import { db } from "../db.js";
import { normalizeLinkedin } from "./linkedin-url.js";
import { isOptedOut } from "./opt-out.js";
import { resolveSections, splitSections } from "./template-sections.js";

export const KNOWN_COLUMNS = new Set(["email", "first_name", "last_name", "company", "linkedin"]);

// Custom field value that removes the field from the contact instead of writing it: imports skip
// empty cells, so clearing must be explicit.
export const CLEAR_FIELD = "[vider]";

// Custom fields seen by a template: the enrollment's (cc.vars, per campaign) override the contact's
// (c.extra, shared across campaigns). Same merge as the scheduler (DUE_SELECT).
export const MERGED_EXTRA = `CASE WHEN cc.vars IS NULL THEN c.extra WHEN c.extra IS NULL THEN cc.vars
  ELSE json_patch(c.extra, cc.vars) END`;

export interface ImportReport {
  imported: number;
  updated: number; // already enrolled in the campaign: fields refreshed
  skipped: number;
  errors: string[];
  // On request (source.withIds): the contact kept for each row, in row order (null = row skipped or
  // contact opted out with the campaign's owner).
  contact_ids?: Array<number | null>;
}

const mxCache = new Map<string, boolean>();

/**
 * Checks that a domain can receive email (MX record), to avoid bounces. When in doubt (DNS down,
 * timeout…) it passes: only ENOTFOUND/ENODATA reject.
 */
export async function domainAcceptsMail(domain: string): Promise<boolean> {
  const cached = mxCache.get(domain);
  if (cached !== undefined) return cached;
  let ok = true;
  try {
    ok = (await resolveMx(domain)).length > 0;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND" || code === "ENODATA") ok = false;
  }
  mxCache.set(domain, ok);
  return ok;
}

/**
 * Upserts contacts, then enrolls them in the campaign (status held). A contact is reachable by
 * email, LinkedIn or both: a row without a valid email is kept if it has a LinkedIn profile. Dedup
 * by email, else by LinkedIn profile (canonical URL), so a candidate imported first without email
 * then with one is completed, not duplicated.
 */
export async function importContacts(
  campaignId: number,
  rows: Array<Record<string, string>>,
  source: { attioRecordIds?: Record<string, string>; withIds?: boolean; campaignVars?: string[] } = {}
): Promise<ImportReport> {
  const report: ImportReport = { imported: 0, updated: 0, skipped: 0, errors: [] };
  const ids: Array<number | null> = [];
  // Columns attached to the enrollment (campaign_contacts.vars) rather than the contact
  const campaignVars = new Set(source.campaignVars ?? []);

  // MX check per domain, before the transaction (DNS resolution is async)
  const domains = new Set(
    rows
      .map((r) => (r.email ?? "").trim().toLowerCase().split("@")[1])
      .filter((d): d is string => Boolean(d))
  );
  const domainOk = new Map<string, boolean>();
  for (const d of domains) domainOk.set(d, await domainAcceptsMail(d));

  const byEmail = db.prepare("SELECT id FROM contacts WHERE email = ?");
  const byLinkedin = db.prepare("SELECT id, email FROM contacts WHERE linkedin = ? ORDER BY email IS NULL, id LIMIT 1");
  const insert = db.prepare(`
    INSERT INTO contacts (email, first_name, last_name, company, linkedin, extra, attio_record_id)
    VALUES (@email, @first_name, @last_name, @company, @linkedin, @extra, @attio_record_id)
  `);
  const update = db.prepare(`
    UPDATE contacts SET
      email      = COALESCE(email, @email),
      first_name = COALESCE(@first_name, first_name),
      last_name  = COALESCE(@last_name, last_name),
      company    = COALESCE(@company, company),
      linkedin   = COALESCE(@linkedin, linkedin),
      -- Fusion des champs personnalisés : les nouvelles valeurs écrasent les
      -- anciennes, les champs absents du nouvel import sont conservés, ceux
      -- marqués CLEAR_FIELD (null dans @extra) sont retirés
      extra      = CASE
        WHEN @extra IS NULL THEN extra
        ELSE NULLIF(json_patch(COALESCE(extra, '{}'), @extra), '{}')
      END,
      attio_record_id = COALESCE(@attio_record_id, attio_record_id)
    WHERE id = @id
  `);
  // Opt-out specific to the campaign's owner (see opt-out.ts)
  const owner = (db.prepare("SELECT owner_ref FROM campaigns WHERE id = ?").get(campaignId) as { owner_ref: string | null } | undefined)
    ?.owner_ref ?? null;
  const enroll = db.prepare(`
    INSERT OR IGNORE INTO campaign_contacts (campaign_id, contact_id, status)
    VALUES (?, ?, 'held')
  `);
  // Same merge as contact fields: new values overwrite old ones
  const setVars = db.prepare(`
    UPDATE campaign_contacts SET vars = NULLIF(json_patch(COALESCE(vars, '{}'), @vars), '{}')
    WHERE campaign_id = @campaign AND contact_id = @contact
  `);

  const run = db.transaction(() => {
    for (const row of rows) {
      let email: string | null = (row.email ?? "").trim().toLowerCase() || null;
      const linkedin = normalizeLinkedin(row.linkedin);
      const label = email ?? linkedin ?? "(ligne vide)";
      if (email && !email.includes("@")) {
        report.errors.push(`Email invalide : ${email}${linkedin ? " — gardé pour LinkedIn" : ""}`);
        email = null;
      } else if (email && domainOk.get(email.split("@")[1]) === false) {
        report.errors.push(`${email} : domaine sans serveur mail (MX introuvable)${linkedin ? " — gardé pour LinkedIn" : ""}`);
        email = null;
      }
      ids.push(null); // replaced by the contact id if kept
      if (!email && !linkedin) {
        report.skipped++;
        if (label === "(ligne vide)") report.errors.push("Ligne sans email ni profil LinkedIn ignorée");
        continue;
      }
      const extra: Record<string, string | null> = {};
      const vars: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(row)) {
        if (KNOWN_COLUMNS.has(k) || !v) continue;
        (campaignVars.has(k) ? vars : extra)[k] = v.trim() === CLEAR_FIELD ? null : v;
      }
      const fields = {
        email,
        first_name: row.first_name?.trim() || null,
        last_name: row.last_name?.trim() || null,
        company: row.company?.trim() || null,
        linkedin,
        extra: Object.keys(extra).length ? JSON.stringify(extra) : null,
        attio_record_id: (email && source.attioRecordIds?.[email]) || null,
      };
      // Existing contact: same email, else same LinkedIn profile (unless the emails differ: two
      // distinct emails on one profile stay two records).
      let existing = email ? (byEmail.get(email) as { id: number } | undefined) : undefined;
      if (!existing && linkedin) {
        const li = byLinkedin.get(linkedin) as { id: number; email: string | null } | undefined;
        if (li && (!email || !li.email || li.email === email)) existing = li;
      }
      let id: number;
      if (existing) {
        update.run({ ...fields, id: existing.id });
        id = existing.id;
      } else {
        // new contact: nothing to remove
        const created = Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== null));
        id = Number(insert.run({ ...fields, extra: Object.keys(created).length ? JSON.stringify(created) : null }).lastInsertRowid);
      }
      if (isOptedOut(id, owner)) {
        report.skipped++; // opted out: never re-enroll
        continue;
      }
      ids[ids.length - 1] = id;
      const r = enroll.run(campaignId, id);
      if (r.changes > 0) report.imported++;
      else report.updated++; // already enrolled: fields just updated
      if (Object.keys(vars).length) setVars.run({ vars: JSON.stringify(vars), campaign: campaignId, contact: id });
    }
  });
  run();
  if (source.withIds) report.contact_ids = ids;
  return report;
}

/** Column name normalized to lowercase snake_case (« Prénom du contact » → prénom_du_contact). */
export function normalizeColumn(name: string): string {
  return name.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/** Parses a CSV (headers on the first line, normalized to snake_case). */
export function parseCsv(content: string): Array<Record<string, string>> {
  return parse(content, {
    columns: (header: string[]) => header.map(normalizeColumn),
    delimiter: detectDelimiter(content),
    skip_empty_lines: true,
    trim: true,
    bom: true,
  }) as Array<Record<string, string>>;
}

/**
 * Detects the delimiter from the first line. French Excel exports often use ";" (or tab) where
 * standard CSV uses ",".
 */
function detectDelimiter(content: string): string {
  const firstLine = content.replace(/^﻿/, "").split(/\r?\n/, 1)[0] ?? "";
  const counts: Record<string, number> = {
    ",": (firstLine.match(/,/g) ?? []).length,
    ";": (firstLine.match(/;/g) ?? []).length,
    "\t": (firstLine.match(/\t/g) ?? []).length,
  };
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ",";
}

/**
 * Is a gender value feminine? Recognizes F, femme, féminin, female, Mme, Madame… Anything else
 * (empty included) is treated as masculine.
 */
function isFeminine(value?: string): boolean {
  const s = (value ?? "").trim().toLowerCase();
  return s.startsWith("f") || s.startsWith("mme") || s.startsWith("mad") || s === "w" || s === "2";
}

/**
 * Replaces variables {{first_name}}, {{company}}, etc. and handles gender agreement via
 * {{genre:masculin|féminin}}: the contact's `genre` column picks the 1st (masculine) or 2nd
 * (feminine) form. Conditional blocks {{if variable}}…{{else}}…{{end}} are resolved first
 * (template-sections.ts).
 */
export function renderTemplate(
  template: string,
  contact: { email: string | null; first_name: string | null; last_name: string | null; company: string | null; extra: string | null },
  extraVars: Record<string, string> = {}
): string {
  const vars: Record<string, string> = {
    email: contact.email ?? "",
    first_name: contact.first_name ?? "",
    last_name: contact.last_name ?? "",
    company: contact.company ?? "",
    ...(contact.extra ? (JSON.parse(contact.extra) as Record<string, string>) : {}),
    ...extraVars,
  };
  return resolveSections(template, vars)
    // Gender agreement {{genre:masculin|féminin}}: before simple variables, since the key is
    // followed by ":", which the generic pattern below excludes.
    .replace(
      /\{\{\s*([\p{L}\p{N}_]+)\s*:\s*([^|{}]*)\|([^{}]*)\}\}/gu,
      (_, key: string, masc: string, fem: string) => (isFeminine(vars[key]) ? fem : masc).trim()
    )
    // Simple variables: {{first_name}}
    .replace(/\{\{\s*([\p{L}\p{N}_]+)\s*\}\}/gu, (_, key: string) => vars[key] ?? "");
}

/** Variables the app fills itself; the others are contact fields or campaign variables. */
export const BUILT_IN_VARIABLES = new Set(["email", "first_name", "last_name", "company", "sender_name", "signature", "link"]);

/**
 * Variables referenced by a template, with the same patterns as renderTemplate. The value tells
 * whether the variable only appears in a gender agreement ({{genre:masculin|féminin}}): absent, it
 * renders the masculine form, not a gap. Both texts of a conditional block count; to get only the
 * variables of the text a contact will receive, resolve its blocks first (resolveSections).
 */
export function templateVariables(template: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const { text, conditions } = splitSections(template);
  for (const m of text.matchAll(/\{\{\s*([\p{L}\p{N}_]+)\s*(:\s*[^|{}]*\|[^{}]*)?\}\}/gu)) {
    out.set(m[1], (out.get(m[1]) ?? true) && m[2] !== undefined);
  }
  // a variable that only drives a block doesn't leave a gap either
  for (const key of conditions) if (!out.has(key)) out.set(key, true);
  return out;
}
