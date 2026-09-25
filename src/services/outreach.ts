/**
 * Canal LinkedIn des séquences, multi-comptes. Quand une étape LinkedIn devient
 * due, le scheduler appelle `enqueueStep` : une action entre en file et le
 * contact passe en attente. Chaque compte LinkedIn réclame ensuite
 * `nextAction()` — et c'est ICI, côté serveur, que se décide si CE compte a le
 * droit d'agir :
 *   1. plafonds journaliers par type (invitation/message), avec warm-up ;
 *   2. plage horaire ouvrée seulement ;
 *   3. délai aléatoire entre deux actions ;
 *   4. pause de sécurité longue dès qu'une action échoue.
 * Quotas, délais et pauses sont propres à chaque compte : plusieurs comptes
 * travaillent en parallèle sans se gêner.
 *
 * Deux exécutants possibles par compte (li_accounts.mode) :
 *   - 'extension' : l'extension Chrome, dans le navigateur de la personne,
 *     identifiée par le jeton du compte (en-tête X-LI-Account) ;
 *   - 'server'    : le service runner (Chromium sur le VPS, derrière le proxy
 *     du compte), qui rejoue la session LinkedIn envoyée par l'extension.
 * Un compte n'est servi qu'à l'exécutant de son mode : jamais les deux à la fois.
 *
 * Attribution : un contact est attaché au premier compte qui le prend en charge
 * (campaign_contacts.li_account_id) et toutes ses actions suivantes passent par
 * lui — un message ne part que d'un compte connecté au destinataire. Tant qu'il
 * n'est attaché à personne, n'importe quel compte autorisé par la campagne peut
 * le prendre : la charge se répartit d'elle-même sur les comptes disponibles.
 *
 * Détection des réponses : quand un compte a des contacts à surveiller, il
 * reçoit régulièrement une action 'sync_inbox' (lecture de la messagerie) dont
 * le résultat est traité par li-inbox.ts.
 *
 * Bon compte, à coup sûr :
 *   - propriétaire (owner_ref) : une campagne n'est servie qu'aux comptes du
 *     même propriétaire — un client Azerit n'envoie jamais depuis le LinkedIn
 *     d'un autre, quelle que soit la sélection de comptes de la campagne ;
 *   - identité (member_slug) : le profil LinkedIn réellement connecté est
 *     relevé à la remise de session, puis l'exécutant le relit dans la page
 *     avant chaque action (`expect_member`). Autre profil → rien n'est envoyé,
 *     l'action retourne en file et le compte s'arrête (« wrong_account »)
 *     jusqu'à ce que la bonne session soit renvoyée.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { db } from "../db.js";
import { linkedinSlug } from "./linkedin-url.js";

const L = config.linkedin;
const DAY_MS = 24 * 60 * 60 * 1000;
const LEASE_MS = 5 * 60 * 1000;
const SEEN_TIMEOUT_MS = 2 * 60 * 1000; // l'exécutant interroge toutes les ~60 s
const WATCH_DAYS = 45; // durée de surveillance des réponses après la dernière action envoyée

export type LiActionType = "invite" | "message";
export type LiMode = "extension" | "server";

export type LiSessionState = "ok" | "expired" | "checkpoint" | "wrong_account";

export interface LiAccount {
  id: number;
  name: string;
  owner_ref: string | null;
  member_slug: string | null;
  member_name: string | null;
  member_avatar: string | null;
  member_checked_at: number | null;
  active: number;
  mode: LiMode;
  invites_per_day: number | null;
  messages_per_day: number | null;
  warmup_started_at: number | null;
  next_allowed_at: number | null;
  paused_until: number | null;
  last_seen_at: number | null;
  last_inbox_at: number | null;
  session_state: LiSessionState | null;
  session_error: string | null;
  session_updated_at: number | null;
  has_proxy: number;
  has_session: number;
  created_at: number;
}

let enabled = true; // interrupteur général (tous comptes)

// --- Chiffrement (session et proxy des comptes en mode serveur) -------------

function secretKey(): Buffer {
  if (!L.secretKey) throw new Error("LI_SECRET_KEY manquant dans .env : impossible de stocker une session ou un proxy");
  return createHash("sha256").update(L.secretKey).digest();
}

function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", secretKey(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64url")).join(".");
}

function unseal(sealed: string): string {
  const [iv, tag, enc] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
  const d = createDecipheriv("aes-256-gcm", secretKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

// --- Comptes -----------------------------------------------------------------

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = () => "li_" + randomBytes(24).toString("base64url");

const ACCOUNT_COLS = `id, name, owner_ref, member_slug, member_name, member_avatar, member_checked_at, active, mode, invites_per_day, messages_per_day, warmup_started_at, next_allowed_at,
  paused_until, last_seen_at, last_inbox_at, session_state, session_error, session_updated_at,
  proxy_enc IS NOT NULL AS has_proxy, session_enc IS NOT NULL AS has_session, created_at`;

export function listAccounts(): LiAccount[] {
  return db.prepare(`SELECT ${ACCOUNT_COLS} FROM li_accounts ORDER BY id`).all() as LiAccount[];
}

export function getAccount(id: number): LiAccount | undefined {
  return db.prepare(`SELECT ${ACCOUNT_COLS} FROM li_accounts WHERE id = ?`).get(id) as LiAccount | undefined;
}

/**
 * Compte appelant, d'après le jeton de l'en-tête X-LI-Account. Sans jeton, on
 * sert le plus ancien compte du tableau de bord (sans propriétaire) : c'est
 * l'extension installée avant le multi-comptes, qui continue de fonctionner
 * sans réglage. Jamais le compte d'un client.
 */
export function resolveAccount(token: string | undefined): LiAccount | null | "invalid" {
  if (token) {
    const row = db.prepare(`SELECT ${ACCOUNT_COLS} FROM li_accounts WHERE token_hash = ?`).get(hashToken(token));
    return (row as LiAccount | undefined) ?? "invalid";
  }
  return (
    (db.prepare(`SELECT ${ACCOUNT_COLS} FROM li_accounts WHERE owner_ref IS NULL ORDER BY id LIMIT 1`).get() as
      | LiAccount
      | undefined) ?? null
  );
}

/** Le runner prouve son identité par le secret partagé (réseau interne du VPS). */
export function isRunner(secret: string | undefined): boolean {
  if (!L.runnerSecret || !secret) return false;
  const a = Buffer.from(secret);
  const b = Buffer.from(L.runnerSecret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Crée un compte ; le jeton en clair n'est rendu qu'ici (seul son hash est stocké). */
export function createAccount(name: string, ownerRef: string | null = null): { account: LiAccount; token: string } {
  const token = newToken();
  const { lastInsertRowid } = db
    .prepare("INSERT INTO li_accounts (name, token_hash, owner_ref) VALUES (?, ?, ?)")
    .run(name, hashToken(token), ownerRef);
  return { account: getAccount(Number(lastInsertRowid))!, token };
}

export function rotateToken(id: number): string | null {
  const token = newToken();
  const { changes } = db.prepare("UPDATE li_accounts SET token_hash = ? WHERE id = ?").run(hashToken(token), id);
  return changes ? token : null;
}

export function updateAccount(
  id: number,
  patch: {
    name?: string;
    active?: boolean;
    mode?: LiMode;
    invites_per_day?: number | null;
    messages_per_day?: number | null;
    restart_warmup?: boolean;
  }
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
    if (patch.mode === "extension" || patch.mode === "server") {
      db.prepare("UPDATE li_accounts SET mode = ? WHERE id = ?").run(patch.mode, id);
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

// --- Session et proxy (mode serveur) -----------------------------------------

export interface LiCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface LiSession {
  cookies: LiCookie[];
  user_agent: string | null;
  captured_at: number;
}

/** Profil LinkedIn connecté, tel que lu par l'exécutant (slug /in/…, nom, photo). */
export interface LiMember {
  slug: string;
  name: string | null;
  avatar: string | null;
}

/** Slug canonique d'un profil (URL complète ou slug nu), sinon null. */
export function memberSlug(value: unknown): string | null {
  return typeof value === "string" ? linkedinSlug(value) : null;
}

/** Identité envoyée par un exécutant ({ slug, name, avatar }), validée ; null si absente/illisible. */
export function parseMember(value: unknown): LiMember | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const slug = memberSlug(v.slug);
  if (!slug) return null;
  const str = (x: unknown, max: number) => (typeof x === "string" && x.trim() ? x.trim().slice(0, max) : null);
  const avatar = str(v.avatar, 1000);
  return { slug, name: str(v.name, 200), avatar: avatar && /^https:\/\//.test(avatar) ? avatar : null };
}

/**
 * Le compte est connecté au mauvais profil LinkedIn : plus aucune action tant
 * que la bonne session n'a pas été renvoyée (storeSession remet l'état à ok).
 */
export function markWrongAccount(account: LiAccount, actual: string | null): void {
  const error = actual
    ? `Connecté à LinkedIn en tant que « ${actual} » au lieu de « ${account.member_slug} » — rien n'a été envoyé. Renvoyez la session du bon compte.`
    : "Profil LinkedIn connecté illisible — rien n'a été envoyé.";
  db.prepare(`UPDATE li_accounts SET session_state = 'wrong_account', session_error = ? WHERE id = ?`).run(error, account.id);
  console.warn(`[linkedin] « ${account.name} » : ${error}`);
}

/** Identité confirmée par l'exécutant : première relève (compte sans identité) ou simple horodatage. */
function confirmMember(account: LiAccount, member: LiMember): void {
  db.prepare(
    `UPDATE li_accounts SET member_slug = COALESCE(member_slug, ?), member_name = COALESCE(?, member_name),
       member_avatar = COALESCE(?, member_avatar), member_checked_at = ? WHERE id = ?`
  ).run(member.slug, member.name, member.avatar, Date.now(), account.id);
}

/**
 * Enregistre la session LinkedIn envoyée par l'extension (cookies du domaine
 * linkedin.com + user-agent du navigateur d'origine) et bascule le compte en
 * mode serveur : l'extension cesse alors d'exécuter pour ce compte.
 */
export function storeSession(
  id: number,
  cookies: unknown,
  userAgent: unknown,
  member: LiMember | null = null
): { ok: true } | { error: string; code?: "other_member" } {
  if (!Array.isArray(cookies)) return { error: "cookies[] manquant" };
  const account = getAccount(id);
  if (!account) return { error: "Compte introuvable" };
  // Une session d'un AUTRE profil que celui du compte est refusée : ses
  // contacts sont reliés à ce profil-là, et c'est de lui que doivent partir les messages.
  if (member && account.member_slug && member.slug !== account.member_slug) {
    return {
      code: "other_member",
      error: `Ce navigateur est connecté à LinkedIn en tant que « ${member.slug} », pas « ${account.member_slug} » (le profil de ce compte).`,
    };
  }
  const clean: LiCookie[] = cookies
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .filter((c) => typeof c.name === "string" && typeof c.value === "string" && /linkedin\.com$/i.test(String(c.domain ?? "")))
    .map((c) => ({
      name: String(c.name),
      value: String(c.value),
      domain: String(c.domain),
      path: typeof c.path === "string" ? c.path : "/",
      expires: typeof c.expires === "number" ? c.expires : undefined,
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure),
      sameSite: c.sameSite === "Strict" || c.sameSite === "Lax" || c.sameSite === "None" ? c.sameSite : undefined,
    }));
  if (!clean.some((c) => c.name === "li_at")) {
    return { error: "Cookie de session LinkedIn (li_at) absent : connectez-vous à LinkedIn dans ce navigateur puis réessayez." };
  }
  const session: LiSession = {
    cookies: clean,
    user_agent: typeof userAgent === "string" ? userAgent.slice(0, 400) : null,
    captured_at: Date.now(),
  };
  let sealed: string;
  try {
    sealed = seal(JSON.stringify(session));
  } catch (e) {
    return { error: (e as Error).message };
  }
  const now = Date.now();
  db.prepare(
    `UPDATE li_accounts SET session_enc = ?, session_state = 'ok', session_error = NULL, session_updated_at = ?,
       mode = 'server', paused_until = NULL WHERE id = ?`
  ).run(sealed, now, id);
  if (member) {
    db.prepare(
      `UPDATE li_accounts SET member_slug = ?, member_name = COALESCE(?, member_name),
         member_avatar = COALESCE(?, member_avatar), member_checked_at = ? WHERE id = ?`
    ).run(member.slug, member.name, member.avatar, now, id);
  }
  return { ok: true };
}

/** Proxy du compte (http://user:pass@hôte:port, https:// ou socks5://) ; null le retire. */
export function setProxy(id: number, url: string | null): { ok: true } | { error: string } {
  if (url == null || !url.trim()) {
    db.prepare("UPDATE li_accounts SET proxy_enc = NULL WHERE id = ?").run(id);
    return { ok: true };
  }
  try {
    const u = new URL(url.trim());
    if (!/^(https?|socks5):$/.test(u.protocol) || !u.hostname || !u.port) {
      return { error: "Proxy attendu sous la forme http://utilisateur:motdepasse@hôte:port (ou socks5://…)" };
    }
    db.prepare("UPDATE li_accounts SET proxy_enc = ? WHERE id = ?").run(seal(u.toString()), id);
    return { ok: true };
  } catch (e) {
    return { error: e instanceof TypeError ? "URL de proxy invalide" : (e as Error).message };
  }
}

/** Le runner signale une session morte (déconnexion) ou un contrôle de sécurité. */
export function setSessionState(id: number, state: LiSessionState, error?: string): void {
  const now = Date.now();
  db.prepare(
    `UPDATE li_accounts SET session_state = ?, session_error = ?,
       paused_until = CASE WHEN ? = 'checkpoint' THEN ? ELSE paused_until END WHERE id = ?`
  ).run(state, error ?? null, state, now + L.checkpointPauseMin * 60_000, id);
}

/**
 * Contrôle de sécurité / captcha LinkedIn : longue pause du compte. En mode
 * serveur, la session est aussi marquée à vérifier (la personne doit passer le
 * contrôle dans son propre navigateur puis renvoyer sa session).
 */
export function pauseForCheckpoint(account: LiAccount, error: string): void {
  db.prepare(
    `UPDATE li_accounts SET paused_until = ?, session_error = ?,
       session_state = CASE WHEN mode = 'server' THEN 'checkpoint' ELSE session_state END WHERE id = ?`
  ).run(Date.now() + L.checkpointPauseMin * 60_000, error.slice(0, 500), account.id);
}

/** Comptes que le runner doit faire tourner, avec session et proxy déchiffrés. */
export function runnerAccounts() {
  const rows = db
    .prepare(
      `SELECT id, name, member_slug, proxy_enc, session_enc, session_updated_at FROM li_accounts
       WHERE mode = 'server' AND active = 1 AND session_state = 'ok' AND session_enc IS NOT NULL`
    )
    .all() as Array<{
      id: number;
      name: string;
      member_slug: string | null;
      proxy_enc: string | null;
      session_enc: string;
      session_updated_at: number;
    }>;
  return rows.flatMap((r) => {
    try {
      return [
        {
          id: r.id,
          name: r.name,
          member_slug: r.member_slug,
          proxy: r.proxy_enc ? unseal(r.proxy_enc) : null,
          session: JSON.parse(unseal(r.session_enc)) as LiSession,
          session_version: r.session_updated_at,
        },
      ];
    } catch (e) {
      console.error(`[linkedin] compte ${r.id} : session illisible (LI_SECRET_KEY changée ?)`, (e as Error).message);
      return [];
    }
  });
}

/** Plage où le runner garde les navigateurs ouverts (envois + lecture de la messagerie). */
export function runnerWindow() {
  return { hour_start: Math.max(0, L.hourStart - 1), hour_end: Math.min(24, L.hourEnd + 3), tz_offset_min: -new Date().getTimezoneOffset() };
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

/** Lecture de la messagerie : plage élargie, week-end compris (lire n'est pas envoyer). */
function withinInboxWindow(ts: number): boolean {
  const w = runnerWindow();
  const h = new Date(ts).getHours();
  return h >= w.hour_start && h < w.hour_end;
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

/** Contacts d'un compte dont on attend une éventuelle réponse sur LinkedIn. */
function watchedCount(accountId: number): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM campaign_contacts cc
         WHERE cc.li_account_id = ? AND cc.replied_at IS NULL
           AND cc.status IN ('awaiting_li', 'in_progress', 'completed')
           AND EXISTS (SELECT 1 FROM li_actions la WHERE la.campaign_contact_id = cc.id AND la.status = 'sent' AND la.sent_at > ?)`
      )
      .get(accountId, Date.now() - WATCH_DAYS * DAY_MS) as { n: number }
  ).n;
}

// --- Mise en file (appelée par le scheduler quand une étape LinkedIn est due) --

/**
 * Dépose une action LinkedIn pour une étape de séquence et met le contact en
 * attente (status 'awaiting_li' : le scheduler email le laisse). L'action hérite
 * du compte déjà attaché au contact (sinon elle reste libre, cf. `nextAction`).
 * Dédoublonné : pas deux actions vivantes pour la même étape du même contact.
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

/** Annule les actions LinkedIn pas encore jouées (réponse, désinscription…). */
export function cancelLinkedInActions(where: string, param: unknown, reason: string): void {
  db.prepare(
    `UPDATE li_actions SET status = 'cancelled', lease_at = NULL, error = ?
     WHERE status IN ('pending', 'sending') AND ${where}`
  ).run(reason, param);
}

// --- Avancement de la séquence après une action réussie ----------------------

interface StepRow {
  step_number: number;
  wait_days: number;
}

/** Marque l'étape franchie et planifie la suivante (ou termine la séquence). */
function advanceContact(ccId: number, completedStep: number): void {
  const cc = db.prepare(`SELECT campaign_id, status FROM campaign_contacts WHERE id = ?`).get(ccId) as
    | { campaign_id: number; status: string }
    | undefined;
  if (!cc || cc.status !== "awaiting_li") return; // réponse/arrêt entre-temps : on ne relance rien
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

// expect_member : profil que l'exécutant doit trouver connecté avant d'agir
// (null = compte encore sans identité, relevée au premier passage).
export type LiServedAction =
  | { id: number; linkedin: string; type: LiActionType; body: string | null; expect_member: string | null }
  | { id: 0; linkedin: null; type: "sync_inbox"; body: null; limit: number; expect_member: string | null };

export type NextResult =
  | { action: LiServedAction }
  | { idle: true; reason: string }
  | { wait: number; reason: string };

type ActionRow = { id: number; campaign_contact_id: number; linkedin: string; type: LiActionType; body: string | null };

// Actions qu'un compte peut prendre : les siennes, ou les libres (contact encore
// attaché à personne) d'une campagne qui l'autorise. Seulement pour les
// campagnes actives et les contacts toujours en attente (ni arrêtés, ni en
// réponse entre-temps), et TOUJOURS du même propriétaire que le compte.
const ELIGIBLE = `
  FROM li_actions la
  JOIN campaign_contacts cc ON cc.id = la.campaign_contact_id
  JOIN campaigns cp ON cp.id = cc.campaign_id
  WHERE la.status = 'pending'
    AND cc.status = 'awaiting_li' AND cp.status = 'active'
    AND cp.owner_ref IS @owner
    AND (la.li_account_id = @acc
         OR (la.li_account_id IS NULL AND cc.li_account_id IS NULL
             AND (cp.li_account_ids IS NULL OR EXISTS (SELECT 1 FROM json_each(cp.li_account_ids) WHERE value = @acc))))`;

export function nextAction(account: LiAccount, via: LiMode): NextResult {
  const now = Date.now();
  db.prepare("UPDATE li_accounts SET last_seen_at = ? WHERE id = ?").run(now, account.id);
  reclaimStale();

  if (!enabled) return { idle: true, reason: "Envoi LinkedIn en pause (désactivé pour tous les comptes)" };
  if (!account.active) return { idle: true, reason: `Compte « ${account.name} » désactivé` };
  if (account.mode !== via) {
    return {
      idle: true,
      reason:
        account.mode === "server"
          ? `Compte « ${account.name} » piloté par le serveur — cette extension n'agit plus pour lui`
          : `Compte « ${account.name} » piloté par l'extension Chrome`,
    };
  }
  if (account.session_state === "wrong_account") {
    return { idle: true, reason: account.session_error ?? "Mauvais profil LinkedIn connecté — renvoyez la session du bon compte" };
  }
  if (via === "server" && account.session_state !== "ok") {
    return { idle: true, reason: "Session LinkedIn à renvoyer depuis l'extension" };
  }
  if ((account.paused_until ?? 0) > now)
    return { wait: Math.ceil((account.paused_until! - now) / 1000), reason: "Pause de sécurité après une erreur" };

  // Lecture de la messagerie (détection des réponses), hors quotas d'envoi.
  if (now - (account.last_inbox_at ?? 0) >= L.inboxEveryMin * 60_000 && withinInboxWindow(now) && watchedCount(account.id)) {
    db.prepare(`UPDATE li_accounts SET last_inbox_at = ?, next_allowed_at = MAX(COALESCE(next_allowed_at, 0), ?) WHERE id = ?`).run(
      now,
      Math.round(now + rand(20, 60) * 1000),
      account.id
    );
    return { action: { id: 0, linkedin: null, type: "sync_inbox", body: null, limit: 40, expect_member: account.member_slug } };
  }

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
    .get({ acc: account.id, owner: account.owner_ref, now }) as ActionRow | undefined;

  if (!row) {
    const blocked = db.prepare(`SELECT 1 ${ELIGIBLE} LIMIT 1`).get({ acc: account.id, owner: account.owner_ref });
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

  return {
    action: { id: row.id, linkedin: row.linkedin, type: row.type, body: row.body, expect_member: account.member_slug },
  };
}

const NOT_FOUND = /\(404\)/;
const CHECKPOINT = /contrôle de sécurité|checkpoint|captcha|challenge/i;

/** Verdict d'un exécutant pour une action servie. */
export interface LiVerdict {
  ok: boolean;
  error?: string;
  retry?: boolean; // message à un profil pas encore connecté : reporter
  member?: LiMember | null; // profil lu dans la page juste avant d'agir
  wrong_account?: boolean; // l'exécutant a refusé d'agir : autre profil connecté
  identity_unknown?: boolean; // profil connecté illisible : rien n'a été fait
}

/** Remet une action servie en file, sans la compter ni punir le contact. */
function requeue(id: number, error: string): void {
  db.prepare(`UPDATE li_actions SET status = 'pending', lease_at = NULL, attempts = MAX(attempts - 1, 0), error = ? WHERE id = ?`).run(
    error,
    id
  );
}

/**
 * Verdict d'une action exécutée par un compte :
 * - autre profil connecté (ou profil illisible) → rien n'est parti : l'action
 *   retourne en file et le compte s'arrête (mauvais profil) ou fait une pause ;
 * - `retry` (message à un profil pas encore connecté) → on reporte l'action de
 *   quelques heures, sans pause ni avancement — jusqu'à LI_MESSAGE_RETRY_MAX_DAYS,
 *   au-delà l'invitation est considérée ignorée et la séquence s'arrête là ;
 * - succès → journalisé (quota du compte, profil émetteur), délai du compte
 *   armé, et le contact avance d'une étape ;
 * - échec → contact marqué en échec, et pause de sécurité du compte : longue
 *   sur un contrôle de sécurité LinkedIn, aucune sur un profil introuvable (404).
 * Rend false si l'action n'appartient pas à ce compte.
 */
export function recordResult(account: LiAccount, id: number, v: LiVerdict): boolean {
  const row = db
    .prepare(`SELECT id, type, status, campaign_contact_id, step_number, li_account_id, created_at FROM li_actions WHERE id = ?`)
    .get(id) as
    | {
        id: number;
        type: LiActionType;
        status: string;
        campaign_contact_id: number;
        step_number: number;
        li_account_id: number | null;
        created_at: number;
      }
    | undefined;
  if (!row || row.li_account_id !== account.id) return false;
  const now = Date.now();
  const member = v.member ?? null;
  const otherMember = Boolean(member && account.member_slug && member.slug !== account.member_slug);

  // Refus de l'exécutant : rien n'a été envoyé.
  if (!v.ok && (v.wrong_account || otherMember)) {
    if (row.status === "sending") requeue(id, "mauvais profil LinkedIn connecté — en attente du bon compte");
    markWrongAccount(account, member?.slug ?? null);
    return true;
  }
  if (!v.ok && v.identity_unknown) {
    if (row.status === "sending") requeue(id, v.error ?? "profil connecté illisible");
    db.prepare(`UPDATE li_accounts SET paused_until = ?, session_error = ? WHERE id = ?`).run(
      now + L.pauseAfterErrorMin * 60_000,
      `Profil LinkedIn connecté illisible (${v.error ?? "?"}) — rien n'a été envoyé`,
      account.id
    );
    return true;
  }
  if (member && !otherMember) confirmMember(account, member);
  // Parti d'un autre profil malgré tout (exécutant d'avant la vérification) :
  // le geste a eu lieu, on le trace, mais le compte s'arrête aussitôt.
  if (v.ok && otherMember) markWrongAccount(account, member!.slug);
  const sentBy = member?.slug ?? account.member_slug;

  // Annulée pendant l'exécution (le contact a répondu) : on compte le geste
  // s'il a eu lieu (quota), sans rien faire avancer.
  if (row.status !== "sending") {
    if (v.ok) db.prepare(`INSERT INTO li_log (type, sent_at, li_account_id) VALUES (?, ?, ?)`).run(row.type, now, account.id);
    return true;
  }

  if (v.retry && !v.ok) {
    if (now - row.created_at > L.messageRetryMaxDays * DAY_MS) {
      // Invitation jamais acceptée : la séquence s'arrête, sans échec ni pause.
      db.prepare(`UPDATE li_actions SET status = 'cancelled', lease_at = NULL, error = ? WHERE id = ?`).run(
        `invitation non acceptée après ${L.messageRetryMaxDays} j`,
        id
      );
      db.prepare(`UPDATE campaign_contacts SET status = 'completed', next_send_at = NULL, error = ? WHERE id = ? AND status = 'awaiting_li'`).run(
        `Invitation LinkedIn non acceptée après ${L.messageRetryMaxDays} j`,
        row.campaign_contact_id
      );
      return true;
    }
    // Invitation pas encore acceptée : on retentera le message plus tard, sans punir.
    db.prepare(`UPDATE li_actions SET status = 'pending', lease_at = NULL, not_before = ?, error = ? WHERE id = ?`).run(
      now + L.messageRetryHours * 3600 * 1000,
      v.error ?? "en attente d'acceptation",
      id
    );
    return true;
  }

  if (v.ok) {
    db.prepare(`UPDATE li_actions SET status = 'sent', sent_at = ?, lease_at = NULL, error = ?, member_slug = ? WHERE id = ?`).run(
      now,
      v.error ?? null,
      sentBy,
      id
    );
    db.prepare(`INSERT INTO li_log (type, sent_at, li_account_id) VALUES (?, ?, ?)`).run(row.type, now, account.id);
    db.prepare(`UPDATE li_accounts SET next_allowed_at = ? WHERE id = ?`).run(
      Math.round(now + rand(L.minGapSec, L.maxGapSec) * 1000),
      account.id
    );
    advanceContact(row.campaign_contact_id, row.step_number);
    return true;
  }

  const msg = v.error ?? "échec";
  db.prepare(`UPDATE li_actions SET status = 'failed', lease_at = NULL, error = ? WHERE id = ?`).run(msg, id);
  db.prepare(`UPDATE campaign_contacts SET status = 'failed', error = ?, next_send_at = NULL WHERE id = ?`).run(
    `LinkedIn (${account.name}) : ${msg}`,
    row.campaign_contact_id
  );
  if (CHECKPOINT.test(msg)) {
    pauseForCheckpoint(account, msg);
  } else if (!NOT_FOUND.test(msg)) {
    db.prepare(`UPDATE li_accounts SET paused_until = ? WHERE id = ?`).run(now + L.pauseAfterErrorMin * 60_000, account.id);
  }
  return true;
}

/**
 * Identité jointe à une lecture de messagerie : autre profil → compte arrêté
 * et lecture ignorée (ce ne sont pas ses conversations). Rend false dans ce cas.
 */
export function checkInboxMember(account: LiAccount, member: LiMember | null, wrongAccount: boolean): boolean {
  if (wrongAccount || (member && account.member_slug && member.slug !== account.member_slug)) {
    markWrongAccount(account, member?.slug ?? null);
    return false;
  }
  if (member) confirmMember(account, member);
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

/** État d'un compte : présence de l'exécutant, session, quotas du jour, file. */
export function accountStatus(a: LiAccount) {
  const now = Date.now();
  const invites = sentToday(a.id, "invite");
  const messages = sentToday(a.id, "message");
  return {
    id: a.id,
    name: a.name,
    owner_ref: a.owner_ref,
    member: a.member_slug
      ? {
          slug: a.member_slug,
          name: a.member_name,
          avatar: a.member_avatar,
          url: `https://www.linkedin.com/in/${a.member_slug}`,
          checked_at: a.member_checked_at,
        }
      : null,
    enabled: enabled && Boolean(a.active),
    active: Boolean(a.active),
    mode: a.mode,
    // « connecté » = l'exécutant de ce compte a interrogé le serveur il y a moins de 2 min
    connected: a.last_seen_at != null && now - a.last_seen_at < SEEN_TIMEOUT_MS,
    last_seen_at: a.last_seen_at,
    session: {
      state: a.session_state,
      error: a.session_error,
      updated_at: a.session_updated_at,
      stored: Boolean(a.has_session),
    },
    has_proxy: Boolean(a.has_proxy),
    last_inbox_at: a.last_inbox_at,
    watching: watchedCount(a.id),
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
    server_mode_ready: Boolean(L.secretKey && L.runnerSecret),
    today: {
      invite: { sent: sum((a) => a.today.invite.sent), cap: sum((a) => (a.active ? a.today.invite.cap : 0)) },
      message: { sent: sum((a) => a.today.message.sent), cap: sum((a) => (a.active ? a.today.message.cap : 0)) },
    },
    queue: { pending, unassigned, sent: sum((a) => a.queue.sent), failed: sum((a) => a.queue.failed) },
    pending, // conservé pour compatibilité
    accounts,
  };
}
