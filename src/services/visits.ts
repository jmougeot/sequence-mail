/**
 * Per-prospect personalized link ({{link}}) and server-side visit tracking.
 * Each campaign_contact gets a stable token (campaign_contacts.visit_token). The `…/p/<token>` link
 * placed in the email via {{link}} logs the visit, then 302-redirects to the public page
 * (VISIT_DEST_URL). Reliable since the visit is recorded server-side, with no pixel or hidden
 * image.
 */
import crypto from "node:crypto";
import type { Express } from "express";
import { config } from "../config.js";
import { db } from "../db.js";
import { classifyVisit } from "./botFilter.js";

/**
 * A prospect's (campaign_contact) stable {{link}} URL. The token is created on first request then
 * reused: a prospect keeps the same link across the whole sequence, and visits are attributed to
 * them.
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

export function registerVisitRoutes(app: Express): void {
  // {{link}}: logs the prospect's visit, then redirects to the public page (VISIT_DEST_URL).
  app.get("/p/:token", (req, res) => {
    const cc = db
      .prepare("SELECT id FROM campaign_contacts WHERE visit_token = ?")
      .get(req.params.token) as { id: number } | undefined;
    if (cc) {
      try {
        const ua = req.get("user-agent") ?? null;
        const ip = req.ip ?? null;
        const now = Date.now();
        // Delay since the last email sent to this contact: a click within seconds betrays a scanner
        // (Safe Links, Proofpoint…) opening the link on delivery. Classified bot/human when
        // recorded, so bots stay out of the counters.
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
