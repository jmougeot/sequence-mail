/**
 * Contacts : liste filtrée/paginée, recherche globale, export CSV, imports
 * (objets, CSV brut ou fichier), Attio, lancement et changements de statut.
 */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../api.js";
import {
  buildImportCsv,
  checkCampaignVars,
  contactSummary,
  decodeCsvBytes,
  exportTable,
  filterContacts,
  isoDates,
  paginate,
  parseExtra,
  pickHeld,
  toCsv,
} from "../lib.js";
import {
  assertLocalPath,
  campaignVars,
  ccIds,
  contactsList,
  fetchCampaignContacts,
  handler,
  importCsv,
  READ,
  STATUSES,
  statusFilter,
} from "./common.js";

type StatusFilter = z.infer<typeof statusFilter>;

const LAUNCH_CHUNK = 500; // ids par requête launch-contacts

const listShape = {
  campaign_id: z.number().int().describe("Identifiant de la campagne."),
  status: statusFilter,
  search: z
    .string()
    .optional()
    .describe("Sous-chaîne cherchée (casse et accents ignorés) dans email, prénom, nom, « prénom nom », société, URL LinkedIn."),
  limit: z.number().int().min(1).max(1000).optional().describe("Nombre max de lignes rendues (défaut 100, max 1000)."),
  offset: z.number().int().min(0).optional().describe("Lignes à sauter, pour paginer (défaut 0)."),
};
type ListArgs = z.infer<z.ZodObject<typeof listShape>>;

const exportShape = {
  campaign_id: z.number().int().describe("Identifiant de la campagne."),
  status: statusFilter,
  file_path: z
    .string()
    .optional()
    .describe(
      "Chemin ABSOLU du fichier .csv à écrire (UTF-8 avec BOM, lisible par Excel). Seulement si le MCP tourne en local (stdio) sur la machine de l'utilisateur. Omis = le CSV est renvoyé en texte."
    ),
  overwrite: z.boolean().optional().describe("Remplacer le fichier s'il existe déjà (défaut false : refus)."),
  delimiter: z
    .enum([",", ";"])
    .optional()
    .describe("Séparateur : « , » (défaut, CSV standard) ou « ; » (Excel en français)."),
};
type ExportArgs = z.infer<z.ZodObject<typeof exportShape>>;

const importShape = {
  campaign_id: z.number().int().describe("Campagne cible."),
  contacts: contactsList,
  campaign_vars: campaignVars,
};
type ImportArgs = z.infer<z.ZodObject<typeof importShape>>;

const importCsvShape = {
  campaign_id: z.number().int().describe("Campagne cible."),
  csv: z
    .string()
    .optional()
    .describe("Contenu CSV brut, ligne d'en-tête comprise (séparateur , ; ou tabulation détecté). Exclusif avec csv_path."),
  csv_path: z
    .string()
    .optional()
    .describe(
      "Chemin ABSOLU d'un fichier CSV local, lu par le process MCP (UTF-8, ou Windows-1252 des exports Excel). Ne marche que si le MCP tourne en local en stdio sur la machine où se trouve le fichier ; refusé par un MCP hébergé. Exclusif avec csv."
    ),
  campaign_vars: campaignVars,
};
type ImportCsvArgs = z.infer<z.ZodObject<typeof importCsvShape>>;

const launchShape = {
  campaign_id: z
    .union([z.number().int(), z.array(z.number().int()).min(1)])
    .describe("Campagne concernée, ou liste de campagnes à lancer en un seul appel."),
  cc_ids: ccIds.optional(),
  all_held: z
    .boolean()
    .optional()
    .describe("true = lancer les contacts en attente ('held') de la campagne, par cc_id croissant. Sans limit : TOUS."),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Avec all_held : ne lancer que les N premiers contacts 'held' (par cc_id croissant) — N par campagne s'il y en a plusieurs."),
};
type LaunchArgs = z.infer<z.ZodObject<typeof launchShape>>;

/** Lance des cc_ids par paquets ; renvoie le nombre réellement passé en pending. */
async function launch(campaignId: number, ids: number[]): Promise<number> {
  let launched = 0;
  for (let i = 0; i < ids.length; i += LAUNCH_CHUNK) {
    const r = (await api("POST", `/api/campaigns/${campaignId}/launch-contacts`, {
      json: { ids: ids.slice(i, i + LAUNCH_CHUNK) },
    })) as { launched?: number };
    launched += Number(r?.launched ?? 0);
  }
  return launched;
}

/** Lance dans UNE campagne les cc_ids donnés, ou ses contacts 'held' (les `limit` premiers). */
async function launchIn(campaignId: number, ids: number[] | undefined, limit?: number): Promise<Record<string, unknown>> {
  if (ids) return { launched: await launch(campaignId, ids) };
  const rows = await fetchCampaignContacts(campaignId);
  const heldBefore = rows.filter((r) => r.status === "held").length;
  const chosen = pickHeld(rows, limit).map((r) => r.cc_id);
  if (!chosen.length) return { launched: 0, held_before: 0, note: "Aucun contact en attente ('held') dans cette campagne." };
  const launched = await launch(campaignId, chosen);
  return {
    launched,
    held_before: heldBefore,
    held_remaining: heldBefore - launched,
    first_cc_id: chosen[0],
    last_cc_id: chosen[chosen.length - 1],
  };
}

export function registerContactTools(server: McpServer): void {
  // ---------------------------------------------------------------- lecture

  server.registerTool(
    "list_campaign_contacts",
    {
      title: "Contacts d'une campagne",
      description:
        "Liste les contacts d'une campagne avec leur état, filtrés (status, search) et paginés (limit défaut 100, offset). Renvoie { total, returned, offset, contacts } : total = nombre de lignes APRÈS filtre ; s'il dépasse offset + returned, appelle à nouveau avec offset augmenté. IMPORTANT : chaque ligne a deux identifiants — « contact_id » (le contact global, utilisé par update_contact) et « cc_id » (l'inscription à CETTE campagne, utilisée par launch_contacts, stop_contacts, set_contacts_status, remove_contacts, get_conversation, reply_to_contact). Inclut statut, étape courante, variante A/B, compte émetteur, prochain envoi et replied_at (epoch ms), visites du lien, extra (champs personnalisés du contact) et vars (variables propres à cette campagne, prioritaires). Un champ absent est vide, un compteur de visites absent vaut 0. Pour les compteurs par statut, list_campaigns suffit.",
      inputSchema: listShape,
      annotations: READ,
    },
    handler(async ({ campaign_id, status, search, limit, offset }: ListArgs) => {
      const rows = filterContacts(await fetchCampaignContacts(campaign_id), { status, search });
      const page = paginate(rows, offset ?? 0, limit ?? 100);
      return { total: page.total, returned: page.returned, offset: page.offset, contacts: page.items.map(contactSummary) };
    })
  );

  server.registerTool(
    "search_contacts",
    {
      title: "Rechercher un contact",
      description:
        "Recherche un contact dans TOUTE la base (toutes campagnes) : sous-chaîne insensible à la casse sur email, prénom, nom, « prénom nom », société, URL LinkedIn. Chaque résultat donne contact_id (contact global : update_contact, preview_email, send_test_email), do_not_contact, extra (champs personnalisés) et campaigns[] : ses inscriptions avec cc_id (get_conversation, reply_to_contact, launch/stop/set_status/remove), statut, étape, replied_at. Dates en ISO 8601 (UTC).",
      inputSchema: {
        q: z.string().min(2).describe("Texte cherché (au moins 2 caractères) : nom, email, société, profil…"),
        limit: z.number().int().min(1).max(200).optional().describe("Nombre max de contacts (défaut 50, max 200)."),
      },
      annotations: READ,
    },
    handler(async ({ q, limit }: { q: string; limit?: number }) => {
      const params = new URLSearchParams({ q });
      if (limit !== undefined) params.set("limit", String(limit));
      const rows = await api("GET", `/api/contacts?${params}`);
      if (!Array.isArray(rows)) return rows;
      return isoDates(rows.map((r: Record<string, unknown>) => ({ ...r, extra: r.extra == null ? null : parseExtra(r.extra) })));
    })
  );

  server.registerTool(
    "export_campaign_contacts",
    {
      title: "Exporter les contacts (CSV)",
      description:
        "Exporte les contacts d'une campagne en CSV : email, first_name, last_name, company, linkedin, status, current_step, variant, sender, li_sender, replied_at et next_send_at (ISO 8601 UTC), visit_count, error, puis une colonne par champ personnalisé (du contact ou propre à la campagne ; préfixée extra_ en cas de collision). Filtre optionnel par statut. Avec file_path (MCP local uniquement) : écrit le fichier et renvoie { path, rows, columns }. Sans file_path : renvoie le texte CSV — préfère file_path au-delà de ~200 lignes pour ne pas saturer la conversation.",
      inputSchema: exportShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler(async ({ campaign_id, status, file_path, overwrite, delimiter }: ExportArgs) => {
      if (file_path !== undefined) assertLocalPath(file_path, "file_path", "Omets file_path pour recevoir le CSV en texte.");
      const rows = filterContacts(await fetchCampaignContacts(campaign_id), { status: status as StatusFilter });
      const table = exportTable(rows);
      const csv = toCsv(table.columns, table.rows, delimiter ?? ",");
      if (file_path === undefined) return csv;
      if (!overwrite) {
        const exists = await access(file_path).then(
          () => true,
          () => false
        );
        if (exists) throw new Error(`Le fichier ${file_path} existe déjà : passe overwrite: true pour le remplacer.`);
      }
      await mkdir(dirname(file_path), { recursive: true });
      await writeFile(file_path, "﻿" + csv, "utf8");
      return { path: file_path, rows: table.rows.length, columns: table.columns };
    })
  );

  // ---------------------------------------------------------------- import

  const importNote =
    "Dédoublonnage par email, sinon par profil LinkedIn ; un contact déjà présent est mis à jour (ses champs personnalisés fusionnés — réimporter corrige donc un champ ou une variable de campagne). Un email sans serveur mail (MX) est écarté (la ligne reste si elle a un LinkedIn). Un contact sans email saute les étapes email ; sans profil, les étapes LinkedIn. Un contact désinscrit n'est jamais réinscrit. Les contacts arrivent en statut 'held' : RIEN n'est envoyé avant launch_contacts. Renvoie { imported, updated, skipped, errors } (errors tronqué à 30, errors_total sinon).";

  server.registerTool(
    "import_contacts",
    {
      title: "Importer des contacts (liste)",
      description: `Importe dans une campagne une liste de contacts passée en objets JSON (le MCP la convertit en CSV pour l'app). Idéal quand les contacts viennent de la conversation, d'une recherche ou d'un autre outil. ${importNote}`,
      inputSchema: importShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handler(async ({ campaign_id, contacts, campaign_vars }: ImportArgs) => {
      const { csv, columns } = buildImportCsv(contacts as Array<Record<string, unknown>>);
      return importCsv(campaign_id, csv, checkCampaignVars(campaign_vars, columns));
    })
  );

  server.registerTool(
    "import_contacts_csv",
    {
      title: "Importer des contacts (CSV)",
      description: `Importe des contacts dans une campagne depuis un CSV : soit le texte (csv), soit un fichier local (csv_path, chemin absolu, MCP local en stdio uniquement) — exactement l'un des deux. Chaque ligne doit avoir un 'email' ou un 'linkedin' (URL de profil) — les deux si possible ; colonnes reconnues : first_name, last_name, company ; toute autre colonne devient une variable de template (en-têtes normalisés en snake_case minuscule). ${importNote}`,
      inputSchema: importCsvShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handler(async ({ campaign_id, csv, csv_path, campaign_vars }: ImportCsvArgs) => {
      if ((csv === undefined) === (csv_path === undefined)) {
        throw new Error("Fournis exactement un de csv (texte) ou csv_path (fichier local).");
      }
      let content = csv ?? "";
      if (csv_path !== undefined) {
        assertLocalPath(csv_path, "csv_path", "Passe le contenu du fichier dans csv.");
        content = decodeCsvBytes(await readFile(csv_path)).text;
      }
      return importCsv(campaign_id, content, campaign_vars);
    })
  );

  server.registerTool(
    "attio_sync",
    {
      title: "Importer depuis Attio",
      description:
        "Importe dans une campagne les personnes Attio dont un attribut de statut correspond aux valeurs choisies (contacts en 'held', comme un import CSV). Nécessite ATTIO_API_KEY configurée côté app.",
      inputSchema: {
        campaign_id: z.number().int().describe("Campagne cible."),
        status_attribute: z
          .string()
          .optional()
          .describe("Slug de l'attribut de statut Attio (défaut : ATTIO_IMPORT_ATTRIBUTE de l'app)."),
        statuses: z.array(z.string()).min(1).describe("Valeurs de statut à importer."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    handler(
      ({ campaign_id, status_attribute, statuses }: { campaign_id: number; status_attribute?: string; statuses: string[] }) =>
        api("POST", `/api/campaigns/${campaign_id}/attio-sync`, { json: { status_attribute, statuses } })
    )
  );

  // -------------------------------------------- écriture (clé = cc_id)

  server.registerTool(
    "launch_contacts",
    {
      title: "Lancer des contacts",
      description:
        "Active des contacts en attente ('held') → 'pending' : ils entrent dans la file d'envoi, et la campagne repasse 'active' — les vrais envois partent ensuite dans la fenêtre d'envoi, selon les quotas et le warm-up. Sélection : soit cc_ids (liste précise), soit all_held: true (contacts 'held' par cc_id croissant), avec limit pour n'en lancer que N. all_held sans limit lance TOUS les contacts en attente. Les contacts qui ne sont pas 'held' sont ignorés. campaign_id accepte une liste pour lancer plusieurs campagnes en un appel (limit vaut alors par campagne ; chaque cc_id est lancé dans la campagne à laquelle il appartient) : le résultat détaille chaque campagne. N'en lance jamais plus que ce que l'utilisateur a demandé et obtiens son accord explicite avant d'appeler.",
      inputSchema: launchShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    handler(async ({ campaign_id, cc_ids, all_held, limit }: LaunchArgs) => {
      if (cc_ids && all_held) throw new Error("Choisis cc_ids OU all_held, pas les deux.");
      if (!cc_ids && !all_held) throw new Error("Précise cc_ids (contacts à lancer) ou all_held: true (avec limit pour en lancer N).");
      if (cc_ids && limit !== undefined) throw new Error("limit ne s'utilise qu'avec all_held : passe directement les cc_ids voulus.");
      const campaigns = [...new Set(Array.isArray(campaign_id) ? campaign_id : [campaign_id])];
      const notHeld = `Les cc_ids non lancés n'étaient pas en 'held' (ou pas dans ${campaigns.length === 1 ? "cette campagne" : "ces campagnes"}).`;
      if (campaigns.length === 1) {
        const result = await launchIn(campaigns[0], cc_ids, limit);
        if (!cc_ids) return { ok: true, ...result };
        return { ok: true, ...result, requested: cc_ids.length, ...(Number(result.launched) < cc_ids.length ? { note: notHeld } : {}) };
      }
      // Plusieurs campagnes : une erreur sur l'une (archivée…) n'annule pas les lancements déjà faits
      const results: Array<Record<string, unknown>> = [];
      for (const id of campaigns) {
        try {
          results.push({ campaign_id: id, ...(await launchIn(id, cc_ids, limit)) });
        } catch (err) {
          results.push({ campaign_id: id, launched: 0, error: err instanceof Error ? err.message : String(err) });
        }
      }
      const launched = results.reduce((n, r) => n + Number(r.launched), 0);
      return {
        ok: results.every((r) => r.error === undefined),
        launched,
        ...(cc_ids ? { requested: cc_ids.length, ...(launched < cc_ids.length ? { note: notHeld } : {}) } : {}),
        campaigns: results,
      };
    })
  );

  server.registerTool(
    "stop_contacts",
    {
      title: "Arrêter des contacts",
      description:
        "Arrête manuellement la séquence d'une sélection (statut → 'stopped', envoi planifié et actions LinkedIn en file annulés). Agit sur les contacts en 'held', 'pending', 'in_progress' ou 'awaiting_li'.",
      inputSchema: { campaign_id: z.number().int().describe("Campagne concernée."), cc_ids: ccIds },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handler(({ campaign_id, cc_ids }: { campaign_id: number; cc_ids: number[] }) =>
      api("POST", `/api/campaigns/${campaign_id}/stop-contacts`, { json: { ids: cc_ids } })
    )
  );

  server.registerTool(
    "set_contacts_status",
    {
      title: "Changer le statut de contacts",
      description:
        "Force le statut d'une sélection de contacts. Statuts : held, pending, in_progress, replied, opted_out, bounced, completed, stopped, failed. 'opted_out' désinscrit aussi le contact auprès du propriétaire de la campagne (liste « ne jamais contacter », ses autres séquences chez lui arrêtées) : à confirmer avec l'utilisateur. Remettre en 'pending'/'in_progress' peut déclencher des envois.",
      inputSchema: {
        campaign_id: z.number().int().describe("Campagne concernée."),
        cc_ids: ccIds,
        status: z.enum(STATUSES).describe("Nouveau statut à appliquer."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handler(({ campaign_id, cc_ids, status }: { campaign_id: number; cc_ids: number[]; status: string }) =>
      api("POST", `/api/campaigns/${campaign_id}/set-status`, { json: { ids: cc_ids, status } })
    )
  );

  server.registerTool(
    "remove_contacts",
    {
      title: "Retirer des contacts de la campagne",
      description:
        "Retire une sélection de contacts de la campagne (supprime l'inscription). Le contact global est conservé (réutilisable ailleurs). Irréversible pour cette campagne — à confirmer avec l'utilisateur.",
      inputSchema: { campaign_id: z.number().int().describe("Campagne concernée."), cc_ids: ccIds },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handler(({ campaign_id, cc_ids }: { campaign_id: number; cc_ids: number[] }) =>
      api("POST", `/api/campaigns/${campaign_id}/remove-contacts`, { json: { ids: cc_ids } })
    )
  );

  server.registerTool(
    "update_contact",
    {
      title: "Modifier un contact",
      description:
        "Met à jour un contact GLOBAL (clé = contact_id, le champ « contact_id » de list_campaign_contacts ou search_contacts, pas cc_id). Les champs personnalisés (extra) sont fusionnés : une valeur vide supprime le champ. Les changements valent pour toutes les campagnes où figure ce contact.",
      inputSchema: {
        contact_id: z.number().int().describe("Identifiant du contact global (champ contact_id)."),
        first_name: z.string().optional(),
        last_name: z.string().optional(),
        company: z.string().optional(),
        linkedin: z.string().optional().describe("URL du profil LinkedIn (une valeur vide ne l'efface pas)."),
        extra: z.record(z.string()).optional().describe("Champs personnalisés à fusionner (clé→valeur ; valeur vide = suppression)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler(({ contact_id, ...body }: { contact_id: number } & Record<string, unknown>) =>
      api("PATCH", `/api/contacts/${contact_id}`, { json: body })
    )
  );
}
