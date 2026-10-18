/**
 * LinkedIn channel API for sequences.
 * Executor side: each account asks for its next allowed action (/next), reports the outcome
 * (/result) and uploads the inbox it read (/inbox); pacing/anti-ban lives in outreach.ts. Two ways
 * to authenticate:
 * - Chrome extension: account token in the X-LI-Account header (no token: the oldest account, for
 *   pre-multi-account extensions);
 * - runner (server browsers): shared secret X-LI-Runner + X-LI-Account-Id.
 * Dashboard side: /status (all accounts) and /accounts (creation, token, mode, proxy, quotas,
 * activation).
 * Every outcome and inbox read carries the LinkedIn profile read in the page (`member`): that is
 * how the server ensures the action came from the right account (see outreach.ts, recordResult).
 */
import type express from "express";
import { processInbox, processThreadReply, type LiConversation } from "./li-inbox.js";
import {
  accountStatus,
  checkInboxMember,
  createAccount,
  deleteAccount,
  getAccount,
  isRunner,
  nextForAccounts,
  outreachStatus,
  parseMember,
  pauseForCheckpoint,
  recordResult,
  resolveAccount,
  rotateToken,
  runnerAccounts,
  runnerWindow,
  setEnabled,
  setProxy,
  setSessionState,
  storeSession,
  updateAccount,
  type LiAccount,
  type LiMode,
} from "./outreach.js";

const ACCOUNT_HEADER = "x-li-account";
const RUNNER_HEADER = "x-li-runner";
const RUNNER_ACCOUNT_HEADER = "x-li-account-id";

/** The calling executor's account and type; replies 401/409 itself if not found. */
function caller(req: express.Request, res: express.Response): { account: LiAccount; via: LiMode } | undefined {
  const runnerSecret = req.get(RUNNER_HEADER);
  if (runnerSecret) {
    if (!isRunner(runnerSecret)) {
      res.status(401).json({ error: "Secret runner invalide" });
      return undefined;
    }
    const account = getAccount(Number(req.get(RUNNER_ACCOUNT_HEADER)));
    if (!account) {
      res.status(404).json({ error: "Compte inconnu" });
      return undefined;
    }
    return { account, via: "server" };
  }
  const raw = req.get(ACCOUNT_HEADER);
  const token = raw?.trim() || undefined;
  // Header present but empty: never the default account (without a token, only a call behind the
  // access password gets it).
  const account = raw !== undefined && !token ? "invalid" : resolveAccount(token);
  if (account === "invalid") {
    res.status(401).json({ error: "Jeton de compte LinkedIn inconnu — recopiez-le depuis Réglages." });
    return undefined;
  }
  if (!account) {
    res.status(409).json({ error: "Aucun compte LinkedIn configuré — créez-en un dans Réglages." });
    return undefined;
  }
  return { account, via: "extension" };
}

/**
 * Accounts served by an extension: its X-LI-Account header may carry several comma-separated tokens
 * (Sequence Mail account + Azerit account in the same browser). The runner serves only one.
 */
function callers(req: express.Request, res: express.Response): { accounts: LiAccount[]; via: LiMode } | undefined {
  const raw = req.get(ACCOUNT_HEADER);
  if (req.get(RUNNER_HEADER) || raw === undefined || !raw.includes(",")) {
    const c = caller(req, res);
    return c && { accounts: [c.account], via: c.via };
  }
  const tokens = [...new Set(raw.split(",").map((t) => t.trim()).filter(Boolean))];
  const accounts = tokens.map((t) => resolveAccount(t));
  if (!tokens.length || accounts.some((a) => a === "invalid" || !a)) {
    res.status(401).json({ error: "Jeton de compte LinkedIn inconnu — recopiez-le depuis Réglages." });
    return undefined;
  }
  return { accounts: accounts as LiAccount[], via: "extension" };
}

function nullableInt(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function registerOutreachRoutes(app: express.Express): void {
  // Minimal CORS: the extension (chrome-extension://… origin) calls this server.
  app.use("/api/li", (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", `content-type, authorization, ${ACCOUNT_HEADER}`);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // --- Executor (extension or runner) ---

  // Several accounts: the server picks which one acts; `account` (token index in the header) says
  // which token to report the outcome with.
  app.get("/api/li/next", (req, res) => {
    const c = callers(req, res);
    if (c) res.json(nextForAccounts(c.accounts, c.via));
  });

  app.post("/api/li/result", (req, res) => {
    const c = caller(req, res);
    if (!c) return;
    const b = req.body as Record<string, unknown>;
    const id = Number(b.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "id manquant" });
    // The contact wrote in the conversation: the executor sent nothing.
    if (b.replied && !b.ok && !b.wrong_account) {
      const text = typeof b.reply_text === "string" ? b.reply_text.slice(0, 2000) : "";
      if (!processThreadReply(c.account, id, text)) return res.status(404).json({ error: "Action inconnue pour ce compte" });
      return res.json({ ok: true, replied: true });
    }
    const ok = recordResult(c.account, id, {
      ok: Boolean(b.ok),
      error: typeof b.error === "string" ? b.error.slice(0, 500) : undefined,
      retry: Boolean(b.retry),
      member: parseMember(b.member),
      wrong_account: Boolean(b.wrong_account),
      identity_unknown: Boolean(b.identity_unknown),
    });
    if (!ok) return res.status(404).json({ error: "Action inconnue pour ce compte" });
    res.json({ ok: true });
  });

  // Inbox read (sync_inbox action): { ok, conversations?: [...], error?, member?, wrong_account? }
  app.post("/api/li/inbox", (req, res) => {
    const c = caller(req, res);
    if (!c) return;
    const b = req.body as {
      ok?: boolean;
      conversations?: LiConversation[];
      error?: string;
      member?: unknown;
      wrong_account?: boolean;
    };
    if (!checkInboxMember(c.account, parseMember(b.member), Boolean(b.wrong_account))) {
      return res.json({ ok: true, processed: false, wrong_account: true });
    }
    if (!b.ok || !Array.isArray(b.conversations)) {
      // Failed read: no pause (it isn't a send), unless it's a security check.
      if (/contrôle de sécurité|checkpoint|captcha/i.test(b.error ?? "")) pauseForCheckpoint(c.account, b.error!);
      console.warn(`[linkedin] cannot read the inbox (${c.account.name}): ${b.error ?? "?"}`);
      return res.json({ ok: true, processed: false });
    }
    res.json({ ok: true, ...processInbox(c.account, b.conversations.slice(0, 200)) });
  });

  // The extension hands over its browser's LinkedIn session: the account switches to server mode
  // (the runner takes over, the extension stops acting).
  app.post("/api/li/session", (req, res) => {
    const c = caller(req, res);
    if (!c) return;
    if (c.via !== "extension") return res.status(403).json({ error: "Réservé à l'extension" });
    const b = req.body as { cookies?: unknown; user_agent?: unknown; member?: unknown };
    const r = storeSession(c.account.id, b.cookies, b.user_agent, parseMember(b.member));
    if ("error" in r) return res.status(r.code === "other_member" ? 409 : 400).json(r);
    res.json({ ok: true, account: accountStatus(getAccount(c.account.id)!) });
  });

  // With a token: THIS account's status (popup). Without: global status (dashboard).
  app.get("/api/li/status", (req, res) => {
    if (!req.get(ACCOUNT_HEADER) && !req.get(RUNNER_HEADER)) return res.json(outreachStatus());
    const c = caller(req, res);
    if (c) res.json(accountStatus(c.account));
  });

  // With a token: (de)activates this account. Without: master switch.
  app.post("/api/li/toggle", (req, res) => {
    const enabled = Boolean((req.body as Record<string, unknown>).enabled);
    if (!req.get(ACCOUNT_HEADER)) {
      setEnabled(enabled);
      return res.json(outreachStatus());
    }
    const c = caller(req, res);
    if (c) res.json(accountStatus(updateAccount(c.account.id, { active: enabled })!));
  });

  // --- Runner (internal network, shared secret) ---

  app.get("/api/li/runner/accounts", (req, res) => {
    if (!isRunner(req.get(RUNNER_HEADER))) return res.status(401).json({ error: "Secret runner invalide" });
    res.json({ window: runnerWindow(), accounts: runnerAccounts() });
  });

  // The runner reports the session state: expired (logged out), checkpoint, ok.
  app.post("/api/li/runner/session-state", (req, res) => {
    const c = caller(req, res);
    if (!c) return;
    if (c.via !== "server") return res.status(403).json({ error: "Réservé au runner" });
    const b = req.body as { state?: string; error?: string };
    if (b.state !== "ok" && b.state !== "expired" && b.state !== "checkpoint" && b.state !== "wrong_account") {
      return res.status(400).json({ error: "state attendu : ok | expired | checkpoint | wrong_account" });
    }
    setSessionState(c.account.id, b.state, typeof b.error === "string" ? b.error.slice(0, 500) : undefined);
    console.warn(`[linkedin] session ${b.state} for "${c.account.name}"${b.error ? `: ${b.error}` : ""}`);
    res.json({ ok: true });
  });

  // --- Dashboard: accounts ---

  app.get("/api/li/accounts", (_req, res) => res.json(outreachStatus().accounts));

  // The plaintext token is only returned on creation (and regeneration).
  app.post("/api/li/accounts", (req, res) => {
    const name = String((req.body as Record<string, unknown>).name ?? "").trim();
    if (!name) return res.status(400).json({ error: "Nom du compte requis" });
    const { account, token } = createAccount(name);
    res.json({ ...accountStatus(account), token });
  });

  app.patch("/api/li/accounts/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!getAccount(id)) return res.status(404).json({ error: "Compte introuvable" });
    const b = req.body as Record<string, unknown>;
    if ("proxy" in b) {
      const r = setProxy(id, typeof b.proxy === "string" ? b.proxy : null);
      if ("error" in r) return res.status(400).json(r);
    }
    const patch: Parameters<typeof updateAccount>[1] = {};
    if (typeof b.name === "string") patch.name = b.name;
    if (b.active !== undefined) patch.active = Boolean(b.active);
    if (b.mode === "extension" || b.mode === "server") patch.mode = b.mode;
    if ("invites_per_day" in b) patch.invites_per_day = nullableInt(b.invites_per_day);
    if ("messages_per_day" in b) patch.messages_per_day = nullableInt(b.messages_per_day);
    res.json(accountStatus(updateAccount(id, patch)!));
  });

  app.post("/api/li/accounts/:id/token", (req, res) => {
    const token = rotateToken(Number(req.params.id));
    if (!token) return res.status(404).json({ error: "Compte introuvable" });
    res.json({ token });
  });

  app.delete("/api/li/accounts/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!getAccount(id)) return res.status(404).json({ error: "Compte introuvable" });
    const r = deleteAccount(id);
    if ("error" in r) return res.status(409).json(r);
    res.json(r);
  });
}
