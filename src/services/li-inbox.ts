/**
 * Réponses LinkedIn : l'exécutant d'un compte (extension ou runner) lit la
 * liste des conversations récentes de la messagerie (action 'sync_inbox') et
 * nous la remet ici. On la rapproche des contacts que CE compte a abordés :
 * une conversation dont le dernier message vient du contact, postérieure à
 * notre première action, vaut réponse — la séquence s'arrête sur tous les
 * canaux (plus d'email ni de message LinkedIn), comme pour une réponse email.
 *
 * Rapprochement : par URL de profil quand la liste la donne, sinon par nom
 * complet (sans accents ni ponctuation), et seulement s'il désigne un contact
 * unique parmi ceux du compte. Dans le doute, on ne conclut pas : mieux vaut
 * une relance de trop qu'une séquence arrêtée à tort… sauf pour une
 * conversation non lue, signal fort qu'on accepte même sans date lisible.
 */
import { db } from "../db.js";
import { linkedinSlug } from "./linkedin-url.js";
import type { LiAccount } from "./outreach.js";
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

/** Minuscules, sans accents ni ponctuation, espaces simples ; coupe « , PhD » & co. */
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

/** Dernier message écrit par nous ? (« Vous : … » / « You: … » en tête de l'aperçu) */
export function lastFromUs(snippet: string | null | undefined): boolean {
  return /^\s*(vous|you)\s*:/i.test(snippet ?? "");
}

const MONTHS: Record<string, number> = {
  janv: 0, jan: 0, fevr: 1, fev: 1, feb: 1, mars: 2, mar: 2, avr: 3, apr: 3, mai: 4, may: 4, juin: 5, jun: 5,
  juil: 6, jul: 6, aout: 7, aug: 7, sept: 8, sep: 8, oct: 9, nov: 10, dec: 11,
};
const WEEKDAYS: Record<string, number> = {
  dim: 0, sun: 0, lun: 1, mon: 1, mar: 2, tue: 2, mer: 3, wed: 3, jeu: 4, thu: 4, ven: 5, fri: 5, sam: 6, sat: 6,
};

/**
 * Date (début de journée) d'un horodatage de la liste des conversations :
 * « 14:32 » / « 2:32 PM » (aujourd'hui), « hier » / « Yesterday », « lun. »
 * (7 derniers jours), « 12 sept. » / « Sep 12 » (cette année, sinon l'an
 * dernier), « 12 sept. 2025 ». Null si illisible.
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

/** Contacts du compte dont on attend une réponse, avec la date de notre première action. */
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
}

/** Traite la liste des conversations lue par l'exécutant du compte. */
export function processInbox(account: LiAccount, conversations: LiConversation[]): InboxReport {
  const report: InboxReport = { conversations: conversations.length, replied: [], ambiguous: [] };
  const pool = watched(account.id);
  if (!pool.length) return report;

  const bySlug = new Map<string, Watched>();
  const byName = new Map<string, Watched[]>();
  for (const w of pool) {
    const slug = linkedinSlug(w.linkedin);
    if (slug) bySlug.set(slug, w);
    const n = normName(`${w.first_name ?? ""} ${w.last_name ?? ""}`);
    if (n.includes(" ")) byName.set(n, [...(byName.get(n) ?? []), w]); // prénom ET nom, sinon trop ambigu
  }

  const done = new Set<number>();
  for (const conv of conversations) {
    if (!conv || lastFromUs(conv.snippet)) continue; // c'est nous qui avons parlé en dernier
    let match: Watched | undefined;
    const slug = linkedinSlug(conv.profile_url);
    if (slug) match = bySlug.get(slug);
    if (!match) {
      const cands = byName.get(normName(conv.name)) ?? [];
      if (cands.length > 1) report.ambiguous.push(conv.name ?? "?");
      if (cands.length === 1) match = cands[0];
    }
    if (!match || done.has(match.cc_id)) continue;

    // Le message du contact doit être postérieur à notre première action
    // (sinon c'est une vieille conversation) ; non lu = on accepte.
    const at = parseLiTime(conv.time);
    const firstDay = new Date(match.first_sent_at);
    firstDay.setHours(0, 0, 0, 0);
    const recent = at != null ? at >= firstDay.getTime() : Boolean(conv.unread);
    if (!recent) continue;

    done.add(match.cc_id);
    const optedOut = isOptOut(conv.snippet ?? "");
    terminate(
      { cc_id: match.cc_id, contact_id: match.contact_id, attio_record_id: match.attio_record_id },
      optedOut ? "opted_out" : "replied",
      optedOut,
      optedOut ? "Pas intéressé / désinscrit 🚫 (LinkedIn)" : "A répondu ✅ (LinkedIn)"
    );
    if (conv.thread_url) db.prepare("UPDATE campaign_contacts SET li_thread_url = ? WHERE id = ?").run(conv.thread_url, match.cc_id);
    report.replied.push({ cc_id: match.cc_id, name: conv.name ?? "?", opted_out: optedOut });
    console.log(`[linkedin] ${conv.name} a répondu sur LinkedIn (${account.name})${optedOut ? " — désinscrit" : ""} — séquence arrêtée`);
  }
  return report;
}
