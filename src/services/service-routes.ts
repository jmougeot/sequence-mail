/**
 * API de service : Azerit (l'app de recrutement) pilote ici, pour ses
 * utilisateurs, le compte LinkedIn et les campagnes de chacun. Appelée sur le
 * réseau interne du VPS (http://sequence-app:3000), authentifiée par la clé
 * partagée SERVICE_API_KEY (en-tête X-Service-Key).
 *
 * Tout est rangé par propriétaire (`owner`, ex. « azerit:u:12 ») :
 *   - un propriétaire a un compte LinkedIn courant (le dernier actif) ;
 *   - ses campagnes (clé `external_ref`, ex. le poste) ne sont servies qu'à ses
 *     comptes — la règle vit dans outreach.ts (ELIGIBLE), pas ici ;
 *   - une campagne d'un autre propriétaire répond 404, comme si elle n'existait pas.
 *
 * Les utilisateurs d'Azerit ne voient jamais Sequence Mail : Azerit relaie.
 */
import { timingSafeEqual } from "node:crypto";
import type express from "express";
import { config } from "../config.js";
import { db } from "../db.js";
import { importContacts } from "./contacts.js";
import { normalizeLinkedin } from "./linkedin-url.js";
import {
  accountStatus,
  cancelLinkedInActions,
  createAccount,
  getAccount,
  parseMember,
  storeSession,
  updateAccount,
  type LiAccount,
} from "./outreach.js";

const OWNER = /^[a-z0-9][a-z0-9:_.-]{0,99}$/i;
const INVITE_NOTE_MAX = 300; // limite LinkedIn d'une note d'invitation
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

/** Compte courant d'un propriétaire : le plus récent actif, sinon le plus récent. */
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

interface OwnedCampaign {
  id: number;
  status: string;
}

function ownedCampaign(id: unknown, owner: string): OwnedCampaign | undefined {
  return db.prepare("SELECT id, status FROM campaigns WHERE id = ? AND owner_ref = ?").get(Number(id), owner) as
    | OwnedCampaign
    | undefined;
}

type SvcStep = { action?: string; body?: string; wait_days?: number };

/** Étapes LinkedIn uniquement (invitation / message) : l'email d'un client n'est pas branché ici. */
function validateSteps(steps: unknown): { steps: Required<SvcStep>[] } | { error: string } {
  if (!Array.isArray(steps) || !steps.length || steps.length > 10) return { error: "steps[] : 1 à 10 étapes" };
  const out: Required<SvcStep>[] = [];
  for (const [i, raw] of (steps as SvcStep[]).entries()) {
    const action = raw?.action === "message" ? "message" : raw?.action === "invite" ? "invite" : null;
    if (!action) return { error: `étape ${i + 1} : action attendue « invite » ou « message »` };
    const body = typeof raw.body === "string" ? raw.body.trim() : "";
    if (action === "message" && !body) return { error: `étape ${i + 1} : message vide` };
    if (action === "message" && body.length > MESSAGE_MAX) return { error: `étape ${i + 1} : message trop long` };
    if (action === "invite" && body.length > INVITE_NOTE_MAX) {
      return { error: `étape ${i + 1} : note d'invitation limitée à ${INVITE_NOTE_MAX} caractères par LinkedIn` };
    }
    const wait = Number(raw.wait_days ?? (i === 0 ? 0 : 2));
    out.push({ action, body, wait_days: i === 0 ? 0 : Math.max(0, Math.min(60, Math.round(Number.isFinite(wait) ? wait : 2))) });
  }
  return { steps: out };
}

function replaceSteps(campaignId: number, steps: Required<SvcStep>[]): void {
  db.prepare("DELETE FROM steps WHERE campaign_id = ?").run(campaignId);
  const insert = db.prepare(
    `INSERT INTO steps (campaign_id, step_number, subject, subject_b, body, wait_days, channel, li_action)
     VALUES (?, ?, '', NULL, ?, ?, 'linkedin', ?)`
  );
  steps.forEach((s, i) => insert.run(campaignId, i + 1, s.body, s.wait_days, s.action));
}

/** Variables d'inscription : clés simples, valeurs texte. */
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

  // --- Compte LinkedIn du propriétaire ---

  app.get("/api/svc/li/account", (req, res) => {
    const account = ownerAccount(ownerOf(req)!);
    res.json({ account: account ? accountStatus(account) : null });
  });

  /**
   * Remise de session depuis l'extension (via Azerit). L'identité lue dans le
   * navigateur est obligatoire. Autre profil que celui du compte : refus (409),
   * sauf `replace` — geste explicite « changer de compte LinkedIn ». Un compte
   * qui a déjà des contacts n'est alors pas réécrit : il est désactivé (ses
   * contacts restent reliés à l'ancien profil) et un nouveau compte le remplace.
   */
  app.post("/api/svc/li/session", (req, res) => {
    const owner = ownerOf(req)!;
    const b = req.body as { cookies?: unknown; user_agent?: unknown; member?: unknown; owner_name?: unknown; replace?: unknown };
    const member = parseMember(b.member);
    if (!member) return res.status(400).json({ error: "Profil LinkedIn connecté illisible : ouvrez LinkedIn dans ce navigateur puis réessayez." });
    const name = (typeof b.owner_name === "string" && b.owner_name.trim()) || member.name || member.slug;

    let account = ownerAccount(owner);
    if (account?.member_slug && account.member_slug !== member.slug) {
      if (!b.replace) {
        return res.status(409).json({
          code: "other_member",
          error: `Ce navigateur est connecté à LinkedIn en tant que « ${member.name ?? member.slug} », pas « ${account.member_name ?? account.member_slug} » (votre compte relié).`,
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
    const r = storeSession(account.id, b.cookies, b.user_agent, member);
    if ("error" in r) return res.status(r.code === "other_member" ? 409 : 400).json(r);
    if (!account.active) updateAccount(account.id, { active: true });
    console.log(`[svc] session LinkedIn de ${owner} reçue (profil ${member.slug}, compte #${account.id})`);
    res.json({ account: accountStatus(getAccount(account.id)!) });
  });

  app.patch("/api/svc/li/account", (req, res) => {
    const account = ownerAccount(ownerOf(req)!);
    if (!account) return res.status(404).json({ error: "Aucun compte LinkedIn relié" });
    const b = req.body as { active?: unknown };
    if (typeof b.active === "boolean") updateAccount(account.id, { active: b.active });
    res.json({ account: accountStatus(getAccount(account.id)!) });
  });

  // --- Campagnes du propriétaire ---

  /** Crée ou met à jour la campagne `external_ref` (étapes remplacées, avancement des contacts conservé). */
  app.post("/api/svc/campaigns", (req, res) => {
    const owner = ownerOf(req)!;
    const b = req.body as { external_ref?: unknown; name?: unknown; steps?: unknown };
    const ref = typeof b.external_ref === "string" ? b.external_ref.trim().slice(0, 200) : "";
    const name = typeof b.name === "string" ? b.name.trim().slice(0, 200) : "";
    if (!ref || !name) return res.status(400).json({ error: "external_ref et name requis" });
    const v = validateSteps(b.steps);
    if ("error" in v) return res.status(400).json(v);
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
      replaceSteps(cid, v.steps);
      return cid;
    })();
    res.json({ id });
  });

  /**
   * Inscrit et lance des candidats : [{ key, first_name, last_name, company,
   * linkedin, email?, vars? }]. `vars` (ex. le message rédigé pour ce candidat)
   * reste propre à cette inscription. Un candidat déjà lancé n'est pas relancé.
   */
  app.post("/api/svc/campaigns/:id/enroll", async (req, res) => {
    const owner = ownerOf(req)!;
    const campaign = ownedCampaign(req.params.id, owner);
    if (!campaign) return res.status(404).json({ error: "Campagne introuvable" });
    const list = (req.body as { contacts?: unknown }).contacts;
    if (!Array.isArray(list) || !list.length || list.length > 500) return res.status(400).json({ error: "contacts[] : 1 à 500" });

    const results: Array<{ key: string; cc_id?: number; status: string; error?: string }> = [];
    const rows: Array<Record<string, string>> = [];
    const meta: Array<{ key: string; vars: Record<string, string> | null }> = [];
    for (const raw of list as Array<Record<string, unknown>>) {
      const key = typeof raw?.key === "string" ? raw.key.trim().slice(0, 300) : "";
      if (!key) {
        results.push({ key: "", status: "rejected", error: "key manquante" });
        continue;
      }
      const linkedin = normalizeLinkedin(typeof raw.linkedin === "string" ? raw.linkedin : "");
      if (!linkedin || !/\/in\//.test(linkedin)) {
        results.push({ key, status: "rejected", error: "profil LinkedIn manquant" });
        continue;
      }
      const str = (x: unknown) => (typeof x === "string" ? x.trim().slice(0, 300) : "");
      rows.push({
        email: str(raw.email),
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

  /** Avancement de chaque candidat (clé Azerit) : statut, actions LinkedIn, profil émetteur. */
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
    const steps = (db.prepare("SELECT COUNT(*) AS n FROM steps WHERE campaign_id = ?").get(campaign.id) as { n: number }).n;
    res.json({
      campaign: { id: campaign.id, status: campaign.status, steps },
      contacts: contacts.map((c) => ({ ...c, actions: byCc.get(c.cc_id) ?? [] })),
    });
  });

  /** Arrête la séquence de candidats (clés Azerit) : plus rien ne part, actions en file annulées. */
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
