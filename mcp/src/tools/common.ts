/**
 * Briques partagées par les tools : mise en forme des réponses MCP, schémas
 * communs, accès aux fichiers locaux.
 */
import { isAbsolute } from "node:path";
import { z } from "zod";
import { api } from "../api.js";
import { compact, summarizeImport, type CampaignContactRow } from "../lib.js";

// --- Réponses MCP -------------------------------------------------------------
export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** JSON sur une ligne, champs vides omis (voir compact) : moins de texte à lire pour le client. */
export function ok(data: unknown): ToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(compact(data));
  return { content: [{ type: "text", text: text || "(vide)" }] };
}
export function fail(err: unknown): ToolResult {
  return {
    content: [{ type: "text", text: `Erreur : ${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  };
}
/** Enveloppe un handler : exécute, sérialise le résultat, capture les erreurs. */
export function handler<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };
}

// --- Annotations --------------------------------------------------------------
/** Lecture sans effet de bord, limitée à l'app. */
export const READ = { readOnlyHint: true, openWorldHint: false } as const;

// --- Statuts d'un contact dans une campagne -------------------------------------
/** Statuts qu'on peut poser à la main (set_contacts_status). */
export const STATUSES = [
  "held",
  "pending",
  "in_progress",
  "replied",
  "opted_out",
  "bounced",
  "completed",
  "stopped",
  "failed",
] as const;
/** Statuts observables : les précédents + awaiting_li (action LinkedIn en file). */
export const FILTER_STATUSES = [...STATUSES, "awaiting_li"] as const;

export const statusFilter = z
  .union([z.enum(FILTER_STATUSES), z.array(z.enum(FILTER_STATUSES)).min(1)])
  .optional()
  .describe(
    "Filtre par statut : un statut ou une liste. held = importé non lancé, pending = lancé en attente du 1er envoi, in_progress, awaiting_li (action LinkedIn en file), replied, opted_out, bounced, completed, stopped, failed."
  );

export const ccIds = z
  .array(z.number().int())
  .min(1)
  .describe("Identifiants « cc_id » (inscription campagne) issus de list_campaign_contacts — PAS les contact_id globaux.");

// --- Contacts à importer --------------------------------------------------------
const contactValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const contactsList = z
  .array(
    z
      .object({
        email: z.string().optional().describe("Email (clé de dédoublonnage)."),
        linkedin: z.string().optional().describe("URL du profil LinkedIn (https://www.linkedin.com/in/…)."),
        first_name: z.string().optional(),
        last_name: z.string().optional(),
        company: z.string().optional(),
      })
      .catchall(contactValue)
  )
  .min(1)
  .max(5000)
  .describe(
    "Contacts à importer. Chaque objet : email et/ou linkedin (au moins l'un des deux), first_name, last_name, company, et tout autre champ (ex. poste, ville, accroche) qui devient une variable de template {{poste}}. Noms de champs : lettres, chiffres, _ (espaces et tirets convertis en _, majuscules en minuscules)."
  );

export const campaignVars = z
  .array(z.string())
  .min(1)
  .optional()
  .describe(
    "Champs personnalisés à rattacher à l'inscription à CETTE campagne plutôt qu'au contact (ex. [\"phrase\"]). Un champ de contact est partagé entre toutes ses campagnes ; une variable de campagne ne vaut que pour celle-ci, donc le même nom {{phrase}} sert dans chaque campagne sans écraser les autres. À l'envoi elle prime sur le champ du contact de même nom."
  );

// --- Données ------------------------------------------------------------------
/** Importe un CSV dans une campagne (contacts en 'held') ; rapport d'import résumé. */
export async function importCsv(campaignId: number, csv: string, vars: string[] = []): Promise<unknown> {
  const query = vars.length ? `?campaign_vars=${encodeURIComponent(vars.join(","))}` : "";
  return summarizeImport(await api("POST", `/api/campaigns/${campaignId}/import${query}`, { csv }));
}

/** Toutes les lignes contacts d'une campagne (l'API ne pagine pas : filtre et page côté MCP). */
export async function fetchCampaignContacts(campaignId: number): Promise<CampaignContactRow[]> {
  const rows = await api("GET", `/api/campaigns/${campaignId}/contacts`);
  if (!Array.isArray(rows)) throw new Error("Réponse inattendue de l'API (liste de contacts attendue)");
  return rows as CampaignContactRow[];
}

// --- Fichiers locaux ------------------------------------------------------------
/**
 * Lire/écrire un fichier n'a de sens que si le MCP tourne sur la machine de
 * l'utilisateur (stdio). En HTTP (MCP hébergé), un chemin désignerait le disque
 * du serveur : refusé.
 */
export function assertLocalPath(path: string, param: string, fallback: string): void {
  if (process.env.MCP_HTTP_PORT) {
    throw new Error(
      `${param} est indisponible : ce serveur MCP est hébergé (HTTP) et n'a pas accès aux fichiers de l'utilisateur. ${fallback}`
    );
  }
  if (!isAbsolute(path)) throw new Error(`${param} doit être un chemin absolu (reçu : ${path}).`);
}
