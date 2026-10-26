/**
 * LinkedIn replies: an account's executor (extension or runner) reads the recent conversation list
 * (action 'sync_inbox') and hands it over here. It is matched against the contacts THIS account
 * reached: a conversation whose last message is from the contact, after our first action, counts as
 * a reply — the sequence stops on all channels (no more emails or LinkedIn messages), as for an
 * email reply.
 * A conversation whose last message is ours but is not one the sequence sent (the user answered by
 * hand before the list was read) also counts: the contact wrote in between, else the user wouldn't
 * have answered.
 * Matching: by profile URL when the list provides it, else by full name (no accents or
 * punctuation), and only if it identifies a single contact of the account. When in doubt, no
 * conclusion: one follow-up too many beats a sequence stopped by mistake… except for an unread
 * conversation, a strong signal accepted even without a readable date.
 */
import { db } from "../db.js";
import { linkedinSlug } from "./linkedin-url.js";
import { cancelLinkedInActions, type LiAccount } from "./outreach.js";
import { isOptOut, terminate } from "./scheduler.js";

const DAY_MS = 24 * 3600 * 1000;
const WATCH_DAYS = 45;

export interface LiConversation {
  name?: string | null;
  thread_url?: string | null;
  profile_url?: string | null;
  snippet?: string | null;
  time?: string | null;
  unread?: boolean;
}

interface Watched {
  cc_id: number;
  contact_id: number;
  first_name: string | null;
  last_name: string | null;
  linkedin: string | null;
  attio_record_id: string | null;
  first_sent_at: number;
}

/** Lowercase, no accents or punctuation, single spaces; strips ", PhD" & co. */
export function normName(s: string | null | undefined): string {
  return (s ?? "")
    .split(/[,|(]/)[0]
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const FROM_US = /^\s*(vous|you)\s*:\s*/i;

/** Last message written by us? (« Vous : … » / « You: … » at the start of the snippet) */
export function lastFromUs(snippet: string | null | undefined): boolean {
  return FROM_US.test(snippet ?? "");
}

/**
 * Our snippet (« Vous : … », cut short by LinkedIn) is one of the sequence's messages or invite
 * notes? Compared on the start of the text, without accents or punctuation.
 */
export function sentBySequence(snippet: string | null | undefined, bodies: Array<string | null>): boolean {
  const raw = (snippet ?? "").replace(FROM_US, "").trim();
  if (!raw) return true; // nothing readable: no conclusion
  const ours = normName(raw.replace(/[,|(]/g, " "));
  if (!ours) return false; // emoji only (« Vous : 👍 »): never a sequence message
  return bodies.some((b) => {
    const body = normName((b ?? "").replace(/[,|(]/g, " "));
    return body !== "" && (body.startsWith(ours) || ours.startsWith(body));
  });
}

const MONTHS: Record<string, number> = {
  janv: 0, jan: 0, fevr: 1, fev: 1, feb: 1, mars: 2, mar: 2, avr: 3, apr: 3, mai: 4, may: 4, juin: 5, jun: 5,
  juil: 6, jul: 6, aout: 7, aug: 7, sept: 8, sep: 8, oct: 9, nov: 10, dec: 11,
};
const WEEKDAYS: Record<string, number> = {
  dim: 0, sun: 0, lun: 1, mon: 1, mar: 2, tue: 2, mer: 3, wed: 3, jeu: 4, thu: 4, ven: 5, fri: 5, sam: 6, sat: 6,
};

/**
 * Date (start of day) of a conversation-list timestamp: « 14:32 » / « 2:32 PM » (today), « hier » /
 * « Yesterday », « lun. » (last 7 days), « 12 sept. » / « Sep 12 » (this year, else last year), «
 * 12 sept. 2025 ». Null if unreadable.
 */
export function parseLiTime(raw: string | null | undefined, now = Date.now()): number | null {
  const s = normName(raw);
  if (!s) return null;
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = new Date(now);
  if (/^\d{1,2} \d{2}( am| pm)?$/.test(s) || /^\d{1,2}h\d{2}$/.test(s)) return day(today);
  if (s === "hier" || s === "yesterday") return day(today) - DAY_MS;
  const wd = WEEKDAYS[s.slice(0, 3)];
  if (wd !== undefined && s.length <= 9 && !/\d/.test(s)) {
    const back = (today.getDay() - wd + 7) % 7 || 7;
    return day(today) - back * DAY_MS;
  }
  const m = s.match(/^(\d{1,2}) ([a-z]+)(?: (\d{4}))?$/) ?? s.match(/^([a-z]+) (\d{1,2})(?: (\d{4}))?$/);
  if (m) {
    const [dayStr, monStr] = /^\d/.test(m[1]) ? [m[1], m[2]] : [m[2], m[1]];
    const month = MONTHS[monStr] ?? MONTHS[monStr.slice(0, 4)] ?? MONTHS[monStr.slice(0, 3)];
    if (month === undefined) return null;
    let year = m[3] ? Number(m[3]) : today.getFullYear();
    let t = new Date(year, month, Number(dayStr)).getTime();
    if (!m[3] && t > now) t = new Date(--year, month, Number(dayStr)).getTime();
    return t;
  }
  return null;
}

/** The account's contacts awaiting a reply, with the date of our first action. */
function watched(accountId: number): Watched[] {
  return db
    .prepare(
      `SELECT cc.id AS cc_id, c.id AS contact_id, c.first_name, c.last_name, c.linkedin, c.attio_record_id,
              (SELECT MIN(la.sent_at) FROM li_actions la WHERE la.campaign_contact_id = cc.id AND la.status = 'sent') AS first_sent_at
       FROM campaign_contacts cc
       JOIN contacts c ON c.id = cc.contact_id
       WHERE cc.li_account_id = ? AND cc.replied_at IS NULL
         AND cc.status IN ('awaiting_li', 'in_progress', 'completed')
         AND EXISTS (SELECT 1 FROM li_actions la WHERE la.campaign_contact_id = cc.id AND la.status = 'sent' AND la.sent_at > ?)`
    )
    .all(accountId, Date.now() - WATCH_DAYS * DAY_MS) as Watched[];
}

export interface InboxReport {
  conversations: number;
  replied: Array<{ cc_id: number; name: string; opted_out: boolean }>;
  ambiguous: string[];
  unmatched: number; // last message from the other side, but no watched contact of that name
  stale: number; // matched, but older than our first action (or unread not set)
}

/** Processes the conversation list read by the account's executor. */
export function processInbox(account: LiAccount, conversations: LiConversation[]): InboxReport {
  const report: InboxReport = { conversations: conversations.length, replied: [], ambiguous: [], unmatched: 0, stale: 0 };
  const pool = watched(account.id);
  if (!pool.length) {
    console.log(`[linkedin] inbox read (${account.name}): ${conversations.length} conversations, no contact to watch`);
    return report;
  }

  const bySlug = new Map<string, Watched>();
  const byName = new Map<string, Watched[]>();
  for (const w of pool) {
    const slug = linkedinSlug(w.linkedin);
    if (slug) bySlug.set(slug, w);
    const n = normName(`${w.first_name ?? ""} ${w.last_name ?? ""}`);
    if (n.includes(" ")) byName.set(n, [...(byName.get(n) ?? []), w]); // first AND last name, else too ambiguous
  }

  const bodies = db.prepare(`SELECT body FROM li_actions WHERE campaign_contact_id = ? AND status = 'sent'`);
  const done = new Set<number>();
  for (const conv of conversations) {
    if (!conv) continue;
    const fromUs = lastFromUs(conv.snippet);
    let match: Watched | undefined;
    const slug = linkedinSlug(conv.profile_url);
    if (slug) match = bySlug.get(slug);
    if (!match) {
      const cands = byName.get(normName(conv.name)) ?? [];
      if (cands.length > 1) report.ambiguous.push(conv.name ?? "?");
      if (cands.length === 1) match = cands[0];
    }
    if (!match) {
      if (!fromUs) report.unmatched++;
      continue;
    }
    if (done.has(match.cc_id)) continue;
    // We spoke last: a reply only if that message isn't the sequence's (answered by hand).
    if (fromUs && sentBySequence(conv.snippet, (bodies.all(match.cc_id) as Array<{ body: string | null }>).map((r) => r.body))) continue;

    // The contact's message must postdate our first action (else it's an old conversation); unread
    // = accepted.
    const at = parseLiTime(conv.time);
    const firstDay = new Date(match.first_sent_at);
    firstDay.setHours(0, 0, 0, 0);
    const recent = at != null ? at >= firstDay.getTime() : Boolean(conv.unread);
    if (!recent) {
      report.stale++;
      continue;
    }

    done.add(match.cc_id);
    const optedOut = !fromUs && isOptOut(conv.snippet ?? "");
    terminate(
      { cc_id: match.cc_id, contact_id: match.contact_id, attio_record_id: match.attio_record_id },
      optedOut ? "opted_out" : "replied",
      optedOut,
      optedOut ? "Pas intéressé / désinscrit 🚫 (LinkedIn)" : "A répondu ✅ (LinkedIn)"
    );
    db.prepare("UPDATE campaign_contacts SET li_thread_url = COALESCE(?, li_thread_url), li_reply_text = ? WHERE id = ?").run(
      conv.thread_url ?? null,
      fromUs ? null : conv.snippet?.trim().slice(0, 2000) || null, // our answer isn't the contact's text
      match.cc_id
    );
    report.replied.push({ cc_id: match.cc_id, name: conv.name ?? "?", opted_out: optedOut });
    console.log(
      `[linkedin] ${conv.name} replied on LinkedIn (${account.name})${optedOut ? " — opted out" : ""}${fromUs ? " — already answered by hand" : ""} — sequence stopped`
    );
  }
  console.log(
    `[linkedin] inbox read (${account.name}): ${conversations.length} conversations, ${pool.length} watched, ` +
      `${report.replied.length} replies, ${report.unmatched} from unknown contacts, ${report.ambiguous.length} ambiguous, ${report.stale} older than our first action`
  );
  return report;
}

/**
 * Reply seen by the executor in the conversation when about to send a message (content.js,
 * threadGuard): nothing went out. The sequence stops as for a reply read from the inbox (recognized
 * refusal → opted out with the owner). Returns false if the action isn't this account's.
 */
export function processThreadReply(account: LiAccount, actionId: number, text: string): boolean {
  const row = db
    .prepare(
      `SELECT la.li_account_id, cc.id AS cc_id, cc.contact_id, c.attio_record_id, c.first_name, c.last_name
       FROM li_actions la
       JOIN campaign_contacts cc ON cc.id = la.campaign_contact_id
       JOIN contacts c ON c.id = cc.contact_id
       WHERE la.id = ?`
    )
    .get(actionId) as
    | { li_account_id: number | null; cc_id: number; contact_id: number; attio_record_id: string | null; first_name: string | null; last_name: string | null }
    | undefined;
  if (!row || row.li_account_id !== account.id) return false;
  const optedOut = isOptOut(text);
  terminate(
    { cc_id: row.cc_id, contact_id: row.contact_id, attio_record_id: row.attio_record_id },
    optedOut ? "opted_out" : "replied",
    optedOut,
    optedOut ? "Pas intéressé / désinscrit 🚫 (LinkedIn)" : "A répondu ✅ (LinkedIn)"
  );
  if (text.trim()) db.prepare("UPDATE campaign_contacts SET li_reply_text = ? WHERE id = ?").run(text.trim().slice(0, 2000), row.cc_id);
  // terminate cancelled the pending action: record why it didn't go out
  db.prepare("UPDATE li_actions SET error = ? WHERE id = ?").run("le contact a écrit dans la conversation — message non envoyé", actionId);
  const name = [row.first_name, row.last_name].filter(Boolean).join(" ") || `contact #${row.contact_id}`;
  console.log(`[linkedin] ${name} wrote in the conversation (${account.name})${optedOut ? " — opted out" : ""} — message held back, sequence stopped`);
  return true;
}

/**
 * Message held back by the executor because the conversation already holds a message of ours that
 * the sequence did not write (sent by hand, or by another campaign): the contact's sequence stops
 * on all channels. Returns false if the action isn't this account's.
 */
export function processAlreadyMessaged(account: LiAccount, actionId: number): boolean {
  const row = db
    .prepare(
      `SELECT la.li_account_id, la.status, cc.id AS cc_id, c.first_name, c.last_name, c.id AS contact_id
       FROM li_actions la
       JOIN campaign_contacts cc ON cc.id = la.campaign_contact_id
       JOIN contacts c ON c.id = cc.contact_id
       WHERE la.id = ?`
    )
    .get(actionId) as
    | { li_account_id: number | null; status: string; cc_id: number; first_name: string | null; last_name: string | null; contact_id: number }
    | undefined;
  if (!row || row.li_account_id !== account.id) return false;
  if (row.status !== "sending") return true; // cancelled meanwhile (reply, stop): nothing to do
  const reason = "déjà en conversation LinkedIn avec ce contact (message hors séquence) — non envoyé";
  db.transaction(() => {
    db.prepare(
      `UPDATE campaign_contacts SET status = 'stopped', next_send_at = NULL, error = ?
       WHERE id = ? AND status IN ('pending', 'in_progress', 'awaiting_li')`
    ).run(`LinkedIn (${account.name}) : ${reason}`, row.cc_id);
    cancelLinkedInActions(`campaign_contact_id = ?`, row.cc_id, reason);
  })();
  const name = [row.first_name, row.last_name].filter(Boolean).join(" ") || `contact #${row.contact_id}`;
  console.log(`[linkedin] ${name}: conversation already holds a message of ours (${account.name}) — message held back, sequence stopped`);
  return true;
}
