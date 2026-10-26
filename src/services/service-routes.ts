/**
 * Service API: Azerit (the recruiting app) drives here, for its users, their sending accounts and
 * campaigns. Called on the VPS internal network (http://sequence-app:3000), authenticated by the
 * shared key SERVICE_API_KEY (X-Service-Key header).
 * Everything is scoped by owner (`owner`, e.g. "azerit:u:12"):
 * - an owner has its own pool of sending accounts — LinkedIn (li_accounts.owner_ref), one per
 *   LinkedIn profile, as many as wanted, and Gmail (accounts.owner_ref) — that nobody else sees or
 *   uses;
 * - its campaigns (key `external_ref`, e.g. the job) are served only by its accounts — the rules live
 *   in outreach.ts (ELIGIBLE) and scheduler.ts (pickAccount), not here — among them, those it ticked
 *   (li_account_ids, account_ids; null = all of them);
 * - another owner's campaign or account returns 404, as if it didn't exist.
 * Azerit users never see Sequence Mail: Azerit relays.
 */
import { timingSafeEqual } from "node:crypto";
import type express from "express";
import { config } from "../config.js";
import { db } from "../db.js";
import { MERGED_EXTRA, importContacts, renderTemplate } from "./contacts.js";
import { authUrl, signOwnerState } from "./google.js";
import { normalizeLinkedin } from "./linkedin-url.js";
import { applyWithPrevious } from "./outreach.js";
import { campaignStepRows, replaceSteps, validateSteps, type StepInput } from "./steps.js";
import { listInstructions, setInstruction } from "./variables.js";
import {
  accountStatus,
  cancelLinkedInActions,
  createAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  setProxy,
  parseMember,
  rotateToken,
  storeSession,
  updateAccount,
  type LiAccount,
} from "./outreach.js";

const OWNER = /^[a-z0-9][a-z0-9:_.-]{0,99}$/i;
const INVITE_NOTE_MAX = 200; // LinkedIn limit for an invite note (free account; over it, the invite goes without a note)
const MESSAGE_MAX = 8000;

function authorized(req: express.Request): boolean {
  const key = config.serviceApiKey;
  const got = req.get("x-service-key") ?? "";
  if (!key || !got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

function ownerOf(req: express.Request): string | null {
  const raw = (req.method === "GET" ? req.query.owner : (req.body as Record<string, unknown>)?.owner) ?? "";
  const owner = String(raw).trim();
  return OWNER.test(owner) ? owner : null;
}

/** The owner's LinkedIn accounts, oldest first. */
function ownerLiAccounts(owner: string): LiAccount[] {
  return listAccounts().filter((a) => a.owner_ref === owner);
}

/** One of the owner's LinkedIn accounts, or nothing (another owner's = unknown). */
function ownerLiAccount(owner: string, id: unknown): LiAccount | undefined {
  const a = getAccount(Number(id));
  return a && a.owner_ref === owner ? a : undefined;
}

function accountUsed(id: number): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM li_actions WHERE li_account_id = @id
         UNION SELECT 1 FROM campaign_contacts WHERE li_account_id = @id LIMIT 1`
      )
      .get({ id })
  );
}

/** The owner's Gmail accounts, as Azerit shows them. */
function ownerEmailAccounts(owner: string) {
  const today = new Date().toISOString().slice(0, 10);
  return (
    db
      .prepare("SELECT id, email, from_name, active, sent_today, sent_today_date FROM accounts WHERE owner_ref = ? ORDER BY id")
      .all(owner) as Array<{ id: number; email: string; from_name: string | null; active: number; sent_today: number; sent_today_date: string | null }>
  ).map((a) => ({
    id: a.id,
    email: a.email,
    from_name: a.from_name,
    active: Boolean(a.active),
    sent_today: a.sent_today_date === today ? a.sent_today : 0,
  }));
}

/** Choice of sending accounts among the owner's own: null = all of them. */
function ownedIds(ids: unknown, owned: number[], field: string): { value: string | null } | { error: string } {
  if (ids == null) return { value: null };
  if (!Array.isArray(ids) || !ids.length || !ids.every((x) => Number.isInteger(x))) {
    return { error: `${field} : liste d'identifiants de comptes, au moins un` };
  }
  if (!ids.every((id) => owned.includes(id as number))) return { error: `${field} : compte inconnu` };
  return { value: JSON.stringify([...new Set(ids as number[])]) };
}

interface OwnedCampaign {
  id: number;
  status: string;
}

function ownedCampaign(id: unknown, owner: string): OwnedCampaign | undefined {
  return db.prepare("SELECT id, status FROM campaigns WHERE id = ? AND owner_ref = ?").get(Number(id), owner) as
    | OwnedCampaign
    | undefined;
}

/**
 * Steps as Azerit sends them: the dashboard's own shape (channel, li_action, subject, subject_b,
 * body, wait_days, branch, with_previous). They obey the dashboard's rules (steps.ts) plus the
 * size limits: a sequence written from Azerit is exactly what the dashboard would have saved.
 */
function toSteps(steps: unknown): { steps: StepInput[] } | { error: string } {
  if (!Array.isArray(steps) || !steps.length || steps.length > 10) return { error: "steps[] : 1 à 10 étapes" };
  const out: StepInput[] = [];
  for (const [i, raw] of (steps as Array<Partial<StepInput>>).entries()) {
    const kind = raw?.channel === "linkedin" ? (raw.li_action === "message" ? "message" : "invite") : raw?.channel === "email" ? "email" : null;
    if (!kind) return { error: `étape ${i + 1} : channel attendu « linkedin » (li_action invite | message) ou « email »` };
    const body = typeof raw.body === "string" ? raw.body.trim() : "";
    const subject = kind === "email" && typeof raw.subject === "string" ? raw.subject.trim().slice(0, 300) : "";
    const subjectB = kind === "email" && typeof raw.subject_b === "string" ? raw.subject_b.trim().slice(0, 300) : "";
    if (kind !== "invite" && !body) return { error: `étape ${i + 1} : message vide` };
    if (body.length > MESSAGE_MAX) return { error: `étape ${i + 1} : message trop long` };
    if (kind === "invite" && body.length > INVITE_NOTE_MAX) {
      return { error: `étape ${i + 1} : note d'invitation limitée à ${INVITE_NOTE_MAX} caractères par LinkedIn` };
    }
    const branch = raw.branch === "accepted" || raw.branch === "not_accepted" ? raw.branch : undefined;
    const wait = Number(raw.wait_days ?? (i === 0 ? 0 : 2));
    out.push({
      channel: kind === "email" ? "email" : "linkedin",
      li_action: kind === "email" ? undefined : kind,
      subject,
      subject_b: subjectB || undefined,
      body,
      wait_days: Math.max(0, Math.min(60, Math.round(Number.isFinite(wait) ? wait : 2))),
      branch,
      with_previous: i > 0 && Boolean(raw.with_previous),
    });
  }
  const error = validateSteps(out);
  return error ? { error } : { steps: out };
}

/** Enrollment variables: simple keys, text values. */
function cleanVars(vars: unknown): Record<string, string> | null {
  if (!vars || typeof vars !== "object") return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars as Record<string, unknown>)) {
    if (/^[\p{L}\p{N}_]{1,40}$/u.test(k) && (typeof v === "string" || typeof v === "number")) {
      out[k] = String(v).slice(0, MESSAGE_MAX);
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Merges variables into one enrollment (campaign_contacts.vars); a null value removes the variable.
 * A LinkedIn action already queued but not yet sent, whose step uses one of these variables, is
 * re-rendered with them; what has gone out stays as it was (emails render at send time). Returns
 * the number of queued actions rewritten. Shared by the service API (Azerit) and the dashboard.
 */
export function setEnrollmentVars(campaignId: number, ccId: number, vars: Record<string, string | null>): number {
  const keys = Object.keys(vars);
  const uses = (template: string) =>
    keys.some((k) => new RegExp(`\\{\\{\\s*(?:(?:if|si)\\s+)?${k}\\s*[}:]`, "iu").test(template));
  return db.transaction(() => {
    db.prepare("UPDATE campaign_contacts SET vars = NULLIF(json_patch(COALESCE(vars, '{}'), ?), '{}') WHERE id = ?").run(
      JSON.stringify(vars),
      ccId
    );
    const contact = db
      .prepare(
        `SELECT c.email, c.first_name, c.last_name, c.company, ${MERGED_EXTRA} AS extra
         FROM campaign_contacts cc JOIN contacts c ON c.id = cc.contact_id WHERE cc.id = ?`
      )
      .get(ccId) as Parameters<typeof renderTemplate>[1];
    const queued = db
      .prepare(
        `SELECT la.id, s.body FROM li_actions la
         JOIN steps s ON s.campaign_id = ? AND s.step_number = la.step_number
         WHERE la.campaign_contact_id = ? AND la.status = 'pending'`
      )
      .all(campaignId, ccId) as Array<{ id: number; body: string | null }>;
    // 'pending' only: an action the executor has already taken ('sending') is not touched
    const rewrite = db.prepare("UPDATE li_actions SET body = ? WHERE id = ? AND status = 'pending'");
    let n = 0;
    for (const a of queued) {
      if (!a.body?.trim() || !uses(a.body)) continue;
      n += rewrite.run(renderTemplate(a.body, contact, { sender_name: "", signature: "" }), a.id).changes;
    }
    return n;
  })();
}

export function registerServiceRoutes(app: express.Express): void {
  app.use("/api/svc", (req, res, next) => {
    if (!config.serviceApiKey) return res.status(503).json({ error: "API de service désactivée (SERVICE_API_KEY absente)" });
    if (!authorized(req)) return res.status(401).json({ error: "Clé de service invalide" });
    if (!ownerOf(req)) return res.status(400).json({ error: "owner manquant ou invalide" });
    next();
  });

  // --- Owner's sending accounts ---

  /**
   * The owner's accounts: `accounts` (LinkedIn, paused ones too — the owner resumes them),
   * `email_accounts` (Gmail). `account` = the latest active LinkedIn one, for callers that only know
   * a single account.
   */
  app.get("/api/svc/li/account", (req, res) => {
    const owner = ownerOf(req)!;
    const accounts = ownerLiAccounts(owner);
    const current = [...accounts].reverse().find((a) => a.active) ?? accounts.at(-1);
    res.json({
      account: current ? accountStatus(current) : null,
      accounts: accounts.map(accountStatus),
      email_accounts: ownerEmailAccounts(owner),
    });
  });

  /**
   * Session handoff from the extension (via Azerit). The identity read in the browser is required.
   * The profile logged in becomes one of the owner's accounts — or refreshes it, if the owner already
   * has it: one account per LinkedIn profile, as many profiles as wanted. A paused account stays
   * paused (the owner resumes it).
   */
  app.post("/api/svc/li/session", (req, res) => {
    const owner = ownerOf(req)!;
    const b = req.body as { cookies?: unknown; user_agent?: unknown; member?: unknown };
    const member = parseMember(b.member);
    if (!member) return res.status(400).json({ error: "Profil LinkedIn connecté illisible : ouvrez LinkedIn dans ce navigateur puis réessayez." });

    // An account of this owner whose identity was never read (created before identities): adopted.
    const accounts = ownerLiAccounts(owner);
    const account =
      accounts.find((a) => a.member_slug === member.slug) ??
      accounts.find((a) => !a.member_slug && !accountUsed(a.id)) ??
      createAccount(member.name || member.slug, owner).account;
    // Profile already linked elsewhere (dashboard, other owner): the lowest cap of the profile
    // applies to all its accounts, so the new one takes the existing caps rather than the default.
    const twin = listAccounts().find((a) => a.id !== account.id && a.member_slug === member.slug);
    if (twin && account.member_slug !== member.slug) {
      updateAccount(account.id, { invites_per_day: twin.invites_per_day, messages_per_day: twin.messages_per_day });
    }
    // Owner whose extension performs the sends itself: the account stays in extension mode, and the
    // extension gets a fresh token for it (the old one stops working) to connect on its own.
    const byExtension = config.linkedin.extensionOwners.includes(owner);
    const r = storeSession(account.id, b.cookies, b.user_agent, member, byExtension ? "extension" : "server");
    if ("error" in r) return res.status(r.code === "other_member" ? 409 : 400).json(r);
    console.log(`[svc] LinkedIn session received for ${owner} (profile ${member.slug}, account #${account.id})`);
    res.json({
      account: accountStatus(getAccount(account.id)!),
      ...(byExtension ? { token: rotateToken(account.id) } : {}),
    });
  });

  /** Pauses / resumes one of the owner's LinkedIn accounts, sets its proxy (null = none). */
  app.patch("/api/svc/li/accounts/:id", (req, res) => {
    const account = ownerLiAccount(ownerOf(req)!, req.params.id);
    if (!account) return res.status(404).json({ error: "Compte introuvable" });
    const b = req.body as { active?: unknown; proxy?: unknown };
    if ("proxy" in b) {
      const r = setProxy(account.id, typeof b.proxy === "string" ? b.proxy : null);
      if ("error" in r) return res.status(400).json(r);
    }
    if (typeof b.active === "boolean") updateAccount(account.id, { active: b.active });
    res.json({ account: accountStatus(getAccount(account.id)!) });
  });

  /** Removes one of the owner's LinkedIn accounts — refused (409) once it has contacts: pause it. */
  app.delete("/api/svc/li/accounts/:id", (req, res) => {
    const account = ownerLiAccount(ownerOf(req)!, req.params.id);
    if (!account) return res.status(404).json({ error: "Compte introuvable" });
    const r = deleteAccount(account.id);
    if ("error" in r) return res.status(409).json(r);
    res.json({ ok: true });
  });

  /** Pauses / resumes all of the owner's LinkedIn accounts. */
  app.patch("/api/svc/li/account", (req, res) => {
    const accounts = ownerLiAccounts(ownerOf(req)!);
    if (!accounts.length) return res.status(404).json({ error: "Aucun compte LinkedIn relié" });
    const b = req.body as { active?: unknown };
    if (typeof b.active === "boolean") for (const a of accounts) updateAccount(a.id, { active: b.active });
    res.json({ accounts: accounts.map((a) => accountStatus(getAccount(a.id)!)) });
  });

  /** Pauses / resumes one of the owner's Gmail accounts. */
  app.patch("/api/svc/email-accounts/:id", (req, res) => {
    const owner = ownerOf(req)!;
    const found = db.prepare("SELECT id FROM accounts WHERE id = ? AND owner_ref = ?").get(Number(req.params.id), owner);
    if (!found) return res.status(404).json({ error: "Compte introuvable" });
    const b = req.body as { active?: unknown };
    if (typeof b.active === "boolean") db.prepare("UPDATE accounts SET active = ? WHERE id = ?").run(b.active ? 1 : 0, Number(req.params.id));
    res.json({ email_accounts: ownerEmailAccounts(owner) });
  });

  /**
   * Google consent link to connect a Gmail account to this owner: the owner rides in the OAuth
   * `state`, signed and short-lived (the callback is public), and the person comes back to Azerit.
   */
  app.get("/api/svc/google/auth-url", (req, res) => {
    if (!config.google.clientId) return res.status(503).json({ error: "Connexion Google non configurée sur Sequence Mail" });
    res.json({ url: authUrl(signOwnerState(ownerOf(req)!)) });
  });

  // --- Owner's campaigns ---

  /** Creates or updates campaign `external_ref` (steps replaced, contacts' progress kept). */
  app.post("/api/svc/campaigns", (req, res) => {
    const owner = ownerOf(req)!;
    const b = req.body as { external_ref?: unknown; name?: unknown; steps?: unknown; li_account_ids?: unknown; account_ids?: unknown };
    const ref = typeof b.external_ref === "string" ? b.external_ref.trim().slice(0, 200) : "";
    const name = typeof b.name === "string" ? b.name.trim().slice(0, 200) : "";
    if (!ref || !name) return res.status(400).json({ error: "external_ref et name requis" });
    const v = toSteps(b.steps);
    if ("error" in v) return res.status(400).json(v);
    const liSenders = "li_account_ids" in b
      ? ownedIds(b.li_account_ids, ownerLiAccounts(owner).map((a) => a.id), "li_account_ids")
      : null;
    if (liSenders && "error" in liSenders) return res.status(400).json(liSenders);
    const emailSenders = "account_ids" in b
      ? ownedIds(b.account_ids, ownerEmailAccounts(owner).map((a) => a.id), "account_ids")
      : null;
    if (emailSenders && "error" in emailSenders) return res.status(400).json(emailSenders);
    const id = db.transaction(() => {
      const found = db.prepare("SELECT id FROM campaigns WHERE owner_ref = ? AND external_ref = ?").get(owner, ref) as
        | { id: number }
        | undefined;
      const cid =
        found?.id ??
        Number(
          db
            .prepare("INSERT INTO campaigns (name, status, owner_ref, external_ref) VALUES (?, 'paused', ?, ?)")
            .run(name, owner, ref).lastInsertRowid
        );
      db.prepare("UPDATE campaigns SET name = ? WHERE id = ?").run(name, cid);
      if (liSenders) db.prepare("UPDATE campaigns SET li_account_ids = ? WHERE id = ?").run(liSenders.value, cid);
      if (emailSenders) db.prepare("UPDATE campaigns SET account_ids = ? WHERE id = ?").run(emailSenders.value, cid);
      replaceSteps(cid, v.steps);
      return cid;
    })();
    // A step set to go "at the same time" goes now for contacts already past the previous one.
    res.json({ id, sent_now: applyWithPrevious(id) });
  });

  /**
   * The campaign as Azerit's Sequence page shows it: its steps in the dashboard's shape, its
   * sending accounts, its state, and each enrolled candidate's variables (the ones Azerit sent,
   * plus any set here — Azerit shows and counts them). These steps are the sequence: Azerit keeps
   * no copy.
   */
  app.get("/api/svc/campaigns/:id", (req, res) => {
    const owner = ownerOf(req)!;
    const campaign = db
      .prepare(
        "SELECT id, name, status, account_ids, li_account_ids FROM campaigns WHERE id = ? AND owner_ref = ?"
      )
      .get(Number(req.params.id), owner) as
      | { id: number; name: string; status: string; account_ids: string | null; li_account_ids: string | null }
      | undefined;
    if (!campaign) return res.status(404).json({ error: "Campagne introuvable" });
    res.json({
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      steps: campaignStepRows(campaign.id).map((s) => ({ ...s, with_previous: Boolean(s.with_previous) })),
      li_account_ids: campaign.li_account_ids ? JSON.parse(campaign.li_account_ids) : null,
      account_ids: campaign.account_ids ? JSON.parse(campaign.account_ids) : null,
      contacts: (
        db
          .prepare("SELECT external_key AS key, vars FROM campaign_contacts WHERE campaign_id = ? AND external_key IS NOT NULL")
          .all(campaign.id) as Array<{ key: string; vars: string | null }>
      ).map((c) => ({ key: c.key, vars: c.vars ? (JSON.parse(c.vars) as Record<string, string>) : {} })),
    });
  });

  /**
   * The variable instructions ({{perso}}: what it contains, length, tone), by name — the very ones
   * the dashboard's Variables panel shows and edits. Set one with PUT (empty text removes it).
   */
  app.get("/api/svc/variables", (_req, res) => {
    res.json({ variables: listInstructions() });
  });
  app.put("/api/svc/variables/:name", (req, res) => {
    const instruction = (req.body as { instruction?: unknown }).instruction;
    if (typeof instruction !== "string" || instruction.length > MESSAGE_MAX) {
      return res.status(400).json({ error: "instruction : texte attendu" });
    }
    const err = setInstruction(req.params.name, instruction);
    if (err) return res.status(400).json({ error: err });
    res.json({ variables: listInstructions() });
  });

  /**
   * Enrolls candidates: [{ key, first_name, last_name, company, linkedin, email?, vars? }].
   * `vars` (e.g. the message written for this candidate) stays specific to this enrollment.
   * `/enroll` launches them; `/hold` leaves them held — nothing goes out until `/launch`. A separate
   * route rather than a flag: a server without it answers 404 instead of sending. An already
   * launched candidate isn't relaunched (nor put back on hold).
   */
  const enroll = (hold: boolean) => async (req: express.Request, res: express.Response) => {
    const owner = ownerOf(req)!;
    const campaign = ownedCampaign(req.params.id, owner);
    if (!campaign) return res.status(404).json({ error: "Campagne introuvable" });
    const list = (req.body as { contacts?: unknown }).contacts;
    if (!Array.isArray(list) || !list.length || list.length > 500) return res.status(400).json({ error: "contacts[] : 1 à 500" });

    const hasEmail = Boolean(
      db.prepare("SELECT 1 FROM steps WHERE campaign_id = ? AND channel = 'email' LIMIT 1").get(campaign.id)
    );
    const results: Array<{ key: string; cc_id?: number; status: string; error?: string }> = [];
    const rows: Array<Record<string, string>> = [];
    const meta: Array<{ key: string; vars: Record<string, string> | null }> = [];
    for (const raw of list as Array<Record<string, unknown>>) {
      const key = typeof raw?.key === "string" ? raw.key.trim().slice(0, 300) : "";
      if (!key) {
        results.push({ key: "", status: "rejected", error: "key manquante" });
        continue;
      }
      const str = (x: unknown) => (typeof x === "string" ? x.trim().slice(0, 300) : "");
      const normalized = normalizeLinkedin(typeof raw.linkedin === "string" ? raw.linkedin : "");
      const linkedin = normalized && /\/in\//.test(normalized) ? normalized : "";
      const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(str(raw.email)) ? str(raw.email) : "";
      // Without email steps, a LinkedIn profile is required (the email is only kept on the contact).
      if (!linkedin && !(hasEmail && email)) {
        results.push({ key, status: "rejected", error: hasEmail ? "ni profil LinkedIn ni email" : "profil LinkedIn manquant" });
        continue;
      }
      rows.push({
        email,
        first_name: str(raw.first_name),
        last_name: str(raw.last_name),
        company: str(raw.company),
        linkedin,
      });
      meta.push({ key, vars: cleanVars(raw.vars) });
    }

    if (rows.length) {
      const report = await importContacts(campaign.id, rows, { withIds: true });
      const ccOf = db.prepare("SELECT id, status FROM campaign_contacts WHERE campaign_id = ? AND contact_id = ?");
      const setMeta = db.prepare("UPDATE campaign_contacts SET vars = ?, external_key = ? WHERE id = ?");
      const launch = db.prepare("UPDATE campaign_contacts SET status = 'pending', error = NULL WHERE id = ? AND status = 'held'");
      db.transaction(() => {
        report.contact_ids!.forEach((contactId, i) => {
          const { key, vars } = meta[i];
          if (contactId == null) {
            results.push({ key, status: "rejected", error: "désinscrit ou injoignable" });
            return;
          }
          const cc = ccOf.get(campaign.id, contactId) as { id: number; status: string } | undefined;
          if (!cc) {
            results.push({ key, status: "rejected", error: "désinscrit (ne plus contacter)" });
            return;
          }
          if (cc.status === "held") {
            setMeta.run(vars ? JSON.stringify(vars) : null, key, cc.id);
            if (hold) {
              results.push({ key, cc_id: cc.id, status: "held" });
              return;
            }
            launch.run(cc.id);
            results.push({ key, cc_id: cc.id, status: "pending" });
          } else {
            results.push({ key, cc_id: cc.id, status: cc.status, error: "déjà lancé" });
          }
        });
        if (results.some((r) => r.status === "pending")) db.prepare("UPDATE campaigns SET status = 'active' WHERE id = ?").run(campaign.id);
      })();
    }
    res.json({ results });
  };
  app.post("/api/svc/campaigns/:id/enroll", enroll(false));
  app.post("/api/svc/campaigns/:id/hold", enroll(true));

  /** Launches held candidates (Azerit keys). `launched`: keys that were held and now go out. */
  app.post("/api/svc/campaigns/:id/launch", (req, res) => {
    const campaign = ownedCampaign(req.params.id, ownerOf(req)!);
    if (!campaign) return res.status(404).json({ error: "Campagne introuvable" });
    const keys = (req.body as { keys?: unknown }).keys;
    if (!Array.isArray(keys) || !keys.length || keys.length > 500) return res.status(400).json({ error: "keys[] : 1 à 500" });
    const launch = db.prepare(
      "UPDATE campaign_contacts SET status = 'pending', error = NULL WHERE campaign_id = ? AND external_key = ? AND status = 'held'"
    );
    const launched = db.transaction(() => {
      const done = keys.map(String).filter((key) => launch.run(campaign.id, key).changes > 0);
      if (done.length) db.prepare("UPDATE campaigns SET status = 'active' WHERE id = ?").run(campaign.id);
      return done;
    })();
    res.json({ launched });
  });

  /**
   * Rewrites one candidate's enrollment variables (Azerit key), e.g. the message retouched in
   * Azerit. A LinkedIn action already queued but not yet sent, whose step uses one of these
   * variables, is re-rendered with them; what has gone out stays as it was.
   * `requeued`: queued actions rewritten.
   */
  app.post("/api/svc/campaigns/:id/vars", (req, res) => {
    const campaign = ownedCampaign(req.params.id, ownerOf(req)!);
    if (!campaign) return res.status(404).json({ error: "Campagne introuvable" });
    const b = req.body as { key?: unknown; vars?: unknown };
    const key = typeof b.key === "string" ? b.key.trim() : "";
    const vars = cleanVars(b.vars);
    if (!key || !vars) return res.status(400).json({ error: "key et vars requis" });
    const cc = db
      .prepare("SELECT id FROM campaign_contacts WHERE campaign_id = ? AND external_key = ?")
      .get(campaign.id, key) as { id: number } | undefined;
    if (!cc) return res.status(404).json({ error: "Candidat introuvable dans cette campagne" });

    const requeued = setEnrollmentVars(campaign.id, cc.id, vars);
    res.json({ ok: true, requeued });
  });

  /** Each candidate's progress (Azerit key): status, LinkedIn actions, sender profile. */
  app.get("/api/svc/campaigns/:id/contacts", (req, res) => {
    const campaign = ownedCampaign(req.params.id, ownerOf(req)!);
    if (!campaign) return res.status(404).json({ error: "Campagne introuvable" });
    const contacts = db
      .prepare(
        `SELECT cc.id AS cc_id, cc.external_key AS key, cc.status, cc.current_step, cc.next_send_at, cc.replied_at,
                cc.error, cc.li_thread_url, c.linkedin, li.member_slug AS sender_slug, li.member_name AS sender_name
         FROM campaign_contacts cc
         JOIN contacts c ON c.id = cc.contact_id
         LEFT JOIN li_accounts li ON li.id = cc.li_account_id
         WHERE cc.campaign_id = ? AND cc.external_key IS NOT NULL
         ORDER BY cc.id`
      )
      .all(campaign.id) as Array<Record<string, unknown> & { cc_id: number }>;
    const actions = db
      .prepare(
        `SELECT la.campaign_contact_id AS cc_id, la.step_number, la.type, la.status, la.sent_at, la.not_before,
                la.error, la.member_slug
         FROM li_actions la JOIN campaign_contacts cc ON cc.id = la.campaign_contact_id
         WHERE cc.campaign_id = ? ORDER BY la.id`
      )
      .all(campaign.id) as Array<Record<string, unknown> & { cc_id: number }>;
    const byCc = new Map<number, Array<Record<string, unknown>>>();
    for (const { cc_id, ...a } of actions) byCc.set(cc_id, [...(byCc.get(cc_id) ?? []), a]);
    const emails = db
      .prepare(
        `SELECT m.campaign_contact_id AS cc_id, m.step_number, m.sent_at, a.email AS sent_from
         FROM messages m JOIN campaign_contacts cc ON cc.id = m.campaign_contact_id
         JOIN accounts a ON a.id = m.account_id
         WHERE cc.campaign_id = ? ORDER BY m.id`
      )
      .all(campaign.id) as Array<Record<string, unknown> & { cc_id: number }>;
    const emailsByCc = new Map<number, Array<Record<string, unknown>>>();
    for (const { cc_id, ...m } of emails) emailsByCc.set(cc_id, [...(emailsByCc.get(cc_id) ?? []), m]);
    const steps = (db.prepare("SELECT COUNT(*) AS n FROM steps WHERE campaign_id = ?").get(campaign.id) as { n: number }).n;
    res.json({
      campaign: { id: campaign.id, status: campaign.status, steps },
      contacts: contacts.map((c) => ({ ...c, actions: byCc.get(c.cc_id) ?? [], emails: emailsByCc.get(c.cc_id) ?? [] })),
    });
  });

  /**
   * Whole-campaign state: 'paused' (job closed: nothing goes out, nothing is lost), 'active'
   * (resume), 'stopped' (job deleted: every candidate still running is stopped, queued actions
   * cancelled).
   */
  app.post("/api/svc/campaigns/:id/status", (req, res) => {
    const campaign = ownedCampaign(req.params.id, ownerOf(req)!);
    if (!campaign) return res.status(404).json({ error: "Campagne introuvable" });
    const status = (req.body as { status?: unknown }).status;
    if (status !== "active" && status !== "paused" && status !== "stopped") {
      return res.status(400).json({ error: "status attendu : active | paused | stopped" });
    }
    db.transaction(() => {
      db.prepare("UPDATE campaigns SET status = ? WHERE id = ?").run(status === "active" ? "active" : "paused", campaign.id);
      if (status === "stopped") {
        db.prepare(
          `UPDATE campaign_contacts SET status = 'stopped', next_send_at = NULL
           WHERE campaign_id = ? AND status IN ('held', 'pending', 'in_progress', 'awaiting_li')`
        ).run(campaign.id);
        cancelLinkedInActions(
          "campaign_contact_id IN (SELECT id FROM campaign_contacts WHERE campaign_id = ?)",
          campaign.id,
          "poste supprimé dans Azerit"
        );
      }
    })();
    res.json({ ok: true, status });
  });

  /** Stops candidates' sequences (Azerit keys): nothing more goes out, queued actions cancelled. */
  app.post("/api/svc/campaigns/:id/stop", (req, res) => {
    const campaign = ownedCampaign(req.params.id, ownerOf(req)!);
    if (!campaign) return res.status(404).json({ error: "Campagne introuvable" });
    const keys = (req.body as { keys?: unknown }).keys;
    if (!Array.isArray(keys) || !keys.length) return res.status(400).json({ error: "keys[] requis" });
    const find = db.prepare(
      `SELECT id FROM campaign_contacts WHERE campaign_id = ? AND external_key = ?
         AND status IN ('held', 'pending', 'in_progress', 'awaiting_li')`
    );
    const stop = db.prepare("UPDATE campaign_contacts SET status = 'stopped', next_send_at = NULL WHERE id = ?");
    const stopped = db.transaction(() => {
      let n = 0;
      for (const key of keys) {
        const cc = find.get(campaign.id, String(key)) as { id: number } | undefined;
        if (!cc) continue;
        stop.run(cc.id);
        cancelLinkedInActions("campaign_contact_id = ?", cc.id, "arrêté depuis Azerit");
        n++;
      }
      return n;
    })();
    res.json({ stopped });
  });
}
