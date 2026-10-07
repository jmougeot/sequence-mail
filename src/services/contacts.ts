import { parse } from "csv-parse/sync";
import { resolveMx } from "node:dns/promises";
import { db } from "../db.js";
import { normalizeLinkedin } from "./linkedin-url.js";
import { isOptedOut } from "./opt-out.js";

export const KNOWN_COLUMNS = new Set(["email", "first_name", "last_name", "company", "linkedin"]);

// Champs personnalisés vus par un template : ceux de l'inscription (cc.vars, propres
// à une campagne) priment sur ceux du contact (c.extra, partagés entre campagnes).
// Même fusion que le scheduler (DUE_SELECT).
export const MERGED_EXTRA = `CASE WHEN cc.vars IS NULL THEN c.extra WHEN c.extra IS NULL THEN cc.vars
  ELSE json_patch(c.extra, cc.vars) END`;

export interface ImportReport {
  imported: number;
  updated: number; // déjà inscrit à la campagne : ses champs ont été rafraîchis
  skipped: number;
  errors: string[];
  // Sur demande (source.withIds) : contact retenu pour chaque ligne, dans
  // l'ordre des lignes (null = ligne ignorée ou contact désinscrit auprès du
  // propriétaire de la campagne).
  contact_ids?: Array<number | null>;
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

/**
 * Insère/met à jour les contacts puis les inscrit à la campagne (statut held).
 * Un contact est joignable par email, par LinkedIn, ou les deux : une ligne
 * sans email valide est gardée si elle a un profil LinkedIn. Dédoublonnage par
 * email, sinon par profil LinkedIn (URL canonique) — un candidat importé d'abord
 * sans email puis avec est donc complété, pas dupliqué.
 */
export async function importContacts(
  campaignId: number,
  rows: Array<Record<string, string>>,
  source: { attioRecordIds?: Record<string, string>; withIds?: boolean; campaignVars?: string[] } = {}
): Promise<ImportReport> {
  const report: ImportReport = { imported: 0, updated: 0, skipped: 0, errors: [] };
  const ids: Array<number | null> = [];
  // Colonnes rattachées à l'inscription (campaign_contacts.vars) plutôt qu'au contact
  const campaignVars = new Set(source.campaignVars ?? []);

  // Vérification MX par domaine, en amont de la transaction (résolution DNS asynchrone)
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
      -- anciennes, les champs absents du nouvel import sont conservés
      extra      = CASE
        WHEN @extra IS NULL THEN extra
        WHEN extra IS NULL THEN @extra
        ELSE json_patch(extra, @extra)
      END,
      attio_record_id = COALESCE(@attio_record_id, attio_record_id)
    WHERE id = @id
  `);
  // Désinscription propre au propriétaire de la campagne (cf. opt-out.ts)
  const owner = (db.prepare("SELECT owner_ref FROM campaigns WHERE id = ?").get(campaignId) as { owner_ref: string | null } | undefined)
    ?.owner_ref ?? null;
  const enroll = db.prepare(`
    INSERT OR IGNORE INTO campaign_contacts (campaign_id, contact_id, status)
    VALUES (?, ?, 'held')
  `);
  // Même fusion que les champs du contact : les nouvelles valeurs écrasent les anciennes
  const setVars = db.prepare(`
    UPDATE campaign_contacts SET vars = CASE WHEN vars IS NULL THEN @vars ELSE json_patch(vars, @vars) END
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
      ids.push(null); // remplacé par l'id du contact s'il est retenu
      if (!email && !linkedin) {
        report.skipped++;
        if (label === "(ligne vide)") report.errors.push("Ligne sans email ni profil LinkedIn ignorée");
        continue;
      }
      const extra: Record<string, string> = {};
      const vars: Record<string, string> = {};
      for (const [k, v] of Object.entries(row)) {
        if (!KNOWN_COLUMNS.has(k) && v) (campaignVars.has(k) ? vars : extra)[k] = v;
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
      // Contact existant : même email, sinon même profil LinkedIn (sans email
      // différent — deux emails distincts sur un même profil restent deux fiches).
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
        id = Number(insert.run(fields).lastInsertRowid);
      }
      if (isOptedOut(id, owner)) {
        report.skipped++; // désinscrit : ne jamais le réinscrire
        continue;
      }
      ids[ids.length - 1] = id;
      const r = enroll.run(campaignId, id);
      if (r.changes > 0) report.imported++;
      else report.updated++; // déjà inscrit : ses champs viennent d'être mis à jour
      if (Object.keys(vars).length) setVars.run({ vars: JSON.stringify(vars), campaign: campaignId, contact: id });
    }
  });
  run();
  if (source.withIds) report.contact_ids = ids;
  return report;
}

/** Nom de colonne normalisé en snake_case minuscule (« Prénom du contact » → prénom_du_contact). */
export function normalizeColumn(name: string): string {
  return name.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/** Parse un CSV (entêtes en première ligne, normalisées en snake_case). */
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

/**
 * Variables référencées par un template, avec les mêmes motifs que
 * renderTemplate. La valeur indique si la variable n'apparaît que dans un accord
 * en genre ({{genre:masculin|féminin}}) : absente, elle donne le masculin, pas un trou.
 */
export function templateVariables(template: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const m of template.matchAll(/\{\{\s*([\p{L}\p{N}_]+)\s*(:\s*[^|{}]*\|[^{}]*)?\}\}/gu)) {
    out.set(m[1], (out.get(m[1]) ?? true) && m[2] !== undefined);
  }
  return out;
}
