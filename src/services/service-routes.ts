/**
 * Service API: Azerit (the recruiting app) drives here, for its users, each one's LinkedIn account
 * and campaigns. Called on the VPS internal network (http://sequence-app:3000), authenticated by
 * the shared key SERVICE_API_KEY (X-Service-Key header).
 * Everything is scoped by owner (`owner`, e.g. "azerit:u:12"):
 * - an owner has one current LinkedIn account (the latest active one);
 * - its campaigns (key `external_ref`, e.g. the job) are served only to its accounts — the rule
 *   lives in outreach.ts (ELIGIBLE), not here;
 * - another owner's campaign returns 404, as if it didn't exist.
 * Owners listed in LI_DASHBOARD_OWNERS are the exception: their campaigns are ordinary dashboard
 * campaigns (owner_ref NULL, svc_owner = them), sent from the dashboard's LinkedIn accounts — as
 * many as wanted, chosen by the client at creation (`li_account_ids`), which share the invitations.
 * They may also mix in emails (Gmail accounts of the dashboard, `account_ids`), typically on the
 * "invitation not accepted" branch, add their own LinkedIn accounts to the dashboard and connect
 * Gmail accounts — so the client never has to open the dashboard.
 * Azerit users never see Sequence Mail: Azerit relays.
 */
import { timingSafeEqual } from "node:crypto";
import type express from "express";
import { config } from "../config.js";
import { db } from "../db.js";
import { MERGED_EXTRA, importContacts, renderTemplate } from "./contacts.js";
import { OAUTH_STATE_AZERIT, authUrl } from "./google.js";
import { normalizeLinkedin } from "./linkedin-url.js";
import {
  accountStatus,
  cancelLinkedInActions,
  createAccount,
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

/** "Léa Martin (in/lea-martin-42)": the name alone can't tell namesakes apart. */
const label = (name: string | null, slug: string) => (name ? `${name} (in/${slug})` : `in/${slug}`);

/** An owner's current account: the latest active one, else the latest. */
function ownerAccount(owner: string): LiAccount | undefined {
  const row = db
    .prepare("SELECT id FROM li_accounts WHERE owner_ref = ? ORDER BY active DESC, id DESC LIMIT 1")
    .get(owner) as { id: number } | undefined;
  return row ? getAccount(row.id) : undefined;
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

const isDashboardOwner = (owner: string) => config.linkedin.dashboardOwners.includes(owner);

/** Gmail accounts of the dashboard, as a dashboard owner sees them. */
function emailAccounts() {
  return (
    db
      .prepare("SELECT id, email, from_name, active, daily_limit, sent_today, sent_today_date FROM accounts ORDER BY email")
      .all() as Array<{ id: number; email: string; from_name: string | null; active: number; daily_limit: number; sent_today: number; sent_today_date: string | null }>
  ).map((a) => ({
    id: a.id,
    email: a.email,
    from_name: a.from_name,
    active: Boolean(a.active),
    sent_today: a.sent_today_date === new Date().toISOString().slice(0, 10) ? a.sent_today : 0,
  }));
}

/** Dashboard owner's choice of Gmail accounts: null = all, else existing ids only. */
function dashboardEmailSenders(ids: unknown): { value: string | null } | { error: string } {
  if (ids == null) return { value: null };
  if (!Array.isArray(ids) || !ids.length || !ids.every((x) => Number.isInteger(x))) {
    return { error: "account_ids : liste d'identifiants de comptes Gmail, au moins un" };
  }
  const known = new Set(emailAccounts().map((a) => a.id));
  if (!ids.every((id) => known.has(id as number))) return { error: "account_ids : compte Gmail inconnu" };
  return { value: JSON.stringify([...new Set(ids as number[])]) };
}

/** A LinkedIn account of the dashboard (owner_ref NULL), the only ones a dashboard owner may touch. */
function dashboardLiAccount(id: unknown): LiAccount | undefined {
  const a = getAccount(Number(id));
  return a && a.owner_ref == null ? a : undefined;
}

/** Dashboard owner's choice of sending accounts: null = all the dashboard's, else dashboard ids only. */
function dashboardSenders(ids: unknown): { value: string | null } | { error: string } {
  if (ids == null) return { value: null };
  if (!Array.isArray(ids) || !ids.length || !ids.every((x) => Number.isInteger(x))) {
    return { error: "li_account_ids : liste d'identifiants de comptes LinkedIn, au moins un" };
  }
  const dashboardIds = new Set(listAccounts().filter((a) => a.owner_ref == null).map((a) => a.id));
  if (!ids.every((id) => dashboardIds.has(id as number))) return { error: "li_account_ids : compte LinkedIn inconnu" };
  return { value: JSON.stringify([...new Set(ids as number[])]) };
}

interface OwnedCampaign {
  id: number;
  status: string;
  dashboard: number;
}

/** The owner's campaign: its own, or the dashboard campaign it created (LI_DASHBOARD_OWNERS). */
function ownedCampaign(id: unknown, owner: string): OwnedCampaign | undefined {
  return db
    .prepare(
      `SELECT id, status, owner_ref IS NULL AS dashboard FROM campaigns
       WHERE id = @id AND (owner_ref = @owner OR (owner_ref IS NULL AND svc_owner = @owner))`
    )
    .get({ id: Number(id), owner }) as OwnedCampaign | undefined;
}

type SvcStep = { action?: string; body?: string; subject?: string; wait_days?: number; branch?: string };
type CleanStep = { action: "invite" | "message" | "email"; body: string; subject: string; wait_days: number; branch: string | null };

/**
 * Steps: LinkedIn (invite / message) and, for dashboard owners only, email (subject + body; an empty
 * subject on a later email = reply in the same thread). `branch`: "accepted" / "not_accepted" (see
 * branches.ts) — the first "accepted" step must be a LinkedIn message (it tests the acceptance).
 */
function validateSteps(steps: unknown, allowEmail = false): { steps: CleanStep[] } | { error: string } {
  if (!Array.isArray(steps) || !steps.length || steps.length > 10) return { error: "steps[] : 1 à 10 étapes" };
  const out: CleanStep[] = [];
  for (const [i, raw] of (steps as SvcStep[]).entries()) {
    const action =
      raw?.action === "message" ? "message" : raw?.action === "invite" ? "invite" : raw?.action === "email" && allowEmail ? "email" : null;
    if (!action) return { error: `étape ${i + 1} : action attendue « invite » ou « message »${allowEmail ? " ou « email »" : ""}` };
    const body = typeof raw.body === "string" ? raw.body.trim() : "";
    const subject = action === "email" && typeof raw.subject === "string" ? raw.subject.trim().slice(0, 300) : "";
    if (action !== "invite" && !body) return { error: `étape ${i + 1} : message vide` };
    if (action !== "invite" && body.length > MESSAGE_MAX) return { error: `étape ${i + 1} : message trop long` };
    if (action === "invite" && body.length > INVITE_NOTE_MAX) {
      return { error: `étape ${i + 1} : note d'invitation limitée à ${INVITE_NOTE_MAX} caractères par LinkedIn` };
    }
    if (action === "email" && !subject && !out.some((s) => s.action === "email")) {
      return { error: `étape ${i + 1} : objet requis pour le premier email` };
    }
    const branch = raw.branch === "accepted" || raw.branch === "not_accepted" ? raw.branch : null;
    if (branch === "accepted" && !out.some((s) => s.branch === "accepted") && action !== "message") {
      return { error: `étape ${i + 1} : la première étape « acceptée » doit être un message LinkedIn` };
    }
    const wait = Number(raw.wait_days ?? (i === 0 ? 0 : 2));
    out.push({ action, body, subject, branch, wait_days: i === 0 ? 0 : Math.max(0, Math.min(60, Math.round(Number.isFinite(wait) ? wait : 2))) });
  }
  return { steps: out };
}

function replaceSteps(campaignId: number, steps: CleanStep[]): void {
  db.prepare("DELETE FROM steps WHERE campaign_id = ?").run(campaignId);
  const insert = db.prepare(
    `INSERT INTO steps (campaign_id, step_number, subject, subject_b, body, wait_days, channel, li_action, branch)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`
  );
  steps.forEach((s, i) =>
    insert.run(campaignId, i + 1, s.subject, s.body, s.wait_days, s.action === "email" ? "email" : "linkedin",
      s.action === "email" ? null : s.action, s.branch)
  );
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

export function registerServiceRoutes(app: express.Express): void {
  app.use("/api/svc", (req, res, next) => {
    if (!config.serviceApiKey) return res.status(503).json({ error: "API de service désactivée (SERVICE_API_KEY absente)" });
    if (!authorized(req)) return res.status(401).json({ error: "Clé de service invalide" });
    if (!ownerOf(req)) return res.status(400).json({ error: "owner manquant ou invalide" });
    next();
  });

  // --- Owner's LinkedIn account ---

  app.get("/api/svc/li/account", (req, res) => {
    const owner = ownerOf(req)!;
    // Dashboard owner: what sends is the dashboard's active LinkedIn accounts, not a linked one.
    if (isDashboardOwner(owner)) {
      // All of them, paused ones too: the client resumes them from Azerit.
      const accounts = listAccounts().filter((a) => a.owner_ref == null);
      return res.json({ account: null, dashboard: { accounts: accounts.map(accountStatus), email_accounts: emailAccounts() } });
    }
    const account = ownerAccount(owner);
    res.json({ account: account ? accountStatus(account) : null });
  });

  /**
   * Session handoff from the extension (via Azerit). The identity read in the browser is required.
   * A profile other than the account's is refused (409), unless `replace` — the explicit "switch
   * LinkedIn account" action. An account that already has contacts is then not overwritten: it is
   * disabled (its contacts stay tied to the old profile) and a new account replaces it.
   */
  app.post("/api/svc/li/session", (req, res) => {
    const owner = ownerOf(req)!;
    const b = req.body as { cookies?: unknown; user_agent?: unknown; member?: unknown; owner_name?: unknown; replace?: unknown };
    const member = parseMember(b.member);
    if (!member) return res.status(400).json({ error: "Profil LinkedIn connecté illisible : ouvrez LinkedIn dans ce navigateur puis réessayez." });
    const name = (typeof b.owner_name === "string" && b.owner_name.trim()) || member.name || member.slug;

    // Dashboard owner: the profile logged in this browser becomes (or refreshes) a dashboard
    // account — one per LinkedIn profile, as many profiles as wanted. Its proxy is set from Azerit.
    if (isDashboardOwner(owner)) {
      let account = listAccounts().find((a) => a.owner_ref == null && a.member_slug === member.slug);
      if (!account) account = createAccount(member.name || member.slug).account;
      const r = storeSession(account.id, b.cookies, b.user_agent, member, "server");
      if ("error" in r) return res.status(r.code === "other_member" ? 409 : 400).json(r);
      console.log(`[svc] LinkedIn session received from ${owner} for dashboard account #${account.id} (profile ${member.slug})`);
      return res.json({ account: accountStatus(getAccount(account.id)!), dashboard: true });
    }

    let account = ownerAccount(owner);
    if (account?.member_slug && account.member_slug !== member.slug) {
      if (!b.replace) {
        return res.status(409).json({
          code: "other_member",
          error: `Ce navigateur est connecté à LinkedIn en tant que « ${label(member.name, member.slug)} », pas « ${label(account.member_name, account.member_slug!)} » (votre compte relié).`,
          current: accountStatus(account).member,
          got: member,
        });
      }
      if (accountUsed(account.id)) {
        updateAccount(account.id, { active: false });
        account = undefined;
      } else {
        db.prepare("UPDATE li_accounts SET member_slug = NULL, member_name = NULL, member_avatar = NULL WHERE id = ?").run(account.id);
      }
    }
    if (!account) account = createAccount(name, owner).account;
    // Owner whose extension performs the sends itself: the account stays in extension mode, and the
    // extension gets a fresh token for it (the old one stops working) to connect on its own.
    const byExtension = config.linkedin.extensionOwners.includes(owner);
    const r = storeSession(account.id, b.cookies, b.user_agent, member, byExtension ? "extension" : "server");
    if ("error" in r) return res.status(r.code === "other_member" ? 409 : 400).json(r);
    if (!account.active) updateAccount(account.id, { active: true });
    console.log(`[svc] LinkedIn session received for ${owner} (profile ${member.slug}, account #${account.id})`);
    res.json({
      account: accountStatus(getAccount(account.id)!),
      ...(byExtension ? { token: rotateToken(account.id) } : {}),
    });
  });

  /** Dashboard owner: pauses / resumes a dashboard LinkedIn account, sets its proxy (null = none). */
  app.patch("/api/svc/li/dashboard-accounts/:id", (req, res) => {
    if (!isDashboardOwner(ownerOf(req)!)) return res.status(404).json({ error: "Compte introuvable" });
    const account = dashboardLiAccount(req.params.id);
    if (!account) return res.status(404).json({ error: "Compte introuvable" });
    const b = req.body as { active?: unknown; proxy?: unknown };
    if ("proxy" in b) {
      const r = setProxy(account.id, typeof b.proxy === "string" ? b.proxy : null);
      if ("error" in r) return res.status(400).json(r);
    }
    if (typeof b.active === "boolean") updateAccount(account.id, { active: b.active });
    res.json({ account: accountStatus(getAccount(account.id)!) });
  });

  /** Dashboard owner: Google consent link to connect a Gmail account; back to Azerit afterwards. */
  app.get("/api/svc/google/auth-url", (req, res) => {
    if (!isDashboardOwner(ownerOf(req)!)) return res.status(404).json({ error: "Introuvable" });
    if (!config.google.clientId) return res.status(503).json({ error: "Connexion Google non configurée sur Sequence Mail" });
    res.json({ url: authUrl(OAUTH_STATE_AZERIT) });
  });

  app.patch("/api/svc/li/account", (req, res) => {
    const account = ownerAccount(ownerOf(req)!);
    if (!account) return res.status(404).json({ error: "Aucun compte LinkedIn relié" });
    const b = req.body as { active?: unknown };
    if (typeof b.active === "boolean") updateAccount(account.id, { active: b.active });
    res.json({ account: accountStatus(getAccount(account.id)!) });
  });

  // --- Owner's campaigns ---

  /** Creates or updates campaign `external_ref` (steps replaced, contacts' progress kept). */
  app.post("/api/svc/campaigns", (req, res) => {
    const owner = ownerOf(req)!;
    const b = req.body as { external_ref?: unknown; name?: unknown; steps?: unknown; li_account_ids?: unknown; account_ids?: unknown };
    const ref = typeof b.external_ref === "string" ? b.external_ref.trim().slice(0, 200) : "";
    const name = typeof b.name === "string" ? b.name.trim().slice(0, 200) : "";
    if (!ref || !name) return res.status(400).json({ error: "external_ref et name requis" });
    const dashboard = isDashboardOwner(owner);
    const v = validateSteps(b.steps, dashboard);
    if ("error" in v) return res.status(400).json(v);
    const senders = dashboard && "li_account_ids" in b ? dashboardSenders(b.li_account_ids) : null;
    if (senders && "error" in senders) return res.status(400).json(senders);
    const emailSenders = dashboard && "account_ids" in b ? dashboardEmailSenders(b.account_ids) : null;
    if (emailSenders && "error" in emailSenders) return res.status(400).json(emailSenders);
    const id = db.transaction(() => {
      const found = (
        dashboard
          ? db.prepare("SELECT id FROM campaigns WHERE owner_ref IS NULL AND svc_owner = ? AND external_ref = ?")
          : db.prepare("SELECT id FROM campaigns WHERE owner_ref = ? AND external_ref = ?")
      ).get(owner, ref) as { id: number } | undefined;
      const cid =
        found?.id ??
        Number(
          (dashboard
            ? db
                .prepare("INSERT INTO campaigns (name, status, svc_owner, external_ref) VALUES (?, 'paused', ?, ?)")
                .run(name, owner, ref)
            : db
                .prepare("INSERT INTO campaigns (name, status, owner_ref, external_ref) VALUES (?, 'paused', ?, ?)")
                .run(name, owner, ref)
          ).lastInsertRowid
        );
      db.prepare("UPDATE campaigns SET name = ? WHERE id = ?").run(name, cid);
      if (senders) db.prepare("UPDATE campaigns SET li_account_ids = ? WHERE id = ?").run(senders.value, cid);
      if (emailSenders) db.prepare("UPDATE campaigns SET account_ids = ? WHERE id = ?").run(emailSenders.value, cid);
      replaceSteps(cid, v.steps);
      return cid;
    })();
    res.json({ id, ...(dashboard ? { dashboard: true } : {}) });
  });

  /**
   * Enrolls and launches candidates: [{ key, first_name, last_name, company, linkedin, email?,
   * vars? }]. `vars` (e.g. the message written for this candidate) stays specific to this
   * enrollment. An already launched candidate isn't relaunched.
   */
  app.post("/api/svc/campaigns/:id/enroll", async (req, res) => {
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

    const uses = (template: string) =>
      Object.keys(vars).some((k) => new RegExp(`\\{\\{\\s*(?:(?:if|si)\\s+)?${k}\\s*[}:]`, "iu").test(template));
    const requeued = db.transaction(() => {
      db.prepare("UPDATE campaign_contacts SET vars = NULLIF(json_patch(COALESCE(vars, '{}'), ?), '{}') WHERE id = ?").run(
        JSON.stringify(vars),
        cc.id
      );
      const contact = db
        .prepare(
          `SELECT c.email, c.first_name, c.last_name, c.company, ${MERGED_EXTRA} AS extra
           FROM campaign_contacts cc JOIN contacts c ON c.id = cc.contact_id WHERE cc.id = ?`
        )
        .get(cc.id) as Parameters<typeof renderTemplate>[1];
      const queued = db
        .prepare(
          `SELECT la.id, s.body FROM li_actions la
           JOIN steps s ON s.campaign_id = ? AND s.step_number = la.step_number
           WHERE la.campaign_contact_id = ? AND la.status = 'pending'`
        )
        .all(campaign.id, cc.id) as Array<{ id: number; body: string | null }>;
      // 'pending' only: an action the executor has already taken ('sending') is not touched
      const rewrite = db.prepare("UPDATE li_actions SET body = ? WHERE id = ? AND status = 'pending'");
      let n = 0;
      for (const a of queued) {
        if (!a.body?.trim() || !uses(a.body)) continue;
        n += rewrite.run(renderTemplate(a.body, contact, { sender_name: "", signature: "" }), a.id).changes;
      }
      return n;
    })();
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
