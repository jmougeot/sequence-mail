#!/usr/bin/env node
/**
 * Serveur MCP pour Sequence Mail.
 *
 * Expose les campagnes, contacts et comptes d'envoi (lecture ET écriture) comme
 * des « tools » MCP, consommables par Claude Desktop, Claude Code ou tout autre
 * client MCP.
 *
 * Deux transports selon l'environnement (voir main()) :
 *   - stdio (défaut) : un client MCP local lance ce process et dialogue en
 *     JSON-RPC sur stdin/stdout (ne JAMAIS écrire de logs sur stdout — uniquement
 *     stderr — sous peine de corrompre le protocole).
 *   - HTTP Streamable (si MCP_HTTP_PORT défini) : sert un client MCP distant
 *     comme l'agent Ruby hébergé, optionnellement derrière Basic Auth.
 *
 * Toutes les opérations passent par l'API HTTP (voir api.ts) : aucune écriture
 * SQLite directe, donc la validation et le scheduler de l'app restent la source
 * de vérité. Sécurité : la surface inclut des écritures (création/suppression de
 * campagnes, changement de statuts, import). L'app ne déclenche pas d'envoi à
 * la création — un contact n'est envoyé qu'une fois en statut « pending » (via
 * launch_contacts), dans la fenêtre d'envoi et selon les quotas/warm-up.
 */
import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { api, BASE_URL } from "./api.js";

// --- Helpers de réponse MCP ---------------------------------------------------
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text: text || "(vide)" }] };
}
function fail(err: unknown): ToolResult {
  return {
    content: [{ type: "text", text: `Erreur : ${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  };
}
/** Enveloppe un handler : exécute, sérialise le résultat, capture les erreurs. */
function handler<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };
}

const STATUSES = [
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

// Une étape de séquence : email (sujet + corps) ou action LinkedIn.
const stepSchema = z.object({
  subject: z.string().optional().describe("Sujet de l'email. Obligatoire pour l'étape 1 quand channel=email."),
  subject_b: z
    .string()
    .optional()
    .describe("Variante B du sujet (A/B test 50/50), étape 1 email uniquement."),
  body: z
    .string()
    .optional()
    .describe(
      "Corps du message. Variables : {{first_name}}, {{last_name}}, {{company}}, {{email}}, {{sender_name}}, {{link}}, {{signature}} + toute colonne CSV. Une relance email sans sujet part dans le même fil (Re:). Pour une invitation LinkedIn, la note est facultative."
    ),
  wait_days: z
    .number()
    .int()
    .optional()
    .describe("Jours d'attente avant cette étape. Ignoré pour l'étape 1 (toujours 0). Défaut 3."),
  channel: z.enum(["email", "linkedin"]).optional().describe("Canal de l'étape. Défaut « email »."),
  li_action: z
    .enum(["invite", "message"])
    .optional()
    .describe("Action LinkedIn quand channel=linkedin : « invite » (avec note) ou « message »."),
});

/**
 * Construit un serveur MCP avec tous les tools enregistrés. Appelé une fois en
 * mode stdio, et une fois par session en mode HTTP (chaque session a son serveur).
 */
function buildServer(): McpServer {
  const server = new McpServer({ name: "sequence-mail", version: "0.1.0" });

// =============================================================================
// LECTURE
// =============================================================================

server.registerTool(
  "list_campaigns",
  {
    title: "Lister les campagnes",
    description:
      "Liste toutes les campagnes avec leurs statistiques : statut (active/paused), nombre de contacts par état, emails envoyés, visites du lien {{link}}, taux de réponse (global et par variante A/B), progression. À utiliser pour avoir une vue d'ensemble avant toute action.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler(async () => api("GET", "/api/campaigns"))
);

server.registerTool(
  "get_campaign",
  {
    title: "Détail d'une campagne",
    description:
      "Renvoie le détail d'une campagne et la liste ordonnée de ses étapes (sujet, corps, wait_days, channel, li_action). À utiliser avant de modifier une campagne (update_campaign attend la séquence complète).",
    inputSchema: { campaign_id: z.number().int().describe("Identifiant de la campagne.") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler(({ campaign_id }: { campaign_id: number }) => api("GET", `/api/campaigns/${campaign_id}`))
);

server.registerTool(
  "list_campaign_contacts",
  {
    title: "Contacts d'une campagne",
    description:
      "Liste les contacts d'une campagne avec leur état. IMPORTANT : chaque ligne a deux identifiants — « contact_id » (le contact global, utilisé par update_contact) et « cc_id » (l'inscription à CETTE campagne, utilisée par launch_contacts, stop_contacts, set_contacts_status, remove_contacts). Inclut statut, étape courante, variante A/B, compte émetteur, prochain envoi, nombre de visites du lien.",
    inputSchema: { campaign_id: z.number().int().describe("Identifiant de la campagne.") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler(({ campaign_id }: { campaign_id: number }) => api("GET", `/api/campaigns/${campaign_id}/contacts`))
);

server.registerTool(
  "list_accounts",
  {
    title: "Lister les comptes d'envoi",
    description:
      "Liste les comptes Google connectés : email, nom d'expéditeur, signature, quota quotidien, quota effectif du jour (warm-up appliqué), envois déjà faits aujourd'hui, actif/inactif, warm-up on/off.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler(async () => api("GET", "/api/accounts"))
);

server.registerTool(
  "get_settings",
  {
    title: "Paramètres de l'app",
    description:
      "Paramètres effectifs (lecture seule, issus du .env) : réglages de délivrabilité (fenêtre d'envoi, quotas, délais, warm-up), si Google et Attio sont configurés.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler(async () => api("GET", "/api/settings"))
);

server.registerTool(
  "preview_email",
  {
    title: "Aperçu d'un email",
    description:
      "Rend un sujet et un corps avec les variables résolues, sur un vrai contact de la campagne (ou un contact d'exemple), signature du compte incluse. Sans effet de bord. Utile pour vérifier le rendu d'un template avant de créer/modifier une campagne.",
    inputSchema: {
      subject: z.string().optional().describe("Sujet à prévisualiser."),
      body: z.string().optional().describe("Corps à prévisualiser."),
      account_id: z.number().int().optional().describe("Compte d'envoi pour la signature (défaut : premier actif)."),
      campaign_id: z.number().int().optional().describe("Campagne dont on prend le 1er contact comme exemple."),
      contact_id: z.number().int().optional().describe("Contact global précis à utiliser comme exemple."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler((args: Record<string, unknown>) => api("POST", "/api/preview", { json: args }))
);

server.registerTool(
  "linkedin_status",
  {
    title: "État du canal LinkedIn",
    description:
      "État de l'automatisation LinkedIn (pilotée par l'extension Chrome) : activée ou non, compteurs du jour, prochaine action en file.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler(async () => api("GET", "/api/li/status"))
);

// =============================================================================
// ÉCRITURE — campagnes
// =============================================================================

server.registerTool(
  "create_campaign",
  {
    title: "Créer une campagne",
    description:
      "Crée une campagne avec sa séquence d'étapes. La campagne démarre EN PAUSE ('paused') et sans contact — aucun email n'est envoyé tant que des contacts ne sont pas importés puis lancés (launch_contacts) et la campagne reprise (resume_campaign). La 1re étape email doit avoir un sujet ; chaque étape doit avoir un corps (sauf une invitation LinkedIn dont la note est facultative).",
    inputSchema: {
      name: z.string().describe("Nom de la campagne."),
      steps: z.array(stepSchema).min(1).describe("Séquence ordonnée d'étapes (au moins une)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  handler((args: unknown) => api("POST", "/api/campaigns", { json: args }))
);

server.registerTool(
  "update_campaign",
  {
    title: "Modifier une campagne",
    description:
      "Remplace le nom et TOUTE la séquence d'une campagne (y compris en cours). Les étapes sont remplacées intégralement : récupère d'abord la séquence via get_campaign, modifie-la, puis renvoie-la entière. Les contacts gardent leur avancement ; les prochains envois utilisent le nouveau contenu.",
    inputSchema: {
      campaign_id: z.number().int().describe("Identifiant de la campagne."),
      name: z.string().describe("Nom (potentiellement inchangé)."),
      steps: z.array(stepSchema).min(1).describe("Séquence complète qui remplace l'existante."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  handler(({ campaign_id, name, steps }: { campaign_id: number; name: string; steps: unknown }) =>
    api("PUT", `/api/campaigns/${campaign_id}`, { json: { name, steps } })
  )
);

server.registerTool(
  "delete_campaign",
  {
    title: "Supprimer une campagne",
    description:
      "Supprime DÉFINITIVEMENT une campagne, ses étapes, les inscriptions de contacts et l'historique d'envois associé (cascade). Les contacts globaux sont conservés. Irréversible — à confirmer avec l'utilisateur avant d'appeler.",
    inputSchema: { campaign_id: z.number().int().describe("Identifiant de la campagne à supprimer.") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  handler(({ campaign_id }: { campaign_id: number }) => api("DELETE", `/api/campaigns/${campaign_id}`))
);

server.registerTool(
  "pause_campaign",
  {
    title: "Mettre en pause une campagne",
    description: "Passe la campagne en statut 'paused' : aucun nouvel envoi tant qu'elle n'est pas reprise.",
    inputSchema: { campaign_id: z.number().int().describe("Identifiant de la campagne.") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  handler(({ campaign_id }: { campaign_id: number }) => api("POST", `/api/campaigns/${campaign_id}/pause`))
);

server.registerTool(
  "resume_campaign",
  {
    title: "Reprendre une campagne",
    description:
      "Passe la campagne en statut 'active' : les envois reprennent pour les contacts en 'pending'/'in_progress', dans la fenêtre d'envoi et selon les quotas.",
    inputSchema: { campaign_id: z.number().int().describe("Identifiant de la campagne.") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  handler(({ campaign_id }: { campaign_id: number }) => api("POST", `/api/campaigns/${campaign_id}/resume`))
);

server.registerTool(
  "import_contacts_csv",
  {
    title: "Importer des contacts (CSV)",
    description:
      "Importe des contacts dans une campagne depuis un CSV brut. Colonne 'email' OBLIGATOIRE ; colonnes reconnues : first_name, last_name, company, linkedin ; toute autre colonne devient une variable de template. Les doublons (email déjà inscrit) sont ignorés ; les adresses sans serveur mail (MX) sont rejetées. Les contacts importés arrivent en statut 'held' (non lancés) — utilise ensuite launch_contacts pour les activer.",
    inputSchema: {
      campaign_id: z.number().int().describe("Campagne cible."),
      csv: z.string().describe("Contenu CSV brut (avec ligne d'en-tête contenant 'email')."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  handler(({ campaign_id, csv }: { campaign_id: number; csv: string }) =>
    api("POST", `/api/campaigns/${campaign_id}/import`, { csv })
  )
);

server.registerTool(
  "attio_sync",
  {
    title: "Importer depuis Attio",
    description:
      "Importe dans une campagne les personnes Attio dont un attribut de statut correspond aux valeurs choisies. Nécessite ATTIO_API_KEY configurée côté app.",
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
  handler(({ campaign_id, status_attribute, statuses }: { campaign_id: number; status_attribute?: string; statuses: string[] }) =>
    api("POST", `/api/campaigns/${campaign_id}/attio-sync`, { json: { status_attribute, statuses } })
  )
);

// =============================================================================
// ÉCRITURE — contacts d'une campagne (clé = cc_id, voir list_campaign_contacts)
// =============================================================================

const ccIds = z
  .array(z.number().int())
  .min(1)
  .describe("Identifiants « cc_id » (inscription campagne) issus de list_campaign_contacts — PAS les contact_id globaux.");

server.registerTool(
  "launch_contacts",
  {
    title: "Lancer des contacts",
    description:
      "Active une sélection de contacts en attente ('held') → 'pending' : ils entreront dans la file d'envoi. Repasse aussi la campagne en 'active'. C'est l'étape qui déclenche réellement l'entrée en séquence après un import.",
    inputSchema: { campaign_id: z.number().int().describe("Campagne concernée."), cc_ids: ccIds },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  handler(({ campaign_id, cc_ids }: { campaign_id: number; cc_ids: number[] }) =>
    api("POST", `/api/campaigns/${campaign_id}/launch-contacts`, { json: { ids: cc_ids } })
  )
);

server.registerTool(
  "stop_contacts",
  {
    title: "Arrêter des contacts",
    description:
      "Arrête manuellement la séquence d'une sélection (statut → 'stopped', envoi planifié annulé). Agit sur les contacts en 'held', 'pending' ou 'in_progress'.",
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
      "Force le statut d'une sélection de contacts. Statuts : held, pending, in_progress, replied, opted_out, bounced, completed, stopped, failed. 'opted_out' ajoute aussi le contact à la liste « ne jamais contacter » (global).",
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
      "Retire une sélection de contacts de la campagne (supprime l'inscription). Le contact global est conservé (réutilisable ailleurs). Irréversible pour cette campagne.",
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
      "Met à jour un contact GLOBAL (clé = contact_id, le champ « contact_id » de list_campaign_contacts, pas cc_id). Les champs personnalisés (extra) sont fusionnés : une valeur vide supprime le champ. Les changements valent pour toutes les campagnes où figure ce contact.",
    inputSchema: {
      contact_id: z.number().int().describe("Identifiant du contact global (champ contact_id)."),
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      company: z.string().optional(),
      linkedin: z.string().optional().describe("URL LinkedIn (vide pour effacer)."),
      extra: z.record(z.string()).optional().describe("Champs personnalisés à fusionner (clé→valeur ; valeur vide = suppression)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  handler(({ contact_id, ...body }: { contact_id: number } & Record<string, unknown>) =>
    api("PATCH", `/api/contacts/${contact_id}`, { json: body })
  )
);

// =============================================================================
// ÉCRITURE — comptes & LinkedIn
// =============================================================================

server.registerTool(
  "update_account",
  {
    title: "Modifier un compte d'envoi",
    description:
      "Met à jour un compte Google connecté : quota quotidien, actif/inactif, nom d'expéditeur, signature, warm-up on/off. Seuls les champs fournis sont modifiés.",
    inputSchema: {
      account_id: z.number().int().describe("Identifiant du compte (list_accounts)."),
      daily_limit: z.number().int().optional().describe("Quota d'envoi quotidien."),
      active: z.boolean().optional().describe("Activer/désactiver le compte pour les envois."),
      from_name: z.string().optional().describe("Nom affiché dans le champ « De »."),
      signature: z.string().optional().describe("Signature (insérée via {{signature}})."),
      warmup: z.boolean().optional().describe("Activer la montée en charge progressive."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  handler(({ account_id, ...body }: { account_id: number } & Record<string, unknown>) =>
    api("PATCH", `/api/accounts/${account_id}`, { json: body })
  )
);

server.registerTool(
  "linkedin_toggle",
  {
    title: "Activer/désactiver le canal LinkedIn",
    description:
      "Active ou met en pause l'automatisation LinkedIn (invitations/messages via l'extension Chrome). Renvoie le nouvel état.",
    inputSchema: { enabled: z.boolean().describe("true pour activer, false pour mettre en pause.") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  handler(({ enabled }: { enabled: boolean }) => api("POST", "/api/li/toggle", { json: { enabled } }))
);

  return server;
}

// --- Démarrage ----------------------------------------------------------------

/** Vérifie l'en-tête Authorization Basic si MCP_HTTP_BASIC_AUTH ("user:pass") est configuré. */
function httpAuthOk(req: IncomingMessage): boolean {
  const expected = process.env.MCP_HTTP_BASIC_AUTH;
  if (!expected || !expected.includes(":")) return true; // endpoint non protégé
  const expectedHeader = "Basic " + Buffer.from(expected).toString("base64");
  return (req.headers.authorization ?? "") === expectedHeader;
}

/** Lit et parse le corps JSON d'une requête (corps vide → undefined). */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

/**
 * Transport HTTP Streamable en mode « stateful » : le client (agent Ruby) ouvre
 * une session à l'initialize, réutilisée via l'en-tête `mcp-session-id`. Chaque
 * session a son propre McpServer. Endpoint MCP sur `/mcp`, santé sur `/health`.
 */
async function startHttp(port: number): Promise<void> {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(async (req, res) => {
    try {
      const path = (req.url ?? "").split("?")[0].replace(/\/+$/, "");

      // Santé — non authentifié, pour healthchecks Docker/Caddy.
      if (req.method === "GET" && (path === "/health" || path === "/healthz")) {
        res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
        return;
      }
      if (path !== "" && path !== "/mcp") {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
        return;
      }
      if (!httpAuthOk(req)) {
        res
          .writeHead(401, { "Content-Type": "text/plain", "WWW-Authenticate": 'Basic realm="sequence-mail-mcp"' })
          .end("unauthorized");
        return;
      }

      const body = req.method === "POST" ? await readJsonBody(req) : undefined;
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      let transport: StreamableHTTPServerTransport | undefined;
      if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId);
      } else if (!sessionId && isInitializeRequest(body)) {
        // Nouvelle session : serveur + transport neufs, indexés à l'initialisation.
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          // Réponses JSON directes (pas de flux SSE) : plus robuste derrière un
          // proxy (Caddy/Cloudflare) qui peut bufferiser un stream.
          enableJsonResponse: true,
          onsessioninitialized: (sid) => { transports.set(sid, transport!); },
          onsessionclosed: (sid) => { transports.delete(sid); },
        });
        transport.onclose = () => { if (transport!.sessionId) transports.delete(transport!.sessionId); };
        await buildServer().connect(transport);
      } else {
        res.writeHead(400, { "Content-Type": "application/json" }).end(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: no valid session" }, id: null })
        );
        return;
      }

      await transport!.handleRequest(req, res, body);
    } catch (err) {
      console.error("Erreur requête MCP HTTP :", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null })
        );
      }
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  const authState = process.env.MCP_HTTP_BASIC_AUTH?.includes(":") ? "Basic Auth" : "SANS auth";
  console.error(`Sequence Mail MCP prêt (HTTP :${port}/mcp, ${authState}) — cible ${BASE_URL}`);
}

async function main(): Promise<void> {
  const portRaw = process.env.MCP_HTTP_PORT;
  if (portRaw) {
    const port = Number(portRaw);
    if (!Number.isInteger(port) || port <= 0) throw new Error(`MCP_HTTP_PORT invalide : ${portRaw}`);
    await startHttp(port);
  } else {
    const transport = new StdioServerTransport();
    await buildServer().connect(transport);
    // stderr uniquement (stdout est réservé au protocole JSON-RPC)
    console.error(`Sequence Mail MCP prêt (stdio) — cible ${BASE_URL}`);
  }
}

main().catch((err) => {
  console.error("Échec du démarrage du serveur MCP :", err);
  process.exit(1);
});
