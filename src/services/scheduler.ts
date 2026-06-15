import { config } from "../config.js";
import { db } from "../db.js";
import { pushSequenceStatus } from "./attio.js";
import { renderTemplate } from "./contacts.js";
import { getForeignMessages, sendEmail, type AccountRow, type ForeignMessage } from "./google.js";

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

/** Détecte un refus / une demande de désinscription dans le texte d'une réponse. */
export function isOptOut(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // retire les accents (decomposes par NFD)
    .replace(/['’-]/g, " ")
    .replace(/\s+/g, " ");
  return OPT_OUT_PATTERNS.some((p) => normalized.includes(p));
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // retire les accents (décomposés par NFD)
    .replace(/['’-]/g, " ")
    .replace(/\s+/g, " ");
}

// Expéditeurs de notifications d'échec : convention universelle (mailer-daemon,
// postmaster — RFC 5321 §4.5.1) + l'adresse fixe des NDR Microsoft Exchange.
const BOUNCE_FROM = [
  "mailer-daemon",
  "postmaster",
  "mail delivery subsystem",
  "mail delivery system",
  "microsoftexchange329e71ec88ae4615bbc36ab6ce41109e",
];

/**
 * Détecte un message de bounce. Volontairement restrictif : uniquement le champ
 * From des notifications serveur. Un bounce non détecté est traité comme une
 * réponse => la séquence s'arrête quand même (échec côté sûr).
 */
export function isBounce(m: Pick<ForeignMessage, "from">): boolean {
  const f = normalize(m.from);
  return BOUNCE_FROM.some((p) => f.includes(p));
}

// Codes d'erreur permanents (classe 5.X.X, RFC 3463) ou mentions explicites
// d'adresse inexistante : seuls ces cas justifient une blackliste définitive.
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

/** Bounce permanent (adresse morte) vs temporaire (boîte pleine, greylisting…). */
export function isHardBounce(text: string): boolean {
  if (/\b5\.\d{1,3}\.\d{1,3}\b/.test(text)) return true; // status DSN 5.X.X
  if (/\b55[0-4]\b/.test(text)) return true; // codes SMTP 550-554
  const t = normalize(text);
  return HARD_BOUNCE_HINTS.some((p) => t.includes(p));
}

// Préfixes de sujet posés automatiquement par Gmail ("Réponse automatique :")
// et Outlook/Exchange ("Automatic reply:") — jamais écrits par un humain.
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
 * Détecte une réponse automatique d'absence via les signaux machine uniquement :
 * en-tête Auto-Submitted (RFC 3834, posé par Gmail/Outlook/etc.), X-Autoreply,
 * Precedence: auto_reply, ou préfixe de sujet généré par le client mail.
 * AUCUNE analyse du texte écrit par l'humain : « je suis en déplacement,
 * appelez-moi » est une vraie réponse et doit arrêter la séquence.
 */
export function isAutoReply(
  m: Pick<ForeignMessage, "subject" | "autoSubmitted" | "precedence" | "hasAutoReplyHeader">
): boolean {
  const auto = m.autoSubmitted.trim().toLowerCase();
  if (auto && auto !== "no") return true; // RFC 3834 : auto-replied / auto-generated
  if (m.hasAutoReplyHeader) return true;
  if (m.precedence.trim().toLowerCase() === "auto_reply") return true;
  const s = normalize(m.subject);
  return AUTO_REPLY_SUBJECT_PREFIXES.some((p) => s.startsWith(p));
}

/**
 * Retire les lignes citées (">") et tout ce qui suit un marqueur de citation
 * ("Le ... a écrit :", "On ... wrote:") : la classification (opt-out) ne doit
 * porter que sur ce que le contact a écrit, pas sur notre email cité dessous.
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

/**
 * Warm-up automatique : un compte démarre à 10 emails/jour puis gagne
 * +5/semaine depuis sa connexion, jusqu'à atteindre son quota configuré.
 */
export function effectiveDailyLimit(a: Pick<AccountRow, "daily_limit" | "warmup" | "created_at">): number {
  if (!a.warmup) return a.daily_limit;
  const weeks = Math.max(0, Math.floor((Date.now() - a.created_at) / (7 * 24 * 3600 * 1000)));
  return Math.min(a.daily_limit, 10 + 5 * weeks);
}

/**
 * Jeton Google révoqué ou expiré : désactive le compte pour arrêter les erreurs
 * en boucle. Reconnecter l'adresse depuis le dashboard le réactive (les jetons
 * sont fusionnés et le compte repasse actif).
 */
function handleAuthError(account: AccountRow, msg: string): boolean {
  if (!msg.includes("invalid_grant") && !msg.includes("invalid_rapt")) return false;
  db.prepare("UPDATE accounts SET active = 0 WHERE id = ?").run(account.id);
  console.error(
    `[auth] accès Google expiré/révoqué pour ${account.email} — compte désactivé, reconnectez-le via « + Connecter un compte Google »`
  );
  return true;
}

/** Pousse l'avancement vers Attio sans bloquer le workflow en cas d'erreur. */
function syncAttio(attioRecordId: string | null, value: string): void {
  if (!attioRecordId) return;
  pushSequenceStatus(attioRecordId, value).catch((err) =>
    console.error("[attio] mise à jour impossible :", err instanceof Error ? err.message : err)
  );
}

const d = config.deliverability;

function randBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function inSendWindow(now = new Date()): boolean {
  if (d.weekdaysOnly) {
    const day = now.getDay();
    if (day === 0 || day === 6) return false;
  }
  const h = now.getHours();
  return h >= d.sendWindowStart && h < d.sendWindowEnd;
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
  email: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  extra: string | null;
  attio_record_id: string | null;
  variant: string | null;
}

interface StepRow {
  step_number: number;
  subject: string;
  subject_b: string | null;
  body: string;
  wait_days: number;
}

/** Remet à zéro les compteurs quotidiens si la date a changé. */
function resetDailyCounters(): void {
  db.prepare(
    "UPDATE accounts SET sent_today = 0, sent_today_date = ? WHERE sent_today_date IS NOT ? "
  ).run(today(), today());
}

/** Choisit le compte le moins chargé, sous quota effectif (warm-up) et hors repos. */
function pickAccount(now: number): AccountRow | undefined {
  const candidates = db
    .prepare(
      `SELECT * FROM accounts
       WHERE active = 1
         AND (next_allowed_at IS NULL OR next_allowed_at <= ?)
       ORDER BY sent_today ASC, COALESCE(last_sent_at, 0) ASC`
    )
    .all(now) as AccountRow[];
  return candidates.find((a) => a.sent_today < effectiveDailyLimit(a));
}

function accountById(id: number): AccountRow | undefined {
  return db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
}

/** Planifie l'étape suivante avec un jitter aléatoire (délivrabilité). */
function scheduleNext(ccId: number, nextStep: StepRow): void {
  const jitterMs = randBetween(0, 4 * 3600 * 1000); // 0 à 4 h de variabilité
  const at = Date.now() + nextStep.wait_days * 24 * 3600 * 1000 + jitterMs;
  db.prepare(
    "UPDATE campaign_contacts SET status = 'in_progress', next_send_at = ? WHERE id = ?"
  ).run(Math.round(at), ccId);
}

async function processOne(row: DueRow): Promise<void> {
  const steps = db
    .prepare("SELECT step_number, subject, subject_b, body, wait_days FROM steps WHERE campaign_id = ? ORDER BY step_number")
    .all(row.campaign_id) as StepRow[];
  const step = steps.find((s) => s.step_number === row.current_step + 1);
  if (!step) {
    db.prepare("UPDATE campaign_contacts SET status = 'completed', next_send_at = NULL WHERE id = ?").run(row.cc_id);
    return;
  }

  const now = Date.now();
  // Continuité du fil : les relances partent toujours du compte du 1er envoi
  const account = row.account_id ? accountById(row.account_id) : pickAccount(now);
  if (!account || account.active !== 1) return; // aucun compte disponible, on retentera au prochain tick
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
  const senderVars = {
    sender_name: senderName,
    // {{signature}} : signature du compte, placée librement dans le template
    signature: account.signature ? renderTemplate(account.signature, contact, { sender_name: senderName }) : "",
  };
  const isFollowUp = row.current_step > 0 && !!row.thread_id;

  // A/B test : si l'étape 1 a un sujet B, chaque contact reçoit une variante (50/50),
  // figée au 1er envoi (les relances "Re:" reprennent le sujet réellement reçu).
  const firstStep = steps.find((s) => s.step_number === 1);
  const variant = row.variant ?? (firstStep?.subject_b && Math.random() < 0.5 ? "B" : "A");
  const subjectFor = (s: StepRow | undefined) =>
    s ? (variant === "B" && s.subject_b ? s.subject_b : s.subject) : "";

  const subject = isFollowUp && !step.subject
    ? `Re: ${renderTemplate(subjectFor(firstStep), contact, senderVars)}`
    : renderTemplate(subjectFor(step), contact, senderVars);

  const body = renderTemplate(step.body, contact, senderVars);

  try {
    const result = await sendEmail(account, {
      to: row.email,
      subject,
      body,
      threadId: isFollowUp ? row.thread_id : null,
      inReplyTo: isFollowUp ? row.last_gmail_message_id : null,
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

    const next = steps.find((s) => s.step_number === step.step_number + 1);
    if (next) {
      scheduleNext(row.cc_id, next);
      syncAttio(row.attio_record_id, `Étape ${step.step_number}/${steps.length} envoyée`);
    } else {
      db.prepare("UPDATE campaign_contacts SET status = 'completed', next_send_at = NULL WHERE id = ?").run(row.cc_id);
      syncAttio(row.attio_record_id, `Séquence terminée (${steps.length} emails, sans réponse)`);
    }
    console.log(`[envoi] étape ${step.step_number} -> ${row.email} via ${account.email}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[envoi] échec pour ${row.email} :`, msg);
    if (handleAuthError(account, msg)) {
      // Problème de compte, pas de contact : on retentera (autre compte ou après reconnexion)
      db.prepare("UPDATE campaign_contacts SET next_send_at = ? WHERE id = ?").run(
        Math.round(Date.now() + 15 * 60_000),
        row.cc_id
      );
      return;
    }
    // Retentera dans 1 à 2 h ; après 3 échecs consécutifs le contact passe en 'failed'
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

/** Un tick d'envoi : traite quelques contacts dus, dans la fenêtre autorisée. */
export async function sendTick(): Promise<void> {
  resetDailyCounters();
  if (!inSendWindow()) return;

  const due = db
    .prepare(
      `SELECT cc.id AS cc_id, cc.campaign_id, cc.contact_id, cc.status, cc.current_step,
              cc.account_id, cc.thread_id, cc.last_gmail_message_id, cc.variant,
              c.email, c.first_name, c.last_name, c.company, c.extra, c.attio_record_id
       FROM campaign_contacts cc
       JOIN contacts c ON c.id = cc.contact_id
       JOIN campaigns cp ON cp.id = cc.campaign_id
       WHERE cp.status = 'active'
         AND c.do_not_contact = 0
         AND cc.status IN ('pending', 'in_progress')
         AND (cc.next_send_at IS NULL OR cc.next_send_at <= ?)
       ORDER BY COALESCE(cc.next_send_at, 0) ASC
       LIMIT 5`
    )
    .all(Date.now()) as DueRow[];

  for (const row of due) {
    await processOne(row);
    // Pause aléatoire entre deux traitements du même tick (variabilité temporelle)
    await new Promise((r) => setTimeout(r, randBetween(2000, 8000)));
  }
}

/** Retire le contact du workflow (statut terminal) et, si demandé, de toutes les campagnes. */
function terminate(
  row: { cc_id: number; contact_id: number; attio_record_id: string | null },
  status: "replied" | "opted_out" | "bounced",
  blacklist: boolean,
  attioLabel: string
): void {
  db.transaction(() => {
    db.prepare(
      "UPDATE campaign_contacts SET status = ?, replied_at = ?, next_send_at = NULL WHERE id = ?"
    ).run(status, Date.now(), row.cc_id);
    if (blacklist) {
      db.prepare("UPDATE contacts SET do_not_contact = 1 WHERE id = ?").run(row.contact_id);
      db.prepare(
        `UPDATE campaign_contacts SET status = 'stopped', next_send_at = NULL
         WHERE contact_id = ? AND status IN ('pending', 'in_progress')`
      ).run(row.contact_id);
    }
  })();
  syncAttio(row.attio_record_id, attioLabel);
}

/**
 * Vérifie les fils en cours et classifie chaque message entrant :
 * - bounce  -> statut 'bounced' + adresse blacklistée (protège la délivrabilité)
 * - réponse automatique (OOO) -> la relance est reportée de ~7 jours, la séquence continue
 * - refus / désinscription    -> 'opted_out' + liste do_not_contact globale
 * - vraie réponse             -> 'replied', retiré du workflow
 */
export async function checkRepliesTick(): Promise<void> {
  const rows = db
    .prepare(
      `SELECT cc.id AS cc_id, cc.thread_id, cc.account_id, cc.status, cc.handled_msgs,
              c.id AS contact_id, c.email, c.attio_record_id
       FROM campaign_contacts cc
       JOIN contacts c ON c.id = cc.contact_id
       WHERE cc.status IN ('in_progress', 'completed')
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
          // Blackliste définitive uniquement sur bounce permanent (adresse morte) ;
          // un échec temporaire (boîte pleine…) arrête la séquence sans blacklister.
          const hard = isHardBounce(m.text);
          terminate(row, "bounced", hard, hard ? "Email invalide (bounce) ⚠️" : "Email en erreur (bounce temporaire)");
          console.log(`[bounce] ${row.email} : ${hard ? "adresse morte — blacklistée" : "échec temporaire"} — séquence arrêtée`);
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
            console.log(`[ooo] ${row.email} : réponse automatique — relance reportée de ~7 jours`);
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
          `[réponse] ${row.email} ${optedOut ? "s'est désinscrit (do_not_contact)" : "a répondu"} — retiré du workflow`
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
      console.error(`[réponse] vérification impossible pour ${row.email} :`, msg);
      if (handleAuthError(account, msg)) badAccounts.add(account.id); // on continue avec les autres comptes
    }
    await new Promise((r) => setTimeout(r, randBetween(300, 1200)));
  }
}

let started = false;

/** Démarre les boucles avec des intervalles légèrement aléatoires. */
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

  loop(sendTick, 45_000, 120_000); // envois : toutes les ~1-2 min
  loop(checkRepliesTick, 4 * 60_000, 7 * 60_000); // réponses : toutes les ~4-7 min
  console.log("[scheduler] démarré (envois + détection de réponses)");
}
