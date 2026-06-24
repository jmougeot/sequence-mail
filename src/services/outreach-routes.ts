/**
 * API consommée par l'extension Chrome pour le canal LinkedIn des séquences.
 * L'extension demande la prochaine action autorisée (/next) et rend son verdict
 * (/result) ; la cadence/anti-ban vit dans outreach.ts. /status et /toggle
 * servent le popup et l'app.
 */
import type express from "express";
import { nextAction, outreachStatus, recordResult, setEnabled } from "./outreach.js";

export function registerOutreachRoutes(app: express.Express): void {
  // CORS minimal : l'extension (origine chrome-extension://…) appelle ce serveur local.
  app.use("/api/li", (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.get("/api/li/next", (_req, res) => res.json(nextAction()));

  app.post("/api/li/result", (req, res) => {
    const b = req.body as Record<string, unknown>;
    const id = Number(b.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "id manquant" });
    recordResult(id, Boolean(b.ok), typeof b.error === "string" ? b.error : undefined, Boolean(b.retry));
    res.json({ ok: true });
  });

  app.get("/api/li/status", (_req, res) => res.json(outreachStatus()));

  app.post("/api/li/toggle", (req, res) => {
    setEnabled(Boolean((req.body as Record<string, unknown>).enabled));
    res.json(outreachStatus());
  });
}
