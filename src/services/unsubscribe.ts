/**
 * Désinscription en un clic (en-tête List-Unsubscribe / RFC 8058).
 *
 * Chaque email porte un lien `…/u/<token>` propre au prospect. Gmail/Yahoo
 * appellent ce lien (POST, sans interaction) quand le destinataire utilise leur
 * bouton « Se désabonner » ; un clic humain (GET) aboutit au même résultat. Le
 * contact est alors désinscrit auprès du propriétaire de la campagne et ses
 * séquences chez lui sont stoppées (cf. opt-out.ts).
 */
import crypto from "node:crypto";
import type { Express } from "express";
import { config } from "../config.js";
import { db } from "../db.js";
import { optOutFromCampaignOf } from "./opt-out.js";

/** Lien de désinscription stable d'un prospect (pour l'en-tête List-Unsubscribe). */
export function unsubLink(ccId: number): string {
  const row = db.prepare("SELECT unsub_token FROM campaign_contacts WHERE id = ?").get(ccId) as
    | { unsub_token: string | null }
    | undefined;
  let token = row?.unsub_token ?? null;
  if (!token) {
    token = crypto.randomBytes(12).toString("hex");
    db.prepare("UPDATE campaign_contacts SET unsub_token = ? WHERE id = ?").run(token, ccId);
  }
  return `${config.baseUrl}/u/${token}`;
}

/** Désinscrit le contact (chez le propriétaire de la campagne) et stoppe ses séquences. */
function optOut(token: string): boolean {
  const cc = db.prepare("SELECT id FROM campaign_contacts WHERE unsub_token = ?").get(token) as { id: number } | undefined;
  if (!cc) return false;
  db.transaction(() => {
    db.prepare("UPDATE campaign_contacts SET status = 'opted_out', next_send_at = NULL WHERE id = ?").run(cc.id);
    optOutFromCampaignOf(cc.id, "lien de désinscription");
  })();
  return true;
}

export function registerUnsubscribeRoutes(app: Express): void {
  // One-click (RFC 8058) : Gmail/Yahoo POSTent ici sans interaction humaine.
  app.post("/u/:token", (req, res) => {
    optOut(req.params.token);
    res.status(200).send("OK");
  });

  // Clic humain depuis le client mail : confirme visuellement la désinscription.
  app.get("/u/:token", (req, res) => {
    const ok = optOut(req.params.token);
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#222">` +
        `<h2>${ok ? "Vous êtes désinscrit" : "Lien invalide"}</h2>` +
        `<p>${
          ok
            ? "Vous ne recevrez plus d'emails de notre part."
            : "Ce lien de désinscription n'est plus valide."
        }</p></div>`
    );
  });
}
