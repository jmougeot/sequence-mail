/**
 * Canal LinkedIn des séquences, multi-comptes. Quand une étape LinkedIn devient
 * due, le scheduler appelle `enqueueStep` : une action entre en file et le
 * contact passe en attente. Chaque compte LinkedIn (une extension Chrome ou un
 * navigateur serveur, identifié par son jeton) réclame ensuite `nextAction()` —
 * et c'est ICI, côté serveur, que se décide si CE compte a le droit d'agir :
 *   1. plafonds journaliers par type (invitation/message), avec warm-up ;
 *   2. plage horaire ouvrée seulement ;
 *   3. délai aléatoire entre deux actions ;
 *   4. pause de sécurité longue dès qu'une action échoue.
 * Quotas, délais et pauses sont propres à chaque compte : plusieurs comptes
 * travaillent en parallèle sans se gêner.
 *
 * Attribution : un contact est attaché au premier compte qui le prend en charge
 * (campaign_contacts.li_account_id) et toutes ses actions suivantes passent par
 * lui — un message ne part que d'un compte connecté au destinataire. Tant qu'il
 * n'est attaché à personne, n'importe quel compte autorisé par la campagne peut
 * le prendre : la charge se répartit d'elle-même sur les comptes disponibles.
 *
 * Au succès, `recordResult` fait avancer le contact à l'étape suivante de la
 * séquence (qu'elle soit email ou LinkedIn).
 */
import { createHash, randomBytes } from "node:crypto";
import { config } from "../config.js";
import { db } from "../db.js";

const L = config.linkedin;
const DAY_MS = 24 * 60 * 60 * 1000;
const LEASE_MS = 5 * 60 * 1000;
const SEEN_TIMEOUT_MS = 2 * 60 * 1000; // l'extension interroge toutes les ~60 s

export type LiActionType = "invite" | "message";

export interface LiAccount {
  id: number;
  name: string;
  active: number;
  invites_per_day: number | null;
  messages_per_day: number | null;
  warmup_started_at: number | null;
  next_allowed_at: number | null;
  paused_until: number | null;
  last_seen_at: number | null;
  created_at: number;
}

let enabled = true; // interrupteur général (tous comptes)

// --- Comptes -----------------------------------------------------------------

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = () => "li_" + randomBytes(24).toString("base64url");

const ACCOUNT_COLS =
  "id, name, active, invites_per_day, messages_per_day, warmup_started_at, next_allowed_at, paused_until, last_seen_at, created_at";

export function listAccounts(): LiAccount[] {
  return db.prepare(`SELECT ${ACCOUNT_COLS} FROM li_accounts ORDER BY id`).all() as LiAccount[];
}

export function getAccount(id: number): LiAccount | undefined {
  return db.prepare(`SELECT ${ACCOUNT_COLS} FROM li_accounts WHERE id = ?`).get(id) as LiAccount | undefined;
}

/**
 * Compte appelant, d'après le jeton de l'en-tête X-LI-Account. Sans jeton, on
 * sert le compte le plus ancien : c'est l'extension installée avant le
 * multi-comptes, qui continue de fonctionner sans réglage.
 */
export function resolveAccount(token: string | undefined): LiAccount | null | "invalid" {
  if (token) {
    const row = db.prepare(`SELECT ${ACCOUNT_COLS} FROM li_accounts WHERE token_hash = ?`).get(hashToken(token));
    return (row as LiAccount | undefined) ?? "invalid";
  }
  return (db.prepare(`SELECT ${ACCOUNT_COLS} FROM li_accounts ORDER BY id LIMIT 1`).get() as LiAccount | undefined) ?? null;
}

/** Crée un compte ; le jeton en clair n'est rendu qu'ici (seul son hash est stocké). */
export function createAccount(name: string): { account: LiAccount; token: string } {
  const token = newToken();
  const { lastInsertRowid } = db
    .prepare("INSERT INTO li_accounts (name, token_hash) VALUES (?, ?)")
    .run(name, hashToken(token));
  return { account: getAccount(Number(lastInsertRowid))!, token };
}

export function rotateToken(id: number): string | null {
  const token = newToken();
  const { changes } = db.prepare("UPDATE li_accounts SET token_hash = ? WHERE id = ?").run(hashToken(token), id);
  return changes ? token : null;
}

export function updateAccount(
  id: number,
  patch: { name?: string; active?: boolean; invites_per_day?: number | null; messages_per_day?: number | null; restart_warmup?: boolean }
): LiAccount | undefined {
  const cap = (v: number | null | undefined) => (v == null ? null : Math.max(0, Math.round(v)));
  db.transaction(() => {
    if (patch.name?.trim()) db.prepare("UPDATE li_accounts SET name = ? WHERE id = ?").run(patch.name.trim(), id);
    if (patch.active !== undefined) {
      // Réactiver lève aussi la pause de sécurité (geste explicite de l'utilisateur)
      db.prepare(
        "UPDATE li_accounts SET active = ?, paused_until = CASE WHEN ? THEN NULL ELSE paused_until END WHERE id = ?"
      ).run(patch.active ? 1 : 0, patch.active ? 1 : 0, id);
    }
    if ("invites_per_day" in patch) db.prepare("UPDATE li_accounts SET invites_per_day = ? WHERE id = ?").run(cap(patch.invites_per_day), id);
    if ("messages_per_day" in patch) db.prepare("UPDATE li_accounts SET messages_per_day = ? WHERE id = ?").run(cap(patch.messages_per_day), id);
    if (patch.restart_warmup) db.prepare("UPDATE li_accounts SET warmup_started_at = ? WHERE id = ?").run(Date.now(), id);
  })();
  return getAccount(id);
}

/**
 * Supprime un compte qui n'a encore rien fait. Un compte qui a déjà agi garde
 * ses contacts (leurs messages ne peuvent partir que de lui) : on le désactive.
 */
export function deleteAccount(id: number): { ok: true } | { error: string } {
  const used = db
    .prepare(
      `SELECT 1 FROM li_log WHERE li_account_id = @id
       UNION SELECT 1 FROM li_actions WHERE li_account_id = @id
       UNION SELECT 1 FROM campaign_contacts WHERE li_account_id = @id LIMIT 1`
    )
    .get({ id });
  if (used) return { error: "Ce compte a déjà des contacts : désactivez-le plutôt que de le supprimer." };
  db.prepare("DELETE FROM li_accounts WHERE id = ?").run(id);
  return { ok: true };
}

// --- Rythme d'un compte ------------------------------------------------------

function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function sentToday(accountId: number, type: LiActionType): number {
  const since = startOfLocalDay(Date.now());
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM li_log WHERE li_account_id = ? AND type = ? AND sent_at >= ?`)
      .get(accountId, type, since) as { n: number }
  ).n;
}

function activeDays(a: LiAccount): number {
  const start =
    a.warmup_started_at ??
    (db.prepare(`SELECT MIN(sent_at) AS t FROM li_log WHERE li_account_id = ?`).get(a.id) as { t: number | null }).t;
  if (!start) return 0;
  return Math.floor((startOfLocalDay(Date.now()) - startOfLocalDay(start)) / DAY_MS);
}

/** Plafond du jour d'un compte pour un type : warm-up croissant, borné au plafond du compte. */
export function dailyCap(a: LiAccount, type: LiActionType): number {
  const hard = type === "invite" ? (a.invites_per_day ?? L.invitesPerDay) : (a.messages_per_day ?? L.messagesPerDay);
  return Math.max(0, Math.min(hard, L.warmupStart + activeDays(a) * L.warmupRamp));
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
 * réponses ne le reprennent). L'action hérite du compte déjà attaché au contact
 * (sinon elle reste libre, cf. `nextAction`). Dédoublonné : pas deux actions
 * vivantes pour la même étape du même contact.
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
      `INSERT INTO li_actions (campaign_contact_id, step_number, linkedin, type, body, li_account_id)
       VALUES (?, ?, ?, ?, ?, (SELECT li_account_id FROM campaign_contacts WHERE id = ?))`
    ).run(ccId, stepNumber, linkedin, type, body, ccId);
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

// --- Distributeur : que peut faire ce compte, maintenant ? -------------------

export type NextResult =
  | { action: { id: number; linkedin: string; type: LiActionType; body: string | null } }
  | { idle: true; reason: string }
  | { wait: number; reason: string };

type ActionRow = { id: number; campaign_contact_id: number; linkedin: string; type: LiActionType; body: string | null };

// Actions qu'un compte peut prendre : les siennes, ou les libres (contact encore
// attaché à personne) d'une campagne qui l'autorise. Seulement pour les
// campagnes actives et les contacts toujours en attente (ni arrêtés, ni en
// réponse entre-temps).
const ELIGIBLE = `
  FROM li_actions la
  JOIN campaign_contacts cc ON cc.id = la.campaign_contact_id
  JOIN campaigns cp ON cp.id = cc.campaign_id
  WHERE la.status = 'pending'
    AND cc.status = 'awaiting_li' AND cp.status = 'active'
    AND (la.li_account_id = @acc
         OR (la.li_account_id IS NULL AND cc.li_account_id IS NULL
             AND (cp.li_account_ids IS NULL OR EXISTS (SELECT 1 FROM json_each(cp.li_account_ids) WHERE value = @acc))))`;

export function nextAction(account: LiAccount): NextResult {
  const now = Date.now();
  db.prepare("UPDATE li_accounts SET last_seen_at = ? WHERE id = ?").run(now, account.id);
  reclaimStale();

  if (!enabled) return { idle: true, reason: "Envoi LinkedIn en pause (désactivé pour tous les comptes)" };
  if (!account.active) return { idle: true, reason: `Compte « ${account.name} » désactivé` };
  if ((account.paused_until ?? 0) > now)
    return { wait: Math.ceil((account.paused_until! - now) / 1000), reason: "Pause de sécurité après une erreur" };
  if (!withinWindow(now)) return { wait: Math.ceil((nextWindowOpen(now) - now) / 1000), reason: "Hors plage horaire d'envoi" };
  if ((account.next_allowed_at ?? 0) > now)
    return { wait: Math.ceil((account.next_allowed_at! - now) / 1000), reason: "Délai entre deux actions" };

  const allowed = (["invite", "message"] as LiActionType[]).filter((t) => sentToday(account.id, t) < dailyCap(account, t));
  const untilTomorrow = Math.ceil((startOfLocalDay(now) + DAY_MS - now) / 1000);
  if (!allowed.length) return { wait: untilTomorrow, reason: "Quota du jour atteint" };

  // Ses propres actions d'abord (contacts déjà engagés), puis les libres.
  const row = db
    .prepare(
      `SELECT la.id, la.campaign_contact_id, la.linkedin, la.type, la.body ${ELIGIBLE}
         AND la.type IN (${allowed.map((t) => `'${t}'`).join(",")})
         AND (la.not_before IS NULL OR la.not_before <= @now)
       ORDER BY (la.li_account_id IS NULL), la.id ASC LIMIT 1`
    )
    .get({ acc: account.id, now }) as ActionRow | undefined;

  if (!row) {
    const blocked = db.prepare(`SELECT 1 ${ELIGIBLE} LIMIT 1`).get({ acc: account.id });
    if (blocked) return { wait: untilTomorrow, reason: "Quota du jour atteint ou actions reportées" };
    return { idle: true, reason: "File LinkedIn vide" };
  }

  // Prise en charge : l'action ET le contact deviennent ceux de ce compte.
  const claimed = db.transaction(() => {
    const { changes } = db
      .prepare(
        `UPDATE li_actions SET status = 'sending', lease_at = ?, attempts = attempts + 1, li_account_id = ?
         WHERE id = ? AND status = 'pending' AND (li_account_id IS NULL OR li_account_id = ?)`
      )
      .run(now, account.id, row.id, account.id);
    if (!changes) return false;
    db.prepare(`UPDATE campaign_contacts SET li_account_id = ? WHERE id = ? AND li_account_id IS NULL`).run(
      account.id,
      row.campaign_contact_id
    );
    return true;
  })();
  if (!claimed) return { wait: 5, reason: "Action prise par un autre compte" };

  return { action: { id: row.id, linkedin: row.linkedin, type: row.type, body: row.body } };
}

/**
 * Verdict d'une action exécutée par un compte :
 * - `retry` (message à un profil pas encore connecté) → on reporte l'action de
 *   quelques heures, sans pause ni avancement ;
 * - succès → journalisé (quota du compte), délai du compte armé, et le contact
 *   avance d'une étape ;
 * - échec → pause de sécurité longue de CE compte, contact marqué en échec.
 * Rend false si l'action n'appartient pas à ce compte.
 */
export function recordResult(account: LiAccount, id: number, ok: boolean, error?: string, retry?: boolean): boolean {
  const row = db
    .prepare(`SELECT id, type, campaign_contact_id, step_number, li_account_id FROM li_actions WHERE id = ?`)
    .get(id) as
    | { id: number; type: LiActionType; campaign_contact_id: number; step_number: number; li_account_id: number | null }
    | undefined;
  if (!row || row.li_account_id !== account.id) return false;
  const now = Date.now();

  if (retry && !ok) {
    // Invitation pas encore acceptée : on retentera le message plus tard, sans punir.
    db.prepare(`UPDATE li_actions SET status = 'pending', lease_at = NULL, not_before = ?, error = ? WHERE id = ?`).run(
      now + L.messageRetryHours * 3600 * 1000,
      error ?? "en attente d'acceptation",
      id
    );
    return true;
  }

  if (ok) {
    db.prepare(`UPDATE li_actions SET status = 'sent', sent_at = ?, lease_at = NULL, error = NULL WHERE id = ?`).run(now, id);
    db.prepare(`INSERT INTO li_log (type, sent_at, li_account_id) VALUES (?, ?, ?)`).run(row.type, now, account.id);
    db.prepare(`UPDATE li_accounts SET next_allowed_at = ? WHERE id = ?`).run(
      Math.round(now + rand(L.minGapSec, L.maxGapSec) * 1000),
      account.id
    );
    advanceContact(row.campaign_contact_id, row.step_number);
  } else {
    db.prepare(`UPDATE li_actions SET status = 'failed', lease_at = NULL, error = ? WHERE id = ?`).run(error ?? "échec", id);
    db.prepare(`UPDATE campaign_contacts SET status = 'failed', error = ?, next_send_at = NULL WHERE id = ?`).run(
      `LinkedIn (${account.name}) : ${error ?? "échec"}`,
      row.campaign_contact_id
    );
    db.prepare(`UPDATE li_accounts SET paused_until = ? WHERE id = ?`).run(now + L.pauseAfterErrorMin * 60 * 1000, account.id);
  }
  return true;
}

// --- État / interrupteur (UI et popup) ---------------------------------------

export function setEnabled(v: boolean): void {
  enabled = v;
  if (v) db.prepare("UPDATE li_accounts SET paused_until = NULL").run();
}

function count(sql: string, ...args: unknown[]): number {
  return (db.prepare(sql).get(...args) as { n: number }).n;
}

/** État d'un compte : présence de l'extension, quotas du jour, file. */
export function accountStatus(a: LiAccount) {
  const now = Date.now();
  const invites = sentToday(a.id, "invite");
  const messages = sentToday(a.id, "message");
  return {
    id: a.id,
    name: a.name,
    enabled: enabled && Boolean(a.active),
    active: Boolean(a.active),
    // « connecté » = l'extension de ce compte a interrogé le serveur il y a moins de 2 min
    connected: a.last_seen_at != null && now - a.last_seen_at < SEEN_TIMEOUT_MS,
    last_seen_at: a.last_seen_at,
    within_window: withinWindow(now),
    paused_until: (a.paused_until ?? 0) > now ? a.paused_until : null,
    next_allowed_at: (a.next_allowed_at ?? 0) > now ? a.next_allowed_at : null,
    invites_per_day: a.invites_per_day ?? L.invitesPerDay,
    messages_per_day: a.messages_per_day ?? L.messagesPerDay,
    today: {
      invite: { sent: invites, cap: dailyCap(a, "invite") },
      message: { sent: messages, cap: dailyCap(a, "message") },
    },
    queue: {
      pending: count(`SELECT COUNT(*) AS n FROM li_actions WHERE li_account_id = ? AND status = 'pending'`, a.id),
      sent: invites + messages,
      failed: count(`SELECT COUNT(*) AS n FROM li_actions WHERE li_account_id = ? AND status = 'failed'`, a.id),
    },
    contacts: count(`SELECT COUNT(*) AS n FROM campaign_contacts WHERE li_account_id = ?`, a.id),
  };
}

/**
 * État global (tableau de bord) : totaux tous comptes + détail par compte. Les
 * champs de tête gardent la forme d'avant le multi-comptes (popup, MCP).
 */
export function outreachStatus() {
  reclaimStale();
  const now = Date.now();
  const accounts = listAccounts().map(accountStatus);
  const sum = (f: (a: (typeof accounts)[number]) => number) => accounts.reduce((n, a) => n + f(a), 0);
  const unassigned = count(`SELECT COUNT(*) AS n FROM li_actions WHERE li_account_id IS NULL AND status = 'pending'`);
  const lastSeen = Math.max(0, ...accounts.map((a) => a.last_seen_at ?? 0));
  const pending = sum((a) => a.queue.pending) + unassigned;
  return {
    enabled,
    connected: accounts.some((a) => a.connected),
    last_seen_at: lastSeen || null,
    within_window: withinWindow(now),
    today: {
      invite: { sent: sum((a) => a.today.invite.sent), cap: sum((a) => (a.active ? a.today.invite.cap : 0)) },
      message: { sent: sum((a) => a.today.message.sent), cap: sum((a) => (a.active ? a.today.message.cap : 0)) },
    },
    queue: { pending, unassigned, sent: sum((a) => a.queue.sent), failed: sum((a) => a.queue.failed) },
    pending, // conservé pour compatibilité
    accounts,
  };
}
