/**
 * API du canal LinkedIn des séquences.
 *
 * Côté exécutant : chaque compte demande la prochaine action autorisée (/next),
 * rend son verdict (/result) et remet la messagerie lue (/inbox) ; la
 * cadence/anti-ban vit dans outreach.ts. Deux façons de s'identifier :
 *   - extension Chrome : jeton du compte dans l'en-tête X-LI-Account (sans
 *     jeton : le compte le plus ancien, extension d'avant le multi-comptes) ;
 *   - runner (navigateurs serveur) : secret partagé X-LI-Runner + X-LI-Account-Id.
 *
 * Côté tableau de bord : /status (tous comptes) et /accounts (création, jeton,
 * mode, proxy, quotas, activation).
 */
import type express from "express";
import { processInbox, type LiConversation } from "./li-inbox.js";
import {
  accountStatus,
  createAccount,
  deleteAccount,
  getAccount,
  isRunner,
  nextAction,
  outreachStatus,
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

/** Compte de l'exécutant appelant et son type ; répond lui-même 401/409 si introuvable. */
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
  const token = req.get(ACCOUNT_HEADER)?.trim() || undefined;
  const account = resolveAccount(token);
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

function nullableInt(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function registerOutreachRoutes(app: express.Express): void {
  // CORS minimal : l'extension (origine chrome-extension://…) appelle ce serveur.
  app.use("/api/li", (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", `content-type, authorization, ${ACCOUNT_HEADER}`);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // --- Exécutant (extension ou runner) ---

  app.get("/api/li/next", (req, res) => {
    const c = caller(req, res);
    if (c) res.json(nextAction(c.account, c.via));
  });

  app.post("/api/li/result", (req, res) => {
    const c = caller(req, res);
    if (!c) return;
    const b = req.body as Record<string, unknown>;
    const id = Number(b.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "id manquant" });
    const ok = recordResult(c.account, id, Boolean(b.ok), typeof b.error === "string" ? b.error : undefined, Boolean(b.retry));
    if (!ok) return res.status(404).json({ error: "Action inconnue pour ce compte" });
    res.json({ ok: true });
  });

  // Messagerie lue (action sync_inbox) : { ok, conversations?: [...], error? }
  app.post("/api/li/inbox", (req, res) => {
    const c = caller(req, res);
    if (!c) return;
    const b = req.body as { ok?: boolean; conversations?: LiConversation[]; error?: string };
    if (!b.ok || !Array.isArray(b.conversations)) {
      // Lecture ratée : pas de pause (ce n'est pas un envoi), sauf contrôle de sécurité.
      if (/contrôle de sécurité|checkpoint|captcha/i.test(b.error ?? "")) pauseForCheckpoint(c.account, b.error!);
      console.warn(`[linkedin] lecture de la messagerie impossible (${c.account.name}) : ${b.error ?? "?"}`);
      return res.json({ ok: true, processed: false });
    }
    res.json({ ok: true, ...processInbox(c.account, b.conversations.slice(0, 200)) });
  });

  // L'extension transmet la session LinkedIn de son navigateur : le compte passe
  // en mode serveur (le runner prend le relais, l'extension cesse d'agir).
  app.post("/api/li/session", (req, res) => {
    const c = caller(req, res);
    if (!c) return;
    if (c.via !== "extension") return res.status(403).json({ error: "Réservé à l'extension" });
    const b = req.body as { cookies?: unknown; user_agent?: unknown };
    const r = storeSession(c.account.id, b.cookies, b.user_agent);
    if ("error" in r) return res.status(400).json(r);
    res.json({ ok: true, account: accountStatus(getAccount(c.account.id)!) });
  });

  // Avec jeton : état de CE compte (popup). Sans jeton : état global (tableau de bord).
  app.get("/api/li/status", (req, res) => {
    if (!req.get(ACCOUNT_HEADER) && !req.get(RUNNER_HEADER)) return res.json(outreachStatus());
    const c = caller(req, res);
    if (c) res.json(accountStatus(c.account));
  });

  // Avec jeton : (dés)active ce compte. Sans jeton : interrupteur général.
  app.post("/api/li/toggle", (req, res) => {
    const enabled = Boolean((req.body as Record<string, unknown>).enabled);
    if (!req.get(ACCOUNT_HEADER)) {
      setEnabled(enabled);
      return res.json(outreachStatus());
    }
    const c = caller(req, res);
    if (c) res.json(accountStatus(updateAccount(c.account.id, { active: enabled })!));
  });

  // --- Runner (réseau interne, secret partagé) ---

  app.get("/api/li/runner/accounts", (req, res) => {
    if (!isRunner(req.get(RUNNER_HEADER))) return res.status(401).json({ error: "Secret runner invalide" });
    res.json({ window: runnerWindow(), accounts: runnerAccounts() });
  });

  // Le runner signale l'état de la session : expired (déconnecté), checkpoint, ok.
  app.post("/api/li/runner/session-state", (req, res) => {
    const c = caller(req, res);
    if (!c) return;
    if (c.via !== "server") return res.status(403).json({ error: "Réservé au runner" });
    const b = req.body as { state?: string; error?: string };
    if (b.state !== "ok" && b.state !== "expired" && b.state !== "checkpoint") {
      return res.status(400).json({ error: "state attendu : ok | expired | checkpoint" });
    }
    setSessionState(c.account.id, b.state, typeof b.error === "string" ? b.error.slice(0, 500) : undefined);
    console.warn(`[linkedin] session ${b.state} pour « ${c.account.name} »${b.error ? ` : ${b.error}` : ""}`);
    res.json({ ok: true });
  });

  // --- Tableau de bord : comptes ---

  app.get("/api/li/accounts", (_req, res) => res.json(outreachStatus().accounts));

  // Le jeton en clair n'est rendu qu'à la création (et à la régénération).
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
    if (b.restart_warmup) patch.restart_warmup = true;
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
