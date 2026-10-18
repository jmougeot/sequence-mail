/**
 * Contacts: filtered/paginated list, global search, CSV export, imports
 * (objects, raw CSV or file), Attio, launch and status changes.
 */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../api.js";
import {
  buildImportCsv,
  checkCampaignVars,
  contactSummary,
  decodeCsvBytes,
  exportTable,
  filterContacts,
  isoDates,
  paginate,
  parseExtra,
  pickHeld,
  toCsv,
} from "../lib.js";
import {
  assertLocalPath,
  campaignVars,
  ccIds,
  contactsList,
  fetchCampaignContacts,
  handler,
  importCsv,
  READ,
  STATUSES,
  statusFilter,
} from "./common.js";

type StatusFilter = z.infer<typeof statusFilter>;

const LAUNCH_CHUNK = 500; // ids per launch-contacts request

const listShape = {
  campaign_id: z.number().int().describe("Campaign id."),
  status: statusFilter,
  search: z
    .string()
    .optional()
    .describe("Substring searched (case- and accent-insensitive) in email, first name, last name, \"first last\", company, LinkedIn URL."),
  limit: z.number().int().min(1).max(1000).optional().describe("Max rows returned (default 100, max 1000)."),
  offset: z.number().int().min(0).optional().describe("Rows to skip, for paging (default 0)."),
};
type ListArgs = z.infer<z.ZodObject<typeof listShape>>;

const exportShape = {
  campaign_id: z.number().int().describe("Campaign id."),
  status: statusFilter,
  file_path: z
    .string()
    .optional()
    .describe(
      "ABSOLUTE path of the .csv file to write (UTF-8 with BOM, Excel-readable). Only when the MCP runs locally (stdio) on the user's machine. Omitted = the CSV is returned as text."
    ),
  overwrite: z.boolean().optional().describe("Overwrite the file if it exists (default false: refuse)."),
  delimiter: z
    .enum([",", ";"])
    .optional()
    .describe("Delimiter: \",\" (default, standard CSV) or \";\" (French-locale Excel)."),
};
type ExportArgs = z.infer<z.ZodObject<typeof exportShape>>;

const importShape = {
  campaign_id: z.number().int().describe("Target campaign."),
  contacts: contactsList,
  campaign_vars: campaignVars,
};
type ImportArgs = z.infer<z.ZodObject<typeof importShape>>;

const importCsvShape = {
  campaign_id: z.number().int().describe("Target campaign."),
  csv: z
    .string()
    .optional()
    .describe("Raw CSV content, header row included (delimiter , ; or tab auto-detected). Mutually exclusive with csv_path."),
  csv_path: z
    .string()
    .optional()
    .describe(
      "ABSOLUTE path of a local CSV file, read by the MCP process (UTF-8, or Windows-1252 from Excel exports). Only works when the MCP runs locally over stdio on the machine holding the file; refused by a hosted MCP. Mutually exclusive with csv."
    ),
  campaign_vars: campaignVars,
};
type ImportCsvArgs = z.infer<z.ZodObject<typeof importCsvShape>>;

const launchShape = {
  campaign_id: z
    .union([z.number().int(), z.array(z.number().int()).min(1)])
    .describe("Campaign, or list of campaigns to launch in one call."),
  cc_ids: ccIds.optional(),
  all_held: z
    .boolean()
    .optional()
    .describe("true = launch the campaign's waiting ('held') contacts, by ascending cc_id. Without limit: ALL."),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("With all_held: launch only the first N 'held' contacts (by ascending cc_id); N per campaign if several."),
};
type LaunchArgs = z.infer<z.ZodObject<typeof launchShape>>;

/** Launches cc_ids in batches; returns how many actually became pending. */
async function launch(campaignId: number, ids: number[]): Promise<number> {
  let launched = 0;
  for (let i = 0; i < ids.length; i += LAUNCH_CHUNK) {
    const r = (await api("POST", `/api/campaigns/${campaignId}/launch-contacts`, {
      json: { ids: ids.slice(i, i + LAUNCH_CHUNK) },
    })) as { launched?: number };
    launched += Number(r?.launched ?? 0);
  }
  return launched;
}

/** Launches the given cc_ids in ONE campaign, or its 'held' contacts (the first `limit`). */
async function launchIn(campaignId: number, ids: number[] | undefined, limit?: number): Promise<Record<string, unknown>> {
  if (ids) return { launched: await launch(campaignId, ids) };
  const rows = await fetchCampaignContacts(campaignId);
  const heldBefore = rows.filter((r) => r.status === "held").length;
  const chosen = pickHeld(rows, limit).map((r) => r.cc_id);
  if (!chosen.length) return { launched: 0, held_before: 0, note: "No waiting ('held') contacts in this campaign." };
  const launched = await launch(campaignId, chosen);
  return {
    launched,
    held_before: heldBefore,
    held_remaining: heldBefore - launched,
    first_cc_id: chosen[0],
    last_cc_id: chosen[chosen.length - 1],
  };
}

export function registerContactTools(server: McpServer): void {
  // ---------------------------------------------------------------- read

  server.registerTool(
    "list_campaign_contacts",
    {
      title: "Campaign contacts",
      description:
        "Lists a campaign's contacts with their state, filtered (status, search) and paginated (limit default 100, offset). Returns { total, returned, offset, contacts }: total = row count AFTER filtering; if it exceeds offset + returned, call again with a higher offset. IMPORTANT: each row has two ids: \"contact_id\" (the global contact, used by update_contact) and \"cc_id\" (the enrollment in THIS campaign, used by launch_contacts, stop_contacts, set_contacts_status, remove_contacts, get_conversation, reply_to_contact). Includes status, current step, A/B variant, sending account, next send and replied_at (epoch ms), link visits, extra (the contact's custom fields) and vars (this campaign's own variables, which take precedence). A missing field is empty, a missing visit counter is 0. For per-status counts, list_campaigns is enough.",
      inputSchema: listShape,
      annotations: READ,
    },
    handler(async ({ campaign_id, status, search, limit, offset }: ListArgs) => {
      const rows = filterContacts(await fetchCampaignContacts(campaign_id), { status, search });
      const page = paginate(rows, offset ?? 0, limit ?? 100);
      return { total: page.total, returned: page.returned, offset: page.offset, contacts: page.items.map(contactSummary) };
    })
  );

  server.registerTool(
    "search_contacts",
    {
      title: "Search contacts",
      description:
        "Searches the WHOLE database (all campaigns): case-insensitive substring on email, first name, last name, \"first last\", company, LinkedIn URL. Each result gives contact_id (global contact: update_contact, preview_email, send_test_email), do_not_contact, extra (custom fields) and campaigns[]: its enrollments with cc_id (get_conversation, reply_to_contact, launch/stop/set_status/remove), status, step, replied_at. Dates in ISO 8601 (UTC).",
      inputSchema: {
        q: z.string().min(2).describe("Search text (at least 2 characters): name, email, company, profile…"),
        limit: z.number().int().min(1).max(200).optional().describe("Max contacts (default 50, max 200)."),
      },
      annotations: READ,
    },
    handler(async ({ q, limit }: { q: string; limit?: number }) => {
      const params = new URLSearchParams({ q });
      if (limit !== undefined) params.set("limit", String(limit));
      const rows = await api("GET", `/api/contacts?${params}`);
      if (!Array.isArray(rows)) return rows;
      return isoDates(rows.map((r: Record<string, unknown>) => ({ ...r, extra: r.extra == null ? null : parseExtra(r.extra) })));
    })
  );

  server.registerTool(
    "export_campaign_contacts",
    {
      title: "Export contacts (CSV)",
      description:
        "Exports a campaign's contacts as CSV: email, first_name, last_name, company, linkedin, status, current_step, variant, sender, li_sender, replied_at and next_send_at (ISO 8601 UTC), visit_count, error, then one column per custom field (contact's or campaign's own; prefixed extra_ on collision). Optional status filter. With file_path (local MCP only): writes the file and returns { path, rows, columns }. Without file_path: returns the CSV text; prefer file_path beyond ~200 rows to avoid flooding the conversation.",
      inputSchema: exportShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler(async ({ campaign_id, status, file_path, overwrite, delimiter }: ExportArgs) => {
      if (file_path !== undefined) assertLocalPath(file_path, "file_path", "Omit file_path to get the CSV as text.");
      const rows = filterContacts(await fetchCampaignContacts(campaign_id), { status: status as StatusFilter });
      const table = exportTable(rows);
      const csv = toCsv(table.columns, table.rows, delimiter ?? ",");
      if (file_path === undefined) return csv;
      if (!overwrite) {
        const exists = await access(file_path).then(
          () => true,
          () => false
        );
        if (exists) throw new Error(`File ${file_path} already exists: pass overwrite: true to replace it.`);
      }
      await mkdir(dirname(file_path), { recursive: true });
      await writeFile(file_path, "﻿" + csv, "utf8");
      return { path: file_path, rows: table.rows.length, columns: table.columns };
    })
  );

  // ---------------------------------------------------------------- import

  const importNote =
    "Deduplicated by email, else by LinkedIn profile; an existing contact is updated (custom fields merged, so re-importing fixes a field or campaign variable; an empty value leaves the field as is, the value \"[vider]\" removes it). An email without a mail server (MX) is dropped (the row stays if it has a LinkedIn). A contact without email skips email steps; without a profile, LinkedIn steps. An opted-out contact is never re-enrolled. Contacts arrive 'held': NOTHING is sent before launch_contacts. Returns { imported, updated, skipped, errors } (errors truncated to 30, with errors_total).";

  server.registerTool(
    "import_contacts",
    {
      title: "Import contacts (list)",
      description: `Imports a list of contacts given as JSON objects into a campaign (the MCP converts it to CSV for the app). Ideal when contacts come from the conversation, a search or another tool. ${importNote}`,
      inputSchema: importShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handler(async ({ campaign_id, contacts, campaign_vars }: ImportArgs) => {
      const { csv, columns } = buildImportCsv(contacts as Array<Record<string, unknown>>);
      return importCsv(campaign_id, csv, checkCampaignVars(campaign_vars, columns));
    })
  );

  server.registerTool(
    "import_contacts_csv",
    {
      title: "Import contacts (CSV)",
      description: `Imports contacts into a campaign from a CSV: either the text (csv) or a local file (csv_path, absolute path, local stdio MCP only), exactly one of the two. Each row needs an 'email' or a 'linkedin' (profile URL), both if possible; known columns: first_name, last_name, company; any other column becomes a template variable (headers normalized to lowercase snake_case). ${importNote}`,
      inputSchema: importCsvShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handler(async ({ campaign_id, csv, csv_path, campaign_vars }: ImportCsvArgs) => {
      if ((csv === undefined) === (csv_path === undefined)) {
        throw new Error("Provide exactly one of csv (text) or csv_path (local file).");
      }
      let content = csv ?? "";
      if (csv_path !== undefined) {
        assertLocalPath(csv_path, "csv_path", "Pass the file content in csv.");
        content = decodeCsvBytes(await readFile(csv_path)).text;
      }
      return importCsv(campaign_id, content, campaign_vars);
    })
  );

  server.registerTool(
    "attio_sync",
    {
      title: "Import from Attio",
      description:
        "Imports into a campaign the Attio people whose status attribute matches the chosen values (contacts 'held', like a CSV import). Requires ATTIO_API_KEY set in the app.",
      inputSchema: {
        campaign_id: z.number().int().describe("Target campaign."),
        status_attribute: z
          .string()
          .optional()
          .describe("Attio status attribute slug (default: the app's ATTIO_IMPORT_ATTRIBUTE)."),
        statuses: z.array(z.string()).min(1).describe("Status values to import."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    handler(
      ({ campaign_id, status_attribute, statuses }: { campaign_id: number; status_attribute?: string; statuses: string[] }) =>
        api("POST", `/api/campaigns/${campaign_id}/attio-sync`, { json: { status_attribute, statuses } })
    )
  );

  // -------------------------------------------- write (key = cc_id)

  server.registerTool(
    "launch_contacts",
    {
      title: "Launch contacts",
      description:
        "Moves waiting contacts ('held') → 'pending': they enter the send queue and the campaign becomes 'active' again; real sends then go out within the send window, quotas and warm-up. Selection: either cc_ids (exact list) or all_held: true ('held' contacts by ascending cc_id), with limit to launch only N. all_held without limit launches ALL waiting contacts. Contacts not 'held' are ignored. campaign_id accepts a list to launch several campaigns in one call (limit then applies per campaign; each cc_id is launched in the campaign it belongs to): the result details each campaign. Never launch more than the user asked for, and get their explicit approval before calling.",
      inputSchema: launchShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    handler(async ({ campaign_id, cc_ids, all_held, limit }: LaunchArgs) => {
      if (cc_ids && all_held) throw new Error("Choose cc_ids OR all_held, not both.");
      if (!cc_ids && !all_held) throw new Error("Specify cc_ids (contacts to launch) or all_held: true (with limit to launch N).");
      if (cc_ids && limit !== undefined) throw new Error("limit only works with all_held: pass the wanted cc_ids directly.");
      const campaigns = [...new Set(Array.isArray(campaign_id) ? campaign_id : [campaign_id])];
      const notHeld = `The cc_ids not launched were not 'held' (or not in ${campaigns.length === 1 ? "this campaign" : "these campaigns"}).`;
      if (campaigns.length === 1) {
        const result = await launchIn(campaigns[0], cc_ids, limit);
        if (!cc_ids) return { ok: true, ...result };
        return { ok: true, ...result, requested: cc_ids.length, ...(Number(result.launched) < cc_ids.length ? { note: notHeld } : {}) };
      }
      // Several campaigns: an error on one (archived…) doesn't undo launches already done
      const results: Array<Record<string, unknown>> = [];
      for (const id of campaigns) {
        try {
          results.push({ campaign_id: id, ...(await launchIn(id, cc_ids, limit)) });
        } catch (err) {
          results.push({ campaign_id: id, launched: 0, error: err instanceof Error ? err.message : String(err) });
        }
      }
      const launched = results.reduce((n, r) => n + Number(r.launched), 0);
      return {
        ok: results.every((r) => r.error === undefined),
        launched,
        ...(cc_ids ? { requested: cc_ids.length, ...(launched < cc_ids.length ? { note: notHeld } : {}) } : {}),
        campaigns: results,
      };
    })
  );

  server.registerTool(
    "stop_contacts",
    {
      title: "Stop contacts",
      description:
        "Manually stops the sequence for a selection (status → 'stopped', scheduled send and queued LinkedIn actions cancelled). Applies to contacts in 'held', 'pending', 'in_progress' or 'awaiting_li'.",
      inputSchema: { campaign_id: z.number().int().describe("Campaign."), cc_ids: ccIds },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handler(({ campaign_id, cc_ids }: { campaign_id: number; cc_ids: number[] }) =>
      api("POST", `/api/campaigns/${campaign_id}/stop-contacts`, { json: { ids: cc_ids } })
    )
  );

  server.registerTool(
    "set_contacts_status",
    {
      title: "Set contacts status",
      description:
        "Forces the status of a selection of contacts. Statuses: held, pending, in_progress, replied, opted_out, bounced, completed, stopped, failed. 'opted_out' also unsubscribes the contact for the campaign owner (\"do not contact\" list, their other sequences with that owner stopped): confirm with the user. Setting back to 'pending'/'in_progress' may trigger sends.",
      inputSchema: {
        campaign_id: z.number().int().describe("Campaign."),
        cc_ids: ccIds,
        status: z.enum(STATUSES).describe("New status to apply."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handler(({ campaign_id, cc_ids, status }: { campaign_id: number; cc_ids: number[]; status: string }) =>
      api("POST", `/api/campaigns/${campaign_id}/set-status`, { json: { ids: cc_ids, status } })
    )
  );

  server.registerTool(
    "remove_contacts",
    {
      title: "Remove contacts from the campaign",
      description:
        "Removes a selection of contacts from the campaign (deletes the enrollment). The global contact is kept (reusable elsewhere). Irreversible for this campaign: confirm with the user.",
      inputSchema: { campaign_id: z.number().int().describe("Campaign."), cc_ids: ccIds },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handler(({ campaign_id, cc_ids }: { campaign_id: number; cc_ids: number[] }) =>
      api("POST", `/api/campaigns/${campaign_id}/remove-contacts`, { json: { ids: cc_ids } })
    )
  );

  server.registerTool(
    "update_contact",
    {
      title: "Update a contact",
      description:
        "Updates a GLOBAL contact (key = contact_id, the \"contact_id\" field from list_campaign_contacts or search_contacts, not cc_id). Custom fields (extra) are merged: an empty value deletes the field. Changes apply to every campaign this contact is in.",
      inputSchema: {
        contact_id: z.number().int().describe("Global contact id (contact_id field)."),
        first_name: z.string().optional(),
        last_name: z.string().optional(),
        company: z.string().optional(),
        linkedin: z.string().optional().describe("LinkedIn profile URL (an empty value doesn't clear it)."),
        extra: z.record(z.string()).optional().describe("Custom fields to merge (key→value; empty value = delete)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler(({ contact_id, ...body }: { contact_id: number } & Record<string, unknown>) =>
      api("PATCH", `/api/contacts/${contact_id}`, { json: body })
    )
  );
}
