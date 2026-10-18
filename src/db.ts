import Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyVisit } from "./services/botFilter.js";
import { normalizeLinkedin } from "./services/linkedin-url.js";

// Relative to the project (src/../data), not the working directory; override with DATA_DIR
const DATA_DIR = process.env.DATA_DIR ?? fileURLToPath(new URL("../data", import.meta.url));
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, "sequence-mail.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  oauth_tokens TEXT NOT NULL,           -- JSON (access_token, refresh_token, expiry_date)
  daily_limit INTEGER NOT NULL,
  sent_today INTEGER NOT NULL DEFAULT 0,
  sent_today_date TEXT,                 -- YYYY-MM-DD of the sent_today counter
  last_sent_at INTEGER,                 -- epoch ms of the last send
  next_allowed_at INTEGER,              -- epoch ms before which this account must not send
  active INTEGER NOT NULL DEFAULT 1,
  warmup INTEGER NOT NULL DEFAULT 1,    -- auto ramp-up (WARMUP_START/day, +WARMUP_RAMP/week up to the quota)
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'paused',  -- active | paused | archived
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL,          -- 1, 2, 3...
  subject TEXT NOT NULL,                 -- empty for follow-ups => same thread (Re:)
  subject_b TEXT,                        -- subject variant B (A/B test, step 1 only)
  body TEXT NOT NULL,                    -- text with {{first_name}} etc.
  wait_days INTEGER NOT NULL DEFAULT 0,  -- delay after the previous step
  channel TEXT NOT NULL DEFAULT 'email', -- 'email' | 'linkedin'
  li_action TEXT,                        -- if channel='linkedin': 'invite' | 'message'
  UNIQUE (campaign_id, step_number)
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,                     -- NULL = reachable on LinkedIn only
  first_name TEXT,
  last_name TEXT,
  company TEXT,
  linkedin TEXT,                         -- LinkedIn profile URL
  extra TEXT,                            -- JSON: extra CSV columns
  attio_record_id TEXT,
  do_not_contact INTEGER NOT NULL DEFAULT 0, -- opted out of the dashboard (ownerless campaigns; clients: owner_opt_outs)
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS campaign_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | in_progress | replied | opted_out | bounced | completed | stopped | failed
  current_step INTEGER NOT NULL DEFAULT 0, -- last step sent (0 = none)
  variant TEXT,                            -- 'A' or 'B' (step 1 subject A/B test)
  handled_msgs TEXT,                       -- JSON: Gmail ids of already handled messages (e.g. auto-replies)
  next_send_at INTEGER,                    -- epoch ms of the next planned send
  account_id INTEGER REFERENCES accounts(id), -- set on the 1st send, then fixed (thread continuity)
  thread_id TEXT,                          -- Gmail thread
  last_gmail_message_id TEXT,              -- RFC822 Message-ID of the last send (References/In-Reply-To)
  replied_at INTEGER,
  error TEXT,
  UNIQUE (campaign_id, contact_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_contact_id INTEGER NOT NULL REFERENCES campaign_contacts(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  step_number INTEGER NOT NULL,
  gmail_message_id TEXT,
  gmail_thread_id TEXT,
  sent_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_cc_due ON campaign_contacts (status, next_send_at);
CREATE INDEX IF NOT EXISTS idx_cc_campaign ON campaign_contacts (campaign_id);
CREATE INDEX IF NOT EXISTS idx_messages_cc ON messages (campaign_contact_id);

-- Queue of LinkedIn sequence actions (invite / message), filled by the scheduler
-- when a LinkedIn step is due. The executor consumes it at the human pace enforced
-- by outreach.ts (daily caps, hours, random delays): the anti-ban safeguard.
-- Success moves the campaign_contact to the next step.
CREATE TABLE IF NOT EXISTS li_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_contact_id INTEGER NOT NULL REFERENCES campaign_contacts(id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL,          -- sequence step completed on success
  linkedin TEXT NOT NULL,                -- target profile URL
  type TEXT NOT NULL,                    -- 'invite' | 'message'
  body TEXT,                             -- invite note / message body (variables rendered)
  status TEXT NOT NULL DEFAULT 'pending',-- pending | sending | sent | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  lease_at INTEGER,                      -- 'sending' lease (prevents double sends)
  not_before INTEGER,                    -- do not try before (postponed: message to a non-connection)
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_li_actions_status ON li_actions (status);
CREATE INDEX IF NOT EXISTS idx_li_actions_cc ON li_actions (campaign_contact_id);

-- Log of LinkedIn actions actually performed: basis of the daily caps.
CREATE TABLE IF NOT EXISTS li_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                    -- invite | message
  sent_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_li_log_sent ON li_log (sent_at);
`);

// Additive migrations for existing databases
function addColumnIfMissing(table: string, column: string, ddl: string): void {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name
  );
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
addColumnIfMissing("accounts", "from_name", "from_name TEXT");
addColumnIfMissing("accounts", "signature", "signature TEXT");
addColumnIfMissing("contacts", "do_not_contact", "do_not_contact INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("steps", "subject_b", "subject_b TEXT");
addColumnIfMissing("campaign_contacts", "variant", "variant TEXT");
addColumnIfMissing("campaign_contacts", "handled_msgs", "handled_msgs TEXT");
addColumnIfMissing("accounts", "warmup", "warmup INTEGER NOT NULL DEFAULT 1");
addColumnIfMissing("steps", "channel", "channel TEXT NOT NULL DEFAULT 'email'");
addColumnIfMissing("steps", "li_action", "li_action TEXT");
addColumnIfMissing("contacts", "linkedin", "linkedin TEXT");
addColumnIfMissing("campaign_contacts", "visit_token", "visit_token TEXT");
// Warm-up ramps from this date, not account creation, so enabling it on an old account starts low again.
addColumnIfMissing("accounts", "warmup_started_at", "warmup_started_at INTEGER");
// Stable unsubscribe token per campaign contact (List-Unsubscribe header).
addColumnIfMissing("campaign_contacts", "unsub_token", "unsub_token TEXT");
// Sending accounts allowed for the campaign: JSON [ids]; NULL = all, including accounts connected later.
addColumnIfMissing("campaigns", "account_ids", "account_ids TEXT");
db.exec(
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_unsub_token ON campaign_contacts (unsub_token) WHERE unsub_token IS NOT NULL"
);

// Drop the old open/click tracking (pixel + rewritten links), replaced by the {{link}} visit link.
db.exec(`
DROP INDEX IF EXISTS idx_messages_track;
DROP INDEX IF EXISTS idx_email_events_track;
DROP INDEX IF EXISTS idx_tracked_links_track;
DROP TABLE IF EXISTS email_events;
DROP TABLE IF EXISTS tracked_links;
`);
try {
  db.exec("ALTER TABLE messages DROP COLUMN track_id");
} catch {
  // column already gone (recent database)
}

db.exec(`
-- Visits of the personal {{link}}: one stable token per campaign_contact
-- (campaign_contacts.visit_token); one row per opening.
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cc_id INTEGER NOT NULL REFERENCES campaign_contacts(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  user_agent TEXT,
  ip TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0,   -- 1 = bot/scanner visit, excluded from counts
  bot_reason TEXT                       -- classification reason (see services/botFilter.ts)
);
CREATE INDEX IF NOT EXISTS idx_visits_cc ON visits (cc_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_visit_token ON campaign_contacts (visit_token) WHERE visit_token IS NOT NULL;
`);
// Databases created before bot filtering.
addColumnIfMissing("visits", "is_bot", "is_bot INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("visits", "bot_reason", "bot_reason TEXT");

// v1: the signature is no longer appended automatically but placed via {{signature}};
// existing steps get it at the end of the body to keep their exact rendering.
if ((db.pragma("user_version", { simple: true }) as number) < 1) {
  db.exec(
    "UPDATE steps SET body = body || char(10) || char(10) || '{{signature}}' WHERE body NOT LIKE '%{{signature}}%'"
  );
  db.pragma("user_version = 1");
}

// Reclassifies all existing visits (bot vs human) with the current logic: run it when the
// botFilter heuristics change, so "visited" counts stay consistent with new visits.
function reclassifyAllVisits(): void {
  const rows = db.prepare("SELECT id, cc_id, at, user_agent, ip FROM visits").all() as Array<{
    id: number;
    cc_id: number;
    at: number;
    user_agent: string | null;
    ip: string | null;
  }>;
  const prevSend = db.prepare(
    "SELECT MAX(sent_at) AS t FROM messages WHERE campaign_contact_id = ? AND sent_at <= ?"
  );
  const upd = db.prepare("UPDATE visits SET is_bot = ?, bot_reason = ? WHERE id = ?");
  db.transaction(() => {
    for (const r of rows) {
      const sent = (prevSend.get(r.cc_id, r.at) as { t: number | null }).t;
      const delaySeconds = sent != null ? Math.round((r.at - sent) / 1000) : null;
      const v = classifyVisit(r.user_agent, r.ip, delaySeconds);
      upd.run(v.bot ? 1 : 0, v.reason || null, r.id);
    }
  })();
}

// v2: first retroactive classification (user agent + datacenter IP + send-to-click delay).
if ((db.pragma("user_version", { simple: true }) as number) < 2) {
  reclassifyAllVisits();
  db.pragma("user_version = 2");
}

// v3: wider datacenter IP ranges (DigitalOcean, Hetzner, OVH, Linode, Vultr, Scaleway, Oracle).
if ((db.pragma("user_version", { simple: true }) as number) < 3) {
  reclassifyAllVisits();
  db.pragma("user_version = 3");
}

// Multiple LinkedIn accounts, each with its own session (extension or server browser),
// token, caps, delays and pauses. A contact stays bound to the account that first
// reached them: a LinkedIn message can only come from a connection.
db.exec(`
CREATE TABLE IF NOT EXISTS li_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,       -- sha256 of the extension token (X-LI-Account header)
  active INTEGER NOT NULL DEFAULT 1,
  invites_per_day INTEGER,               -- NULL = LI_INVITES_PER_DAY
  messages_per_day INTEGER,              -- NULL = LI_MESSAGES_PER_DAY
  warmup_started_at INTEGER,             -- unused (LinkedIn warm-up removed)
  next_allowed_at INTEGER,               -- random delay between two actions
  paused_until INTEGER,                  -- safety pause after a failure
  last_seen_at INTEGER,                  -- last executor call ("connected")
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
`);
addColumnIfMissing("li_actions", "li_account_id", "li_account_id INTEGER REFERENCES li_accounts(id)");
addColumnIfMissing("li_log", "li_account_id", "li_account_id INTEGER REFERENCES li_accounts(id)");
addColumnIfMissing("campaign_contacts", "li_account_id", "li_account_id INTEGER REFERENCES li_accounts(id)");
// LinkedIn accounts allowed for the campaign: JSON [ids]; NULL = all.
addColumnIfMissing("campaigns", "li_account_ids", "li_account_ids TEXT");
db.exec("CREATE INDEX IF NOT EXISTS idx_li_actions_account ON li_actions (li_account_id, status)");
db.exec("CREATE INDEX IF NOT EXISTS idx_li_log_account ON li_log (li_account_id, sent_at)");

// v4: LinkedIn history from before multi-account belongs to a "main" account,
// which also serves the already installed extension (no token).
if ((db.pragma("user_version", { simple: true }) as number) < 4) {
  db.transaction(() => {
    const hasHistory = db.prepare("SELECT 1 FROM li_actions UNION SELECT 1 FROM li_log LIMIT 1").get();
    const hasAccount = db.prepare("SELECT 1 FROM li_accounts LIMIT 1").get();
    if (hasHistory && !hasAccount) {
      const hash = createHash("sha256").update(randomBytes(24)).digest("hex");
      const first = db.prepare("SELECT MIN(sent_at) AS t FROM li_log").get() as { t: number | null };
      const { lastInsertRowid: id } = db
        .prepare("INSERT INTO li_accounts (name, token_hash, warmup_started_at) VALUES ('Compte principal', ?, ?)")
        .run(hash, first.t);
      db.prepare("UPDATE li_actions SET li_account_id = ? WHERE li_account_id IS NULL").run(id);
      db.prepare("UPDATE li_log SET li_account_id = ? WHERE li_account_id IS NULL").run(id);
      db.prepare(
        `UPDATE campaign_contacts SET li_account_id = ?
         WHERE li_account_id IS NULL AND id IN (SELECT campaign_contact_id FROM li_actions)`
      ).run(id);
    }
    db.pragma("user_version = 4");
  })();
}

// Server browser: a 'server' mode account is driven by the runner (Chromium on the VPS,
// behind its own proxy) with the session sent by the extension. Proxy and session are
// encrypted (LI_SECRET_KEY). last_inbox_at paces the inbox reads that detect replies.
addColumnIfMissing("li_accounts", "mode", "mode TEXT NOT NULL DEFAULT 'extension'"); // extension | server
addColumnIfMissing("li_accounts", "proxy_enc", "proxy_enc TEXT");
addColumnIfMissing("li_accounts", "session_enc", "session_enc TEXT");
addColumnIfMissing("li_accounts", "session_state", "session_state TEXT"); // NULL | ok | expired | checkpoint
addColumnIfMissing("li_accounts", "session_error", "session_error TEXT");
addColumnIfMissing("li_accounts", "session_updated_at", "session_updated_at INTEGER");
addColumnIfMissing("li_accounts", "last_inbox_at", "last_inbox_at INTEGER");
// LinkedIn thread where the contact replied (link in the dashboard).
addColumnIfMissing("campaign_contacts", "li_thread_url", "li_thread_url TEXT");
// Replies page: contact's last LinkedIn message (inbox preview), reply opened, reply handled.
addColumnIfMissing("campaign_contacts", "li_reply_text", "li_reply_text TEXT");
addColumnIfMissing("campaign_contacts", "inbox_seen_at", "inbox_seen_at INTEGER");
addColumnIfMissing("campaign_contacts", "inbox_done_at", "inbox_done_at INTEGER");

// v5: a contact may have only LinkedIn (no known email). SQLite cannot drop a NOT NULL:
// rebuild the table (official procedure, foreign keys off during the swap).
if ((db.pragma("user_version", { simple: true }) as number) < 5) {
  const cols = db.prepare("PRAGMA table_info(contacts)").all() as Array<{ name: string; notnull: number }>;
  if (cols.find((c) => c.name === "email")?.notnull) {
    const names = cols.map((c) => c.name).join(", ");
    db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE contacts_v5 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE,
            first_name TEXT,
            last_name TEXT,
            company TEXT,
            linkedin TEXT,
            extra TEXT,
            attio_record_id TEXT,
            do_not_contact INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
          );
          INSERT INTO contacts_v5 (${names}) SELECT ${names} FROM contacts;
          DROP TABLE contacts;
          ALTER TABLE contacts_v5 RENAME TO contacts;
        `);
        const broken = db.pragma("foreign_key_check") as unknown[];
        if (broken.length) throw new Error(`migration v5 : ${broken.length} clé(s) étrangère(s) cassée(s)`);
      })();
    } finally {
      db.pragma("foreign_keys = ON");
    }
  }
  // Canonical LinkedIn URLs: dedup and matching key.
  const upd = db.prepare("UPDATE contacts SET linkedin = ? WHERE id = ?");
  db.transaction(() => {
    for (const r of db.prepare("SELECT id, linkedin FROM contacts WHERE linkedin IS NOT NULL").all() as Array<{ id: number; linkedin: string }>) {
      const n = normalizeLinkedin(r.linkedin);
      if (n !== r.linkedin) upd.run(n, r.id);
    }
  })();
  db.pragma("user_version = 5");
}
db.exec("CREATE INDEX IF NOT EXISTS idx_contacts_linkedin ON contacts (linkedin)");

// Multiple clients (Azerit): each LinkedIn account and campaign has an owner (owner_ref,
// e.g. "azerit:u:12"; NULL = the Sequence Mail dashboard). A campaign is only served to
// accounts of the same owner (outreach.ts), whatever the rest of the configuration.
// external_ref: the campaign's key on the client side (e.g. the Azerit job).
addColumnIfMissing("li_accounts", "owner_ref", "owner_ref TEXT");
addColumnIfMissing("campaigns", "owner_ref", "owner_ref TEXT");
addColumnIfMissing("campaigns", "external_ref", "external_ref TEXT");
db.exec(
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_campaigns_external ON campaigns (owner_ref, external_ref) WHERE external_ref IS NOT NULL"
);
db.exec("CREATE INDEX IF NOT EXISTS idx_li_accounts_owner ON li_accounts (owner_ref)");
// LinkedIn identity of the account (/in/<slug> actually logged in), read when the session
// is handed over and rechecked by the executor before each action: a message never
// leaves from any other profile.
addColumnIfMissing("li_accounts", "member_slug", "member_slug TEXT");
addColumnIfMissing("li_accounts", "member_name", "member_name TEXT");
addColumnIfMissing("li_accounts", "member_avatar", "member_avatar TEXT");
addColumnIfMissing("li_accounts", "member_checked_at", "member_checked_at INTEGER");
// Profile that actually performed the action ("sent from ...").
addColumnIfMissing("li_actions", "member_slug", "member_slug TEXT");
// Per-enrollment variables (message written for THIS candidate on THIS job): take
// precedence over contacts.extra, which is shared across campaigns.
addColumnIfMissing("campaign_contacts", "vars", "vars TEXT");
// Candidate key on the client side (Azerit lead): statuses are reported by this key.
addColumnIfMissing("campaign_contacts", "external_key", "external_key TEXT");
// Opt-outs per client (owner_ref): a refusal on a client's campaign only applies to that
// client (see services/opt-out.ts). The dashboard (owner_ref NULL) keeps contacts.do_not_contact.
db.exec(`
CREATE TABLE IF NOT EXISTS owner_opt_outs (
  owner_ref TEXT NOT NULL,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  reason TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (owner_ref, contact_id)
);
`);

// Sequence branches on the LinkedIn invite: a step may apply only if the invite is
// accepted, or only if it is not (NULL = all contacts).
// li_accepted: NULL = unknown yet, 1 = accepted, 0 = not accepted.
addColumnIfMissing("steps", "branch", "branch TEXT");
addColumnIfMissing("campaign_contacts", "li_accepted", "li_accepted INTEGER");

// Campaign description (audience, which contacts to add, message angle), read by
// agents (MCP) before adding contacts or editing the sequence.
addColumnIfMissing("campaigns", "description", "description TEXT");

// Instruction for a personalization variable ({{personnalisation}}…): meaning, content, length, tone.
// One per variable name, shared by all campaigns; read by the agent (MCP) that fills it for contacts.
db.exec("CREATE TABLE IF NOT EXISTS variable_instructions (name TEXT PRIMARY KEY, instruction TEXT NOT NULL)");

// Settings entered in the UI (Google credentials…); the .env takes precedence.
db.exec("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
