/**
 * LinkedIn replies: an account's executor (extension or runner) reads the recent conversation list
 * (action 'sync_inbox') and hands it over here. It is matched against the contacts THIS account
 * reached: a conversation whose last message is from the contact, after our first action, counts as
 * a reply — the sequence stops on all channels (no more emails or LinkedIn messages), as for an
 * email reply.
 * A conversation whose last message is ours but is not one the sequence sent (written by hand, or an
 * attachment: « You sent an attachment ») is ambiguous: the contact may have written in between, or
 * the user followed up by hand. An executor that reads threads is asked to open that conversation
 * once (readThreads); its messages decide: a message from the contact after the sequence's = reply,
 * else ours only = the user took over by hand, the sequence stops without counting as a reply. An
 * executor that doesn't (runner) keeps the old rule: it counts as a reply.
 * Passive reading (processSeenThread): the extension also reads, without a request to LinkedIn, the
 * conversations the user opens in their own tabs. That settles the same question at once (writing
 * by hand means having the thread open), and fills in the full text of replies. The executor only
 * opens a conversation the user never had on screen (followed up from the phone).
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
  first_sent_at: number;
  li_thread_read: string | null;
  li_thread_url: string | null;
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
// What we did without text: « You sent an attachment », « Vous avez envoyé une pièce jointe », «
// You reacted 👍 to… »; compared without accents.
const OUR_EVENT = /^(you (sent|shared|reacted|forwarded)|vous avez (envoye|partage|reagi|transfere)) /;

/** Last message written by us? (« Vous : … » / « You: … », or one of our attachments, reactions…) */
export function lastFromUs(snippet: string | null | undefined): boolean {
  return FROM_US.test(snippet ?? "") || OUR_EVENT.test(normName(snippet));
}

// li_thread_read written by a passive read: SEEN + the thread's last message ("" = attachment).
const SEEN = "seen:";

/** Our last message in the snippet is the one the user already had on screen (passive read)? */
function seenLast(memo: string | null, snippet: string): boolean {
  if (!memo?.startsWith(SEEN)) return false;
  const last = memo.slice(SEEN.length);
  if (OUR_EVENT.test(normName(snippet))) return last === "";
  return last !== "" && sentBySequence(snippet, [last]);
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

/**
 * The account's contacts awaiting a reply, with the date of our first action. Stopped ones too: a
 * sequence stopped because the user wrote by hand still waits for the contact's answer. `replied`:
 * those who already replied instead (passive read: full text of their reply).
 */
function watched(accountId: number, replied = false): Watched[] {
  return db
    .prepare(
      `SELECT cc.id AS cc_id, c.id AS contact_id, c.first_name, c.last_name, c.linkedin,
              (SELECT MIN(la.sent_at) FROM li_actions la WHERE la.campaign_contact_id = cc.id AND la.status = 'sent') AS first_sent_at,
              cc.li_thread_read, cc.li_thread_url
       FROM campaign_contacts cc
       JOIN contacts_v c ON c.id = cc.contact_id
       WHERE cc.li_account_id = ? AND ${
         replied
           ? "cc.replied_at IS NOT NULL AND cc.status IN ('replied', 'opted_out')"
           : "cc.replied_at IS NULL AND cc.status IN ('awaiting_li', 'in_progress', 'completed', 'stopped')"
       }
         AND EXISTS (SELECT 1 FROM li_actions la WHERE la.campaign_contact_id = cc.id AND la.status = 'sent' AND la.sent_at > ?)`
    )
    .all(accountId, Date.now() - WATCH_DAYS * DAY_MS) as Watched[];
}

// The sequence's messages to a contact; 'sending' too: just written, its verdict not back yet.
const SEQUENCE_BODIES = `SELECT body FROM li_actions WHERE campaign_contact_id = ? AND status IN ('sent', 'sending')`;

/** A conversation the executor is asked to open: its last message is ours, not the sequence's. */
export interface ThreadToRead {
  thread_url: string;
  cc_ids: number[];
  snippet: string; // echoed back with the messages: once read, this snippet isn't read again
}

export interface InboxReport {
  conversations: number;
  replied: Array<{ cc_id: number; name: string; opted_out: boolean }>;
  ambiguous: string[];
  unmatched: number; // last message from the other side, but no watched contact of that name
  stale: number; // matched, but older than our first action (or unread not set)
  read_threads: ThreadToRead[];
}

/**
 * Processes the conversation list read by the account's executor. `readsThreads`: the executor can
 * open a conversation (readThreads) — the ambiguous ones go in `read_threads` instead of counting as
 * replies.
 */
export function processInbox(account: LiAccount, conversations: LiConversation[], readsThreads = false): InboxReport {
  const report: InboxReport = { conversations: conversations.length, replied: [], ambiguous: [], unmatched: 0, stale: 0, read_threads: [] };
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

  const bodies = db.prepare(SEQUENCE_BODIES);
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
    // We spoke last: nothing new if that message is the sequence's.
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
    const snippet = conv.snippet?.trim() ?? "";
    if (fromUs && match.li_thread_read === snippet) continue; // already settled by reading its thread
    if (fromUs && seenLast(match.li_thread_read, snippet)) {
      // the user had this thread on screen after that message: settled then, no click
      db.prepare("UPDATE campaign_contacts SET li_thread_read = ? WHERE id = ?").run(snippet, match.cc_id);
      continue;
    }
    if (fromUs && readsThreads) {
      // By hand or not? The thread says, read once per snippet.
      if (conv.thread_url) report.read_threads.push({ thread_url: conv.thread_url, cc_ids: [match.cc_id], snippet });
      continue;
    }
    const optedOut = !fromUs && isOptOut(conv.snippet ?? "");
    terminate({ cc_id: match.cc_id, contact_id: match.contact_id }, optedOut ? "opted_out" : "replied", optedOut);
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
      `${report.replied.length} replies, ${report.unmatched} from unknown contacts, ${report.ambiguous.length} ambiguous, ${report.stale} older than our first action` +
      (report.read_threads.length ? `, ${report.read_threads.length} conversation(s) to read` : "")
  );
  return report;
}

/** Message of a conversation read by the executor: `mine` null = author unreadable; `seen`: LinkedIn's
 *  read receipt (the contact's photo) under it. */
export interface ThreadMessage {
  mine: boolean | null;
  text: string;
  seen?: boolean;
}

export interface ThreadRead extends ThreadToRead {
  ok?: boolean;
  messages?: ThreadMessage[];
  error?: string;
}

// Same key as the extension's (content.js, textKey): first 200 characters, no accents, single spaces.
const textKey = (s: string | null | undefined) =>
  (s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);

export type ThreadVerdict =
  | { kind: "replied"; text: string }
  | { kind: "by_hand" }
  | { kind: "nothing" } // nothing after the sequence's messages
  | { kind: "unknown"; why: string };

/**
 * What a conversation says, read because its last message is ours but not the sequence's. Only what
 * follows the sequence's first message counts (before it: an older conversation); without it in
 * the thread, the whole thread when the sequence's invitation made the relation, else no
 * conclusion. A message from the contact = reply; ours outside the sequence = written by hand. An
 * attachment comes with an empty text.
 */
export function threadVerdict(messages: ThreadMessage[], bodies: Array<string | null>, invited: boolean): ThreadVerdict {
  if (!messages.length) return { kind: "unknown", why: "conversation vide ou illisible" };
  const anchors = new Set(bodies.map(textKey).filter(Boolean));
  const msgs = messages.map((m) => (anchors.has(textKey(m.text)) ? { ...m, mine: true } : m));
  const first = msgs.findIndex((m) => anchors.has(textKey(m.text)));
  if (first < 0 && !invited) return { kind: "unknown", why: "message de la séquence absent du fil" };
  const scope = first >= 0 ? msgs.slice(first + 1) : msgs;
  const theirs = scope.filter((m) => m.mine === false);
  if (theirs.length) return { kind: "replied", text: theirs.map((m) => m.text.trim() || "(pièce jointe)").join("\n\n") };
  const extra = scope.filter((m) => !anchors.has(textKey(m.text)));
  if (extra.some((m) => m.mine === null)) return { kind: "unknown", why: "auteur des messages illisible" };
  return extra.length ? { kind: "by_hand" } : { kind: "nothing" };
}

export interface ThreadsReport {
  replied: Array<{ cc_id: number; name: string; opted_out: boolean }>;
  by_hand: number[];
  unknown: number;
}

interface Settled {
  cc_id: number;
  contact_id: number;
  first_name: string | null;
  last_name: string | null;
}

/**
 * Applies what a conversation says to a contact awaiting a reply. Reply: the sequence stops as from
 * the inbox, with the contact's messages as text. Written by hand: the sequence stops (status
 * stopped), no reply, and the contact stays watched. `memo` goes in li_thread_read.
 */
function settle(row: Settled, account: LiAccount, verdict: ThreadVerdict, memo: string, how: string, report: ThreadsReport): void {
  const name = [row.first_name, row.last_name].filter(Boolean).join(" ") || `contact #${row.contact_id}`;
  if (verdict.kind === "unknown") {
    report.unknown++;
    console.log(`[linkedin] ${name}: conversation ${how}, no conclusion (${account.name}): ${verdict.why}`);
    return;
  }
  db.prepare("UPDATE campaign_contacts SET li_thread_read = ? WHERE id = ?").run(memo, row.cc_id);
  if (verdict.kind === "replied") {
    const optedOut = isOptOut(verdict.text);
    terminate({ cc_id: row.cc_id, contact_id: row.contact_id }, optedOut ? "opted_out" : "replied", optedOut);
    db.prepare("UPDATE campaign_contacts SET li_reply_text = ? WHERE id = ?").run(verdict.text.slice(0, 2000), row.cc_id);
    report.replied.push({ cc_id: row.cc_id, name, opted_out: optedOut });
    console.log(`[linkedin] ${name} replied on LinkedIn (${account.name}, conversation ${how})${optedOut ? " — opted out" : ""} — sequence stopped`);
  } else if (verdict.kind === "by_hand") {
    const reason = "message écrit à la main dans la conversation LinkedIn — séquence arrêtée, pas une réponse";
    db.transaction(() => {
      db.prepare(
        `UPDATE campaign_contacts SET status = 'stopped', next_send_at = NULL, error = ?
         WHERE id = ? AND status IN ('pending', 'in_progress', 'awaiting_li')`
      ).run(`LinkedIn (${account.name}) : ${reason}`, row.cc_id);
      cancelLinkedInActions(`campaign_contact_id = ?`, row.cc_id, reason);
    })();
    report.by_hand.push(row.cc_id);
    console.log(`[linkedin] ${name}: message written by hand (${account.name}, conversation ${how}), no reply — sequence stopped`);
  }
}

const invitedSql = `EXISTS (SELECT 1 FROM li_actions la WHERE la.campaign_contact_id = ? AND la.type = 'invite' AND la.status = 'sent') AS invited`;

/**
 * Conversations opened by the executor (read_threads of the inbox read). `accounts`: those of the
 * executor's LinkedIn profile, the only ones whose contacts it may settle. Nothing after the
 * sequence's messages counts as by hand here: the snippet showed an action of ours (attachment…).
 */
export function processThreads(accounts: LiAccount[], threads: ThreadRead[]): ThreadsReport {
  const report: ThreadsReport = { replied: [], by_hand: [], unknown: 0 };
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const rowOf = db.prepare(
    `SELECT cc.id AS cc_id, cc.contact_id, cc.li_account_id, cc.replied_at, c.first_name, c.last_name, ${invitedSql}
     FROM campaign_contacts cc
     JOIN contacts_v c ON c.id = cc.contact_id
     WHERE cc.id = ?`
  );
  const bodies = db.prepare(SEQUENCE_BODIES);
  for (const t of threads.slice(0, 10)) {
    if (!t || !Array.isArray(t.cc_ids)) continue;
    for (const ccId of t.cc_ids.slice(0, 5)) {
      const row = rowOf.get(Number(ccId), Number(ccId)) as
        | (Settled & { li_account_id: number | null; replied_at: number | null; invited: number | boolean })
        | undefined;
      const account = row?.li_account_id != null ? byId.get(row.li_account_id) : undefined;
      if (!row || !account || row.replied_at != null) continue;
      const verdict: ThreadVerdict = t.ok
        ? threadVerdict(cleanMessages(t.messages), (bodies.all(row.cc_id) as Array<{ body: string | null }>).map((r) => r.body), Boolean(row.invited))
        : { kind: "unknown", why: t.error || "lecture impossible" };
      // Read once per snippet, whatever it said: no new click until the conversation moves.
      const memo = typeof t.snippet === "string" ? t.snippet : "";
      if (verdict.kind === "unknown") db.prepare("UPDATE campaign_contacts SET li_thread_read = ? WHERE id = ?").run(memo, row.cc_id);
      if (typeof t.thread_url === "string") {
        db.prepare("UPDATE campaign_contacts SET li_thread_url = COALESCE(li_thread_url, ?) WHERE id = ?").run(t.thread_url, row.cc_id);
      }
      if (t.ok) {
        markSeen(row.cc_id, seenTexts(cleanMessages(t.messages)));
        keepThread(row.cc_id, cleanMessages(t.messages), t.thread_url);
      }
      settle(row, account, verdict.kind === "nothing" ? { kind: "by_hand" } : verdict, memo, "opened", report);
    }
  }
  return report;
}

function cleanMessages(raw: unknown): ThreadMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => m && typeof m.text === "string")
    .slice(-50)
    .map((m) => ({ mine: typeof m.mine === "boolean" ? m.mine : null, text: String(m.text).slice(0, 2000), seen: m.seen === true }));
}

/** Our messages up to the last one LinkedIn shows as seen by the contact (read receipt). */
export function seenTexts(messages: ThreadMessage[]): string[] {
  let last = -1;
  messages.forEach((m, i) => {
    if (m.seen) last = i;
  });
  return messages.slice(0, last + 1).filter((m) => m.mine !== false && m.text.trim()).map((m) => m.text);
}

/** The sequence's LinkedIn messages to this contact found among `texts` (seen): seen_at set, once. */
export function markSeen(ccId: number, texts: string[]): number {
  const keys = new Set(texts.map(textKey).filter(Boolean));
  if (!keys.size) return 0;
  const rows = db
    .prepare(`SELECT id, body FROM li_actions WHERE campaign_contact_id = ? AND type = 'message' AND status = 'sent' AND seen_at IS NULL`)
    .all(ccId) as Array<{ id: number; body: string | null }>;
  const now = Date.now();
  let n = 0;
  for (const r of rows) {
    if (keys.has(textKey(r.body))) n += db.prepare("UPDATE li_actions SET seen_at = ? WHERE id = ? AND seen_at IS NULL").run(now, r.id).changes;
  }
  return n;
}

/**
 * Read receipts seen by the executor in the conversation just before sending a follow-up
 * (content.js, doMessage): `texts` = our messages LinkedIn shows as seen. Only this account's action.
 */
export function processSeenBeforeSend(account: LiAccount, actionId: number, texts: unknown): void {
  if (!Array.isArray(texts) || !texts.length) return;
  const row = db.prepare("SELECT campaign_contact_id AS cc_id, li_account_id FROM li_actions WHERE id = ?").get(actionId) as
    | { cc_id: number; li_account_id: number | null }
    | undefined;
  if (!row || row.li_account_id !== account.id) return;
  markSeen(row.cc_id, texts.filter((t): t is string => typeof t === "string").slice(0, 25));
}

/** Keeps the conversation as read (both sides, in order) for the app, and its address. */
function keepThread(ccId: number, messages: ThreadMessage[], threadUrl: string | null | undefined): void {
  if (!messages.length) return;
  db.prepare("UPDATE campaign_contacts SET li_thread = ?, li_thread_url = COALESCE(li_thread_url, ?) WHERE id = ?").run(
    JSON.stringify({ at: Date.now(), messages: messages.map((m) => ({ mine: m.mine, text: m.text, ...(m.seen ? { seen: true } : {}) })) }),
    threadId(threadUrl) ? threadUrl : null,
    ccId
  );
}

const threadId = (url: string | null | undefined) => url?.match(/\/messaging\/thread\/([^/?#]+)/)?.[1] ?? null;

/** Conversation the user had on screen in their own LinkedIn tab, read by the extension (passive). */
export interface SeenThread {
  thread_url?: string | null;
  name?: string | null;
  profile_urls?: unknown;
  messages?: unknown;
  diag?: unknown; // nothing readable on the page: what the extension saw there (element counts)
}

/**
 * A conversation the user opened. Its contact is found among those the accounts reached: by profile
 * link, else by thread, else by full name (single match). Awaiting a reply: settled at once (reply,
 * or written by hand), and remembered so that the executor doesn't open it again. Already replied:
 * the text of the reply is completed with every message the contact wrote.
 */
export function processSeenThread(accounts: LiAccount[], t: SeenThread): ThreadsReport {
  const report: ThreadsReport = { replied: [], by_hand: [], unknown: 0 };
  const messages = cleanMessages(t.messages);
  if (!messages.length) {
    if (t.diag) console.log(`[linkedin] conversation on screen, no message readable: « ${t.name ?? "?"} » ${JSON.stringify(t.diag).slice(0, 600)}`);
    return report;
  }
  const slugs = new Set((Array.isArray(t.profile_urls) ? t.profile_urls : []).map((u) => linkedinSlug(String(u))).filter(Boolean));
  const tid = threadId(t.thread_url);
  const name = normName(t.name);
  const find = (pool: Watched[]) => {
    const bySlug = pool.filter((w) => slugs.has(linkedinSlug(w.linkedin) ?? ""));
    // several contacts in one conversation (group): no conclusion
    if (new Set(bySlug.map((w) => linkedinSlug(w.linkedin))).size > 1) return [];
    if (bySlug.length) return bySlug;
    const byThread = tid ? pool.filter((w) => threadId(w.li_thread_url) === tid) : [];
    if (byThread.length) return byThread;
    // the header may carry more than the name (« Maelle Cabayot · 1st », status): the name first
    const byName = pool.filter((w) => {
      const full = normName(`${w.first_name ?? ""} ${w.last_name ?? ""}`);
      return full.includes(" ") && (name === full || name.startsWith(`${full} `));
    });
    return byName.length === 1 ? byName : [];
  };
  const bodies = db.prepare(SEQUENCE_BODIES);
  const invited = db.prepare(`SELECT ${invitedSql}`);
  const seen = seenTexts(messages);
  const last = messages[messages.length - 1];
  // contact's message last: "§" never matches a snippet of ours
  const memo = SEEN + (last.mine === false ? "§" : last.text.trim().slice(0, 300));
  let matched = 0;
  for (const account of accounts) {
    const awaiting = find(watched(account.id));
    const replied = find(watched(account.id, true));
    matched += awaiting.length + replied.length;
    console.log(
      `[linkedin] conversation on screen (${account.name}): « ${t.name ?? "?"} », ${messages.length} message(s), ` +
        `${seen.length ? "read receipt, " : ""}profiles [${[...slugs].join(", ")}]${tid ? `, thread ${tid}` : ""} — ` +
        (awaiting.length || replied.length ? `contact(s) ${[...awaiting, ...replied].map((w) => w.cc_id).join(", ")}` : "no contact of this account")
    );
    for (const w of awaiting) {
      const verdict = threadVerdict(
        messages,
        (bodies.all(w.cc_id) as Array<{ body: string | null }>).map((r) => r.body),
        Boolean((invited.get(w.cc_id) as { invited: number | boolean }).invited)
      );
      keepThread(w.cc_id, messages, t.thread_url);
      markSeen(w.cc_id, seen);
      settle(w, account, verdict, memo, "seen on screen", report);
    }
    for (const w of replied) {
      const verdict = threadVerdict(
        messages,
        (bodies.all(w.cc_id) as Array<{ body: string | null }>).map((r) => r.body),
        Boolean((invited.get(w.cc_id) as { invited: number | boolean }).invited)
      );
      if (verdict.kind === "replied") db.prepare("UPDATE campaign_contacts SET li_reply_text = ? WHERE id = ?").run(verdict.text.slice(0, 2000), w.cc_id);
      keepThread(w.cc_id, messages, t.thread_url);
      markSeen(w.cc_id, seen);
    }
  }
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
      `SELECT la.li_account_id, cc.id AS cc_id, cc.contact_id, c.first_name, c.last_name
       FROM li_actions la
       JOIN campaign_contacts cc ON cc.id = la.campaign_contact_id
       JOIN contacts_v c ON c.id = cc.contact_id
       WHERE la.id = ?`
    )
    .get(actionId) as
    | { li_account_id: number | null; cc_id: number; contact_id: number; first_name: string | null; last_name: string | null }
    | undefined;
  if (!row || row.li_account_id !== account.id) return false;
  const optedOut = isOptOut(text);
  terminate({ cc_id: row.cc_id, contact_id: row.contact_id }, optedOut ? "opted_out" : "replied", optedOut);
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
       JOIN contacts_v c ON c.id = cc.contact_id
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
