import { parse } from "csv-parse/sync";
import { resolveMx } from "node:dns/promises";
import { db } from "../db.js";

const KNOWN_COLUMNS = new Set(["email", "first_name", "last_name", "company", "linkedin"]);

export interface ImportReport {
  imported: number;
  updated: number; // déjà inscrit à la campagne : ses champs ont été rafraîchis
  skipped: number;
  errors: string[];
}

const mxCache = new Map<string, boolean>();

/**
 * Vérifie qu'un domaine peut recevoir des emails (enregistrement MX).
 * Élimine les bounces avant l'envoi. En cas de doute (DNS indisponible,
 * timeout…), on laisse passer : seul ENOTFOUND/ENODATA rejette.
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

/** Insère/met à jour les contacts puis les inscrit à la campagne (statut pending). */
export async function importContacts(
  campaignId: number,
  rows: Array<Record<string, string>>,
  source: { attioRecordIds?: Record<string, string> } = {}
): Promise<ImportReport> {
  const report: ImportReport = { imported: 0, updated: 0, skipped: 0, errors: [] };

  // Vérification MX par domaine, en amont de la transaction (résolution DNS asynchrone)
  const domains = new Set(
    rows
      .map((r) => (r.email ?? "").trim().toLowerCase().split("@")[1])
      .filter((d): d is string => Boolean(d))
  );
  const domainOk = new Map<string, boolean>();
  for (const d of domains) domainOk.set(d, await domainAcceptsMail(d));

  const upsertContact = db.prepare(`
    INSERT INTO contacts (email, first_name, last_name, company, linkedin, extra, attio_record_id)
    VALUES (@email, @first_name, @last_name, @company, @linkedin, @extra, @attio_record_id)
    ON CONFLICT(email) DO UPDATE SET
      first_name = COALESCE(excluded.first_name, contacts.first_name),
      last_name  = COALESCE(excluded.last_name, contacts.last_name),
      company    = COALESCE(excluded.company, contacts.company),
      linkedin   = COALESCE(excluded.linkedin, contacts.linkedin),
      -- Fusion des champs personnalisés : les nouvelles valeurs écrasent les
      -- anciennes, les champs absents du nouvel import sont conservés
      extra      = CASE
        WHEN excluded.extra IS NULL THEN contacts.extra
        WHEN contacts.extra IS NULL THEN excluded.extra
        ELSE json_patch(contacts.extra, excluded.extra)
      END,
      attio_record_id = COALESCE(excluded.attio_record_id, contacts.attio_record_id)
  `);
  const getContactId = db.prepare("SELECT id, do_not_contact FROM contacts WHERE email = ?");
  const enroll = db.prepare(`
    INSERT OR IGNORE INTO campaign_contacts (campaign_id, contact_id, status)
    VALUES (?, ?, 'held')
  `);

  const run = db.transaction(() => {
    for (const row of rows) {
      const email = (row.email ?? "").trim().toLowerCase();
      if (!email || !email.includes("@")) {
        report.skipped++;
        if (email) report.errors.push(`Email invalide : ${email}`);
        continue;
      }
      if (domainOk.get(email.split("@")[1]) === false) {
        report.skipped++;
        report.errors.push(`${email} : domaine sans serveur mail (MX introuvable)`);
        continue;
      }
      const extra: Record<string, string> = {};
      for (const [k, v] of Object.entries(row)) {
        if (!KNOWN_COLUMNS.has(k) && v) extra[k] = v;
      }
      upsertContact.run({
        email,
        first_name: row.first_name?.trim() || null,
        last_name: row.last_name?.trim() || null,
        company: row.company?.trim() || null,
        linkedin: row.linkedin?.trim() || null,
        extra: Object.keys(extra).length ? JSON.stringify(extra) : null,
        attio_record_id: source.attioRecordIds?.[email] ?? null,
      });
      const { id, do_not_contact } = getContactId.get(email) as {
        id: number;
        do_not_contact: number;
      };
      if (do_not_contact) {
        report.skipped++; // désinscrit : ne jamais le réinscrire
        continue;
      }
      const r = enroll.run(campaignId, id);
      if (r.changes > 0) report.imported++;
      else report.updated++; // déjà inscrit : ses champs viennent d'être mis à jour
    }
  });
  run();
  return report;
}

/** Parse un CSV (entêtes en première ligne, normalisées en snake_case). */
export function parseCsv(content: string): Array<Record<string, string>> {
  return parse(content, {
    columns: (header: string[]) =>
      header.map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, "_")),
    delimiter: detectDelimiter(content),
    skip_empty_lines: true,
    trim: true,
    bom: true,
  }) as Array<Record<string, string>>;
}

/**
 * Détecte le séparateur depuis la 1re ligne. Les exports Excel FR utilisent
 * souvent « ; » (ou tabulation), là où le CSV standard utilise « , ».
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
 * Une valeur de genre est-elle féminine ? Reconnaît F, femme, féminin,
 * female, Mme, Madame… Tout le reste (y compris vide) est traité au masculin.
 */
function isFeminine(value?: string): boolean {
  const s = (value ?? "").trim().toLowerCase();
  return s.startsWith("f") || s.startsWith("mme") || s.startsWith("mad") || s === "w" || s === "2";
}

/**
 * Remplace les variables {{first_name}}, {{company}}, etc. et gère l'accord
 * en genre via {{genre:masculin|féminin}} : la colonne `genre` du contact
 * choisit la 1re forme (masculin) ou la 2e (féminin).
 */
export function renderTemplate(
  template: string,
  contact: { email: string; first_name: string | null; last_name: string | null; company: string | null; extra: string | null },
  extraVars: Record<string, string> = {}
): string {
  const vars: Record<string, string> = {
    email: contact.email,
    first_name: contact.first_name ?? "",
    last_name: contact.last_name ?? "",
    company: contact.company ?? "",
    ...(contact.extra ? (JSON.parse(contact.extra) as Record<string, string>) : {}),
    ...extraVars,
  };
  return template
    // Accord en genre : {{genre:masculin|féminin}} — placé avant les variables
    // simples car la clé est suivie de « : », exclue du motif générique ci-dessous.
    .replace(
      /\{\{\s*([\p{L}\p{N}_]+)\s*:\s*([^|{}]*)\|([^{}]*)\}\}/gu,
      (_, key: string, masc: string, fem: string) => (isFeminine(vars[key]) ? fem : masc).trim()
    )
    // Variables simples : {{first_name}}
    .replace(/\{\{\s*([\p{L}\p{N}_]+)\s*\}\}/gu, (_, key: string) => vars[key] ?? "");
}
