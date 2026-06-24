/**
 * Canal LinkedIn des séquences. Quand une étape LinkedIn devient due, le
 * scheduler appelle `enqueueStep` : une action entre en file et le contact passe
 * en attente. L'extension Chrome réclame ensuite `nextAction()` — et c'est ICI,
 * côté serveur, que se décide si l'on a le droit d'agir maintenant :
 *   1. plafonds journaliers par type (invitation/message), avec warm-up ;
 *   2. plage horaire ouvrée seulement ;
 *   3. délai aléatoire entre deux actions ;
 *   4. pause de sécurité longue dès qu'une action échoue.
 * Au succès, `recordResult` fait avancer le contact à l'étape suivante de la
 * séquence (qu'elle soit email ou LinkedIn).
 */
import { config } from "../config.js";
import { db } from "../db.js";

const L = config.linkedin;
const DAY_MS = 24 * 60 * 60 * 1000;
const LEASE_MS = 5 * 60 * 1000;

export type LiActionType = "invite" | "message";

let nextAllowedAt = 0;
let pausedUntil = 0;
let enabled = true;
let rearmed = false;
let lastSeenAt = 0; // dernier appel de l'extension (heartbeat → « connecté »)

const SEEN_TIMEOUT_MS = 2 * 60 * 1000; // l'extension interroge toutes les ~60 s

function rearmFromLog(): void {
  if (rearmed) return;
  rearmed = true;
  const last = db.prepare(`SELECT MAX(sent_at) AS t FROM li_log`).get() as { t: number | null };
  if (last.t) nextAllowedAt = last.t + L.minGapSec * 1000;
}

function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function sentToday(type: LiActionType): number {
  const since = startOfLocalDay(Date.now());
  return (db.prepare(`SELECT COUNT(*) AS n FROM li_log WHERE type = ? AND sent_at >= ?`).get(type, since) as { n: number }).n;
}

function activeDays(): number {
  const first = db.prepare(`SELECT MIN(sent_at) AS t FROM li_log`).get() as { t: number | null };
  if (!first.t) return 0;
  return Math.floor((startOfLocalDay(Date.now()) - startOfLocalDay(first.t)) / DAY_MS);
}

/** Plafond du jour pour un type : warm-up croissant, borné au plafond dur. */
export function dailyCap(type: LiActionType): number {
  const hard = type === "invite" ? L.invitesPerDay : L.messagesPerDay;
  return Math.max(0, Math.min(hard, L.warmupStart + activeDays() * L.warmupRamp));
}

function withinWindow(ts: number): boolean {
  const d = new Date(ts);
  if (L.workdaysOnly && (d.getDay() === 0 || d.getDay() === 6)) return false;
  return d.getHours() >= L.hourStart && d.getHours() < L.hourEnd;
}

function nextWindowOpen(ts: number): number {
  const d = new Date(ts);
  for (let i = 0; i < 8; i++) {
    const open = new Date(d);
    if (i > 0 || d.getHours() >= L.hourEnd) open.setDate(open.getDate() + (i || 1));
    open.setHours(L.hourStart, 0, 0, 0);
    if (open.getTime() > ts && withinWindow(open.getTime())) return open.getTime();
  }
  return ts + DAY_MS;
}

const rand = (min: number, max: number) => min + Math.random() * (max - min);

function reclaimStale(): void {
  db.prepare(
    `UPDATE li_actions SET status = 'pending', lease_at = NULL
     WHERE status = 'sending' AND (lease_at IS NULL OR lease_at < ?)`
  ).run(Date.now() - LEASE_MS);
}

// --- Mise en file (appelée par le scheduler quand une étape LinkedIn est due) --

/**
 * Dépose une action LinkedIn pour une étape de séquence et met le contact en
 * attente (status 'awaiting_li' : ni le scheduler email ni la détection de
 * réponses ne le reprennent). Dédoublonné : pas deux actions vivantes pour la
 * même étape du même contact.
 */
export function enqueueStep(
  ccId: number,
  stepNumber: number,
  linkedin: string,
  type: LiActionType,
  body: string | null
): void {
  const dup = db
    .prepare(
      `SELECT 1 FROM li_actions WHERE campaign_contact_id = ? AND step_number = ? AND status IN ('pending','sending','sent') LIMIT 1`
    )
    .get(ccId, stepNumber);
  if (dup) return;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO li_actions (campaign_contact_id, step_number, linkedin, type, body) VALUES (?, ?, ?, ?, ?)`
    ).run(ccId, stepNumber, linkedin, type, body);
    db.prepare(`UPDATE campaign_contacts SET status = 'awaiting_li', next_send_at = NULL, error = NULL WHERE id = ?`).run(ccId);
  })();
}

// --- Avancement de la séquence après une action réussie ----------------------

interface StepRow {
  step_number: number;
  wait_days: number;
}

/** Marque l'étape franchie et planifie la suivante (ou termine la séquence). */
function advanceContact(ccId: number, completedStep: number): void {
  const cc = db.prepare(`SELECT campaign_id FROM campaign_contacts WHERE id = ?`).get(ccId) as
    | { campaign_id: number }
    | undefined;
  if (!cc) return;
  const steps = db
    .prepare(`SELECT step_number, wait_days FROM steps WHERE campaign_id = ? ORDER BY step_number`)
    .all(cc.campaign_id) as StepRow[];
  const next = steps.find((s) => s.step_number === completedStep + 1);
  if (next) {
    const jitter = rand(0, 4 * 3600 * 1000); // 0-4 h de variabilité
    const at = Date.now() + next.wait_days * DAY_MS + jitter;
    db.prepare(
      `UPDATE campaign_contacts SET current_step = ?, status = 'in_progress', next_send_at = ?, error = NULL WHERE id = ?`
    ).run(completedStep, Math.round(at), ccId);
  } else {
    db.prepare(
      `UPDATE campaign_contacts SET current_step = ?, status = 'completed', next_send_at = NULL WHERE id = ?`
    ).run(completedStep, ccId);
  }
}

// --- Distributeur : que peut faire l'extension, maintenant ? -----------------

export type NextResult =
  | { action: { id: number; linkedin: string; type: LiActionType; body: string | null } }
  | { idle: true; reason: string }
  | { wait: number; reason: string };

export function nextAction(): NextResult {
  lastSeenAt = Date.now(); // l'extension vient d'interroger : elle est en ligne
  rearmFromLog();
  reclaimStale();
  const now = Date.now();

  if (!enabled) return { idle: true, reason: "Envoi LinkedIn en pause (désactivé)" };
  if (pausedUntil > now) return { wait: Math.ceil((pausedUntil - now) / 1000), reason: "Pause de sécurité après une erreur" };
  if (!withinWindow(now)) return { wait: Math.ceil((nextWindowOpen(now) - now) / 1000), reason: "Hors plage horaire d'envoi" };
  if (nextAllowedAt > now) return { wait: Math.ceil((nextAllowedAt - now) / 1000), reason: "Délai entre deux actions" };

  const allowed = (["invite", "message"] as LiActionType[]).filter((t) => sentToday(t) < dailyCap(t));
  if (!allowed.length) return { wait: Math.ceil((startOfLocalDay(now) + DAY_MS - now) / 1000), reason: "Quota du jour atteint" };

  const row = db
    .prepare(
      `SELECT id, linkedin, type, body FROM li_actions
       WHERE status = 'pending' AND type IN (${allowed.map(() => "?").join(",")})
         AND (not_before IS NULL OR not_before <= ?)
       ORDER BY id ASC LIMIT 1`
    )
    .get(...allowed, now) as { id: number; linkedin: string; type: LiActionType; body: string | null } | undefined;

  if (!row) {
    const blocked = db.prepare(`SELECT 1 FROM li_actions WHERE status = 'pending' LIMIT 1`).get();
    if (blocked) return { wait: Math.ceil((startOfLocalDay(now) + DAY_MS - now) / 1000), reason: "Quota du jour atteint" };
    return { idle: true, reason: "File LinkedIn vide" };
  }

  db.prepare(`UPDATE li_actions SET status = 'sending', lease_at = ?, attempts = attempts + 1 WHERE id = ?`).run(now, row.id);
  return { action: row };
}

/**
 * Verdict d'une action exécutée par l'extension :
 * - `retry` (message à un profil pas encore connecté) → on reporte l'action de
 *   quelques heures, sans pause ni avancement ;
 * - succès → journalisé (quota), délai armé, et le contact avance d'une étape ;
 * - échec → pause de sécurité longue et contact marqué en échec.
 */
export function recordResult(id: number, ok: boolean, error?: string, retry?: boolean): void {
  const row = db.prepare(`SELECT id, type, campaign_contact_id, step_number FROM li_actions WHERE id = ?`).get(id) as
    | { id: number; type: LiActionType; campaign_contact_id: number; step_number: number }
    | undefined;
  if (!row) return;
  const now = Date.now();

  if (retry && !ok) {
    // Invitation pas encore acceptée : on retentera le message plus tard, sans punir.
    db.prepare(`UPDATE li_actions SET status = 'pending', lease_at = NULL, not_before = ?, error = ? WHERE id = ?`).run(
      now + L.messageRetryHours * 3600 * 1000,
      error ?? "en attente d'acceptation",
      id
    );
    return;
  }

  if (ok) {
    db.prepare(`UPDATE li_actions SET status = 'sent', sent_at = ?, lease_at = NULL, error = NULL WHERE id = ?`).run(now, id);
    db.prepare(`INSERT INTO li_log (type, sent_at) VALUES (?, ?)`).run(row.type, now);
    nextAllowedAt = now + rand(L.minGapSec, L.maxGapSec) * 1000;
    advanceContact(row.campaign_contact_id, row.step_number);
  } else {
    db.prepare(`UPDATE li_actions SET status = 'failed', lease_at = NULL, error = ? WHERE id = ?`).run(error ?? "échec", id);
    db.prepare(`UPDATE campaign_contacts SET status = 'failed', error = ?, next_send_at = NULL WHERE id = ?`).run(
      `LinkedIn : ${error ?? "échec"}`,
      row.campaign_contact_id
    );
    pausedUntil = now + L.pauseAfterErrorMin * 60 * 1000;
  }
}

// --- État / interrupteur (UI et popup) ---------------------------------------

export function setEnabled(v: boolean): void {
  enabled = v;
  if (v) pausedUntil = 0;
}

export function outreachStatus() {
  rearmFromLog();
  reclaimStale();
  const now = Date.now();
  const pending = (db.prepare(`SELECT COUNT(*) AS n FROM li_actions WHERE status = 'pending'`).get() as { n: number }).n;
  const failed = (db.prepare(`SELECT COUNT(*) AS n FROM li_actions WHERE status = 'failed'`).get() as { n: number }).n;
  const sent = sentToday("invite") + sentToday("message");
  // « connecté » = l'extension a interrogé le serveur il y a moins de 2 min
  const connected = lastSeenAt > 0 && now - lastSeenAt < SEEN_TIMEOUT_MS;
  return {
    enabled,
    connected,
    last_seen_at: lastSeenAt || null,
    within_window: withinWindow(now),
    paused_until: pausedUntil > now ? pausedUntil : null,
    next_allowed_at: nextAllowedAt > now ? nextAllowedAt : null,
    today: {
      invite: { sent: sentToday("invite"), cap: dailyCap("invite") },
      message: { sent: sentToday("message"), cap: dailyCap("message") },
    },
    queue: { pending, sent, failed },
    pending, // conservé pour compatibilité
  };
}
