/**
 * Suivi des emails : ouverture (pixel image) et clic (liens réécrits).
 *
 * Chaque email envoyé reçoit un `track_id` aléatoire (stocké sur la ligne
 * `messages`). Le HTML de l'email contient :
 *   - un pixel `…/t/open/<track_id>/pixel.gif` : son chargement = une ouverture ;
 *   - des liens réécrits `…/t/click/<track_id>/<n>` : le clic est journalisé puis
 *     redirigé vers l'URL d'origine (mémorisée dans `tracked_links`).
 *
 * Les deux URLs pointent vers BASE_URL : le suivi ne fonctionne en conditions
 * réelles que si BASE_URL est PUBLIC (pas localhost). L'ouverture reste peu fiable
 * (Apple Mail Privacy Protection / préchargement Gmail) ; le clic est le signal sûr.
 */
import crypto from "node:crypto";
import type { Express, Request } from "express";
import { config } from "../config.js";
import { db } from "../db.js";
import { bodyToHtml } from "./google.js";

/** Jeton de suivi opaque et non devinable pour un email. */
export function newTrackId(): string {
  return crypto.randomBytes(16).toString("hex");
}

/** Y a-t-il quelque chose à suivre (sinon on n'attribue pas de track_id) ? */
export function trackingActive(): boolean {
  return config.tracking.enabled && (config.tracking.opens || config.tracking.clicks);
}

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

/** Préfixe d'un lien de visite : sert à l'exclure de la réécriture de clics. */
function isVisitLink(url: string): boolean {
  return url.startsWith(`${config.visit.baseUrl}/p/`);
}

/**
 * Construit le HTML d'un email avec suivi : liens cliquables réécrits (si activé)
 * et pixel d'ouverture (si activé). Les liens d'origine sont mémorisés dans
 * `tracked_links` pour la redirection au clic.
 */
export function buildTrackedHtml(body: string, trackId: string): string {
  const insertLink = db.prepare(
    "INSERT OR IGNORE INTO tracked_links (track_id, ordinal, url) VALUES (?, ?, ?)"
  );
  let ordinal = 0;
  const onLink = config.tracking.clicks
    ? (url: string) => {
        // Le lien de visite a son propre suivi (route /p/) : ne pas le réécrire.
        if (isVisitLink(url)) return url;
        ordinal += 1;
        insertLink.run(trackId, ordinal, url);
        return `${config.baseUrl}/t/click/${trackId}/${ordinal}`;
      }
    : undefined;

  let html = bodyToHtml(body, onLink);
  if (config.tracking.opens) {
    html +=
      `<img src="${config.baseUrl}/t/open/${trackId}/pixel.gif" alt="" width="1" height="1" ` +
      `style="display:none;max-height:0;max-width:0;opacity:0;overflow:hidden">`;
  }
  return html;
}

// GIF transparent 1×1 (43 octets) servi pour chaque ouverture.
const PIXEL_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
  "base64"
);

function recordEvent(trackId: string, type: "open" | "click", ordinal: number | null, req: Request): void {
  db.prepare(
    "INSERT INTO email_events (track_id, type, ordinal, at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(trackId, type, ordinal, Date.now(), req.get("user-agent") ?? null, req.ip ?? null);
}

/** Enregistre les routes publiques de suivi (pixel d'ouverture + redirection de clic). */
export function registerTrackingRoutes(app: Express): void {
  // Pixel d'ouverture : journalise puis renvoie un GIF transparent, jamais mis en cache.
  app.get("/t/open/:trackId/pixel.gif", (req, res) => {
    try {
      recordEvent(req.params.trackId, "open", null, req);
    } catch (err) {
      console.error("[tracking] open:", err instanceof Error ? err.message : err);
    }
    res.set("Content-Type", "image/gif");
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.set("Pragma", "no-cache");
    res.send(PIXEL_GIF);
  });

  // Clic : journalise puis redirige (302) vers l'URL d'origine.
  app.get("/t/click/:trackId/:ordinal", (req, res) => {
    const ordinal = Number(req.params.ordinal);
    const link = db
      .prepare("SELECT url FROM tracked_links WHERE track_id = ? AND ordinal = ?")
      .get(req.params.trackId, ordinal) as { url: string } | undefined;
    try {
      recordEvent(req.params.trackId, "click", Number.isFinite(ordinal) ? ordinal : null, req);
    } catch (err) {
      console.error("[tracking] click:", err instanceof Error ? err.message : err);
    }
    // Lien inconnu (jeton trafiqué) : on retombe sur l'accueil plutôt qu'une 404.
    res.redirect(302, link?.url ?? config.baseUrl);
  });

  // Lien personnalisé {{link}} : journalise la visite du prospect puis redirige
  // vers la page publique (VISIT_DEST_URL).
  app.get("/p/:token", (req, res) => {
    const cc = db
      .prepare("SELECT id FROM campaign_contacts WHERE visit_token = ?")
      .get(req.params.token) as { id: number } | undefined;
    if (cc) {
      try {
        db.prepare("INSERT INTO visits (cc_id, at, user_agent, ip) VALUES (?, ?, ?, ?)").run(
          cc.id,
          Date.now(),
          req.get("user-agent") ?? null,
          req.ip ?? null
        );
      } catch (err) {
        console.error("[visit]", err instanceof Error ? err.message : err);
      }
    }
    res.redirect(302, config.visit.destUrl);
  });
}
