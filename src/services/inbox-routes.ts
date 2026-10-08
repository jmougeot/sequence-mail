/**
 * Boîte de réception unifiée et outils de pilotage (façon lemlist), appelés par
 * le serveur MCP (Claude) comme par le tableau de bord :
 *   - /api/inbox : réponses reçues, toutes campagnes confondues (texte lu dans Gmail sur demande) ;
 *   - /api/campaign-contacts/:ccId/conversation : fil complet d'un contact
 *     (emails lus dans Gmail, étapes envoyées, actions LinkedIn) ;
 *   - /api/campaign-contacts/:ccId/reply : répondre à la main dans le fil email ;
 *   - /api/contacts : recherche globale de contacts ;
 *   - /api/activity : journal d'activité (envois, réponses, LinkedIn, visites) ;
 *   - /api/test-email : email de test d'une étape, rendu comme au scheduler ;
 *   - /api/campaigns/:id/preview : variables manquantes sur tous les contacts
 *     d'une campagne, avec le rendu des étapes pour quelques-uns.
 *
 * Toutes les campagnes sont visibles, y compris celles des clients Azerit
 * (owner_ref renvoyé). Une lecture Gmail qui échoue ne fait jamais échouer une
 * liste : l'erreur est rapportée sur la ligne concernée.
 */
import type express from "express";
import { config } from "../config.js";
import { db } from "../db.js";
import { MERGED_EXTRA, renderTemplate, templateVariables } from "./contacts.js";
import { resolveSections } from "./template-sections.js";
import {
  getThreadMessages,
  googleErrorMessage,
  isGoogleAuthError,
  sendEmail,
  type AccountRow,
  type ThreadMessage,
} from "./google.js";
import { isAutoReply, isBounce, parseAccountIds, stripQuoted } from "./scheduler.js";
import { visitLink } from "./visits.js";

const DAY_MS = 24 * 3600 * 1000;
const INBOX_STATUSES = ["replied", "opted_out", "bounced"];
const GMAIL_CONCURRENCY = 5; // lectures Gmail simultanées au plus (include_text)
const REPLY_TEXT_MAX = 2000;
const THREAD_TEXT_MAX = 8000;
const EVENTS_MAX = 300;
// Aperçu d'une campagne : contacts à qui il reste quelque chose à envoyer
const PREVIEW_STATUSES = ["held", "pending", "in_progress", "awaiting_li"];
const CC_STATUSES = [...PREVIEW_STATUSES, "replied", "opted_out", "bounced", "completed", "stopped", "failed"];
// Variables fournies par le compte d'envoi, pas par le contact
const SENDER_VARS = new Set(["sender_name", "link", "signature"]);

const SAMPLE_CONTACT = {
  email: "marie.dupont@exemple.fr",
  first_name: "Marie",
  last_name: "Dupont",
  company: "Exemple SAS",
  extra: null,
};

type ContactVars = {
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  extra: string | null;
};
type MailKind = "sent" | "reply" | "auto_reply" | "bounce";
type Handler = (req: express.Request, res: express.Response) => Promise<unknown>;

/** Express 4 ne rattrape pas les promesses rejetées : une erreur imprévue devient un 500 JSON. */
function safe(fn: Handler): express.RequestHandler {
  return (req, res) => {
    fn(req, res).catch((err) => {
      console.error("[inbox]", err instanceof Error ? err.message : err);
      if (!res.headersSent) res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    });
  };
}

/** Entier d'un paramètre (requête ou body) : undefined si absent, NaN si invalide. */
function optInt(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
}

/**
 * dry_run : tout ce qui n'est pas explicitement faux vaut simulation — en cas
 * de doute on n'envoie rien.
 */
function isDryRun(v: unknown): boolean {
  return v !== undefined && v !== null && v !== false && v !== 0 && v !== "false" && v !== "0" && v !== "";
}

function accountById(id: number): AccountRow | undefined {
  return db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
}

/** En-tête From tel que l'envoie sendEmail : « Nom <adresse> » ou l'adresse seule. */
function fromLabel(account: Pick<AccountRow, "email" | "from_name">): string {
  return account.from_name ? `${account.from_name} <${account.email}>` : account.email;
}

/** {{sender_name}}, {{link}}, {{signature}} d'un compte, rendus comme au scheduler. */
function senderVars(
  account: Pick<AccountRow, "email" | "from_name" | "signature"> | undefined,
  contact: ContactVars,
  link: string
): Record<string, string> {
  const senderName = account?.from_name ?? account?.email ?? "Votre nom";
  return {
    sender_name: senderName,
    link,
    signature: account?.signature ? renderTemplate(account.signature, contact, { sender_name: senderName, link }) : "",
  };
}

/** Classe un message du fil avec les mêmes règles que la détection des réponses. */
function kindOf(m: ThreadMessage): MailKind {
  if (m.outgoing) return "sent";
  if (isBounce(m)) return "bounce";
  if (isAutoReply(m)) return "auto_reply";
  return "reply";
}

/** Dernier message entrant écrit par le contact (ni bounce ni réponse automatique). */
function lastReply(msgs: ThreadMessage[]): ThreadMessage | undefined {
  return msgs.filter((m) => m.from && kindOf(m) === "reply").at(-1);
}

/** Retire les préfixes de réponse répétés (« Re: RE : Réf. : … »). */
function stripReplyPrefixes(subject: string): string {
  return subject.replace(/^\s*((re|ré|réf|ref|rép|aw|sv)\.?\s*(\[\d+\])?\s*:\s*)+/iu, "").trim();
}

/** JSON en base → objet, null si vide ou illisible. */
function parseJsonObject(s: string | null): Record<string, unknown> | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Applique fn à chaque élément, `limit` à la fois au plus (fn ne doit pas lever). */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export function registerInboxRoutes(app: express.Express): void {
  // --- Boîte de réception : réponses reçues, triées de la plus récente à la plus ancienne ---
  app.get(
    "/api/inbox",
    safe(async (req, res) => {
      const statuses = String(req.query.status ?? "replied,opted_out")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (!statuses.length || statuses.some((s) => !INBOX_STATUSES.includes(s))) {
        return res.status(400).json({ error: `status : valeurs possibles ${INBOX_STATUSES.join(", ")} (séparées par des virgules)` });
      }
      const campaignId = optInt(req.query.campaign_id);
      const since = optInt(req.query.since);
      const limit = optInt(req.query.limit) ?? 50;
      if ([campaignId, since, limit].some((n) => Number.isNaN(n))) {
        return res.status(400).json({ error: "campaign_id, since et limit doivent être des entiers" });
      }
      const includeText = req.query.include_text === "1" || req.query.include_text === "true";

      const rows = db
        .prepare(
          `SELECT cc.id AS cc_id, c.id AS contact_id, cp.id AS campaign_id, cp.name AS campaign_name, cp.owner_ref,
                  c.email, c.first_name, c.last_name, c.company, c.linkedin,
                  cc.status, cc.replied_at, cc.current_step,
                  a.email AS sender, li.name AS li_sender, cc.li_thread_url,
                  cc.thread_id, cc.account_id
           FROM campaign_contacts cc
           JOIN contacts c ON c.id = cc.contact_id
           JOIN campaigns cp ON cp.id = cc.campaign_id
           LEFT JOIN accounts a ON a.id = cc.account_id
           LEFT JOIN li_accounts li ON li.id = cc.li_account_id
           WHERE cc.status IN (SELECT value FROM json_each(@statuses))
             AND (@campaign IS NULL OR cc.campaign_id = @campaign)
             AND (@since IS NULL OR cc.replied_at >= @since)
           ORDER BY cc.replied_at DESC, cc.id DESC
           LIMIT @limit`
        )
        .all({
          statuses: JSON.stringify(statuses),
          campaign: campaignId ?? null,
          since: since ?? null,
          limit: Math.min(Math.max(limit, 1), 200),
        }) as Array<Record<string, unknown> & { cc_id: number; status: string; thread_id: string | null; account_id: number | null; li_thread_url: string | null }>;

      // Canal de la réponse : un fil LinkedIn connu prime, sinon le fil Gmail
      const items = rows.map(({ thread_id, account_id, ...r }) => {
        const channel: "email" | "linkedin" = r.li_thread_url ? "linkedin" : thread_id ? "email" : "linkedin";
        return { item: { ...r, channel } as Record<string, unknown>, thread_id, account_id, channel };
      });

      if (includeText) {
        const authErrors = new Map<number, string>(); // compte dont l'accès Google est expiré : inutile d'insister
        const accounts = new Map<number, AccountRow | undefined>();
        await mapLimit(
          items.filter((i) => i.channel === "email"),
          GMAIL_CONCURRENCY,
          async ({ item, thread_id, account_id }) => {
            if (account_id == null || !thread_id) return;
            if (!accounts.has(account_id)) accounts.set(account_id, accountById(account_id));
            const account = accounts.get(account_id);
            if (!account) {
              item.reply_error = "Compte Google du fil introuvable";
              return;
            }
            const known = authErrors.get(account_id);
            if (known) {
              item.reply_error = known;
              return;
            }
            try {
              const msgs = await getThreadMessages(account, thread_id);
              // Contact en bounce : à défaut de vraie réponse, le rapport de non-remise
              const m =
                lastReply(msgs) ??
                (item.status === "bounced" ? msgs.filter((x) => !x.outgoing && kindOf(x) === "bounce").at(-1) : undefined);
              item.reply_text = m ? stripQuoted(m.text).trim().slice(0, REPLY_TEXT_MAX) : null;
              item.reply_from = m?.from ?? null;
              item.reply_at = m?.date ?? null;
            } catch (err) {
              item.reply_error = googleErrorMessage(err, account.email);
              if (isGoogleAuthError(err instanceof Error ? err.message : String(err))) {
                authErrors.set(account_id, item.reply_error as string);
              }
            }
          }
        );
      }
      res.json(items.map((i) => i.item));
    })
  );

  // --- Fil complet d'un contact : emails (lus dans Gmail), étapes envoyées, actions LinkedIn ---
  app.get(
    "/api/campaign-contacts/:ccId/conversation",
    safe(async (req, res) => {
      const cc = db
        .prepare(
          `SELECT cc.id AS cc_id, cc.status, cc.current_step, cc.replied_at, cc.error,
                  cc.thread_id, cc.account_id, cc.li_thread_url,
                  cp.id AS campaign_id, cp.name AS campaign_name, cp.owner_ref,
                  c.id AS contact_id, c.email, c.first_name, c.last_name, c.company, c.linkedin,
                  a.email AS sender
           FROM campaign_contacts cc
           JOIN campaigns cp ON cp.id = cc.campaign_id
           JOIN contacts c ON c.id = cc.contact_id
           LEFT JOIN accounts a ON a.id = cc.account_id
           WHERE cc.id = ?`
        )
        .get(req.params.ccId) as
        | {
            cc_id: number;
            status: string;
            current_step: number;
            replied_at: number | null;
            error: string | null;
            thread_id: string | null;
            account_id: number | null;
            li_thread_url: string | null;
            campaign_id: number;
            campaign_name: string;
            owner_ref: string | null;
            contact_id: number;
            email: string | null;
            first_name: string | null;
            last_name: string | null;
            company: string | null;
            linkedin: string | null;
            sender: string | null;
          }
        | undefined;
      if (!cc) return res.status(404).json({ error: "Contact de campagne introuvable" });

      let emailThread: Array<Record<string, unknown>> | null = null;
      let emailThreadError: string | undefined;
      if (cc.thread_id) {
        const account = cc.account_id != null ? accountById(cc.account_id) : undefined;
        if (!account) {
          emailThreadError = "Compte Google du fil introuvable";
        } else {
          try {
            emailThread = (await getThreadMessages(account, cc.thread_id)).map((m) => {
              const kind = kindOf(m);
              const text = m.text.replace(/\r\n/g, "\n").slice(0, THREAD_TEXT_MAX);
              return {
                id: m.id,
                direction: m.outgoing ? "out" : "in",
                kind,
                from: m.from,
                to: m.to,
                date: m.date,
                subject: m.subject,
                text,
                ...(m.outgoing ? {} : { text_clean: stripQuoted(text).trim() }),
              };
            });
          } catch (err) {
            emailThreadError = googleErrorMessage(err, account.email);
          }
        }
      }

      const stepsSent = db
        .prepare(
          `SELECT m.step_number, m.sent_at, a.email AS account
           FROM messages m LEFT JOIN accounts a ON a.id = m.account_id
           WHERE m.campaign_contact_id = ? ORDER BY m.sent_at, m.id`
        )
        .all(cc.cc_id);
      const linkedin = db
        .prepare(
          `SELECT step_number, type, body, status, sent_at, error, member_slug
           FROM li_actions WHERE campaign_contact_id = ?
           ORDER BY COALESCE(sent_at, created_at), id`
        )
        .all(cc.cc_id);

      res.json({
        cc_id: cc.cc_id,
        campaign: { id: cc.campaign_id, name: cc.campaign_name, owner_ref: cc.owner_ref },
        status: cc.status,
        current_step: cc.current_step,
        replied_at: cc.replied_at,
        error: cc.error,
        contact: {
          id: cc.contact_id,
          email: cc.email,
          first_name: cc.first_name,
          last_name: cc.last_name,
          company: cc.company,
          linkedin: cc.linkedin,
        },
        sender: cc.sender,
        email_thread: emailThread,
        ...(emailThreadError ? { email_thread_error: emailThreadError } : {}),
        steps_sent: stepsSent,
        linkedin,
        li_thread_url: cc.li_thread_url,
      });
    })
  );

  // --- Réponse manuelle dans le fil email du contact ---
  // Envoyée depuis le compte du fil, dans le même thread Gmail, en réponse au
  // dernier message. Le statut du contact ne bouge pas ; last_gmail_message_id
  // suit, pour que d'éventuelles relances restent dans le fil.
  app.post(
    "/api/campaign-contacts/:ccId/reply",
    safe(async (req, res) => {
      const { body, subject, dry_run } = (req.body ?? {}) as { body?: unknown; subject?: unknown; dry_run?: unknown };
      const cc = db
        .prepare(
          `SELECT cc.id AS cc_id, cc.campaign_id, cc.thread_id, cc.account_id, cc.last_gmail_message_id, cc.variant,
                  c.email, c.first_name, c.last_name, c.company, ${MERGED_EXTRA} AS extra
           FROM campaign_contacts cc JOIN contacts c ON c.id = cc.contact_id
           WHERE cc.id = ?`
        )
        .get(req.params.ccId) as
        | (ContactVars & {
            cc_id: number;
            campaign_id: number;
            thread_id: string | null;
            account_id: number | null;
            last_gmail_message_id: string | null;
            variant: string | null;
          })
        | undefined;
      if (!cc) return res.status(404).json({ error: "Contact de campagne introuvable" });
      if (typeof body !== "string" || !body.trim()) return res.status(400).json({ error: "body est requis" });
      if (subject != null && typeof subject !== "string") return res.status(400).json({ error: "subject doit être un texte" });
      if (!cc.thread_id || cc.account_id == null) {
        return res.status(400).json({ error: "Pas de fil email pour ce contact : aucun email ne lui a encore été envoyé" });
      }
      if (!cc.email) return res.status(400).json({ error: "Ce contact n'a pas d'adresse email" });
      const account = accountById(cc.account_id);
      if (!account) return res.status(400).json({ error: "Compte Google du fil introuvable" });

      // Le fil est relu (même en simulation) : sujet et Message-ID du message
      // auquel on répond. Un accès expiré se voit donc dès le dry_run.
      let msgs: ThreadMessage[];
      try {
        msgs = await getThreadMessages(account, cc.thread_id);
      } catch (err) {
        return res.status(502).json({ error: googleErrorMessage(err, account.email) });
      }
      // Dernier message du fil, hors bounce / réponse automatique (sujet
      // « Réponse automatique : … » ou NDR) quand il y en a un autre
      const last = msgs.filter((m) => kindOf(m) === "sent" || kindOf(m) === "reply").at(-1) ?? msgs.at(-1);

      const vars = senderVars(account, cc, config.visit.enabled ? visitLink(cc.cc_id) : "");
      let baseSubject = last ? stripReplyPrefixes(last.subject) : "";
      if (!baseSubject) {
        // Fil sans sujet lisible : celui de l'étape 1 réellement reçu (variante A/B)
        const first = db
          .prepare("SELECT subject, subject_b FROM steps WHERE campaign_id = ? AND step_number = 1")
          .get(cc.campaign_id) as { subject: string; subject_b: string | null } | undefined;
        const raw = cc.variant === "B" && first?.subject_b ? first.subject_b : (first?.subject ?? "");
        baseSubject = stripReplyPrefixes(renderTemplate(raw, cc, vars));
      }
      const finalSubject = typeof subject === "string" && subject.trim() ? renderTemplate(subject.trim(), cc, vars) : `Re: ${baseSubject}`;
      const finalBody = renderTemplate(body, cc, vars);
      const from = fromLabel(account);
      const out = { ok: true, from, to: cc.email, subject: finalSubject, body: finalBody };
      if (isDryRun(dry_run)) return res.json({ ...out, sent: false });

      let result;
      try {
        result = await sendEmail(account, {
          to: cc.email,
          subject: finalSubject,
          body: finalBody,
          threadId: cc.thread_id,
          inReplyTo: last?.messageId || cc.last_gmail_message_id,
          listUnsubscribeUrl: null, // conversation en cours, pas un envoi de séquence
        });
      } catch (err) {
        return res.status(502).json({ error: googleErrorMessage(err, account.email) });
      }
      db.prepare("UPDATE campaign_contacts SET last_gmail_message_id = ? WHERE id = ?").run(result.rfc822MessageId, cc.cc_id);
      console.log(`[réponse manuelle] ${cc.email} via ${account.email}`);
      res.json({ ...out, sent: true, gmail_message_id: result.gmailMessageId, thread_id: result.threadId });
    })
  );

  // --- Recherche globale de contacts (toutes campagnes) ---
  app.get("/api/contacts", (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (q.length < 2) return res.status(400).json({ error: "q est requis (2 caractères au moins)" });
    const limit = optInt(req.query.limit) ?? 50;
    if (Number.isNaN(limit)) return res.status(400).json({ error: "limit doit être un entier" });
    // LIKE insensible à la casse (ASCII) ; % et _ saisis sont cherchés tels quels
    const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const contacts = db
      .prepare(
        `SELECT c.id AS contact_id, c.email, c.first_name, c.last_name, c.company, c.linkedin, c.do_not_contact, c.extra
         FROM contacts c
         WHERE c.email LIKE @like ESCAPE '\\'
            OR c.first_name LIKE @like ESCAPE '\\'
            OR c.last_name LIKE @like ESCAPE '\\'
            OR c.company LIKE @like ESCAPE '\\'
            OR c.linkedin LIKE @like ESCAPE '\\'
            OR (COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) LIKE @like ESCAPE '\\'
            OR (COALESCE(c.last_name, '') || ' ' || COALESCE(c.first_name, '')) LIKE @like ESCAPE '\\'
         ORDER BY CASE WHEN lower(c.email) = lower(@q) THEN 0 ELSE 1 END, c.id DESC
         LIMIT @limit`
      )
      .all({ like, q, limit: Math.min(Math.max(limit, 1), 200) }) as Array<{ contact_id: number; extra: string | null }>;

    // Inscriptions des contacts trouvés, en une requête
    const byContact = new Map<number, unknown[]>();
    if (contacts.length) {
      const ids = contacts.map((c) => c.contact_id);
      const enrolments = db
        .prepare(
          `SELECT cc.contact_id, cc.campaign_id, cp.name AS campaign_name, cc.id AS cc_id,
                  cc.status, cc.current_step, cc.replied_at
           FROM campaign_contacts cc JOIN campaigns cp ON cp.id = cc.campaign_id
           WHERE cc.contact_id IN (${ids.map(() => "?").join(",")})
           ORDER BY cc.id`
        )
        .all(...ids) as Array<{ contact_id: number }>;
      for (const { contact_id, ...e } of enrolments) {
        if (!byContact.has(contact_id)) byContact.set(contact_id, []);
        byContact.get(contact_id)!.push(e);
      }
    }
    res.json(
      contacts.map((c) => ({ ...c, extra: parseJsonObject(c.extra), campaigns: byContact.get(c.contact_id) ?? [] }))
    );
  });

  // --- Journal d'activité : envois, réponses, actions LinkedIn, visites (hors bots) ---
  app.get("/api/activity", (req, res) => {
    const days = optInt(req.query.days) ?? 7;
    const campaignId = optInt(req.query.campaign_id);
    if (Number.isNaN(days) || Number.isNaN(campaignId)) {
      return res.status(400).json({ error: "days et campaign_id doivent être des entiers" });
    }
    const since = Date.now() - Math.min(Math.max(days, 1), 90) * DAY_MS;
    // Un événement par ligne ; totals et events lisent la même union (même périmètre)
    const EVENTS = `
      WITH ev AS (
        SELECT m.sent_at AS at, 'email_sent' AS type, cc.campaign_id, cc.id AS cc_id, cc.contact_id,
               m.step_number, a.email AS account
        FROM messages m
        JOIN campaign_contacts cc ON cc.id = m.campaign_contact_id
        LEFT JOIN accounts a ON a.id = m.account_id
        WHERE m.sent_at >= @since
        UNION ALL
        SELECT cc.replied_at, cc.status, cc.campaign_id, cc.id, cc.contact_id,
               cc.current_step, CASE WHEN cc.li_thread_url IS NULL AND cc.thread_id IS NOT NULL THEN a.email ELSE li.name END
        FROM campaign_contacts cc
        LEFT JOIN accounts a ON a.id = cc.account_id
        LEFT JOIN li_accounts li ON li.id = cc.li_account_id
        WHERE cc.status IN ('replied', 'opted_out', 'bounced') AND cc.replied_at >= @since
        UNION ALL
        SELECT la.sent_at, 'li_' || la.type, cc.campaign_id, cc.id, cc.contact_id, la.step_number, li.name
        FROM li_actions la
        JOIN campaign_contacts cc ON cc.id = la.campaign_contact_id
        LEFT JOIN li_accounts li ON li.id = la.li_account_id
        WHERE la.status = 'sent' AND la.sent_at >= @since
        UNION ALL
        SELECT v.at, 'visit', cc.campaign_id, cc.id, cc.contact_id, NULL, NULL
        FROM visits v JOIN campaign_contacts cc ON cc.id = v.cc_id
        WHERE v.is_bot = 0 AND v.at >= @since
      )`;
    const params = { since, campaign: campaignId ?? null };
    const counts = db
      .prepare(`${EVENTS} SELECT type, COUNT(*) AS n FROM ev WHERE @campaign IS NULL OR campaign_id = @campaign GROUP BY type`)
      .all(params) as Array<{ type: string; n: number }>;
    const n = (type: string) => counts.find((c) => c.type === type)?.n ?? 0;
    const events = db
      .prepare(
        `${EVENTS}
         SELECT ev.at, ev.type, ev.campaign_id, cp.name AS campaign_name, ev.cc_id, ev.contact_id,
                NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), '') AS name,
                c.email, ev.step_number, ev.account
         FROM ev
         JOIN campaigns cp ON cp.id = ev.campaign_id
         JOIN contacts c ON c.id = ev.contact_id
         WHERE @campaign IS NULL OR ev.campaign_id = @campaign
         ORDER BY ev.at DESC, ev.cc_id DESC
         LIMIT ${EVENTS_MAX}`
      )
      .all(params) as Array<Record<string, unknown>>;
    res.json({
      since,
      totals: {
        emails_sent: n("email_sent"),
        replied: n("replied"),
        opted_out: n("opted_out"),
        bounced: n("bounced"),
        li_invites: n("li_invite"),
        li_messages: n("li_message"),
        visits: n("visit"),
      },
      // step_number / account omis quand sans objet (visites)
      events: events.map(({ step_number, account, ...e }) => ({
        ...e,
        ...(step_number != null ? { step_number } : {}),
        ...(account != null ? { account } : {}),
      })),
    });
  });

  // --- Email de test d'une étape : rendu identique au scheduler, sujet préfixé [TEST] ---
  // Ne touche ni aux quotas, ni aux statuts, ni à la table messages.
  app.post(
    "/api/test-email",
    safe(async (req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const to = typeof b.to === "string" ? b.to.trim() : "";
      if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to)) return res.status(400).json({ error: "to : adresse email valide requise" });
      const campaignId = optInt(b.campaign_id);
      const stepNumber = optInt(b.step_number) ?? 1;
      const accountId = optInt(b.account_id);
      const contactId = optInt(b.contact_id);
      if (campaignId === undefined || [campaignId, stepNumber, accountId, contactId].some((v) => Number.isNaN(v))) {
        return res.status(400).json({ error: "campaign_id (entier) est requis ; step_number, account_id et contact_id sont des entiers" });
      }
      if (b.variant != null && b.variant !== "A" && b.variant !== "B") {
        return res.status(400).json({ error: "variant : \"A\" ou \"B\"" });
      }
      const variant = b.variant === "B" ? "B" : "A";
      const dryRun = isDryRun(b.dry_run);

      const campaign = db.prepare("SELECT id, account_ids FROM campaigns WHERE id = ?").get(campaignId) as
        | { id: number; account_ids: string | null }
        | undefined;
      if (!campaign) return res.status(404).json({ error: "Campagne introuvable" });
      const steps = db
        .prepare("SELECT step_number, subject, subject_b, body, channel FROM steps WHERE campaign_id = ? ORDER BY step_number")
        .all(campaignId) as Array<{ step_number: number; subject: string; subject_b: string | null; body: string; channel: string }>;
      const step = steps.find((s) => s.step_number === stepNumber);
      if (!step) return res.status(404).json({ error: `Étape ${stepNumber} introuvable dans cette campagne` });

      // Contact : celui demandé, sinon le 1er de la campagne, sinon un contact d'exemple
      let contact: ContactVars | undefined;
      if (contactId !== undefined) {
        contact = db
          .prepare(
            `SELECT c.email, c.first_name, c.last_name, c.company, ${MERGED_EXTRA} AS extra
             FROM contacts c LEFT JOIN campaign_contacts cc ON cc.contact_id = c.id AND cc.campaign_id = ?
             WHERE c.id = ?`
          )
          .get(campaignId, contactId) as ContactVars | undefined;
        if (!contact) return res.status(404).json({ error: "Contact introuvable" });
      } else {
        contact = db
          .prepare(
            `SELECT c.email, c.first_name, c.last_name, c.company, ${MERGED_EXTRA} AS extra
             FROM campaign_contacts cc JOIN contacts c ON c.id = cc.contact_id
             WHERE cc.campaign_id = ? ORDER BY cc.id LIMIT 1`
          )
          .get(campaignId) as ContactVars | undefined;
      }
      const sample = contact ?? SAMPLE_CONTACT;

      if (step.channel === "linkedin") {
        // Rendu tel que mis en file pour LinkedIn (sans expéditeur ni signature)
        const rendered = step.body?.trim() ? renderTemplate(step.body, sample, { sender_name: "", signature: "" }) : "";
        return res.status(400).json({
          error: `L'étape ${stepNumber} est une étape LinkedIn : pas d'email de test possible`,
          rendered_body: rendered,
        });
      }

      // Compte : celui demandé, sinon le 1er actif autorisé par la campagne, sinon le 1er actif
      let account: AccountRow | undefined;
      if (accountId !== undefined) {
        account = accountById(accountId);
        if (!account) return res.status(404).json({ error: "Compte Google introuvable" });
      } else {
        const allowed = parseAccountIds(campaign.account_ids);
        const active = db.prepare("SELECT * FROM accounts WHERE active = 1 ORDER BY id").all() as AccountRow[];
        account = active.find((a) => !allowed || allowed.includes(a.id)) ?? active[0];
      }
      if (!account && !dryRun) {
        return res.status(400).json({ error: "Aucun compte Google actif : connectez-en un via /auth/google" });
      }

      const vars = senderVars(account, sample, config.visit.enabled ? `${config.visit.baseUrl}/p/exemple` : "");
      const subjectFor = (s: { subject: string; subject_b: string | null }) =>
        variant === "B" && s.subject_b ? s.subject_b : s.subject;
      const first = steps.find((s) => s.step_number === 1);
      // Relance sans sujet : « Re: » + sujet de l'étape 1 (même fil, comme au scheduler)
      const subject =
        step.step_number > 1 && !step.subject
          ? first && subjectFor(first)
            ? `Re: ${renderTemplate(subjectFor(first), sample, vars)}`
            : ""
          : renderTemplate(subjectFor(step), sample, vars);
      const finalSubject = `[TEST] ${subject}`.trim();
      const finalBody = renderTemplate(step.body, sample, vars);
      const out = {
        ok: true,
        from: account ? fromLabel(account) : "(aucun compte connecté)",
        to,
        subject: finalSubject,
        body: finalBody,
        sample_contact: !contact,
      };
      if (dryRun || !account) return res.json({ ...out, sent: false });

      try {
        await sendEmail(account, { to, subject: finalSubject, body: finalBody });
      } catch (err) {
        return res.status(502).json({ error: googleErrorMessage(err, account.email) });
      }
      console.log(`[test] étape ${stepNumber} de la campagne ${campaignId} -> ${to} via ${account.email}`);
      res.json({ ...out, sent: true });
    })
  );

  // --- Aperçu d'une campagne sur tous ses contacts : variables manquantes, étapes sautées ---
  // Même résolution des variables que le scheduler (celles de l'inscription
  // comprises). Seules les étapes restant à envoyer à chaque contact comptent.
  app.get("/api/campaigns/:id/preview", (req, res) => {
    const campaign = db.prepare("SELECT id, name, status, account_ids FROM campaigns WHERE id = ?").get(req.params.id) as
      | { id: number; name: string; status: string; account_ids: string | null }
      | undefined;
    if (!campaign) return res.status(404).json({ error: "Campagne introuvable" });
    const statuses = String(req.query.status ?? PREVIEW_STATUSES.join(","))
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    if (!statuses.length || statuses.some((x) => !CC_STATUSES.includes(x))) {
      return res.status(400).json({ error: `status : valeurs possibles ${CC_STATUSES.join(", ")} (séparées par des virgules)` });
    }
    const samples = optInt(req.query.samples) ?? 1;
    const limit = optInt(req.query.limit) ?? 50;
    if (Number.isNaN(samples) || Number.isNaN(limit)) return res.status(400).json({ error: "samples et limit doivent être des entiers" });

    type Step = { step_number: number; subject: string; subject_b: string | null; body: string; channel: string; li_action: string | null };
    const steps = db
      .prepare("SELECT step_number, subject, subject_b, body, channel, li_action FROM steps WHERE campaign_id = ? ORDER BY step_number")
      .all(campaign.id) as Step[];
    const rows = db
      .prepare(
        `SELECT cc.id AS cc_id, c.id AS contact_id, cc.status, cc.current_step, cc.variant, cc.account_id,
                c.email, c.first_name, c.last_name, c.company, c.linkedin, ${MERGED_EXTRA} AS extra
         FROM campaign_contacts cc JOIN contacts c ON c.id = cc.contact_id
         WHERE cc.campaign_id = ? AND cc.status IN (SELECT value FROM json_each(?))
         ORDER BY cc.id`
      )
      .all(campaign.id, JSON.stringify(statuses)) as Array<
        ContactVars & { cc_id: number; contact_id: number; status: string; current_step: number; variant: string | null; account_id: number | null; linkedin: string | null }
      >;

    // Variables de chaque étape (un email : sujets + corps ; LinkedIn : corps seul)
    const stepText = (s: Step) => (s.channel === "linkedin" ? s.body : [s.subject, s.subject_b ?? "", s.body].join("\n"));
    const stepVars = new Map(steps.map((s) => [s.step_number, templateVariables(stepText(s))]));
    // Un bloc {{si …}} commandé par une variable d'expéditeur est tenu pour rempli
    const senderFilled = Object.fromEntries([...SENDER_VARS].map((key) => [key, "x"]));
    const stats = new Map<string, { steps: number[]; genderOnly: boolean; used: number; missing: number }>();
    for (const s of steps) {
      for (const [key, genderOnly] of stepVars.get(s.step_number)!) {
        if (SENDER_VARS.has(key)) continue;
        const st = stats.get(key) ?? { steps: [], genderOnly: true, used: 0, missing: 0 };
        st.steps.push(s.step_number);
        st.genderOnly &&= genderOnly;
        stats.set(key, st);
      }
    }

    // Un contact sans email saute les étapes email ; sans profil, les étapes LinkedIn
    const unreachable = (s: Step, r: { email: string | null; linkedin: string | null }) => (s.channel === "linkedin" ? !r.linkedin : !r.email);
    const skipped = new Map<number, number>();
    const checked = rows.map((r) => {
      const values: Record<string, unknown> = {
        email: r.email,
        first_name: r.first_name,
        last_name: r.last_name,
        company: r.company,
        ...parseJsonObject(r.extra),
      };
      const used = new Set<string>();
      const missing = new Set<string>();
      for (const s of steps) {
        if (s.step_number <= r.current_step) continue; // déjà envoyée
        if (unreachable(s, r)) {
          skipped.set(s.step_number, (skipped.get(s.step_number) ?? 0) + 1);
          continue;
        }
        // blocs conditionnels résolus pour ce contact : seules comptent les variables du texte qu'il recevra
        for (const key of templateVariables(resolveSections(stepText(s), { ...senderFilled, ...values })).keys()) {
          if (SENDER_VARS.has(key)) continue;
          used.add(key);
          if (!String(values[key] ?? "").trim()) missing.add(key);
        }
      }
      for (const key of used) stats.get(key)!.used++;
      for (const key of missing) stats.get(key)!.missing++;
      return { row: r, missing: [...missing] };
    });
    // Une variable vide chez tous ses contacts est signalée une fois, pas contact par contact
    const nowhere = new Set([...stats].filter(([, st]) => st.used > 0 && st.missing === st.used).map(([key]) => key));
    const incomplete = checked
      .map(({ row, missing }) => ({ row, missing: missing.filter((key) => !nowhere.has(key)) }))
      .filter((c) => c.missing.length);

    // Comptes qui porteront les premiers envois : actifs et autorisés par la campagne
    const allowed = parseAccountIds(campaign.account_ids);
    const senders = (db.prepare("SELECT * FROM accounts WHERE active = 1 ORDER BY id").all() as AccountRow[]).filter(
      (a) => !allowed || allowed.includes(a.id)
    );
    const emailSteps = steps.filter((s) => s.channel !== "linkedin");
    const usedIn = (list: Step[], key: string) => list.filter((s) => stepVars.get(s.step_number)!.has(key));
    const warnings: string[] = [];
    if (emailSteps.length && !senders.length) {
      warnings.push("Aucun compte Google actif autorisé pour cette campagne : les emails ne partiront pas.");
    }
    const unsigned = senders.filter((a) => !a.signature?.trim()).map((a) => a.email);
    if (usedIn(emailSteps, "signature").length && unsigned.length) {
      warnings.push(`{{signature}} sera vide pour ${unsigned.join(", ")} (compte sans signature).`);
    }
    if (usedIn(emailSteps, "link").length && !config.visit.enabled) {
      warnings.push("{{link}} sera vide : le lien de suivi est désactivé (VISIT_ENABLED=false).");
    }
    for (const s of steps) {
      // un {{si …}} resté après résolution n'a pas de {{fin}} : il partirait tel quel dans le message
      if (/\{\{\s*si\s/iu.test(resolveSections(stepText(s), {}))) warnings.push(`Étape ${s.step_number} : bloc {{si …}} sans {{fin}}.`);
    }
    for (const s of steps.filter((x) => x.channel === "linkedin")) {
      const empty = [...SENDER_VARS].filter((key) => stepVars.get(s.step_number)!.has(key));
      if (empty.length) {
        warnings.push(`Étape ${s.step_number} (LinkedIn) : ${empty.map((k) => `{{${k}}}`).join(", ")} toujours vide dans un message LinkedIn.`);
      }
    }

    // Rendu des étapes restantes pour les premiers contacts, tel qu'il partira
    const link = config.visit.enabled ? `${config.visit.baseUrl}/p/exemple` : "";
    const firstEmail = emailSteps[0];
    const rendered = rows.slice(0, Math.min(Math.max(samples, 0), 5)).map((r) => {
      const account = r.account_id != null ? accountById(r.account_id) : senders[0];
      const vars = senderVars(account, r, link);
      const subjectOf = (s: Step) => (r.variant === "B" && s.subject_b ? s.subject_b : s.subject);
      return {
        cc_id: r.cc_id,
        contact_id: r.contact_id,
        to: r.email ?? r.linkedin,
        from: account ? fromLabel(account) : null,
        steps: steps
          .filter((s) => s.step_number > r.current_step && !unreachable(s, r))
          .map((s) =>
            s.channel === "linkedin"
              ? {
                  step_number: s.step_number,
                  channel: s.channel,
                  li_action: s.li_action,
                  body: s.body?.trim() ? renderTemplate(s.body, r, { sender_name: "", signature: "" }) : "",
                }
              : {
                  step_number: s.step_number,
                  channel: s.channel,
                  // Relance sans sujet : même fil que le premier email
                  subject: s !== firstEmail && !s.subject ? `Re: ${renderTemplate(subjectOf(firstEmail), r, vars)}` : renderTemplate(subjectOf(s), r, vars),
                  body: renderTemplate(s.body, r, vars),
                }
          ),
      };
    });

    res.json({
      campaign: { id: campaign.id, name: campaign.name, status: campaign.status },
      statuses,
      checked: rows.length,
      ready: checked.filter((c) => !c.missing.length).length,
      steps: steps.map((s) => ({
        step_number: s.step_number,
        channel: s.channel,
        li_action: s.li_action,
        variables: [...stepVars.get(s.step_number)!.keys()],
        // contacts qui sauteront l'étape (sans email / sans profil LinkedIn)
        ...(skipped.has(s.step_number) ? { skipped: skipped.get(s.step_number) } : {}),
      })),
      missing: [...stats]
        .filter(([, st]) => st.missing > 0)
        .map(([variable, st]) => ({
          variable,
          steps: st.steps,
          contacts: st.missing,
          ...(nowhere.has(variable) ? { all: true } : {}),
          ...(st.genderOnly ? { gender_form: true } : {}),
        })),
      incomplete_total: incomplete.length,
      incomplete: incomplete.slice(0, Math.min(Math.max(limit, 1), 500)).map(({ row, missing }) => ({
        cc_id: row.cc_id,
        contact_id: row.contact_id,
        name: [row.first_name, row.last_name].filter(Boolean).join(" ") || null,
        email: row.email,
        linkedin: row.email ? null : row.linkedin,
        status: row.status,
        missing,
      })),
      warnings,
      samples: rendered,
    });
  });
}
