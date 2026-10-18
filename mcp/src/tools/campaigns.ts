/**
 * Campaigns: read, activity, previews and test email, creation (contacts
 * included), editing (campaign or a single step), pause/resume, archive, delete.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, ApiError } from "../api.js";
import { buildImportCsv, campaignSummary, checkCampaignVars, isoDates } from "../lib.js";
import { campaignVars, contactsList, handler, importCsv, READ, statusFilter } from "./common.js";

// A sequence step: email (subject + body) or LinkedIn action.
const stepSchema = z.object({
  subject: z.string().optional().describe("Email subject. Required for step 1 when channel=email."),
  subject_b: z
    .string()
    .optional()
    .describe("Subject variant B (50/50 A/B test), email step 1 only."),
  body: z
    .string()
    .optional()
    .describe(
      "Message body. Variables: {{first_name}}, {{last_name}}, {{company}}, {{email}}, {{sender_name}}, {{link}}, {{signature}} + any CSV column. Conditional block: {{if variable}}text if set{{else}}text otherwise{{end}} ({{else}} optional, no nesting; French {{si}}/{{sinon}}/{{fin}} still accepted), also in the subject. An email follow-up without subject goes in the same thread (Re:). For a LinkedIn invite, the note is optional."
    ),
  wait_days: z
    .number()
    .int()
    .optional()
    .describe("Days to wait before this step. Ignored for step 1 (always 0). Default 3."),
  channel: z.enum(["email", "linkedin"]).optional().describe("Step channel. Default \"email\"."),
  li_action: z
    .enum(["invite", "message"])
    .optional()
    .describe("LinkedIn action when channel=linkedin: \"invite\" (with note) or \"message\"."),
  branch: z
    .enum(["accepted", "not_accepted", ""])
    .optional()
    .describe(
      "After a LinkedIn invite: step only for contacts whose invite was accepted (\"accepted\") or not (\"not_accepted\"); missing or empty = everyone. The first \"accepted\" step must be a LinkedIn message placed before the \"not_accepted\" steps: it tests acceptance (retried until it happens). The first \"not_accepted\" step's wait_days is the deadline, counted from the invite: past it without acceptance, the contact switches to the \"not_accepted\" steps (no LinkedIn message in them). A contact without a LinkedIn profile goes there directly."
    ),
});

const EVENT_TYPES = ["email_sent", "replied", "opted_out", "bounced", "li_invite", "li_message", "visit"] as const;

const activityShape = {
  days: z.number().int().min(1).max(90).optional().describe("Period in days up to now (default 7, max 90)."),
  campaign_id: z.number().int().optional().describe("Limit to one campaign (default: all)."),
  event_types: z
    .array(z.enum(EVENT_TYPES))
    .min(1)
    .optional()
    .describe("Keep only these event types in the list (totals stay complete)."),
  events_limit: z
    .number()
    .int()
    .min(0)
    .max(300)
    .optional()
    .describe("Max events returned, newest first (default 100; 0 = totals only)."),
};
type ActivityArgs = z.infer<z.ZodObject<typeof activityShape>>;

const testEmailShape = {
  to: z.string().email().describe("Test recipient (usually the user's address)."),
  campaign_id: z.number().int().describe("Campaign whose step is tested."),
  step_number: z.number().int().min(1).optional().describe("Step to test (default 1). Must be an email step."),
  account_id: z
    .number()
    .int()
    .optional()
    .describe("Sending account (list_accounts). Default: first active account allowed by the campaign."),
  contact_id: z
    .number()
    .int()
    .optional()
    .describe(
      "GLOBAL contact (contact_id, not cc_id) whose variables fill the template. Default: the campaign's first contact, else a sample contact."
    ),
  variant: z.enum(["A", "B"]).optional().describe("Subject variant for an A/B-tested campaign."),
  dry_run: z
    .boolean()
    .optional()
    .describe("true by default: nothing is sent, the rendering is returned. false = real send, after explicit user approval."),
};
type TestEmailArgs = z.infer<z.ZodObject<typeof testEmailShape>>;

const previewCampaignShape = {
  campaign_id: z.number().int().describe("Campaign to check."),
  status: statusFilter.describe(
    "Contacts checked: one status or a list. Default: those with sends left (held, pending, in_progress, awaiting_li)."
  ),
  samples: z
    .number()
    .int()
    .min(0)
    .max(5)
    .optional()
    .describe("Number of contacts whose remaining steps are fully rendered, in cc_id order (default 1; 0 = none)."),
  limit: z.number().int().min(1).max(500).optional().describe("Max incomplete contacts detailed (default 50)."),
};
type PreviewCampaignArgs = z.infer<z.ZodObject<typeof previewCampaignShape>>;

const DESCRIPTION =
  "Campaign description: who it targets, which contacts to include and exclude (role, company type and size…), the message angle. Written so an agent can tell, with no other context, whether a contact belongs.";

const createShape = {
  name: z.string().describe("Campaign name."),
  description: z.string().optional().describe(DESCRIPTION),
  steps: z.array(stepSchema).min(1).describe("Ordered sequence of steps (at least one)."),
  account_ids: z
    .array(z.number().int())
    .min(1)
    .optional()
    .describe("Allowed sending accounts (ids from list_accounts). Omitted = all accounts, including future ones."),
  li_account_ids: z
    .array(z.number().int())
    .min(1)
    .optional()
    .describe("Allowed LinkedIn accounts (ids from list_linkedin_accounts). Omitted = all LinkedIn accounts."),
  contacts: contactsList
    .optional()
    .describe("Contacts to import right away, same format as import_contacts: they arrive 'held', nothing is sent."),
  campaign_vars: campaignVars,
};
type CreateArgs = z.infer<z.ZodObject<typeof createShape>>;

const updateShape = {
  campaign_id: z.number().int().describe("Campaign id."),
  name: z.string().min(1).optional().describe("New name. Omitted = unchanged."),
  description: z.string().optional().describe(`${DESCRIPTION} Replaces the current one; empty string = clear it; omitted = unchanged.`),
  steps: z
    .array(stepSchema)
    .min(1)
    .optional()
    .describe("FULL sequence replacing the current one. Omitted = unchanged; for a single step, use update_step."),
  account_ids: z
    .union([z.array(z.number().int()).min(1), z.null()])
    .optional()
    .describe("Allowed sending accounts (ids from list_accounts). null = all accounts; omitted = unchanged."),
  li_account_ids: z
    .union([z.array(z.number().int()).min(1), z.null()])
    .optional()
    .describe(
      "Allowed LinkedIn accounts (ids from list_linkedin_accounts). null = all; omitted = unchanged. A contact already approached stays with its account."
    ),
};
type UpdateArgs = z.infer<z.ZodObject<typeof updateShape>>;

const updateStepShape = {
  campaign_id: z.number().int().describe("Campaign id."),
  step_number: z.number().int().min(1).describe("Number of the step to edit (1 = first)."),
  ...stepSchema.shape,
};
type UpdateStepArgs = z.infer<z.ZodObject<typeof updateStepShape>>;

/** Keeps provided fields (undefined = not provided; null is a value). */
function provided(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

export function registerCampaignTools(server: McpServer): void {
  // ---------------------------------------------------------------- read

  server.registerTool(
    "list_campaigns",
    {
      title: "List campaigns",
      description:
        "Lists campaigns with their description (who each targets, which contacts belong) and stats: status (active/paused/archived), contacts per state, emails sent, {{link}} visits, reply rate (overall, and per variant with an A/B test), progress. A missing counter or rate means 0. Archived campaigns are hidden by default (archived_hidden gives their count): include_archived: true to see them. Use for an overview before any action, and to pick a contact's campaign.",
      inputSchema: {
        include_archived: z.boolean().optional().describe("true = include archived campaigns (default false)."),
      },
      annotations: READ,
    },
    handler(async ({ include_archived }: { include_archived?: boolean }) => {
      const all = await api("GET", "/api/campaigns");
      if (!Array.isArray(all)) return all;
      const shown = include_archived ? all : all.filter((c: { status?: string }) => c.status !== "archived");
      return {
        campaigns: shown.map(campaignSummary),
        ...(shown.length < all.length ? { archived_hidden: all.length - shown.length } : {}),
      };
    })
  );

  server.registerTool(
    "get_campaign",
    {
      title: "Campaign detail",
      description:
        "Returns a campaign's detail (description included) and its ordered steps (subject, body, wait_days, channel, li_action, branch). variables: the sequence's personalization variables (excluding first_name, company… which the app fills) with their instruction (what the variable holds, its length, its tone); read before filling a variable for contacts; without an instruction, ask the user. Missing account_ids / li_account_ids = all accounts; a follow-up without subject goes in the first email's thread. Read before editing a step's text (update_step) or the sequence (update_campaign).",
      inputSchema: { campaign_id: z.number().int().describe("Campaign id.") },
      annotations: READ,
    },
    handler(({ campaign_id }: { campaign_id: number }) => api("GET", `/api/campaigns/${campaign_id}`))
  );

  server.registerTool(
    "list_variable_instructions",
    {
      title: "Variable instructions",
      description:
        "Returns the instruction of each personalization variable ({{personalization}}…) that has one: {variable: instruction}. An instruction applies to all campaigns. For one sequence's variables, get_campaign is enough.",
      inputSchema: {},
      annotations: READ,
    },
    handler(() => api("GET", "/api/variable-instructions"))
  );

  server.registerTool(
    "set_variable_instruction",
    {
      title: "Set a variable instruction",
      description:
        "Writes a personalization variable's instruction: what it holds, its length, its tone, where to find the information. Replaces the current one, for every campaign using the variable; empty string = remove it. Written so an agent filling the variable for contacts has nothing else to ask.",
      inputSchema: {
        name: z.string().describe("Variable name, without braces (e.g. personalization)."),
        instruction: z.string().describe("Instruction; empty string = remove it."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handler(({ name, instruction }: { name: string; instruction: string }) =>
      api("PUT", `/api/variable-instructions/${encodeURIComponent(name)}`, { json: { instruction } })
    )
  );

  server.registerTool(
    "get_activity",
    {
      title: "Activity log",
      description:
        "What happened over a period (default 7 days), all campaigns or one: totals (emails sent, replies, opt-outs, bounces, LinkedIn invites and messages, link visits excluding bots) and events newest first (type, campaign, contact with cc_id and contact_id, step, account). The server returns at most 300 events; events_limit trims further. Dates in ISO 8601 (UTC).",
      inputSchema: activityShape,
      annotations: READ,
    },
    handler(async ({ days, campaign_id, event_types, events_limit }: ActivityArgs) => {
      const q = new URLSearchParams();
      if (days !== undefined) q.set("days", String(days));
      if (campaign_id !== undefined) q.set("campaign_id", String(campaign_id));
      const qs = q.toString();
      const data = (await api("GET", `/api/activity${qs ? `?${qs}` : ""}`)) as {
        since?: number;
        totals?: unknown;
        events?: Array<{ type?: string }>;
      };
      const all = Array.isArray(data?.events) ? data.events : [];
      const types = event_types ? new Set<string>(event_types) : null;
      const filtered = types ? all.filter((e) => types.has(String(e.type))) : all;
      const events = filtered.slice(0, events_limit ?? 100);
      return isoDates({
        since: data?.since,
        totals: data?.totals,
        events_total: filtered.length,
        events_returned: events.length,
        events,
      });
    })
  );

  server.registerTool(
    "preview_email",
    {
      title: "Email preview",
      description:
        "Renders a subject and body with variables resolved, on a real campaign contact (or a sample contact), account signature included. No side effects. Useful to check a template before creating/editing a campaign; to test an existing step exactly as it will be sent, see send_test_email.",
      inputSchema: {
        subject: z.string().optional().describe("Subject to preview."),
        body: z.string().optional().describe("Body to preview."),
        account_id: z.number().int().optional().describe("Sending account for the signature (default: first active)."),
        campaign_id: z.number().int().optional().describe("Campaign whose first contact is used as the sample."),
        contact_id: z.number().int().optional().describe("Specific global contact (contact_id) to use as the sample."),
      },
      annotations: READ,
    },
    handler((args: Record<string, unknown>) => api("POST", "/api/preview", { json: args }))
  );

  server.registerTool(
    "preview_campaign",
    {
      title: "Campaign preview across all contacts",
      description:
        "Checks, without sending anything, what each campaign contact will receive: variables of the steps left to send are resolved as at send time (contact fields, campaign variables). Returns checked (contacts checked) and ready (no empty variable); steps (each step's variables, skipped = contacts that will skip the step for lack of email or LinkedIn profile); missing (per variable: number of contacts where it's empty; all: true = empty for everyone, so check the name; gender_form: true = only a {{genre:…|…}} agreement, rendered masculine); incomplete (affected contacts with cc_id, contact_id and empty variables; fix with update_contact or a re-import); warnings (account without signature, empty sender variables on LinkedIn…); samples (full step rendering for the first contacts). Call before launch_contacts: replaces contact-by-contact trials.",
      inputSchema: previewCampaignShape,
      annotations: READ,
    },
    handler(async ({ campaign_id, status, samples, limit }: PreviewCampaignArgs) => {
      const q = new URLSearchParams();
      if (status !== undefined) q.set("status", (Array.isArray(status) ? status : [status]).join(","));
      if (samples !== undefined) q.set("samples", String(samples));
      if (limit !== undefined) q.set("limit", String(limit));
      const qs = q.toString();
      return api("GET", `/api/campaigns/${campaign_id}/preview${qs ? `?${qs}` : ""}`);
    })
  );

  server.registerTool(
    "send_test_email",
    {
      title: "Step test email",
      description:
        "Renders a campaign email step exactly like the scheduler (contact variables, {{sender_name}}, sample {{link}}, {{signature}}; a follow-up without subject becomes \"Re: \" + step 1 subject) and sends it to \"to\", subject prefixed [TEST]. Touches no quotas, statuses or history. dry_run defaults to true: nothing is sent and the rendering (from, to, subject, body) is returned. To really send: show this rendering first, then call again with dry_run: false after explicit user approval. Refused for a LinkedIn step (the rendered body is in the error).",
      inputSchema: testEmailShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    handler(async ({ dry_run, ...rest }: TestEmailArgs) => {
      try {
        return await api("POST", "/api/test-email", { json: { ...rest, dry_run: dry_run ?? true } });
      } catch (err) {
        const rendered = err instanceof ApiError ? (err.data as { rendered_body?: unknown } | null)?.rendered_body : undefined;
        if (typeof rendered === "string") throw new Error(`${err instanceof Error ? err.message : err}\n\nRendered body:\n${rendered}`);
        throw err;
      }
    })
  );

  // ---------------------------------------------------------------- write

  server.registerTool(
    "create_campaign",
    {
      title: "Create a campaign",
      description:
        "Creates a campaign with its step sequence and, if contacts is given, imports them in the same call (same rules as import_contacts; the result then includes the import report). Always fill description. The campaign starts PAUSED ('paused') and its contacts 'held': nothing is sent before launch_contacts. The first email step needs a subject; every step needs a body (except a LinkedIn invite, whose note is optional). Returns { id }; add more contacts later with import_contacts / import_contacts_csv.",
      inputSchema: createShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handler(async ({ contacts, campaign_vars, ...campaign }: CreateArgs) => {
      if (campaign_vars && !contacts) throw new Error("campaign_vars only works with contacts.");
      // Validate contacts before creating: an invalid field doesn't leave an empty campaign behind
      const table = contacts ? buildImportCsv(contacts as Array<Record<string, unknown>>) : null;
      const vars = table ? checkCampaignVars(campaign_vars, table.columns) : [];
      const created = (await api("POST", "/api/campaigns", { json: campaign })) as { id: number };
      if (!table) return created;
      try {
        return { ...created, import: await importCsv(created.id, table.csv, vars) };
      } catch (err) {
        return {
          ...created,
          import_error: `${err instanceof Error ? err.message : err} — the campaign was created without contacts: fix, then import_contacts.`,
        };
      }
    })
  );

  server.registerTool(
    "update_campaign",
    {
      title: "Update a campaign",
      description:
        "Updates a campaign, even while running: only provided fields change (name, description, sending accounts, LinkedIn accounts, sequence). steps, if given, replaces the WHOLE sequence; to change one step's text, delay or channel, prefer update_step. Contacts keep their progress; upcoming sends use the new content.",
      inputSchema: updateShape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handler(({ campaign_id, ...fields }: UpdateArgs) => {
      const body = provided(fields);
      if (!Object.keys(body).length) throw new Error("No field to update.");
      return api("PATCH", `/api/campaigns/${campaign_id}`, { json: body });
    })
  );

  server.registerTool(
    "update_step",
    {
      title: "Update a step",
      description:
        "Updates ONE campaign step without resending the rest of the sequence: only provided fields change (subject, subject_b, body, wait_days, channel, li_action, branch). An empty string clears the field: empty subject on a follow-up = same thread as the first email, empty subject_b = ends the A/B test. The body is replaced whole (no partial text edits): read it first with get_campaign. The resulting sequence must stay valid (subject on the first email, body on every step except invites). Contacts keep their progress; upcoming sends of this step use the new content. Returns the step as saved.",
      inputSchema: updateStepShape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handler(({ campaign_id, step_number, ...fields }: UpdateStepArgs) => {
      const body = provided(fields);
      if (!Object.keys(body).length) throw new Error("No field to update.");
      return api("PATCH", `/api/campaigns/${campaign_id}/steps/${step_number}`, { json: body });
    })
  );

  server.registerTool(
    "delete_campaign",
    {
      title: "Delete a campaign",
      description:
        "PERMANENTLY deletes a campaign, its steps, contact enrollments and related send history (cascade). Global contacts are kept. Irreversible: confirm with the user before calling.",
      inputSchema: { campaign_id: z.number().int().describe("Id of the campaign to delete.") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handler(({ campaign_id }: { campaign_id: number }) => api("DELETE", `/api/campaigns/${campaign_id}`))
  );

  server.registerTool(
    "pause_campaign",
    {
      title: "Pause a campaign",
      description: "Sets the campaign to 'paused': no new sends until resumed.",
      inputSchema: { campaign_id: z.number().int().describe("Campaign id.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler(({ campaign_id }: { campaign_id: number }) => api("POST", `/api/campaigns/${campaign_id}/pause`))
  );

  server.registerTool(
    "resume_campaign",
    {
      title: "Resume a campaign",
      description:
        "Sets the campaign to 'active': sends (emails and LinkedIn actions) resume for 'pending'/'in_progress' contacts, within the send window and quotas. Triggers real sends: confirm with the user.",
      inputSchema: { campaign_id: z.number().int().describe("Campaign id.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    handler(({ campaign_id }: { campaign_id: number }) => api("POST", `/api/campaigns/${campaign_id}/resume`))
  );

  server.registerTool(
    "archive_campaign",
    {
      title: "Archive a campaign",
      description:
        "Sets the campaign to 'archived': it stays viewable (sequence, contacts, stats) and filed separately in the app, but sends nothing and can't be resumed or launched while archived. Nothing is deleted. Prefer it over delete_campaign to put away a finished campaign.",
      inputSchema: { campaign_id: z.number().int().describe("Campaign id.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler(({ campaign_id }: { campaign_id: number }) => api("POST", `/api/campaigns/${campaign_id}/archive`))
  );

  server.registerTool(
    "unarchive_campaign",
    {
      title: "Unarchive a campaign",
      description: "Takes the campaign out of the archive: it returns to 'paused', with no sends (resume_campaign to resume it).",
      inputSchema: { campaign_id: z.number().int().describe("Campaign id.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler(({ campaign_id }: { campaign_id: number }) => api("POST", `/api/campaigns/${campaign_id}/unarchive`))
  );
}
