/**
 * LinkedIn channel of sequences, multi-account. When a LinkedIn step is due the
 * scheduler calls `enqueueStep`: an action is queued and the contact waits. Each
 * account then polls `nextAction()`, and it is HERE, server side, that we decide
 * whether THIS account may act:
 *   1. daily caps per type (invite/message), full from day one;
 *   2. working hours only;
 *   3. random delay between two actions;
 *   4. long safety pause as soon as an action fails.
 * Caps, delays and pauses are per account, so accounts work in parallel.
 *
 * Two possible executors per account (li_accounts.mode), never both at once:
 *   - 'extension': the Chrome extension in the person's browser, identified by the
 *     account token (X-LI-Account header);
 *   - 'server': the runner (Chromium on the VPS, behind the account's proxy), replaying
 *     the LinkedIn session sent by the extension.
 *
 * Assignment: a contact is bound to the first account that takes it
 * (campaign_contacts.li_account_id) and all its later actions go through it, since a
 * message can only come from a connection. Until bound, any account allowed by the
 * campaign may take it, which spreads the load.
 *
 * Reply detection: an account with contacts to watch regularly gets a 'sync_inbox'
 * action (inbox read), whose result is handled by li-inbox.ts.
 *
 * Right account, guaranteed:
 *   - owner (owner_ref): a campaign is only served to accounts of the same owner, so an
 *     Azerit client never sends from another's LinkedIn, whatever the account selection;
 *   - identity (member_slug): the logged-in profile is read when the session is handed
 *     over, then re-read by the executor before each action (`expect_member`). Other
 *     profile → nothing is sent, the action is requeued and the account stops
 *     ("wrong_account") until the right session is sent again.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { db } from "../db.js";
import { firstNotAccepted, nextStep, unreachable } from "./branches.js";
import { linkedinSlug } from "./linkedin-url.js";

const L = config.linkedin;
const DAY_MS = 24 * 60 * 60 * 1000;
const LEASE_MS = 5 * 60 * 1000;
const SEEN_TIMEOUT_MS = 2 * 60 * 1000; // the executor polls every ~60 s
const WATCH_DAYS = 45; // how long replies are watched after the last sent action

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

let enabled = true; // global switch (all accounts)

// --- Encryption (session and proxy of server-mode accounts) ------------------

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

// --- Accounts ----------------------------------------------------------------

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = () => "li_" + randomBytes(24).toString("base64url");

const ACCOUNT_COLS = `id, name, owner_ref, member_slug, member_name, member_avatar, member_checked_at, active, mode, invites_per_day, messages_per_day, next_allowed_at,
  paused_until, last_seen_at, last_inbox_at, session_state, session_error, session_updated_at,
  proxy_enc IS NOT NULL AS has_proxy, session_enc IS NOT NULL AS has_session, created_at`;

export function listAccounts(): LiAccount[] {
  return db.prepare(`SELECT ${ACCOUNT_COLS} FROM li_accounts ORDER BY id`).all() as LiAccount[];
}

export function getAccount(id: number): LiAccount | undefined {
  return db.prepare(`SELECT ${ACCOUNT_COLS} FROM li_accounts WHERE id = ?`).get(id) as LiAccount | undefined;
}

/**
 * Calling account, from the X-LI-Account token. Without a token, serves the oldest
 * dashboard (ownerless) account: the extension installed before multi-account keeps
 * working unconfigured. Never a client's account.
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

/** The runner proves its identity with the shared secret (VPS internal network). */
export function isRunner(secret: string | undefined): boolean {
  if (!L.runnerSecret || !secret) return false;
  const a = Buffer.from(secret);
  const b = Buffer.from(L.runnerSecret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Creates an account; the plain token is only returned here (only its hash is stored). */
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
  }
): LiAccount | undefined {
  const cap = (v: number | null | undefined) => (v == null ? null : Math.max(0, Math.round(v)));
  db.transaction(() => {
    if (patch.name?.trim()) db.prepare("UPDATE li_accounts SET name = ? WHERE id = ?").run(patch.name.trim(), id);
    if (patch.active !== undefined) {
      // Reactivating also lifts the safety pause (explicit user action)
      db.prepare(
        "UPDATE li_accounts SET active = ?, paused_until = CASE WHEN ? THEN NULL ELSE paused_until END WHERE id = ?"
      ).run(patch.active ? 1 : 0, patch.active ? 1 : 0, id);
    }
    if (patch.mode === "extension" || patch.mode === "server") {
      db.prepare("UPDATE li_accounts SET mode = ? WHERE id = ?").run(patch.mode, id);
    }
    if ("invites_per_day" in patch) db.prepare("UPDATE li_accounts SET invites_per_day = ? WHERE id = ?").run(cap(patch.invites_per_day), id);
    if ("messages_per_day" in patch) db.prepare("UPDATE li_accounts SET messages_per_day = ? WHERE id = ?").run(cap(patch.messages_per_day), id);
  })();
  return getAccount(id);
}

/**
 * Deletes an account that has done nothing yet. An account that already acted keeps
 * its contacts (their messages can only come from it): disable it instead.
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

// --- Session and proxy (server mode) -----------------------------------------

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

/** Logged-in LinkedIn profile, as read by the executor (/in/… slug, name, photo). */
export interface LiMember {
  slug: string;
  name: string | null;
  avatar: string | null;
}

/** Canonical profile slug (full URL or bare slug), else null. */
export function memberSlug(value: unknown): string | null {
  return typeof value === "string" ? linkedinSlug(value) : null;
}

/** Validated identity sent by an executor ({ slug, name, avatar }); null if missing/unreadable. */
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
 * The account is logged in to the wrong LinkedIn profile: no more actions until the
 * right session is sent again (storeSession resets the state to ok).
 */
export function markWrongAccount(account: LiAccount, actual: string | null): void {
  const error = actual
    ? `Connecté à LinkedIn en tant que « ${actual} » au lieu de « ${account.member_slug} » — rien n'a été envoyé. Renvoyez la session du bon compte.`
    : "Profil LinkedIn connecté illisible — rien n'a été envoyé.";
  db.prepare(`UPDATE li_accounts SET session_state = 'wrong_account', session_error = ? WHERE id = ?`).run(error, account.id);
  console.warn(`[linkedin] "${account.name}": ${error}`);
}

/** Identity confirmed by the executor: first capture (account without identity) or just a timestamp. */
function confirmMember(account: LiAccount, member: LiMember): void {
  db.prepare(
    `UPDATE li_accounts SET member_slug = COALESCE(member_slug, ?), member_name = COALESCE(?, member_name),
       member_avatar = COALESCE(?, member_avatar), member_checked_at = ? WHERE id = ?`
  ).run(member.slug, member.name, member.avatar, Date.now(), account.id);
}

/**
 * Stores the LinkedIn session sent by the extension (linkedin.com cookies + the
 * originating browser's user agent) and switches the account to server mode: the
 * extension then stops executing for it.
 */
export function storeSession(
  id: number,
  cookies: unknown,
  userAgent: unknown,
  member: LiMember | null = null,
  mode: LiMode = "server"
): { ok: true } | { error: string; code?: "other_member" } {
  if (!Array.isArray(cookies)) return { error: "cookies[] manquant" };
  const account = getAccount(id);
  if (!account) return { error: "Compte introuvable" };
  // A session of ANOTHER profile is refused: the account's contacts are connected to its
  // own profile, and messages must come from it.
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
       mode = ?, paused_until = NULL WHERE id = ?`
  ).run(sealed, now, mode, id);
  if (member) {
    db.prepare(
      `UPDATE li_accounts SET member_slug = ?, member_name = COALESCE(?, member_name),
         member_avatar = COALESCE(?, member_avatar), member_checked_at = ? WHERE id = ?`
    ).run(member.slug, member.name, member.avatar, now, id);
  }
  return { ok: true };
}

/** Account proxy (http://user:pass@host:port, https:// or socks5://); null removes it. */
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

/** The runner reports a dead session (logged out) or a security checkpoint. */
export function setSessionState(id: number, state: LiSessionState, error?: string): void {
  const now = Date.now();
  db.prepare(
    `UPDATE li_accounts SET session_state = ?, session_error = ?,
       paused_until = CASE WHEN ? = 'checkpoint' THEN ? ELSE paused_until END WHERE id = ?`
  ).run(state, error ?? null, state, now + L.checkpointPauseMin * 60_000, id);
}

/**
 * LinkedIn security checkpoint / captcha: long account pause. In server mode the
 * session is also flagged (the person must pass the check in their own browser,
 * then send the session again).
 */
export function pauseForCheckpoint(account: LiAccount, error: string): void {
  db.prepare(
    `UPDATE li_accounts SET paused_until = ?, session_error = ?,
       session_state = CASE WHEN mode = 'server' THEN 'checkpoint' ELSE session_state END WHERE id = ?`
  ).run(Date.now() + L.checkpointPauseMin * 60_000, error.slice(0, 500), account.id);
}

/** Accounts the runner must run, with decrypted session and proxy. */
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
      console.error(`[linkedin] account ${r.id}: unreadable session (LI_SECRET_KEY changed?)`, (e as Error).message);
      return [];
    }
  });
}

/** Hours during which the runner keeps browsers open (sending + inbox reads). */
export function runnerWindow() {
  return { hour_start: Math.max(0, L.hourStart - 1), hour_end: Math.min(24, L.hourEnd + 3), tz_offset_min: -new Date().getTimezoneOffset() };
}

// --- Account pacing ----------------------------------------------------------

function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function sentToday(accountIds: number | number[], type: LiActionType): number {
  const ids = [accountIds].flat();
  const since = startOfLocalDay(Date.now());
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM li_log WHERE li_account_id IN (${ids.map(() => "?").join(",")}) AND type = ? AND sent_at >= ?`
      )
      .get(...ids, type, since) as { n: number }
  ).n;
}

/**
 * Accounts sending from the same LinkedIn profile as this one (itself included): one
 * extension may serve a Sequence Mail account and an Azerit account. LinkedIn sees a
 * single profile, so daily caps, delay between actions and safety pauses are shared.
 */
function sameProfile(account: LiAccount): LiAccount[] {
  if (!account.member_slug) return [account];
  return db.prepare(`SELECT ${ACCOUNT_COLS} FROM li_accounts WHERE member_slug = ? ORDER BY id`).all(account.member_slug) as LiAccount[];
}

/** Account's daily cap for a type, no ramp-up. */
export function dailyCap(a: LiAccount, type: LiActionType): number {
  return Math.max(0, type === "invite" ? (a.invites_per_day ?? L.invitesPerDay) : (a.messages_per_day ?? L.messagesPerDay));
}

function withinWindow(ts: number): boolean {
  const d = new Date(ts);
  if (L.workdaysOnly && (d.getDay() === 0 || d.getDay() === 6)) return false;
  return d.getHours() >= L.hourStart && d.getHours() < L.hourEnd;
}

/** Inbox reads: wider hours, weekends included (reading is not sending). */
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

/** An account's contacts from whom a LinkedIn reply may come. */
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

// --- Queueing (called by the scheduler when a LinkedIn step is due) ----------

/**
 * Queues a LinkedIn action for a sequence step and puts the contact on hold
 * ('awaiting_li': ignored by the email scheduler). The action inherits the account
 * already bound to the contact (otherwise it stays free, see `nextAction`).
 * Deduplicated: never two live actions for the same step of the same contact.
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

/** Cancels LinkedIn actions not yet played (reply, opt-out…). */
export function cancelLinkedInActions(where: string, param: unknown, reason: string): void {
  db.prepare(
    `UPDATE li_actions SET status = 'cancelled', lease_at = NULL, error = ?
     WHERE status IN ('pending', 'sending') AND ${where}`
  ).run(reason, param);
}

// --- Sequence progress after a successful action -----------------------------

interface StepRow {
  step_number: number;
  wait_days: number;
  channel: string;
  branch: string | null;
}

function campaignSteps(campaignId: number): StepRow[] {
  return db
    .prepare(`SELECT step_number, wait_days, channel, branch FROM steps WHERE campaign_id = ? ORDER BY step_number`)
    .all(campaignId) as StepRow[];
}

/**
 * Marks the step done and schedules the next one of the contact's branch (or ends the
 * sequence); steps of the other branch count as done. `immediate`: the next step skips
 * its delay (switch to "not accepted", whose delay was the acceptance deadline). A step
 * the contact cannot receive (email without address) also goes without delay: the
 * scheduler skips it and schedules the next one with its own.
 */
function advanceContact(ccId: number, completedStep: number, immediate = false): void {
  const cc = db
    .prepare(
      `SELECT cc.campaign_id, cc.status, cc.li_accepted, c.email, c.linkedin
       FROM campaign_contacts cc JOIN contacts c ON c.id = cc.contact_id WHERE cc.id = ?`
    )
    .get(ccId) as
    | { campaign_id: number; status: string; li_accepted: number | null; email: string | null; linkedin: string | null }
    | undefined;
  if (!cc || cc.status !== "awaiting_li") return; // replied/stopped meanwhile: do not restart anything
  const next = nextStep(campaignSteps(cc.campaign_id), completedStep, cc.li_accepted);
  if (next) {
    const jitter = rand(0, 4 * 3600 * 1000); // 0-4 h
    const at = Date.now() + (immediate || unreachable(next, cc) ? 0 : next.wait_days * DAY_MS + jitter);
    db.prepare(
      `UPDATE campaign_contacts SET current_step = ?, status = 'in_progress', next_send_at = ?, error = NULL WHERE id = ?`
    ).run(next.step_number - 1, Math.round(at), ccId);
  } else {
    db.prepare(
      `UPDATE campaign_contacts SET current_step = ?, status = 'completed', next_send_at = NULL WHERE id = ?`
    ).run(completedStep, ccId);
  }
}

/**
 * Message to a contact not yet connected: past this deadline the invite counts as not
 * accepted. Branched campaign: delay of the first "not accepted" step, counted from the
 * invite; otherwise LI_MESSAGE_RETRY_MAX_DAYS from when the message was queued.
 * `branch`: the campaign has "not accepted" steps to switch to.
 */
function acceptanceDeadline(ccId: number, actionCreatedAt: number): { at: number; days: number; branch: boolean } {
  const cc = db.prepare(`SELECT campaign_id FROM campaign_contacts WHERE id = ?`).get(ccId) as { campaign_id: number };
  const fallback = firstNotAccepted(campaignSteps(cc.campaign_id));
  if (!fallback) return { at: actionCreatedAt + L.messageRetryMaxDays * DAY_MS, days: L.messageRetryMaxDays, branch: false };
  const invite = db
    .prepare(`SELECT MAX(sent_at) AS t FROM li_actions WHERE campaign_contact_id = ? AND type = 'invite' AND status = 'sent'`)
    .get(ccId) as { t: number | null };
  return { at: (invite.t ?? actionCreatedAt) + fallback.wait_days * DAY_MS, days: fallback.wait_days, branch: true };
}

// --- Dispatcher: what may this account do, now? ------------------------------

// expect_member: profile the executor must find logged in before acting (null = account
// without identity yet, captured on first run).
// guard (messages): markers the executor looks for in the conversation before writing
// (see messageGuard, and threadGuard in content.js).
export type LiServedAction =
  | {
      id: number;
      linkedin: string;
      type: LiActionType;
      body: string | null;
      expect_member: string | null;
      guard?: MessageGuard;
    }
  | { id: 0; linkedin: null; type: "sync_inbox"; body: null; limit: number; expect_member: string | null };

export interface MessageGuard {
  sent: Array<{ type: LiActionType; body: string }>; // already sent to this contact by the sequence, in order
  fresh: boolean; // the connection comes from our invite: no older conversation
}

/**
 * What the sequence already sent to this contact (invite note, messages). The executor
 * re-reads the conversation before writing, using these texts as markers: has the
 * contact written since? is this message already there (lost verdict, replayed action)?
 */
function messageGuard(ccId: number): MessageGuard {
  const sent = db
    .prepare(`SELECT type, body, error FROM li_actions WHERE campaign_contact_id = ? AND status = 'sent' ORDER BY sent_at, id`)
    .all(ccId) as Array<{ type: LiActionType; body: string | null; error: string | null }>;
  const invite = sent.find((a) => a.type === "invite");
  return {
    sent: sent.filter((a) => a.body?.trim()).map((a) => ({ type: a.type, body: a.body! })),
    fresh: Boolean(invite && !/déjà en relation/i.test(invite.error ?? "")),
  };
}

export type NextResult =
  | { action: LiServedAction }
  | { idle: true; reason: string }
  | { wait: number; reason: string };

type ActionRow = { id: number; campaign_contact_id: number; linkedin: string; type: LiActionType; body: string | null };

// Actions an account may take: its own, or free ones (contact not bound yet) of a campaign
// that allows it. Only for active campaigns and contacts still waiting (not stopped, no
// reply meanwhile), and ALWAYS of the same owner as the account.
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
  // "Connected" = the account's own executor (per its mode) is seen: an extension polling
  // a server-mode account does not count.
  if (account.mode === via) db.prepare("UPDATE li_accounts SET last_seen_at = ? WHERE id = ?").run(now, account.id);
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
  const profile = sameProfile(account);
  const pausedUntil = Math.max(...profile.map((a) => a.paused_until ?? 0));
  if (pausedUntil > now) return { wait: Math.ceil((pausedUntil - now) / 1000), reason: "Pause de sécurité après une erreur" };

  // Inbox read (reply detection), outside sending caps.
  if (now - (account.last_inbox_at ?? 0) >= L.inboxEveryMin * 60_000 && withinInboxWindow(now) && watchedCount(account.id)) {
    db.prepare(`UPDATE li_accounts SET last_inbox_at = ?, next_allowed_at = MAX(COALESCE(next_allowed_at, 0), ?) WHERE id = ?`).run(
      now,
      Math.round(now + rand(20, 60) * 1000),
      account.id
    );
    return { action: { id: 0, linkedin: null, type: "sync_inbox", body: null, limit: 40, expect_member: account.member_slug } };
  }

  if (!withinWindow(now)) return { wait: Math.ceil((nextWindowOpen(now) - now) / 1000), reason: "Hors plage horaire d'envoi" };
  const nextAllowed = Math.max(...profile.map((a) => a.next_allowed_at ?? 0));
  if (nextAllowed > now) return { wait: Math.ceil((nextAllowed - now) / 1000), reason: "Délai entre deux actions" };

  const ids = profile.map((a) => a.id);
  const allowed = (["invite", "message"] as LiActionType[]).filter(
    (t) => sentToday(ids, t) < Math.min(...profile.map((a) => dailyCap(a, t)))
  );
  const untilTomorrow = Math.ceil((startOfLocalDay(now) + DAY_MS - now) / 1000);
  if (!allowed.length) return { wait: untilTomorrow, reason: "Quota du jour atteint" };

  // Its own actions first (contacts already engaged), then free ones.
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

  // Claim: the action AND the contact now belong to this account.
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
    action: {
      id: row.id,
      linkedin: row.linkedin,
      type: row.type,
      body: row.body,
      expect_member: account.member_slug,
      ...(row.type === "message" ? { guard: messageGuard(row.campaign_contact_id) } : {}),
    },
  };
}

/**
 * Next action among several accounts served by the same executor: the account idle
 * the longest goes first, one action at most. Without an action: the shortest wait,
 * else the idle reasons. `account` = index of the account in the given list.
 */
export function nextForAccounts(accounts: LiAccount[], via: LiMode): NextResult & { account?: number } {
  const lastSent = (a: LiAccount) =>
    (db.prepare(`SELECT MAX(sent_at) AS t FROM li_log WHERE li_account_id = ?`).get(a.id) as { t: number | null }).t ?? 0;
  // All are seen on this call, even those a served action spares from being polled.
  const now = Date.now();
  for (const a of accounts) if (a.mode === via) db.prepare("UPDATE li_accounts SET last_seen_at = ? WHERE id = ?").run(now, a.id);
  const order = accounts.map((a, i) => ({ i, t: lastSent(a) })).sort((x, y) => x.t - y.t || x.i - y.i);
  const results: NextResult[] = [];
  for (const { i } of order) {
    const r = nextAction(accounts[i], via);
    if ("action" in r) return { ...r, account: i };
    results.push(r);
  }
  const waits = results.filter((r): r is { wait: number; reason: string } => "wait" in r);
  if (waits.length) return waits.reduce((a, b) => (b.wait < a.wait ? b : a));
  return { idle: true, reason: [...new Set(results.map((r) => (r as { reason: string }).reason))].join(" · ") };
}

const NOT_FOUND = /\(404\)/;
const CHECKPOINT = /contrôle de sécurité|checkpoint|captcha|challenge/i;

/** An executor's verdict on a served action. */
export interface LiVerdict {
  ok: boolean;
  error?: string;
  retry?: boolean; // message to a profile not yet connected: postpone
  member?: LiMember | null; // profile read from the page just before acting
  wrong_account?: boolean; // the executor refused to act: another profile is logged in
  identity_unknown?: boolean; // logged-in profile unreadable: nothing was done
}

/** Puts a served action back in the queue, without counting it or penalizing the contact. */
function requeue(id: number, error: string): void {
  db.prepare(`UPDATE li_actions SET status = 'pending', lease_at = NULL, attempts = MAX(attempts - 1, 0), error = ? WHERE id = ?`).run(
    error,
    id
  );
}

/**
 * Verdict of an action executed by an account:
 * - other profile logged in (or unreadable) → nothing was sent: the action is requeued
 *   and the account stops (wrong profile) or pauses;
 * - `retry` (message to a profile not yet connected) → postponed a few hours, no pause
 *   or progress, until the acceptance deadline (acceptanceDeadline); past it the invite
 *   counts as ignored: the contact moves to the "not accepted" steps, or the sequence ends;
 * - success → logged (account cap, sending profile), account delay armed, contact moves
 *   one step, even when the verdict arrives after the lease expired, as long as the
 *   action was not replayed;
 * - failure → contact marked failed and account safety pause: long on a LinkedIn
 *   checkpoint, none on a profile not found (404).
 * Returns false if the action does not belong to this account.
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

  // The executor refused: nothing was sent.
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
  // Sent from another profile anyway (executor predating the check): the action happened,
  // log it, but stop the account right away.
  if (v.ok && otherMember) markWrongAccount(account, member!.slug);
  const sentBy = member?.slug ?? account.member_slug;

  // Late verdict: the lease expired (executor cut off, app restarted) and the action went
  // back to the queue without being replayed. It did happen: record it, or it would go again.
  const late = v.ok && row.status === "pending";
  // Cancelled during execution (the contact replied): count it if it happened (cap), advance nothing.
  if (row.status !== "sending" && !late) {
    if (v.ok) db.prepare(`INSERT INTO li_log (type, sent_at, li_account_id) VALUES (?, ?, ?)`).run(row.type, now, account.id);
    return true;
  }

  if (v.retry && !v.ok) {
    const deadline = acceptanceDeadline(row.campaign_contact_id, row.created_at);
    if (now >= deadline.at) {
      db.prepare(`UPDATE li_actions SET status = 'cancelled', lease_at = NULL, error = ? WHERE id = ?`).run(
        `invitation non acceptée après ${deadline.days} j`,
        id
      );
      if (deadline.branch) {
        // Switch to the "not accepted" steps (all after this message), without further wait.
        db.prepare(`UPDATE campaign_contacts SET li_accepted = 0 WHERE id = ?`).run(row.campaign_contact_id);
        advanceContact(row.campaign_contact_id, row.step_number, true);
        return true;
      }
      // Invite never accepted: the sequence ends, no failure, no pause.
      db.prepare(`UPDATE campaign_contacts SET status = 'completed', next_send_at = NULL, error = ? WHERE id = ? AND status = 'awaiting_li'`).run(
        `Invitation LinkedIn non acceptée après ${deadline.days} j`,
        row.campaign_contact_id
      );
      return true;
    }
    // Invite not accepted yet: retry the message later, without penalty.
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
    // A message only reaches a connection: the invite is accepted.
    if (row.type === "message") db.prepare(`UPDATE campaign_contacts SET li_accepted = 1 WHERE id = ?`).run(row.campaign_contact_id);
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
 * Identity attached to an inbox read: other profile → account stopped and read ignored
 * (those are not its conversations). Returns false in that case.
 */
export function checkInboxMember(account: LiAccount, member: LiMember | null, wrongAccount: boolean): boolean {
  if (wrongAccount || (member && account.member_slug && member.slug !== account.member_slug)) {
    markWrongAccount(account, member?.slug ?? null);
    return false;
  }
  if (member) confirmMember(account, member);
  return true;
}

// --- Status / switch (UI and popup) ------------------------------------------

export function setEnabled(v: boolean): void {
  enabled = v;
  if (v) db.prepare("UPDATE li_accounts SET paused_until = NULL").run();
}

function count(sql: string, ...args: unknown[]): number {
  return (db.prepare(sql).get(...args) as { n: number }).n;
}

/** Account status: executor presence, session, today's caps, queue. */
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
    // "connected" = this account's executor polled the server less than 2 min ago
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
 * Global status (dashboard): totals across accounts + per-account detail. Top-level
 * fields keep their pre-multi-account shape (popup, MCP).
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
    pending, // kept for compatibility
    accounts,
  };
}
