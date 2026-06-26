import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyVisit } from "./services/botFilter.js";

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
  warmup INTEGER NOT NULL DEFAULT 1,    -- montée en charge auto (WARMUP_START/j puis +WARMUP_RAMP/sem. jusqu'au quota)
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
  channel TEXT NOT NULL DEFAULT 'email', -- 'email' | 'linkedin'
  li_action TEXT,                        -- si channel='linkedin' : 'invite' | 'message'
  UNIQUE (campaign_id, step_number)
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  first_name TEXT,
  last_name TEXT,
  company TEXT,
  linkedin TEXT,                         -- URL du profil LinkedIn (pour les étapes LinkedIn)
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

-- File des actions LinkedIn d'une séquence (invitation / message). Quand une
-- étape LinkedIn devient due, le scheduler y dépose une ligne ; l'extension
-- Chrome la consomme à un rythme « humain » imposé par outreach.ts (quotas du
-- jour, plage horaire, délais aléatoires, warm-up) — c'est le rempart anti-ban.
-- Le succès fait avancer le campaign_contact à l'étape suivante.
CREATE TABLE IF NOT EXISTS li_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_contact_id INTEGER NOT NULL REFERENCES campaign_contacts(id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL,          -- étape de séquence à valider au succès
  linkedin TEXT NOT NULL,                -- URL du profil cible
  type TEXT NOT NULL,                    -- 'invite' | 'message'
  body TEXT,                             -- note d'invitation / corps du message (variables rendues)
  status TEXT NOT NULL DEFAULT 'pending',-- pending | sending | sent | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  lease_at INTEGER,                      -- bail 'sending' (anti double-envoi)
  not_before INTEGER,                    -- ne pas tenter avant (report : message à un non-connecté)
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_li_actions_status ON li_actions (status);
CREATE INDEX IF NOT EXISTS idx_li_actions_cc ON li_actions (campaign_contact_id);

-- Journal des actions LinkedIn réellement effectuées : base des quotas du jour et du warm-up.
CREATE TABLE IF NOT EXISTS li_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                    -- invite | message
  sent_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_li_log_sent ON li_log (sent_at);
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
addColumnIfMissing("steps", "channel", "channel TEXT NOT NULL DEFAULT 'email'");
addColumnIfMissing("steps", "li_action", "li_action TEXT");
addColumnIfMissing("contacts", "linkedin", "linkedin TEXT");
addColumnIfMissing("campaign_contacts", "visit_token", "visit_token TEXT");
// Warm-up : la montée en charge repart de cette date (et non de la création du
// compte), pour qu'activer le warm-up sur un compte ancien recommence vraiment bas.
addColumnIfMissing("accounts", "warmup_started_at", "warmup_started_at INTEGER");
// Jeton de désinscription stable par contact de campagne (en-tête List-Unsubscribe).
addColumnIfMissing("campaign_contacts", "unsub_token", "unsub_token TEXT");
db.exec(
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_unsub_token ON campaign_contacts (unsub_token) WHERE unsub_token IS NOT NULL"
);

// Nettoyage de l'ancien suivi ouverture/clic (pixel + liens réécrits), retiré au
// profit du seul lien {{link}} : on supprime tables, index et colonne devenus inutiles.
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
  // colonne déjà absente (base récente) : rien à faire
}

db.exec(`
-- Visites du lien personnalisé {{link}} : un jeton stable par campaign_contact
-- (campaign_contacts.visit_token) ; chaque ouverture du lien crée une ligne ici.
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cc_id INTEGER NOT NULL REFERENCES campaign_contacts(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  user_agent TEXT,
  ip TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0,   -- 1 = visite d'un bot/scanner, exclue des compteurs
  bot_reason TEXT                       -- motif du classement (cf. services/botFilter.ts)
);
CREATE INDEX IF NOT EXISTS idx_visits_cc ON visits (cc_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_visit_token ON campaign_contacts (visit_token) WHERE visit_token IS NOT NULL;
`);
// Bases déjà créées avant le filtrage bot : on ajoute les colonnes manquantes.
addColumnIfMissing("visits", "is_bot", "is_bot INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("visits", "bot_reason", "bot_reason TEXT");

// v1 : la signature n'est plus ajoutée automatiquement en fin d'email mais placée
// via {{signature}} — les étapes existantes la reçoivent en fin de corps pour
// conserver exactement le rendu d'avant.
if ((db.pragma("user_version", { simple: true }) as number) < 1) {
  db.exec(
    "UPDATE steps SET body = body || char(10) || char(10) || '{{signature}}' WHERE body NOT LIKE '%{{signature}}%'"
  );
  db.pragma("user_version = 1");
}

// Reclasse toutes les visites existantes (bot/scanner vs humain) avec la logique
// courante : à exécuter quand les heuristiques de botFilter évoluent, pour que les
// compteurs « ont visité » restent cohérents avec les nouvelles visites.
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

// v2 : premier classement rétroactif (user-agent + IP datacenter + délai envoi→clic).
if ((db.pragma("user_version", { simple: true }) as number) < 2) {
  reclassifyAllVisits();
  db.pragma("user_version = 2");
}

// v3 : plages d'IP datacenter élargies (DigitalOcean, Hetzner, OVH, Linode, Vultr,
// Scaleway, Oracle) → on reclasse pour absorber les scanners passés inaperçus.
if ((db.pragma("user_version", { simple: true }) as number) < 3) {
  reclassifyAllVisits();
  db.pragma("user_version = 3");
}
