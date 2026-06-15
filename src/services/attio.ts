import { config } from "../config.js";
import { importContacts, type ImportReport } from "./contacts.js";

const ATTIO_API = "https://api.attio.com/v2";

interface AttioPerson {
  id: { record_id: string };
  values: Record<string, Array<Record<string, unknown>>>;
}

function firstValue(person: AttioPerson, attr: string): Record<string, unknown> | undefined {
  return person.values[attr]?.[0];
}

// Attributs système Attio sans intérêt pour la personnalisation d'emails
const SKIP_ATTRS = new Set([
  "email_addresses",
  "name",
  "created_at",
  "created_by",
  "avatar_url",
  "record_id",
  "company", // référence vers une fiche, pas un texte
  "associated_deals",
  "associated_users",
  "matching_criteria",
  "strongest_connection_user",
  "strongest_connection_strength",
  "strongest_connection_strength_legacy",
]);

/**
 * Extrait la valeur d'un attribut Attio sous forme de texte, quel que soit son
 * type (texte, select, statut, téléphone, domaine, nombre…). Renvoie "" pour
 * les types non textuels (références, interactions…), qui sont alors ignorés.
 */
export function attioValueText(v: Record<string, unknown>): string {
  if (typeof v.value === "string") return v.value.trim();
  if (typeof v.value === "number") return String(v.value);
  for (const k of ["option", "status"]) {
    const o = v[k] as { title?: string } | undefined;
    if (o && typeof o.title === "string") return o.title.trim();
  }
  for (const k of ["email_address", "domain", "phone_number", "original_phone_number", "full_name"]) {
    if (typeof v[k] === "string") return (v[k] as string).trim();
  }
  if (typeof v.currency_value === "number") return String(v.currency_value);
  return "";
}

/**
 * Convertit une fiche Attio en ligne d'import : tous les attributs ayant une
 * valeur textuelle non vide deviennent des champs personnalisés ({{variables}}).
 */
export function attioPersonToRow(person: AttioPerson): Record<string, string> {
  const row: Record<string, string> = {};
  for (const [slug, vals] of Object.entries(person.values)) {
    if (SKIP_ATTRS.has(slug) || !Array.isArray(vals) || !vals.length) continue;
    const text = vals.map(attioValueText).filter(Boolean).join(", ");
    if (!text) continue;
    const key = slug.trim().toLowerCase().replace(/[\s-]+/g, "_");
    // La clé doit être utilisable comme variable {{...}}
    if (!/^[\p{L}\p{N}_]+$/u.test(key)) continue;
    if (["email", "first_name", "last_name", "company"].includes(key)) continue;
    row[key] = text;
  }
  return row;
}

/**
 * Écrit l'avancement de séquence sur la fiche Attio du contact
 * (attribut texte configuré via ATTIO_STAGE_ATTRIBUTE). Silencieux si non configuré.
 */
export async function pushSequenceStatus(attioRecordId: string, value: string): Promise<void> {
  if (!config.attioApiKey || !config.attioStageAttribute) return;
  const res = await fetch(`${ATTIO_API}/objects/people/records/${attioRecordId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${config.attioApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: { values: { [config.attioStageAttribute]: [{ value }] } },
    }),
  });
  if (!res.ok) {
    throw new Error(`Attio PATCH ${res.status} : ${await res.text()}`);
  }
}

/**
 * Importe depuis Attio les personnes dont l'attribut `statusAttribute`
 * (slug, ex: "stage" ou un attribut select personnalisé) vaut l'un des `statuses`.
 */
export async function syncFromAttio(
  campaignId: number,
  statusAttribute: string,
  statuses: string[]
): Promise<ImportReport & { fetched: number }> {
  if (!config.attioApiKey) {
    throw new Error("ATTIO_API_KEY manquant dans .env");
  }

  const rows: Array<Record<string, string>> = [];
  const attioIds: Record<string, string> = {};
  let offset = 0;
  const limit = 500;

  // Les attributs de type select n'acceptent que $eq : un $or de $eq couvre
  // tous les types d'attributs, contrairement à $in.
  const filter =
    statuses.length === 1
      ? { [statusAttribute]: { $eq: statuses[0] } }
      : { $or: statuses.map((s) => ({ [statusAttribute]: { $eq: s } })) };

  for (;;) {
    const res = await fetch(`${ATTIO_API}/objects/people/records/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.attioApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ filter, limit, offset }),
    });
    if (!res.ok) {
      throw new Error(`Attio API ${res.status} : ${await res.text()}`);
    }
    const { data } = (await res.json()) as { data: AttioPerson[] };

    for (const person of data) {
      const emailVal = firstValue(person, "email_addresses");
      const email = (emailVal?.email_address as string | undefined)?.toLowerCase();
      if (!email) continue;
      const nameVal = firstValue(person, "name");
      rows.push({
        ...attioPersonToRow(person), // tous les attributs non vides => variables {{...}}
        email,
        first_name: (nameVal?.first_name as string) ?? "",
        last_name: (nameVal?.last_name as string) ?? "",
        company: "",
      });
      attioIds[email] = person.id.record_id;
    }

    if (data.length < limit) break;
    offset += limit;
  }

  const report = await importContacts(campaignId, rows, { attioRecordIds: attioIds });
  return { ...report, fetched: rows.length };
}
