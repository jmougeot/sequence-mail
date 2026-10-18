import { config } from "../config.js";
import { db } from "../db.js";
import { pushSequenceStatus } from "./attio.js";
import { renderTemplate } from "./contacts.js";
import { getForeignMessages, sendEmail, type AccountRow, type ForeignMessage } from "./google.js";
import { nextStep, unreachable } from "./branches.js";
import { cancelLinkedInActions, enqueueStep } from "./outreach.js";
import { NOT_OPTED_OUT, optOutFromCampaignOf } from "./opt-out.js";
import { visitLink } from "./visits.js";
import { unsubLink } from "./unsubscribe.js";

const OPT_OUT_PATTERNS = [
  "pas interesse",
  "pas du tout interesse",
  "ne plus me contacter",
  "ne me contactez plus",
  "ne plus etre contacte",
  "ne plus recevoir",
  "ne m envoyez plus",
  "retirez moi",
  "me retirer de",
  "desinscri",
  "desabonn",
  "arretez de m",
  "unsubscribe",
  "not interested",
  "no longer interested",
  "remove me",
  "stop emailing",
  "stop contacting",
  "opt out",
];

/** Detects a refusal / unsubscribe request in a reply. */
export function isOptOut(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents (decomposed by NFD)
    .replace(/['’-]/g, " ")
    .replace(/\s+/g, " ");
  return OPT_OUT_PATTERNS.some((p) => normalized.includes(p));
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents (decomposed by NFD)
    .replace(/['’-]/g, " ")
    .replace(/\s+/g, " ");
}

// Bounce notification senders: mailer-daemon, postmaster (RFC 5321 §4.5.1) + Microsoft Exchange's fixed NDR address.
const BOUNCE_FROM = [
  "mailer-daemon",
  "postmaster",
  "mail delivery subsystem",
  "mail delivery system",
  "microsoftexchange329e71ec88ae4615bbc36ab6ce41109e",
];

// Non-delivery report (NDR) subjects: fallback when the NDR's From matches no BOUNCE_FROM.
const BOUNCE_SUBJECT = [
  "undeliverable",
  "message non distribue",
  "mail delivery failed",
  "delivery status notification",
  "echec de la remise",
  "non remis",
  "returned mail",
  "delivery failure",
];

/**
 * Detects a bounce (non-delivery report): first the most reliable machine signal,
 * Content-Type: multipart/report; report-type=delivery-status (RFC 3462), then the
 * From and subject of server notifications. An undetected bounce counts as a reply,
 * so the sequence still stops (fails safe).
 */
export function isBounce(
  m: Pick<ForeignMessage, "from" | "subject" | "contentType" | "deliveryStatus">
): boolean {
  // A delay-only DSN (Action: delayed, RFC 3464) is not final: the message may still be delivered.
  const ds = m.deliveryStatus.toLowerCase();
  if (/action:\s*delayed/.test(ds) && !/action:\s*failed/.test(ds)) return false;

  const ct = m.contentType.toLowerCase();
  if (ct.includes("multipart/report") && ct.includes("delivery-status")) return true;
  const f = normalize(m.from);
  // normalize() turns "mailer-daemon" into "mailer daemon": normalize the patterns too.
  if (BOUNCE_FROM.some((p) => f.includes(normalize(p)))) return true;
  const s = normalize(m.subject);
  return BOUNCE_SUBJECT.some((p) => s.includes(normalize(p)));
}

// Permanent error codes (5.X.X, RFC 3463) or explicit unknown-address wording: only these justify a permanent blacklist.
const HARD_BOUNCE_HINTS = [
  "user unknown",
  "address not found",
  "does not exist",
  "no such user",
  "recipient rejected",
  "address rejected",
  "adresse introuvable",
  "utilisateur inconnu",
];

/** Permanent bounce (dead address) vs temporary (full mailbox, greylisting…). */
export function isHardBounce(text: string): boolean {
  if (/\b5\.\d{1,3}\.\d{1,3}\b/.test(text)) return true; // DSN status 5.X.X
  if (/\b55[0-4]\b/.test(text)) return true; // SMTP codes 550-554
  const t = normalize(text);
  return HARD_BOUNCE_HINTS.some((p) => t.includes(p));
}

// Subject prefixes added automatically by mail clients (Gmail, Outlook/Exchange…), never by a human.
const AUTO_REPLY_SUBJECT_PREFIXES = [
  "automatic reply",
  "reponse automatique",
  "out of office",
  "auto:",
  "autosvar",
  "automatische antwort",
  "respuesta automatica",
];

/**
 * Detects an out-of-office auto-reply from machine signals only: Auto-Submitted
 * (RFC 3834), X-Autoreply, Precedence: auto_reply, or a client-generated subject prefix.
 * The human-written text is NOT analyzed: "I'm travelling, call me" is a real reply
 * and must stop the sequence.
 */
export function isAutoReply(
  m: Pick<ForeignMessage, "subject" | "autoSubmitted" | "precedence" | "hasAutoReplyHeader">
): boolean {
  const auto = m.autoSubmitted.trim().toLowerCase();
  if (auto && auto !== "no") return true; // RFC 3834: auto-replied / auto-generated
  if (m.hasAutoReplyHeader) return true;
  if (m.precedence.trim().toLowerCase() === "auto_reply") return true;
  const s = normalize(m.subject);
  return AUTO_REPLY_SUBJECT_PREFIXES.some((p) => s.startsWith(p));
}

/**
 * Removes quoted lines (">") and everything after a quote marker ("Le ... a écrit :",
 * "On ... wrote:"), so opt-out classification only sees what the contact wrote.
 */
export function stripQuoted(text: string): string {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(le|on)\s.{0,100}(a [ée]crit|wrote)\s*:?\s*$/i.test(line)) break;
    if (/^\s*-{2,}\s*(message d'origine|original message|forwarded message)/i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n");
}

/** Automatic warm-up: WARMUP_START emails/day, +WARMUP_RAMP per week, up to the configured quota. */
export function effectiveDailyLimit(
  a: Pick<AccountRow, "daily_limit" | "warmup" | "created_at" | "warmup_started_at">
): number {
  if (!a.warmup) return a.daily_limit;
  const base = a.warmup_started_at ?? a.created_at;
  const weeks = Math.max(0, Math.floor((Date.now() - base) / (7 * 24 * 3600 * 1000)));
  return Math.min(
    a.daily_limit,
    config.deliverability.warmupStart + config.deliverability.warmupRamp * weeks
  );
}

/**
 * Revoked or expired Google token: disable the account to stop looping errors.
 * Reconnecting the address from the dashboard reactivates it.
 */
function handleAuthError(account: AccountRow, msg: string): boolean {
  if (!msg.includes("invalid_grant") && !msg.includes("invalid_rapt")) return false;
  db.prepare("UPDATE accounts SET active = 0 WHERE id = ?").run(account.id);
  console.error(
    `[auth] Google access expired/revoked for ${account.email}: account disabled, reconnect it via "+ Connect a Google account"`
  );
  return true;
}

/** Pushes progress to Attio without blocking the workflow on error. */
function syncAttio(attioRecordId: string | null, value: string): void {
  if (!attioRecordId) return;
  pushSequenceStatus(attioRecordId, value).catch((err) =>
    console.error("[attio] update failed:", err instanceof Error ? err.message : err)
  );
}

const d = config.deliverability;

function randBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// The email send window has its own time zone (SEND_WINDOW_TZ); server time stays the LinkedIn flow's.
const windowZone = new Intl.DateTimeFormat("en-US", {
  timeZone: d.sendWindowTimezone, hourCycle: "h23",
  year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
});

/** Instant `ts` in the send window's time zone: a Date whose UTC fields hold the local time. */
function zoned(ts: number): Date {
  const p: Record<string, number> = {};
  for (const part of windowZone.formatToParts(ts)) p[part.type] = Number(part.value);
  return new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second));
}

/** Instant when it is `hour`:00 in the window's time zone, `days` days after the day of `ts`. */
function zonedHour(ts: number, days: number, hour: number): number {
  const z = zoned(ts);
  const wall = Date.UTC(z.getUTCFullYear(), z.getUTCMonth(), z.getUTCDate() + days, hour);
  const offset = (at: number): number => zoned(at).getTime() - Math.floor(at / 1000) * 1000;
  // the offset may differ between `ts` and the target (DST): second pass
  return wall - offset(wall - offset(ts));
}

function inSendWindow(now = new Date()): boolean {
  const z = zoned(now.getTime());
  if (d.weekdaysOnly) {
    const day = z.getUTCDay();
    if (day === 0 || day === 6) return false;
  }
  const h = z.getUTCHours();
  return h >= d.sendWindowStart && h < d.sendWindowEnd;
}

/** Start of the next send window after `ts`. */
function nextSendWindowOpen(ts: number): number {
  for (let i = 0; i < 8; i++) {
    const open = zonedHour(ts, i, d.sendWindowStart);
    if (open > ts && inSendWindow(new Date(open))) return open;
  }
  return ts + 24 * 3600 * 1000;
}

/** Email send window: open until closes_at, or closed until opens_at (epoch ms). */
export function sendWindowState(ts = Date.now()): { open: boolean; opens_at?: number; closes_at?: number } {
  if (!inSendWindow(new Date(ts))) return { open: false, opens_at: nextSendWindowOpen(ts) };
  return { open: true, closes_at: zonedHour(ts, 0, d.sendWindowEnd) };
}

interface DueRow {
  cc_id: number;
  campaign_id: number;
  contact_id: number;
  status: string;
  current_step: number;
  account_id: number | null;
  thread_id: string | null;
  last_gmail_message_id: string | null;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  linkedin: string | null;
  extra: string | null;
  attio_record_id: string | null;
  variant: string | null;
  li_accepted: number | null;
  campaign_account_ids: string | null;
}

interface StepRow {
  step_number: number;
  subject: string;
  subject_b: string | null;
  body: string;
  wait_days: number;
  channel: string;
  li_action: string | null;
  branch: string | null;
}

/** Resets the daily counters when the date has changed. */
function resetDailyCounters(): void {
  db.prepare(
    "UPDATE accounts SET sent_today = 0, sent_today_date = ? WHERE sent_today_date IS NOT ? "
  ).run(today(), today());
}

/** Campaign's account selection (campaigns.account_ids); null = all. */
export function parseAccountIds(json: string | null): number[] | null {
  if (!json) return null;
  try {
    const ids = JSON.parse(json);
    return Array.isArray(ids) && ids.length ? ids.map(Number) : null;
  } catch {
    return null;
  }
}

/** Least loaded account, under its effective quota (warm-up) and not resting. */
function pickAccount(now: number, allowedIds: number[] | null): AccountRow | undefined {
  const candidates = db
    .prepare(
      `SELECT * FROM accounts
       WHERE active = 1
         AND (next_allowed_at IS NULL OR next_allowed_at <= ?)
       ORDER BY sent_today ASC, COALESCE(last_sent_at, 0) ASC`
    )
    .all(now) as AccountRow[];
  return candidates.find(
    (a) => (!allowedIds || allowedIds.includes(a.id)) && a.sent_today < effectiveDailyLimit(a)
  );
}

function accountById(id: number): AccountRow | undefined {
  return db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
}

/**
 * Schedules the next step with random jitter (deliverability). Steps of another
 * branch count as passed (current_step set just before the next one), so the due
 * step is always current_step + 1. A step the contact cannot receive is due now:
 * it will be skipped without waiting for its delay.
 */
function scheduleNext(row: DueRow, next: StepRow): void {
  const jitterMs = randBetween(0, 4 * 3600 * 1000); // 0 to 4 h
  const at = unreachable(next, row) ? Date.now() : Date.now() + next.wait_days * 24 * 3600 * 1000 + jitterMs;
  db.prepare(
    "UPDATE campaign_contacts SET status = 'in_progress', current_step = ?, next_send_at = ? WHERE id = ?"
  ).run(next.step_number - 1, Math.round(at), row.cc_id);
}

/**
 * LinkedIn step (invite / message): queues the action for the executor. The contact
 * goes to 'awaiting_li' (ignored by the email scheduler); on success outreach.ts
 * moves it to the next step.
 */
function dispatchLinkedIn(row: DueRow, step: StepRow, steps: StepRow[]): void {
  if (!row.linkedin) {
    // No profile: no invite will ever be accepted ("not accepted" branch).
    db.prepare("UPDATE campaign_contacts SET li_accepted = 0 WHERE id = ?").run(row.cc_id);
    skipStep({ ...row, li_accepted: 0 }, step, steps, "pas de profil LinkedIn");
    return;
  }
  const totalSteps = steps.length;
  const type = step.li_action === "message" ? "message" : "invite";
  const contact = {
    email: row.email,
    first_name: row.first_name,
    last_name: row.last_name,
    company: row.company,
    extra: row.extra,
  };
  // An empty invite note is legitimate (invite without a message); an empty message
  // should not happen (validated at creation), null just in case.
  const body = step.body?.trim() ? renderTemplate(step.body, contact, { sender_name: "", signature: "" }) : null;
  enqueueStep(row.cc_id, step.step_number, row.linkedin, type, body);
  syncAttio(row.attio_record_id, `Étape ${step.step_number}/${totalSteps} — ${type === "invite" ? "invitation" : "message"} LinkedIn en file`);
  console.log(`[linkedin] step ${step.step_number} (${type}) -> ${who(row)} queued`);
}

/** Contact label for logs (email, else LinkedIn profile). */
function who(row: { email: string | null; linkedin?: string | null }): string {
  return row.email ?? row.linkedin ?? "(contact sans coordonnées)";
}

/**
 * Step this contact cannot receive (email without address, LinkedIn without profile):
 * skip it, since a campaign may mix email-only, LinkedIn-only and both. It was scheduled
 * without delay (scheduleNext), so its delay does not count: the next step keeps its own,
 * counted from the last real send, and goes now if the contact has received nothing yet.
 */
function skipStep(row: DueRow, step: StepRow, steps: StepRow[], reason: string): void {
  const next = nextStep(steps, step.step_number, row.li_accepted);
  const received = db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM messages WHERE campaign_contact_id = ?)
           OR EXISTS (SELECT 1 FROM li_actions WHERE campaign_contact_id = ? AND status = 'sent') AS r`
    )
    .get(row.cc_id, row.cc_id) as { r: number };
  const at = !next ? null
    : unreachable(next, row) || !received.r ? Date.now()
    : Math.round(Date.now() + next.wait_days * 24 * 3600 * 1000 + randBetween(0, 4 * 3600 * 1000));
  db.prepare(
    `UPDATE campaign_contacts SET current_step = ?, status = ?, next_send_at = ?, error = ? WHERE id = ?`
  ).run(next ? next.step_number - 1 : step.step_number, next ? "in_progress" : "completed", at, `étape ${step.step_number} sautée : ${reason}`, row.cc_id);
  if (!next) syncAttio(row.attio_record_id, `Séquence terminée (${steps.length} étapes, sans réponse)`);
  console.log(`[sequence] ${who(row)}: step ${step.step_number} skipped (${reason})`);
}

async function processOne(row: DueRow): Promise<void> {
  const steps = db
    .prepare("SELECT step_number, subject, subject_b, body, wait_days, channel, li_action, branch FROM steps WHERE campaign_id = ? ORDER BY step_number")
    .all(row.campaign_id) as StepRow[];
  const step = nextStep(steps, row.current_step, row.li_accepted);
  if (!step) {
    db.prepare("UPDATE campaign_contacts SET status = 'completed', next_send_at = NULL WHERE id = ?").run(row.cc_id);
    return;
  }

  if (step.channel === "linkedin") {
    dispatchLinkedIn(row, step, steps);
    return;
  }
  if (!row.email) {
    skipStep(row, step, steps, "pas d'email");
    return;
  }
  const to = row.email;

  const now = Date.now();
  // Thread continuity: follow-ups always use the 1st send's account (even if deselected
  // since); the 1st send follows the campaign's selection.
  const account = row.account_id
    ? accountById(row.account_id)
    : pickAccount(now, parseAccountIds(row.campaign_account_ids));
  if (!account || account.active !== 1) return; // no account available, retry next tick
  if (account.sent_today >= effectiveDailyLimit(account)) return;
  if (account.next_allowed_at && account.next_allowed_at > now) return;

  const contact = {
    email: row.email,
    first_name: row.first_name,
    last_name: row.last_name,
    company: row.company,
    extra: row.extra,
  };
  const senderName = account.from_name ?? account.email;
  // {{link}}: the prospect's stable personal link (server-side visit tracking)
  const link = config.visit.enabled ? visitLink(row.cc_id) : "";
  const senderVars = {
    sender_name: senderName,
    link,
    // {{signature}}: account signature, placed anywhere in the template
    signature: account.signature ? renderTemplate(account.signature, contact, { sender_name: senderName, link }) : "",
  };
  const isFollowUp = row.current_step > 0 && !!row.thread_id;

  // A/B test: if step 1 has a subject B, each contact gets a variant (50/50), fixed at
  // the 1st send ("Re:" follow-ups reuse the subject actually received).
  const firstStep = steps.find((s) => s.step_number === 1);
  const variant = row.variant ?? (firstStep?.subject_b && Math.random() < 0.5 ? "B" : "A");
  const subjectFor = (s: StepRow | undefined) =>
    s ? (variant === "B" && s.subject_b ? s.subject_b : s.subject) : "";

  // A follow-up without a subject stays in the thread opened by the sequence's first
  // email (not necessarily step 1 if the sequence starts on LinkedIn).
  const firstEmail = steps.find((s) => s.channel !== "linkedin") ?? firstStep;
  const subject = isFollowUp && !step.subject
    ? `Re: ${renderTemplate(subjectFor(firstEmail), contact, senderVars)}`
    : renderTemplate(subjectFor(step), contact, senderVars);

  const body = renderTemplate(step.body, contact, senderVars);

  try {
    const result = await sendEmail(account, {
      to,
      subject,
      body,
      threadId: isFollowUp ? row.thread_id : null,
      inReplyTo: isFollowUp ? row.last_gmail_message_id : null,
      listUnsubscribeUrl: unsubLink(row.cc_id),
    });

    const gap = Math.round(randBetween(d.minGapSeconds, d.maxGapSeconds) * 1000);
    db.transaction(() => {
      db.prepare(
        `UPDATE accounts SET sent_today = sent_today + 1, sent_today_date = ?,
         last_sent_at = ?, next_allowed_at = ? WHERE id = ?`
      ).run(today(), now, now + gap, account.id);
      db.prepare(
        `UPDATE campaign_contacts SET current_step = ?, account_id = ?, thread_id = ?,
         last_gmail_message_id = ?, variant = ?, error = NULL WHERE id = ?`
      ).run(step.step_number, account.id, result.threadId, result.rfc822MessageId, variant, row.cc_id);
      db.prepare(
        `INSERT INTO messages (campaign_contact_id, account_id, step_number, gmail_message_id, gmail_thread_id)
         VALUES (?, ?, ?, ?, ?)`
      ).run(row.cc_id, account.id, step.step_number, result.gmailMessageId, result.threadId);
    })();

    const next = nextStep(steps, step.step_number, row.li_accepted);
    if (next) {
      scheduleNext(row, next);
      syncAttio(row.attio_record_id, `Étape ${step.step_number}/${steps.length} envoyée`);
    } else {
      db.prepare("UPDATE campaign_contacts SET status = 'completed', next_send_at = NULL WHERE id = ?").run(row.cc_id);
      syncAttio(row.attio_record_id, `Séquence terminée (${steps.length} emails, sans réponse)`);
    }
    console.log(`[send] step ${step.step_number} -> ${to} via ${account.email}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[send] failed for ${to}:`, msg);
    if (handleAuthError(account, msg)) {
      // Account problem, not a contact problem: retry (other account or after reconnection)
      db.prepare("UPDATE campaign_contacts SET next_send_at = ? WHERE id = ?").run(
        Math.round(Date.now() + 15 * 60_000),
        row.cc_id
      );
      return;
    }
    // Retry in 1 to 2 h; after 3 consecutive failures the contact goes to 'failed'
    const failures = (db
      .prepare("SELECT error FROM campaign_contacts WHERE id = ?")
      .get(row.cc_id) as { error: string | null }).error;
    const count = failures?.startsWith("retry:") ? parseInt(failures.split(":")[1], 10) + 1 : 1;
    if (count >= 3) {
      db.prepare(
        "UPDATE campaign_contacts SET status = 'failed', error = ?, next_send_at = NULL WHERE id = ?"
      ).run(msg, row.cc_id);
      syncAttio(row.attio_record_id, "Échec d'envoi ⚠️");
    } else {
      db.prepare("UPDATE campaign_contacts SET error = ?, next_send_at = ? WHERE id = ?").run(
        `retry:${count}:${msg}`,
        Math.round(Date.now() + randBetween(1, 2) * 3600 * 1000),
        row.cc_id
      );
    }
  }
}

// Contacts whose next step is due (active campaign, not opted out with the campaign's owner).
const DUE_SELECT = `
  SELECT cc.id AS cc_id, cc.campaign_id, cc.contact_id, cc.status, cc.current_step,
         cc.account_id, cc.thread_id, cc.last_gmail_message_id, cc.variant, cc.li_accepted,
         cp.account_ids AS campaign_account_ids,
         c.email, c.first_name, c.last_name, c.company, c.linkedin, c.attio_record_id,
         -- enrollment variables (message written for this candidate on this job) take precedence
         CASE WHEN cc.vars IS NULL THEN c.extra WHEN c.extra IS NULL THEN cc.vars
              ELSE json_patch(c.extra, cc.vars) END AS extra
  FROM campaign_contacts cc
  JOIN contacts c ON c.id = cc.contact_id
  JOIN campaigns cp ON cp.id = cc.campaign_id
  WHERE cp.status = 'active'
    AND ${NOT_OPTED_OUT}
    AND cc.status IN ('pending', 'in_progress')
    AND (cc.next_send_at IS NULL OR cc.next_send_at <= @now)`;

const NEXT_IS_LINKEDIN = `EXISTS (SELECT 1 FROM steps s
  WHERE s.campaign_id = cc.campaign_id AND s.step_number = cc.current_step + 1 AND s.channel = 'linkedin')`;

// Outside the email queue: LinkedIn step, or contact without email (the email step is
// skipped without waiting for the send window or quotas).
const NOT_EMAIL_WORK = `(${NEXT_IS_LINKEDIN} OR c.email IS NULL)`;

/**
 * Earliest estimate of the next email: due or scheduled contacts of active campaigns,
 * send window, account quotas and rest. Ignores each campaign's account selection
 * and the tick (1 to 2 min).
 */
export function nextEmailEstimate(ts = Date.now()): { earliest_at: number | null; due_now: number; reason?: string } {
  const dueNow = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM (${DUE_SELECT} AND NOT ${NEXT_IS_LINKEDIN}) WHERE email IS NOT NULL`)
      .get({ now: ts }) as { n: number }
  ).n;
  const scheduled = (
    db
      .prepare(
        `SELECT MIN(cc.next_send_at) AS t
         FROM campaign_contacts cc
         JOIN contacts c ON c.id = cc.contact_id
         JOIN campaigns cp ON cp.id = cc.campaign_id
         WHERE cp.status = 'active' AND ${NOT_OPTED_OUT} AND c.email IS NOT NULL
           AND cc.status IN ('pending', 'in_progress') AND cc.next_send_at > @now
           AND NOT ${NEXT_IS_LINKEDIN}`
      )
      .get({ now: ts }) as { t: number | null }
  ).t;
  if (!dueNow && scheduled == null) {
    return { earliest_at: null, due_now: 0, reason: "aucun email en attente dans une campagne active" };
  }
  const accounts = db.prepare("SELECT * FROM accounts WHERE active = 1").all() as AccountRow[];
  if (!accounts.length) return { earliest_at: null, due_now: dueNow, reason: "aucun compte Google actif" };

  let at = dueNow ? ts : scheduled!;
  // sent_today is only reset at the first tick of the day (UTC date)
  const underQuota = accounts.filter((a) => (a.sent_today_date === today() ? a.sent_today : 0) < effectiveDailyLimit(a));
  if (underQuota.length) {
    at = Math.max(at, Math.min(...underQuota.map((a) => a.next_allowed_at ?? 0)));
  } else {
    at = Math.max(at, Date.parse(`${today()}T00:00:00Z`) + 24 * 3600 * 1000);
  }
  if (!inSendWindow(new Date(at))) at = nextSendWindowOpen(at);
  return { earliest_at: at, due_now: dueNow, ...(underQuota.length ? {} : { reason: "quota du jour atteint sur tous les comptes actifs" }) };
}

/**
 * One send tick, two separate queues so neither blocks the other:
 * - LinkedIn steps: just queued, at any hour; LinkedIn hours, caps and pace apply
 *   when the action is served (outreach.ts);
 * - emails: a few due contacts, within the send window. An email waiting for quota
 *   or delay stays at the head of this queue without holding back LinkedIn.
 */
export async function sendTick(): Promise<void> {
  resetDailyCounters();
  const now = Date.now();

  const linkedinDue = db
    .prepare(`${DUE_SELECT} AND ${NOT_EMAIL_WORK} ORDER BY COALESCE(cc.next_send_at, 0) ASC, cc.id ASC LIMIT 200`)
    .all({ now }) as DueRow[];
  for (const row of linkedinDue) await processOne(row);

  if (!inSendWindow()) return;
  const due = db
    .prepare(`${DUE_SELECT} AND NOT ${NOT_EMAIL_WORK} ORDER BY COALESCE(cc.next_send_at, 0) ASC LIMIT 5`)
    .all({ now }) as DueRow[];

  for (const row of due) {
    await processOne(row);
    // Random pause between two sends of the same tick
    await new Promise((r) => setTimeout(r, randBetween(2000, 8000)));
  }
}

/**
 * Removes the contact from the workflow (terminal status) and, if asked, opts them out
 * with the campaign's owner: their other campaigns with that owner stop, other clients'
 * continue (opt-out.ts). Queued LinkedIn actions are cancelled: a reply on any channel
 * stops all channels.
 */
export function terminate(
  row: { cc_id: number; contact_id: number; attio_record_id: string | null },
  status: "replied" | "opted_out" | "bounced",
  blacklist: boolean,
  attioLabel: string
): void {
  db.transaction(() => {
    db.prepare(
      "UPDATE campaign_contacts SET status = ?, replied_at = ?, next_send_at = NULL WHERE id = ?"
    ).run(status, Date.now(), row.cc_id);
    cancelLinkedInActions(`campaign_contact_id = ?`, row.cc_id, `séquence arrêtée (${status})`);
    if (blacklist) optOutFromCampaignOf(row.cc_id, status === "bounced" ? "adresse email invalide" : "refus du contact");
  })();
  syncAttio(row.attio_record_id, attioLabel);
}

/**
 * Checks active threads and classifies each incoming message:
 * - bounce               -> 'bounced', address blacklisted if permanent (protects deliverability)
 * - auto-reply (OOO)     -> follow-up postponed by ~7 days, sequence continues
 * - refusal / opt-out    -> 'opted_out' + opted out with the campaign's owner
 * - real reply           -> 'replied', removed from the workflow
 */
export async function checkRepliesTick(): Promise<void> {
  const rows = db
    .prepare(
      `SELECT cc.id AS cc_id, cc.thread_id, cc.account_id, cc.status, cc.handled_msgs,
              c.id AS contact_id, c.email, c.attio_record_id
       FROM campaign_contacts cc
       JOIN contacts c ON c.id = cc.contact_id
       WHERE cc.status IN ('in_progress', 'completed', 'awaiting_li')
         AND cc.thread_id IS NOT NULL
         AND cc.replied_at IS NULL
       LIMIT 100`
    )
    .all() as Array<{
      cc_id: number;
      thread_id: string;
      account_id: number;
      status: string;
      handled_msgs: string | null;
      contact_id: number;
      email: string;
      attio_record_id: string | null;
    }>;

  const badAccounts = new Set<number>();
  for (const row of rows) {
    if (badAccounts.has(row.account_id)) continue;
    const account = accountById(row.account_id);
    if (!account) continue;
    try {
      const messages = await getForeignMessages(account, row.thread_id);
      if (!messages.length) continue;
      const handled: string[] = JSON.parse(row.handled_msgs ?? "[]");
      let handledChanged = false;
      let terminal = false;

      for (const m of messages) {
        if (handled.includes(m.id)) continue;

        if (isBounce(m)) {
          // Blacklist only on a permanent bounce; a temporary one (full mailbox…) just stops
          // the sequence. The delivery-status part carries the authoritative code (Status: 5.x.x);
          // the readable text does not always.
          const hard = isHardBounce(`${m.deliveryStatus}\n${m.text}`);
          terminate(row, "bounced", hard, hard ? "Email invalide (bounce) ⚠️" : "Email en erreur (bounce temporaire)");
          console.log(`[bounce] ${row.email}: ${hard ? "dead address, blacklisted" : "temporary failure"}, sequence stopped`);
          terminal = true;
          break;
        }
        if (isAutoReply(m)) {
          handled.push(m.id);
          handledChanged = true;
          if (row.status === "in_progress") {
            db.prepare("UPDATE campaign_contacts SET next_send_at = ? WHERE id = ?").run(
              Math.round(Date.now() + 7 * 24 * 3600 * 1000 + randBetween(0, 8 * 3600 * 1000)),
              row.cc_id
            );
            console.log(`[ooo] ${row.email}: auto-reply, follow-up postponed by ~7 days`);
          }
          continue;
        }
        const optedOut = isOptOut(stripQuoted(m.text));
        terminate(
          row,
          optedOut ? "opted_out" : "replied",
          optedOut,
          optedOut ? "Pas intéressé / désinscrit 🚫" : "A répondu ✅"
        );
        console.log(
          `[reply] ${row.email} ${optedOut ? "opted out" : "replied"}, removed from the workflow`
        );
        terminal = true;
        break;
      }

      if (handledChanged && !terminal) {
        db.prepare("UPDATE campaign_contacts SET handled_msgs = ? WHERE id = ?").run(
          JSON.stringify(handled),
          row.cc_id
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[reply] check failed for ${row.email}:`, msg);
      if (handleAuthError(account, msg)) badAccounts.add(account.id); // keep going with the other accounts
    }
    await new Promise((r) => setTimeout(r, randBetween(300, 1200)));
  }
}

let started = false;

/** Starts the loops with slightly random intervals. */
export function startScheduler(): void {
  if (started) return;
  started = true;

  const loop = (fn: () => Promise<void>, minMs: number, maxMs: number) => {
    const run = async () => {
      try {
        await fn();
      } catch (err) {
        console.error("[scheduler]", err instanceof Error ? err.message : err);
      }
      setTimeout(run, randBetween(minMs, maxMs));
    };
    setTimeout(run, randBetween(2000, 10000));
  };

  loop(sendTick, 45_000, 120_000); // sends: every ~1-2 min
  loop(checkRepliesTick, 4 * 60_000, 7 * 60_000); // replies: every ~4-7 min
  console.log("[scheduler] started (sending + reply detection)");
}
