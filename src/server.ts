import express from "express";
import { fileURLToPath } from "node:url";
import { config, googleRedirectUri } from "./config.js";
import { db } from "./db.js";
import { authUrl, googleCredentialsSource, handleOAuthCallback, saveGoogleCredentials } from "./services/google.js";
import { BUILT_IN_VARIABLES, importContacts, KNOWN_COLUMNS, MERGED_EXTRA, normalizeColumn, parseCsv, renderTemplate, templateVariables } from "./services/contacts.js";
import { syncFromAttio } from "./services/attio.js";
import { effectiveDailyLimit, nextEmailEstimate, sendWindowState } from "./services/scheduler.js";
import { registerOutreachRoutes } from "./services/outreach-routes.js";
import { registerServiceRoutes } from "./services/service-routes.js";
import { BRANCHES, type Branch } from "./services/branches.js";
import { cancelLinkedInActions } from "./services/outreach.js";
import { optOutFromCampaignOf } from "./services/opt-out.js";
import { registerVisitRoutes } from "./services/visits.js";
import { registerUnsubscribeRoutes } from "./services/unsubscribe.js";
import { registerInboxRoutes } from "./services/inbox-routes.js";
import { normalizeLinkedin } from "./services/linkedin-url.js";

export function createServer(): express.Express {
  const app = express();
  // Behind a reverse proxy / tunnel (ngrok, Cloudflare…): req.ip = the recipient's real IP
  app.set("trust proxy", true);
  app.use(express.json({ limit: "10mb" }));
  app.use(express.text({ type: ["text/csv", "text/plain"], limit: "20mb" }));
  // Relative to the project, not the launch directory.
  // no-cache: the browser revalidates (ETag) on every load, so no stale CSS/JS after a deploy
  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url)), { cacheControl: true, maxAge: 0, setHeaders: (res) => res.setHeader("Cache-Control", "no-cache") }));

  // --- LinkedIn steps (used by the Chrome extension) ---
  registerOutreachRoutes(app);

  // --- Service API (Azerit, internal network) ---
  registerServiceRoutes(app);

  // --- Personalized {{link}} + visit tracking ---
  registerVisitRoutes(app);

  // --- One-click unsubscribe (List-Unsubscribe) ---
  registerUnsubscribeRoutes(app);

  // --- Inbox, conversations, search, activity log, test email (MCP) ---
  registerInboxRoutes(app);

  // --- Google accounts ---
  app.get("/auth/google", (_req, res) => res.redirect(config.google.clientId ? authUrl() : "/settings.html"));

  // OAuth credentials entered in Settings (when .env provides none)
  app.put("/api/settings/google", (req, res) => {
    const { client_id, client_secret } = req.body as { client_id?: string; client_secret?: string };
    const id = String(client_id ?? "").trim();
    const secret = String(client_secret ?? "").trim();
    if (!id || !secret) return res.status(400).json({ error: "client_id and client_secret are required" });
    try {
      saveGoogleCredentials(id, secret);
    } catch (err) {
      return res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
    }
    res.json({ ok: true });
  });

  app.get("/auth/google/callback", async (req, res) => {
    try {
      const email = await handleOAuthCallback(String(req.query.code ?? ""));
      res.redirect(`/settings.html?connected=${encodeURIComponent(email)}`);
    } catch (err) {
      res.status(500).send(`OAuth error: ${err instanceof Error ? err.message : err}`);
    }
  });

  app.get("/api/accounts", (_req, res) => {
    const rows = db
      .prepare(
        "SELECT id, email, from_name, signature, daily_limit, sent_today, sent_today_date, active, warmup, warmup_started_at, created_at FROM accounts ORDER BY email"
      )
      .all() as Array<{ daily_limit: number; warmup: number; warmup_started_at: number | null; created_at: number }>;
    res.json(rows.map((r) => ({ ...r, effective_limit: effectiveDailyLimit(r) })));
  });

  app.patch("/api/accounts/:id", (req, res) => {
    const { daily_limit, active, from_name, signature, warmup } = req.body as {
      daily_limit?: number;
      active?: boolean;
      from_name?: string;
      signature?: string;
      warmup?: boolean;
    };
    if (warmup !== undefined) {
      db.prepare("UPDATE accounts SET warmup = ? WHERE id = ?").run(warmup ? 1 : 0, req.params.id);
    }
    if (daily_limit !== undefined) {
      db.prepare("UPDATE accounts SET daily_limit = ? WHERE id = ?").run(daily_limit, req.params.id);
    }
    if (active !== undefined) {
      db.prepare("UPDATE accounts SET active = ? WHERE id = ?").run(active ? 1 : 0, req.params.id);
    }
    if (from_name !== undefined) {
      db.prepare("UPDATE accounts SET from_name = ? WHERE id = ?").run(from_name.trim() || null, req.params.id);
    }
    if (signature !== undefined) {
      db.prepare("UPDATE accounts SET signature = ? WHERE id = ?").run(signature.trim() || null, req.params.id);
    }
    res.json({ ok: true });
  });

  // Deletes a Google account, which must be disabled first (so a sending account is never deleted).
  // Its sent messages go with it; its contacts still in sequence are stopped, since follow-ups can
  // only come from it (thread continuity); its Gmail threads, now unreadable, are detached (no more
  // reply detection).
  app.delete("/api/accounts/:id", (req, res) => {
    const id = Number(req.params.id);
    const account = db.prepare("SELECT id, email, active FROM accounts WHERE id = ?").get(id) as
      | { id: number; email: string; active: number }
      | undefined;
    if (!account) return res.status(404).json({ error: "Account not found" });
    if (account.active) {
      return res.status(409).json({ error: `${account.email} is active: deactivate it first (active: false)` });
    }
    const report = db.transaction(() => {
      const running = db
        .prepare("SELECT id FROM campaign_contacts WHERE account_id = ? AND status IN ('pending', 'in_progress', 'awaiting_li')")
        .all(id) as Array<{ id: number }>;
      db.prepare(
        `UPDATE campaign_contacts SET status = 'stopped', next_send_at = NULL, error = ?
         WHERE account_id = ? AND status IN ('pending', 'in_progress', 'awaiting_li')`
      ).run(`compte d'envoi ${account.email} supprimé`, id);
      for (const r of running) cancelLinkedInActions("campaign_contact_id = ?", r.id, "compte d'envoi supprimé");
      const detached = db
        .prepare("UPDATE campaign_contacts SET account_id = NULL, thread_id = NULL WHERE account_id = ?")
        .run(id).changes;
      const messages = db.prepare("DELETE FROM messages WHERE account_id = ?").run(id).changes;
      // Remove the account from campaign selections; an emptied selection reverts to "all accounts"
      const campaigns: Array<{ id: number; name: string; account_ids: number[] | null }> = [];
      for (const c of db.prepare("SELECT id, name, account_ids FROM campaigns WHERE account_ids IS NOT NULL").all() as Array<{
        id: number;
        name: string;
        account_ids: string;
      }>) {
        const ids = JSON.parse(c.account_ids) as number[];
        if (!ids.includes(id)) continue;
        const left = ids.filter((x) => x !== id);
        db.prepare("UPDATE campaigns SET account_ids = ? WHERE id = ?").run(left.length ? JSON.stringify(left) : null, c.id);
        campaigns.push({ id: c.id, name: c.name, account_ids: left.length ? left : null });
      }
      db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
      return { contacts_stopped: running.length, contacts_detached: detached, messages_deleted: messages, campaigns_updated: campaigns };
    })();
    console.log(`[accounts] ${account.email} deleted (${report.messages_deleted} sends erased, ${report.contacts_stopped} contacts stopped)`);
    res.json({ ok: true, email: account.email, ...report });
  });

  // --- Campaigns ---
  // A step is either an email (subject + body) or a LinkedIn action (channel='linkedin',
  // li_action='invite'|'message', body = note/message). branch: only for contacts whose invitation
  // was accepted ('accepted') or not ('not_accepted'); absent = all (see services/branches.ts).
  type StepInput = {
    subject?: string;
    subject_b?: string;
    body?: string;
    wait_days?: number;
    channel?: string;
    li_action?: string;
    branch?: string;
  };

  /** Validates a sequence; returns an error message, or null if valid. */
  function validateSteps(name: string, steps: StepInput[]): string | null {
    if (!name || !steps?.length) return "name et steps[] sont requis";
    const isEmail = (s: StepInput) => (s.channel ?? "email") !== "linkedin";
    const isMessage = (s: StepInput) => s.channel === "linkedin" && s.li_action === "message";
    // The first email opens the thread, so its subject is required (subjectless follow-ups go out
    // as "Re:"). With branches, the first email of each branch.
    const hasBranches = steps.some((s) => s.branch);
    for (const branch of hasBranches ? BRANCHES : [undefined]) {
      const firstEmail = steps.find((s) => isEmail(s) && (!s.branch || s.branch === branch));
      if (firstEmail && !firstEmail.subject?.trim()) {
        return branch
          ? `Le premier email des contacts dont l'invitation ${branch === "accepted" ? "est acceptée" : "n'est pas acceptée"} doit avoir un objet`
          : "Le premier email de la séquence doit avoir un objet";
      }
    }
    for (const s of steps) {
      const isInvite = s.channel === "linkedin" && (s.li_action ?? "invite") === "invite";
      if (!isInvite && !s.body?.trim()) return "Chaque étape doit avoir un contenu (la note d'invitation seule est facultative)";
    }
    if (hasBranches) {
      if (steps.some((s) => s.branch && !BRANCHES.includes(s.branch as Branch))) return `branch : valeurs possibles ${BRANCHES.join(", ")}`;
      const invite = steps.findIndex((s) => s.channel === "linkedin" && (s.li_action ?? "invite") === "invite");
      const firstBranch = steps.findIndex((s) => s.branch);
      if (invite < 0 || firstBranch < invite) return "Les étapes « si invitation acceptée / non acceptée » viennent après une invitation LinkedIn";
      // The LinkedIn message reveals acceptance: it opens the "accepted" branch, before any "not
      // accepted" step (which has no LinkedIn message).
      const probe = steps.findIndex((s) => s.branch === "accepted");
      const fallback = steps.findIndex((s) => s.branch === "not_accepted");
      if (fallback >= 0 && (probe < 0 || !isMessage(steps[probe]) || probe > fallback)) {
        return "Des étapes « invitation non acceptée » demandent un message LinkedIn en tête du chemin « invitation acceptée » : c'est lui qui détecte l'acceptation";
      }
      if (steps.some((s) => s.branch === "not_accepted" && isMessage(s))) {
        return "Pas de message LinkedIn dans les étapes « si invitation non acceptée »";
      }
    }
    return null;
  }

  /**
   * Normalizes a campaign's sender selection: null / undefined = all accounts (default), else a
   * non-empty id list.
   */
  function normalizeAccountIds(ids: unknown, field = "account_ids"): { value: string | null } | { error: string } {
    if (ids == null) return { value: null };
    if (!Array.isArray(ids) || !ids.every((x) => Number.isInteger(x))) {
      return { error: `${field} must be a list of account ids` };
    }
    if (!ids.length) return { error: "Select at least one sending account" };
    return { value: JSON.stringify([...new Set(ids as number[])]) };
  }

  /** Campaign description: free text, empty = none (null). */
  function normalizeDescription(value: unknown): { value: string | null } | { error: string } {
    if (value == null) return { value: null };
    if (typeof value !== "string") return { error: "description must be a string" };
    return { value: value.trim() || null };
  }

  /** Inserts a campaign's steps (email or LinkedIn). */
  function insertSteps(campaignId: number | bigint, steps: StepInput[]): void {
    const insert = db.prepare(
      "INSERT INTO steps (campaign_id, step_number, subject, subject_b, body, wait_days, channel, li_action, branch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    steps.forEach((s, i) => {
      const channel = s.channel === "linkedin" ? "linkedin" : "email";
      const li = channel === "linkedin" ? (s.li_action === "message" ? "message" : "invite") : null;
      insert.run(
        campaignId,
        i + 1,
        channel === "linkedin" ? "" : (s.subject ?? ""),
        i === 0 && channel === "email" ? s.subject_b?.trim() || null : null, // A/B test: email step 1 only
        s.body ?? "",
        i === 0 ? 0 : (s.wait_days ?? 3),
        channel,
        li,
        BRANCHES.includes(s.branch as Branch) ? s.branch : null
      );
    });
  }

  app.post("/api/campaigns", (req, res) => {
    const { name, description, steps, account_ids, li_account_ids } = req.body as {
      name: string;
      description?: string | null;
      steps: StepInput[];
      account_ids?: number[] | null;
      li_account_ids?: number[] | null;
    };
    const err = validateSteps(name, steps);
    if (err) return res.status(400).json({ error: err });
    const senders = normalizeAccountIds(account_ids);
    if ("error" in senders) return res.status(400).json({ error: senders.error });
    const liSenders = normalizeAccountIds(li_account_ids, "li_account_ids");
    if ("error" in liSenders) return res.status(400).json({ error: liSenders.error });
    const desc = normalizeDescription(description);
    if ("error" in desc) return res.status(400).json({ error: desc.error });
    const result = db.transaction(() => {
      const { lastInsertRowid } = db
        .prepare("INSERT INTO campaigns (name, description, status, account_ids, li_account_ids) VALUES (?, ?, 'paused', ?, ?)")
        .run(name, desc.value, senders.value, liSenders.value);
      insertSteps(lastInsertRowid, steps);
      return lastInsertRowid;
    })();
    res.json({ id: result });
  });

  // --- Personalization variable instructions: one per variable name, shared by all campaigns ---
  app.get("/api/variable-instructions", (_req, res) => {
    const rows = db.prepare("SELECT name, instruction FROM variable_instructions ORDER BY name").all() as Array<{ name: string; instruction: string }>;
    res.json(Object.fromEntries(rows.map((r) => [r.name, r.instruction])));
  });

  // Empty text = instruction removed
  app.put("/api/variable-instructions/:name", (req, res) => {
    const { name } = req.params;
    if (!/^[\p{L}\p{N}_]+$/u.test(name)) return res.status(400).json({ error: `"${name}" is not a valid variable name` });
    const instruction = req.body?.instruction;
    if (typeof instruction !== "string") return res.status(400).json({ error: "instruction must be a string" });
    if (instruction.trim()) {
      db.prepare("INSERT INTO variable_instructions (name, instruction) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET instruction = excluded.instruction").run(name, instruction.trim());
    } else {
      db.prepare("DELETE FROM variable_instructions WHERE name = ?").run(name);
    }
    res.json({ ok: true });
  });

  app.get("/api/campaigns", (_req, res) => {
    const campaigns = db
      .prepare(
        `SELECT cp.id, cp.name, cp.description, cp.status, cp.created_at,
           (SELECT COUNT(*) FROM steps s WHERE s.campaign_id = cp.id) AS steps,
           (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = cp.id) AS contacts,
           (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = cp.id AND cc.status = 'held') AS held,
           (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = cp.id AND cc.status = 'pending') AS pending,
           (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = cp.id AND cc.status = 'in_progress') AS in_progress,
           (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = cp.id AND cc.status = 'replied') AS replied,
           (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = cp.id AND cc.status = 'opted_out') AS opted_out,
           (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = cp.id AND cc.status = 'bounced') AS bounced,
           (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = cp.id AND cc.status = 'completed') AS completed,
           (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = cp.id AND cc.status = 'failed') AS failed,
           (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = cp.id AND cc.status = 'awaiting_li') AS awaiting_li,
           (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = cp.id AND cc.status = 'stopped') AS stopped,
           -- lancés : sortis de « held », sauf ceux arrêtés avant tout envoi
           (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = cp.id AND cc.status <> 'held'
              AND NOT (cc.status = 'stopped' AND cc.current_step = 0)) AS launched,
           -- contactés : au moins une étape (email ou LinkedIn) partie, hors bounces (jamais reçus)
           (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = cp.id AND cc.current_step > 0
              AND cc.status <> 'bounced') AS contacted,
           (SELECT COUNT(*) FROM messages m JOIN campaign_contacts cc ON cc.id = m.campaign_contact_id
              WHERE cc.campaign_id = cp.id) AS emails_sent,
           (SELECT COUNT(DISTINCT v.cc_id) FROM visits v
              JOIN campaign_contacts cc ON cc.id = v.cc_id
              WHERE cc.campaign_id = cp.id AND v.is_bot = 0) AS visited,
           (SELECT COUNT(*) FROM steps s WHERE s.campaign_id = cp.id AND s.channel = 'linkedin') AS li_steps,
           (SELECT COUNT(*) FROM li_actions la JOIN campaign_contacts cc ON cc.id = la.campaign_contact_id
              WHERE cc.campaign_id = cp.id AND la.type = 'invite' AND la.status = 'sent') AS li_invites_sent,
           (SELECT COUNT(*) FROM li_actions la JOIN campaign_contacts cc ON cc.id = la.campaign_contact_id
              WHERE cc.campaign_id = cp.id AND la.type = 'message' AND la.status = 'sent') AS li_messages_sent,
           (SELECT s.subject_b FROM steps s WHERE s.campaign_id = cp.id AND s.step_number = 1) AS subject_b,
           (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = cp.id AND cc.variant = 'A' AND cc.current_step > 0) AS contacted_a,
           (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = cp.id AND cc.variant = 'A' AND cc.status = 'replied') AS replied_a,
           (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = cp.id AND cc.variant = 'B' AND cc.current_step > 0) AS contacted_b,
           (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = cp.id AND cc.variant = 'B' AND cc.status = 'replied') AS replied_b
         FROM campaigns cp ORDER BY cp.created_at DESC`
      )
      .all() as Array<Record<string, number | string | null>>;

    const rate = (replied: number, contacted: number) =>
      contacted > 0 ? Math.round((replied / contacted) * 1000) / 10 : 0;

    for (const c of campaigns) {
      // Denominator: contacts who received at least one step (not held, pending, stopped before any
      // send, or bounced)
      c.reply_rate = rate(Number(c.replied), Number(c.contacted));
      const launched = Number(c.launched);
      // awaiting_li: LinkedIn action queued, sequence not finished, so still "running"
      const stillRunning = Number(c.pending) + Number(c.in_progress) + Number(c.awaiting_li);
      c.progress = launched > 0 ? Math.round(((launched - stillRunning) / launched) * 100) : 0;
      c.ab_test = c.subject_b ? 1 : 0;
      c.reply_rate_a = rate(Number(c.replied_a), Number(c.contacted_a));
      c.reply_rate_b = rate(Number(c.replied_b), Number(c.contacted_b));
    }
    res.json(campaigns);
  });

  // Campaign detail with its steps (for editing)
  app.get("/api/campaigns/:id", (req, res) => {
    const campaign = db
      .prepare("SELECT id, name, description, status, account_ids, li_account_ids FROM campaigns WHERE id = ?")
      .get(req.params.id) as { account_ids: string | null; li_account_ids: string | null } | undefined;
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    const steps = db
      .prepare(
        "SELECT step_number, subject, subject_b, body, wait_days, channel, li_action, branch FROM steps WHERE campaign_id = ? ORDER BY step_number"
      )
      .all(req.params.id);
    // The sequence's personalization variables (excluding built-ins), with their instruction: to
    // read before filling them
    const instructions = new Map(
      (db.prepare("SELECT name, instruction FROM variable_instructions").all() as Array<{ name: string; instruction: string }>).map((r) => [r.name, r.instruction])
    );
    const names = new Set<string>();
    for (const s of steps as Array<{ subject: string; subject_b: string | null; body: string }>) {
      for (const text of [s.subject, s.subject_b, s.body]) {
        if (text) for (const key of templateVariables(text).keys()) if (!BUILT_IN_VARIABLES.has(key)) names.add(key);
      }
    }
    // account_ids / li_account_ids: null = all accounts, else an id list (JSON in the DB)
    res.json({
      ...campaign,
      variables: [...names].map((name) => ({ name, instruction: instructions.get(name) })),
      account_ids: campaign.account_ids ? JSON.parse(campaign.account_ids) : null,
      li_account_ids: campaign.li_account_ids ? JSON.parse(campaign.li_account_ids) : null,
      steps,
    });
  });

  // Updates a campaign, even while running: steps are replaced. Contacts keep their progress
  // (current_step) and the next sends use the new content; a contact whose current step is past the
  // new sequence is marked 'completed' on the next tick.
  app.put("/api/campaigns/:id", (req, res) => {
    const exists = db.prepare("SELECT id FROM campaigns WHERE id = ?").get(req.params.id);
    if (!exists) return res.status(404).json({ error: "Campaign not found" });
    const { name, steps, account_ids, li_account_ids } = req.body as {
      name: string;
      steps: StepInput[];
      account_ids?: number[] | null;
      li_account_ids?: number[] | null;
    };
    const err = validateSteps(name, steps);
    if (err) return res.status(400).json({ error: err });
    // account_ids absent from the body = selection unchanged; null = all accounts
    const senders = "account_ids" in req.body ? normalizeAccountIds(account_ids) : null;
    if (senders && "error" in senders) return res.status(400).json({ error: senders.error });
    const liSenders = "li_account_ids" in req.body ? normalizeAccountIds(li_account_ids, "li_account_ids") : null;
    if (liSenders && "error" in liSenders) return res.status(400).json({ error: liSenders.error });
    // description absent from the body = unchanged
    const desc = "description" in req.body ? normalizeDescription(req.body.description) : null;
    if (desc && "error" in desc) return res.status(400).json({ error: desc.error });
    db.transaction(() => {
      db.prepare("UPDATE campaigns SET name = ? WHERE id = ?").run(name, req.params.id);
      if (desc) db.prepare("UPDATE campaigns SET description = ? WHERE id = ?").run(desc.value, req.params.id);
      if (senders) {
        db.prepare("UPDATE campaigns SET account_ids = ? WHERE id = ?").run(senders.value, req.params.id);
      }
      // Only touches contacts not attached yet: an engaged contact stays with its account.
      if (liSenders) {
        db.prepare("UPDATE campaigns SET li_account_ids = ? WHERE id = ?").run(liSenders.value, req.params.id);
      }
      db.prepare("DELETE FROM steps WHERE campaign_id = ?").run(req.params.id);
      insertSteps(Number(req.params.id), steps);
    })();
    res.json({ ok: true });
  });

  // Partial update (MCP server): only provided fields change. `steps`, if given, replaces the whole
  // sequence like PUT.
  app.patch("/api/campaigns/:id", (req, res) => {
    const campaign = db.prepare("SELECT id, name FROM campaigns WHERE id = ?").get(req.params.id) as
      | { id: number; name: string }
      | undefined;
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    const body = (req.body ?? {}) as {
      name?: unknown;
      description?: unknown;
      steps?: StepInput[];
      account_ids?: number[] | null;
      li_account_ids?: number[] | null;
    };
    if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim())) {
      return res.status(400).json({ error: "name cannot be empty" });
    }
    const name = typeof body.name === "string" ? body.name.trim() : campaign.name;
    if (body.steps !== undefined) {
      const err = validateSteps(name, body.steps);
      if (err) return res.status(400).json({ error: err });
    }
    const senders = "account_ids" in body ? normalizeAccountIds(body.account_ids) : null;
    if (senders && "error" in senders) return res.status(400).json({ error: senders.error });
    const liSenders = "li_account_ids" in body ? normalizeAccountIds(body.li_account_ids, "li_account_ids") : null;
    if (liSenders && "error" in liSenders) return res.status(400).json({ error: liSenders.error });
    const desc = "description" in body ? normalizeDescription(body.description) : null;
    if (desc && "error" in desc) return res.status(400).json({ error: desc.error });
    if (body.name === undefined && body.steps === undefined && !senders && !liSenders && !desc) {
      return res.status(400).json({ error: "No field to update" });
    }
    db.transaction(() => {
      db.prepare("UPDATE campaigns SET name = ? WHERE id = ?").run(name, campaign.id);
      if (desc) db.prepare("UPDATE campaigns SET description = ? WHERE id = ?").run(desc.value, campaign.id);
      if (senders) db.prepare("UPDATE campaigns SET account_ids = ? WHERE id = ?").run(senders.value, campaign.id);
      if (liSenders) db.prepare("UPDATE campaigns SET li_account_ids = ? WHERE id = ?").run(liSenders.value, campaign.id);
      if (body.steps !== undefined) {
        db.prepare("DELETE FROM steps WHERE campaign_id = ?").run(campaign.id);
        insertSteps(campaign.id, body.steps);
      }
    })();
    res.json({ ok: true });
  });

  // Updates a single step: only provided fields change, then the resulting sequence is validated
  // and rewritten like PUT (same rules: first email's subject, B variant on step 1, zero delay on
  // step 1).
  app.patch("/api/campaigns/:id/steps/:n", (req, res) => {
    const campaign = db.prepare("SELECT id, name FROM campaigns WHERE id = ?").get(req.params.id) as
      | { id: number; name: string }
      | undefined;
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    const selectSteps = db.prepare(
      "SELECT step_number, subject, subject_b, body, wait_days, channel, li_action, branch FROM steps WHERE campaign_id = ? ORDER BY step_number"
    );
    const steps = selectSteps.all(campaign.id) as Array<{ step_number: number } & Record<string, unknown>>;
    const n = Number(req.params.n);
    const index = steps.findIndex((s) => s.step_number === n);
    if (index < 0) return res.status(404).json({ error: `Step ${req.params.n} not found (the campaign has ${steps.length})` });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const key of ["subject", "subject_b", "body", "channel", "li_action", "branch"]) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== "string") return res.status(400).json({ error: `${key} must be a string` });
      patch[key] = body[key];
    }
    if (body.wait_days !== undefined) {
      if (!Number.isInteger(body.wait_days) || (body.wait_days as number) < 0) {
        return res.status(400).json({ error: "wait_days must be a non-negative integer" });
      }
      patch.wait_days = body.wait_days;
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: "No field to update" });

    // NULL in the DB (subject_b, li_action, branch) = field absent for insertSteps
    const next = steps.map((s, i) =>
      Object.fromEntries(Object.entries(i === index ? { ...s, ...patch } : s).filter(([, v]) => v !== null))
    ) as StepInput[];
    const err = validateSteps(campaign.name, next);
    if (err) return res.status(400).json({ error: err });
    db.transaction(() => {
      db.prepare("DELETE FROM steps WHERE campaign_id = ?").run(campaign.id);
      insertSteps(campaign.id, next);
    })();
    res.json({ ok: true, step: (selectSteps.all(campaign.id) as Array<{ step_number: number }>)[index] });
  });

  // Email preview: variables rendered with a real contact of the campaign (the first) or a sample
  // contact, account signature included.
  app.post("/api/preview", (req, res) => {
    const { subject, body, account_id, campaign_id, contact_id } = req.body as {
      subject?: string;
      body?: string;
      account_id?: number;
      campaign_id?: number;
      contact_id?: number;
    };
    // Enrollment variables (cc.vars) take precedence, as when sending
    const contact = (contact_id
      ? db
          .prepare(
            `SELECT c.email, c.first_name, c.last_name, c.company, ${MERGED_EXTRA} AS extra
             FROM contacts c LEFT JOIN campaign_contacts cc ON cc.contact_id = c.id AND cc.campaign_id = ?
             WHERE c.id = ?`
          )
          .get(campaign_id ?? null, contact_id)
      : campaign_id
      ? db
          .prepare(
            `SELECT c.email, c.first_name, c.last_name, c.company, ${MERGED_EXTRA} AS extra
             FROM campaign_contacts cc JOIN contacts c ON c.id = cc.contact_id
             WHERE cc.campaign_id = ? ORDER BY cc.id LIMIT 1`
          )
          .get(campaign_id)
      : undefined) as
      | { email: string; first_name: string | null; last_name: string | null; company: string | null; extra: string | null }
      | undefined;
    const sample = contact ?? {
      email: "marie.dupont@exemple.fr",
      first_name: "Marie",
      last_name: "Dupont",
      company: "Exemple SAS",
      extra: null,
    };
    const account = (account_id
      ? db.prepare("SELECT email, from_name, signature FROM accounts WHERE id = ?").get(account_id)
      : db.prepare("SELECT email, from_name, signature FROM accounts WHERE active = 1 ORDER BY id LIMIT 1").get()) as
      | { email: string; from_name: string | null; signature: string | null }
      | undefined;
    const senderName = account?.from_name ?? account?.email ?? "Votre nom";
    const link = `${config.visit.baseUrl}/p/exemple`;
    const senderVars = {
      sender_name: senderName,
      link,
      signature: account?.signature ? renderTemplate(account.signature, sample, { sender_name: senderName, link }) : "",
    };
    const renderedBody = renderTemplate(body ?? "", sample, senderVars);
    res.json({
      from: account ? (account.from_name ? `${account.from_name} <${account.email}>` : account.email) : "(aucun compte connecté)",
      to: sample.email,
      sample_contact: !contact,
      subject: renderTemplate(subject ?? "", sample, senderVars),
      body: renderedBody,
    });
  });

  // Effective settings (from .env, plus Google credentials entered in Settings)
  app.get("/api/settings", (_req, res) => {
    // The send window is read in deliverability.sendWindowTimezone, which may differ from the
    // server's timezone
    const now = new Date();
    const offset = -now.getTimezoneOffset(); // minutes to add to UTC
    const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
    res.json({
      server: {
        now: now.getTime(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        utc_offset: `${offset < 0 ? "-" : "+"}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`,
        local_time: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
      },
      send_window: sendWindowState(now.getTime()),
      next_email: nextEmailEstimate(now.getTime()),
      deliverability: config.deliverability,
      google_configured: Boolean(config.google.clientId),
      google_source: googleCredentialsSource(),
      google_redirect_uri: googleRedirectUri(),
      attio_configured: Boolean(config.attioApiKey),
      attio_stage_attribute: config.attioStageAttribute || null,
      attio_import_attribute: config.attioImportAttribute || null,
    });
  });

  app.post("/api/campaigns/:id/pause", (req, res) => {
    db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  });

  // An archived campaign stays viewable but sends nothing: it can only be resumed after unarchiving
  // (back to paused).
  const isArchived = (id: string) =>
    (db.prepare("SELECT status FROM campaigns WHERE id = ?").get(id) as { status: string } | undefined)?.status === "archived";
  const ARCHIVED = "Campagne archivée : désarchivez-la avant de relancer des envois";

  app.post("/api/campaigns/:id/resume", (req, res) => {
    if (isArchived(req.params.id)) return res.status(409).json({ error: ARCHIVED });
    db.prepare("UPDATE campaigns SET status = 'active' WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  });

  app.post("/api/campaigns/:id/archive", (req, res) => {
    db.prepare("UPDATE campaigns SET status = 'archived' WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  });

  app.post("/api/campaigns/:id/unarchive", (req, res) => {
    db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ? AND status = 'archived'").run(req.params.id);
    res.json({ ok: true });
  });

  // --- Launch sends for selected contacts ---
  app.post("/api/campaigns/:id/launch-contacts", (req, res) => {
    const { ids } = req.body as { ids?: number[] };
    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ error: "ids[] is required" });
    }
    if (isArchived(req.params.id)) return res.status(409).json({ error: ARCHIVED });
    const placeholders = ids.map(() => "?").join(",");
    const launched = db.transaction(() => {
      const { changes } = db
        .prepare(
          `UPDATE campaign_contacts SET status = 'pending' WHERE id IN (${placeholders}) AND campaign_id = ? AND status = 'held'`
        )
        .run(...ids, Number(req.params.id));
      if (changes) db.prepare("UPDATE campaigns SET status = 'active' WHERE id = ?").run(req.params.id);
      return changes;
    })();
    res.json({ ok: true, launched });
  });

  // --- Manually stop the sequence of selected contacts ---
  app.post("/api/campaigns/:id/stop-contacts", (req, res) => {
    const { ids } = req.body as { ids?: number[] };
    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ error: "ids[] is required" });
    }
    const placeholders = ids.map(() => "?").join(",");
    const changes = db.transaction(() => {
      const { changes } = db
        .prepare(
          `UPDATE campaign_contacts SET status = 'stopped', next_send_at = NULL
           WHERE id IN (${placeholders}) AND campaign_id = ? AND status IN ('held', 'pending', 'in_progress', 'awaiting_li')`
        )
        .run(...ids, Number(req.params.id));
      for (const id of ids) cancelLinkedInActions("campaign_contact_id = ?", id, "arrêté manuellement");
      return changes;
    })();
    res.json({ ok: true, stopped: changes });
  });

  // --- Manually set the status of selected contacts ---
  app.post("/api/campaigns/:id/set-status", (req, res) => {
    const { ids, status } = req.body as { ids?: number[]; status?: string };
    const allowed = ["held", "pending", "in_progress", "replied", "opted_out", "bounced", "completed", "stopped", "failed"];
    if (!Array.isArray(ids) || !ids.length || !status || !allowed.includes(status)) {
      return res.status(400).json({ error: "ids[] and a valid status are required" });
    }
    const placeholders = ids.map(() => "?").join(",");
    const changed = db.transaction(() => {
      // next_send_at NULL: a contact reset to pending/in_progress is eligible on the next tick;
      // terminal statuses have no scheduled send. replied_at is set for replied/opted_out (stats)
      // and cleared otherwise, so reply detection resumes on a reactivated contact.
      const { changes } = db
        .prepare(
          `UPDATE campaign_contacts SET status = ?, next_send_at = NULL, error = NULL,
             replied_at = CASE WHEN ? IN ('replied', 'opted_out') THEN COALESCE(replied_at, ?) ELSE NULL END
           WHERE id IN (${placeholders}) AND campaign_id = ?`
        )
        .run(status, status, Date.now(), ...ids, Number(req.params.id));
      if (status === "opted_out") {
        // Same as automatic detection: opted out with the campaign's owner, their other sequences
        // with that owner stopped
        const own = db
          .prepare(`SELECT id FROM campaign_contacts WHERE id IN (${placeholders}) AND campaign_id = ?`)
          .all(...ids, Number(req.params.id)) as Array<{ id: number }>;
        for (const { id } of own) optOutFromCampaignOf(id, "marqué désinscrit à la main");
      }
      return changes;
    })();
    res.json({ ok: true, changed });
  });

  // --- Remove selected contacts from the campaign (the global contact is kept) ---
  app.post("/api/campaigns/:id/remove-contacts", (req, res) => {
    const { ids } = req.body as { ids?: number[] };
    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ error: "ids[] is required" });
    }
    const placeholders = ids.map(() => "?").join(",");
    const { changes } = db
      .prepare(`DELETE FROM campaign_contacts WHERE id IN (${placeholders}) AND campaign_id = ?`)
      .run(...ids, Number(req.params.id));
    res.json({ ok: true, removed: changes });
  });

  // --- Update a contact's fields (standard + custom columns) ---
  app.patch("/api/contacts/:id", (req, res) => {
    const contact = db.prepare("SELECT id, extra FROM contacts WHERE id = ?").get(req.params.id) as
      | { id: number; extra: string | null }
      | undefined;
    if (!contact) return res.status(404).json({ error: "Contact not found" });
    const { first_name, last_name, company, linkedin, extra } = req.body as {
      first_name?: string;
      last_name?: string;
      company?: string;
      linkedin?: string;
      extra?: Record<string, string>;
    };
    // Custom fields are merged; an empty value deletes the field
    let merged: Record<string, string> | null = null;
    if (extra && typeof extra === "object") {
      merged = { ...(contact.extra ? (JSON.parse(contact.extra) as Record<string, string>) : {}) };
      for (const [k, v] of Object.entries(extra)) {
        const key = k.trim();
        if (!/^[\p{L}\p{N}_]+$/u.test(key)) {
          return res.status(400).json({ error: `Invalid field name: "${k}" (letters, digits and _ only)` });
        }
        if (String(v).trim() === "") delete merged[key];
        else merged[key] = String(v);
      }
    }
    db.prepare(
      `UPDATE contacts SET
         first_name = COALESCE(?, first_name),
         last_name  = COALESCE(?, last_name),
         company    = COALESCE(?, company),
         linkedin   = COALESCE(?, linkedin),
         extra      = COALESCE(?, extra)
       WHERE id = ?`
    ).run(
      first_name ?? null,
      last_name ?? null,
      company ?? null,
      linkedin === undefined ? null : normalizeLinkedin(linkedin),
      merged ? JSON.stringify(merged) : null,
      req.params.id
    );
    res.json({ ok: true });
  });

  // --- Delete a campaign (steps, enrollments and history cascade) ---
  app.delete("/api/campaigns/:id", (req, res) => {
    const { changes } = db.prepare("DELETE FROM campaigns WHERE id = ?").run(req.params.id);
    if (!changes) return res.status(404).json({ error: "Campaign not found" });
    res.json({ ok: true });
  });

  // --- CSV import (body = raw CSV content) ---
  app.post("/api/campaigns/:id/import", async (req, res) => {
    const campaign = db.prepare("SELECT id FROM campaigns WHERE id = ?").get(req.params.id);
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    try {
      const rows = parseCsv(String(req.body ?? ""));
      if (!rows.length) return res.status(400).json({ error: "Empty or unreadable CSV" });
      if (!("email" in rows[0]) && !("linkedin" in rows[0])) {
        return res.status(400).json({ error: "The CSV must have an 'email' or 'linkedin' column" });
      }
      // ?campaign_vars=a,b: these columns become variables of this campaign
      // (campaign_contacts.vars) instead of shared contact fields.
      const campaignVars = [...new Set(String(req.query.campaign_vars ?? "").split(",").map(normalizeColumn).filter(Boolean))];
      const reserved = campaignVars.filter((k) => KNOWN_COLUMNS.has(k));
      if (reserved.length) {
        return res.status(400).json({ error: `campaign_vars: ${reserved.join(", ")} are contact fields, not campaign variables` });
      }
      const unknown = campaignVars.filter((k) => !(k in rows[0]));
      if (unknown.length) {
        return res.status(400).json({ error: `campaign_vars: column(s) missing from the CSV: ${unknown.join(", ")}` });
      }
      res.json(await importContacts(Number(req.params.id), rows, { campaignVars }));
    } catch (err) {
      res.status(400).json({ error: `Invalid CSV: ${err instanceof Error ? err.message : err}` });
    }
  });

  // --- Attio sync ---
  app.post("/api/campaigns/:id/attio-sync", async (req, res) => {
    const { status_attribute, statuses } = req.body as {
      status_attribute?: string;
      statuses?: string[];
    };
    const attr = status_attribute || config.attioImportAttribute;
    if (!attr || !statuses?.length) {
      return res.status(400).json({ error: "status_attribute and statuses[] are required" });
    }
    try {
      res.json(await syncFromAttio(Number(req.params.id), attr, statuses));
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // --- Campaign contacts detail ---
  app.get("/api/campaigns/:id/contacts", (req, res) => {
    const rows = db
      .prepare(
        `SELECT c.id AS contact_id, c.email, c.first_name, c.last_name, c.company, c.linkedin, c.extra,
                cc.id AS cc_id, cc.vars, cc.status, cc.current_step, cc.variant, cc.account_id,
                cc.next_send_at, cc.replied_at, cc.error, a.email AS sender,
                li.name AS li_sender, cc.li_thread_url,
                (SELECT COUNT(*) FROM visits v WHERE v.cc_id = cc.id AND v.is_bot = 0) AS visit_count,
                (SELECT MAX(v.at) FROM visits v WHERE v.cc_id = cc.id AND v.is_bot = 0) AS last_visit_at,
                (SELECT COUNT(*) FROM visits v WHERE v.cc_id = cc.id AND v.is_bot = 1) AS bot_visit_count
         FROM campaign_contacts cc
         JOIN contacts c ON c.id = cc.contact_id
         LEFT JOIN accounts a ON a.id = cc.account_id
         LEFT JOIN li_accounts li ON li.id = cc.li_account_id
         WHERE cc.campaign_id = ?
         ORDER BY cc.id`
      )
      .all(req.params.id);
    res.json(rows);
  });

  return app;
}
