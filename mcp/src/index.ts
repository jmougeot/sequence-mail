#!/usr/bin/env node
/**
 * Serveur MCP pour Sequence Mail.
 *
 * Expose les campagnes, contacts, réponses et comptes d'envoi (Google et
 * LinkedIn), en lecture ET écriture, comme des « tools » MCP consommables par
 * Claude Desktop, Claude Code ou tout autre client MCP : de quoi tout piloter
 * sans l'interface web. Les tools sont rangés par domaine dans tools/*.ts ; les
 * fonctions pures (CSV, filtres, dates) dans lib.ts.
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
 * campagnes, changement de statuts, import) et des envois (réponse à un contact,
 * email de test — en dry_run par défaut). L'app ne déclenche pas d'envoi à la
 * création — un contact n'est envoyé qu'une fois en statut « pending » (via
 * launch_contacts), dans la fenêtre d'envoi et selon les quotas/warm-up.
 */
import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { BASE_URL } from "./api.js";
import { INSTRUCTIONS } from "./instructions.js";
import { registerAccountTools } from "./tools/accounts.js";
import { registerCampaignTools } from "./tools/campaigns.js";
import { registerContactTools } from "./tools/contacts.js";
import { registerInboxTools } from "./tools/inbox.js";
import { registerLinkedinTools } from "./tools/linkedin.js";

/**
 * Construit un serveur MCP avec tous les tools enregistrés. Appelé une fois en
 * mode stdio, et une fois par session en mode HTTP (chaque session a son serveur).
 * Les `instructions` (flux, identifiants, règles de sécurité) sont transmises au
 * client à l'initialisation.
 */
function buildServer(): McpServer {
  const server = new McpServer({ name: "sequence-mail", version: "0.3.0" }, { instructions: INSTRUCTIONS });
  registerCampaignTools(server); // campagnes, activité, aperçu, email de test
  registerContactTools(server); // contacts : liste, recherche, export, imports, lancement, statuts
  registerInboxTools(server); // réponses : boîte de réception, conversation, réponse
  registerAccountTools(server); // comptes Google, paramètres
  registerLinkedinTools(server); // canal et comptes LinkedIn
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
