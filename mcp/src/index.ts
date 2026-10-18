#!/usr/bin/env node
/**
 * MCP server for Sequence Mail.
 *
 * Exposes campaigns, contacts, replies and sending accounts (Google and
 * LinkedIn), read AND write, as MCP tools for Claude Desktop, Claude Code or any
 * MCP client: everything can be driven without the web UI. Tools are grouped by
 * domain in tools/*.ts; pure functions (CSV, filters, dates) live in lib.ts.
 *
 * Two transports (see main()):
 *   - stdio (default): a local MCP client spawns this process and speaks
 *     JSON-RPC over stdin/stdout (NEVER log to stdout, only stderr, or the
 *     protocol breaks).
 *   - Streamable HTTP (if MCP_HTTP_PORT is set): serves a remote MCP client such
 *     as a hosted agent, optionally behind Basic Auth.
 *
 * Everything goes through the HTTP API (see api.ts): no direct SQLite writes, so
 * the app's validation and scheduler stay the source of truth. Safety: the
 * surface includes writes (campaign create/delete, status changes, imports) and
 * sends (reply to a contact, test email; dry_run by default). Nothing is sent on
 * creation: a contact is only sent to once "pending" (via launch_contacts),
 * within the send window and quotas/warm-up.
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
 * Builds an MCP server with every tool registered. Called once in stdio mode and
 * once per session in HTTP mode. `instructions` (flows, ids, safety rules) are
 * sent to the client at initialization.
 */
function buildServer(): McpServer {
  const server = new McpServer({ name: "sequence-mail", version: "0.3.0" }, { instructions: INSTRUCTIONS });
  registerCampaignTools(server); // campaigns, activity, previews, test email
  registerContactTools(server); // contacts: list, search, export, imports, launch, statuses
  registerInboxTools(server); // replies: inbox, conversation, reply
  registerAccountTools(server); // Google accounts, settings
  registerLinkedinTools(server); // LinkedIn channel and accounts
  return server;
}

// --- Startup ------------------------------------------------------------------

/** Checks the Basic Authorization header when MCP_HTTP_BASIC_AUTH ("user:pass") is set. */
function httpAuthOk(req: IncomingMessage): boolean {
  const expected = process.env.MCP_HTTP_BASIC_AUTH;
  if (!expected || !expected.includes(":")) return true; // unprotected endpoint
  const expectedHeader = "Basic " + Buffer.from(expected).toString("base64");
  return (req.headers.authorization ?? "") === expectedHeader;
}

/** Reads and parses a request's JSON body (empty body → undefined). */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

/**
 * Stateful Streamable HTTP transport: the client opens a session on initialize,
 * reused via the `mcp-session-id` header. Each session has its own McpServer.
 * MCP endpoint at `/mcp`, health at `/health`.
 */
async function startHttp(port: number): Promise<void> {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(async (req, res) => {
    try {
      const path = (req.url ?? "").split("?")[0].replace(/\/+$/, "");

      // Health: unauthenticated, for Docker/Caddy healthchecks.
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
        // New session: fresh server + transport, indexed on initialization.
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          // Plain JSON responses (no SSE stream): more robust behind a proxy
          // (Caddy/Cloudflare) that may buffer streams.
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
      console.error("MCP HTTP request error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null })
        );
      }
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  const authState = process.env.MCP_HTTP_BASIC_AUTH?.includes(":") ? "Basic Auth" : "NO auth";
  console.error(`Sequence Mail MCP ready (HTTP :${port}/mcp, ${authState}) — target ${BASE_URL}`);
}

async function main(): Promise<void> {
  const portRaw = process.env.MCP_HTTP_PORT;
  if (portRaw) {
    const port = Number(portRaw);
    if (!Number.isInteger(port) || port <= 0) throw new Error(`Invalid MCP_HTTP_PORT: ${portRaw}`);
    await startHttp(port);
  } else {
    const transport = new StdioServerTransport();
    await buildServer().connect(transport);
    // stderr only (stdout is reserved for JSON-RPC)
    console.error(`Sequence Mail MCP ready (stdio) — target ${BASE_URL}`);
  }
}

main().catch((err) => {
  console.error("MCP server failed to start:", err);
  process.exit(1);
});
