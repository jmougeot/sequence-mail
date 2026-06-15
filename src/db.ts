import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Relatif au projet (src/../data), pas au répertoire de lancement ; surchargeable via DATA_DIR
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
  sent_today_date TEXT,                 -- YYYY-MM-DD du compteur sent_today
  last_sent_at INTEGER,                 -- epoch ms du dernier envoi
  next_allowed_at INTEGER,              -- epoch ms avant lequel ce compte ne doit pas renvoyer
  active INTEGER NOT NULL DEFAULT 1,
  warmup INTEGER NOT NULL DEFAULT 1,    -- montée en charge auto : 10/j puis +5/semaine jusqu'au quota
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
  subject TEXT NOT NULL,                 -- vide pour les relances => même fil (Re:)
  subject_b TEXT,                        -- variante B du sujet (A/B test, étape 1 uniquement)
  body TEXT NOT NULL,                    -- texte avec variables {{first_name}} etc.
  wait_days INTEGER NOT NULL DEFAULT 0,  -- délai après l'étape précédente
  UNIQUE (campaign_id, step_number)
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  first_name TEXT,
  last_name TEXT,
  company TEXT,
  extra TEXT,                            -- JSON : colonnes CSV supplémentaires
  attio_record_id TEXT,
  do_not_contact INTEGER NOT NULL DEFAULT 0, -- désinscrit : exclu de toutes les campagnes
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS campaign_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | in_progress | replied | opted_out | bounced | completed | stopped | failed
  current_step INTEGER NOT NULL DEFAULT 0, -- dernière étape envoyée (0 = aucune)
  variant TEXT,                            -- 'A' ou 'B' si A/B test sur le sujet de l'étape 1
  handled_msgs TEXT,                       -- JSON : ids Gmail des messages déjà traités (ex. réponses auto)
  next_send_at INTEGER,                    -- epoch ms du prochain envoi prévu
  account_id INTEGER REFERENCES accounts(id), -- compte assigné au 1er envoi, fixe ensuite (continuité du fil)
  thread_id TEXT,                          -- thread Gmail
  last_gmail_message_id TEXT,              -- Message-ID RFC822 du dernier envoi (References/In-Reply-To)
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
`);

// Migrations additives sur les bases existantes
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

// v1 : la signature n'est plus ajoutée automatiquement en fin d'email mais placée
// via {{signature}} — les étapes existantes la reçoivent en fin de corps pour
// conserver exactement le rendu d'avant.
if ((db.pragma("user_version", { simple: true }) as number) < 1) {
  db.exec(
    "UPDATE steps SET body = body || char(10) || char(10) || '{{signature}}' WHERE body NOT LIKE '%{{signature}}%'"
  );
  db.pragma("user_version = 1");
}
