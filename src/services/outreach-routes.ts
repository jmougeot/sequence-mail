/**
 * API du canal LinkedIn des séquences.
 *
 * Côté exécutant (extension Chrome ou navigateur serveur) : chaque compte
 * s'identifie par son jeton dans l'en-tête X-LI-Account, demande la prochaine
 * action autorisée (/next) et rend son verdict (/result) ; la cadence/anti-ban
 * vit dans outreach.ts. Sans jeton, c'est le compte le plus ancien (extension
 * installée avant le multi-comptes).
 *
 * Côté tableau de bord : /status (tous comptes) et /accounts (création, jeton,
 * quotas, activation).
 */
import type express from "express";
import {
  accountStatus,
  createAccount,
  deleteAccount,
  getAccount,
  nextAction,
  outreachStatus,
  recordResult,
  resolveAccount,
  rotateToken,
  setEnabled,
  updateAccount,
  type LiAccount,
} from "./outreach.js";

const ACCOUNT_HEADER = "x-li-account";

/** Compte de l'exécutant appelant ; répond lui-même 401/409 si introuvable. */
function callerAccount(req: express.Request, res: express.Response): LiAccount | undefined {
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
  return account;
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

  // --- Exécutant ---

  app.get("/api/li/next", (req, res) => {
    const account = callerAccount(req, res);
    if (account) res.json(nextAction(account));
  });

  app.post("/api/li/result", (req, res) => {
    const account = callerAccount(req, res);
    if (!account) return;
    const b = req.body as Record<string, unknown>;
    const id = Number(b.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "id manquant" });
    const ok = recordResult(account, id, Boolean(b.ok), typeof b.error === "string" ? b.error : undefined, Boolean(b.retry));
    if (!ok) return res.status(404).json({ error: "Action inconnue pour ce compte" });
    res.json({ ok: true });
  });

  // Avec jeton : état de CE compte (popup). Sans jeton : état global (tableau de bord).
  app.get("/api/li/status", (req, res) => {
    if (!req.get(ACCOUNT_HEADER)) return res.json(outreachStatus());
    const account = callerAccount(req, res);
    if (account) res.json(accountStatus(account));
  });

  // Avec jeton : (dés)active ce compte. Sans jeton : interrupteur général.
  app.post("/api/li/toggle", (req, res) => {
    const enabled = Boolean((req.body as Record<string, unknown>).enabled);
    if (!req.get(ACCOUNT_HEADER)) {
      setEnabled(enabled);
      return res.json(outreachStatus());
    }
    const account = callerAccount(req, res);
    if (account) res.json(accountStatus(updateAccount(account.id, { active: enabled })!));
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
    const patch: Parameters<typeof updateAccount>[1] = {};
    if (typeof b.name === "string") patch.name = b.name;
    if (b.active !== undefined) patch.active = Boolean(b.active);
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
