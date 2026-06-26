/**
 * Lien personnalisé par prospect ({{link}}) et suivi des visites côté serveur.
 *
 * Chaque campaign_contact reçoit un jeton stable (campaign_contacts.visit_token).
 * Le lien `…/p/<token>` placé dans l'email via {{link}} journalise la visite puis
 * redirige (302) vers la page publique (VISIT_DEST_URL). Fiable car la visite est
 * enregistrée serveur, sans pixel ni image cachée.
 */
import crypto from "node:crypto";
import type { Express } from "express";
import { config } from "../config.js";
import { db } from "../db.js";
import { classifyVisit } from "./botFilter.js";

/**
 * Lien personnalisé et stable d'un prospect (campaign_contact) pour {{link}}.
 * Génère un jeton à la première demande puis le réutilise : un même prospect a
 * toujours le même lien dans toute la séquence, et une visite lui est attribuée.
 */
export function visitLink(ccId: number): string {
  const row = db.prepare("SELECT visit_token FROM campaign_contacts WHERE id = ?").get(ccId) as
    | { visit_token: string | null }
    | undefined;
  let token = row?.visit_token ?? null;
  if (!token) {
    token = crypto.randomBytes(12).toString("hex");
    db.prepare("UPDATE campaign_contacts SET visit_token = ? WHERE id = ?").run(token, ccId);
  }
  return `${config.visit.baseUrl}/p/${token}`;
}

/** Enregistre la route publique du lien personnalisé {{link}}. */
export function registerVisitRoutes(app: Express): void {
  // Lien personnalisé {{link}} : journalise la visite du prospect puis redirige
  // vers la page publique (VISIT_DEST_URL).
  app.get("/p/:token", (req, res) => {
    const cc = db
      .prepare("SELECT id FROM campaign_contacts WHERE visit_token = ?")
      .get(req.params.token) as { id: number } | undefined;
    if (cc) {
      try {
        const ua = req.get("user-agent") ?? null;
        const ip = req.ip ?? null;
        const now = Date.now();
        // Délai depuis le dernier email envoyé à ce contact : un clic en quelques
        // secondes trahit un scanner (Safe Links, Proofpoint…) qui ouvre le lien à la
        // livraison. Classement bot/humain à l'enregistrement → exclu des compteurs.
        const prevSend = db
          .prepare(
            "SELECT MAX(sent_at) AS t FROM messages WHERE campaign_contact_id = ? AND sent_at <= ?"
          )
          .get(cc.id, now) as { t: number | null };
        const delaySeconds = prevSend?.t != null ? Math.round((now - prevSend.t) / 1000) : null;
        const verdict = classifyVisit(ua, ip, delaySeconds);
        db.prepare(
          "INSERT INTO visits (cc_id, at, user_agent, ip, is_bot, bot_reason) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(cc.id, now, ua, ip, verdict.bot ? 1 : 0, verdict.reason || null);
      } catch (err) {
        console.error("[visit]", err instanceof Error ? err.message : err);
      }
    }
    res.redirect(302, config.visit.destUrl);
  });
}
