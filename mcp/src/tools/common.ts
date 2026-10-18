/**
 * Shared tool building blocks: MCP response formatting, common schemas, local
 * file access.
 */
import { isAbsolute } from "node:path";
import { z } from "zod";
import { api } from "../api.js";
import { compact, summarizeImport, type CampaignContactRow } from "../lib.js";

// --- MCP responses ------------------------------------------------------------
export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Single-line JSON, empty fields omitted (see compact): less text for the client to read. */
export function ok(data: unknown): ToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(compact(data));
  return { content: [{ type: "text", text: text || "(empty)" }] };
}
export function fail(err: unknown): ToolResult {
  return {
    content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  };
}
/** Wraps a handler: runs it, serializes the result, catches errors. */
export function handler<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };
}

// --- Annotations --------------------------------------------------------------
/** Read-only, no side effects, limited to the app. */
export const READ = { readOnlyHint: true, openWorldHint: false } as const;

// --- Contact statuses within a campaign ----------------------------------------
/** Statuses that can be set by hand (set_contacts_status). */
export const STATUSES = [
  "held",
  "pending",
  "in_progress",
  "replied",
  "opted_out",
  "bounced",
  "completed",
  "stopped",
  "failed",
] as const;
/** Observable statuses: the above + awaiting_li (LinkedIn action queued). */
export const FILTER_STATUSES = [...STATUSES, "awaiting_li"] as const;

export const statusFilter = z
  .union([z.enum(FILTER_STATUSES), z.array(z.enum(FILTER_STATUSES)).min(1)])
  .optional()
  .describe(
    "Status filter: one status or a list. held = imported, not launched; pending = launched, awaiting 1st send; in_progress, awaiting_li (LinkedIn action queued), replied, opted_out, bounced, completed, stopped, failed."
  );

export const ccIds = z
  .array(z.number().int())
  .min(1)
  .describe("cc_id values (campaign enrollments) from list_campaign_contacts, NOT global contact_id values.");

// --- Contacts to import ---------------------------------------------------------
const contactValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const contactsList = z
  .array(
    z
      .object({
        email: z.string().optional().describe("Email (deduplication key)."),
        linkedin: z.string().optional().describe("LinkedIn profile URL (https://www.linkedin.com/in/…)."),
        first_name: z.string().optional(),
        last_name: z.string().optional(),
        company: z.string().optional(),
      })
      .catchall(contactValue)
  )
  .min(1)
  .max(5000)
  .describe(
    "Contacts to import. Each object: email and/or linkedin (at least one), first_name, last_name, company, and any other field (e.g. title, city, hook) that becomes a template variable {{title}}. Field names: letters, digits, _ (spaces and hyphens become _, uppercase becomes lowercase)."
  );

export const campaignVars = z
  .array(z.string())
  .min(1)
  .optional()
  .describe(
    "Custom fields to attach to the enrollment in THIS campaign rather than to the contact (e.g. [\"hook\"]). A contact field is shared across all its campaigns; a campaign variable applies to this one only, so the same {{hook}} can be used in each campaign without overwriting the others. At send time it overrides the contact field of the same name."
  );

// --- Data ---------------------------------------------------------------------
/** Imports a CSV into a campaign (contacts 'held'); returns a summarized import report. */
export async function importCsv(campaignId: number, csv: string, vars: string[] = []): Promise<unknown> {
  const query = vars.length ? `?campaign_vars=${encodeURIComponent(vars.join(","))}` : "";
  return summarizeImport(await api("POST", `/api/campaigns/${campaignId}/import${query}`, { csv }));
}

/** All contact rows of a campaign (the API doesn't paginate: filtering and paging happen here). */
export async function fetchCampaignContacts(campaignId: number): Promise<CampaignContactRow[]> {
  const rows = await api("GET", `/api/campaigns/${campaignId}/contacts`);
  if (!Array.isArray(rows)) throw new Error("Unexpected API response (expected a list of contacts)");
  return rows as CampaignContactRow[];
}

// --- Local files ----------------------------------------------------------------
/**
 * Reading/writing a file only makes sense when the MCP runs on the user's
 * machine (stdio). Over HTTP (hosted MCP) a path would point at the server's
 * disk: refused.
 */
export function assertLocalPath(path: string, param: string, fallback: string): void {
  if (process.env.MCP_HTTP_PORT) {
    throw new Error(
      `${param} is unavailable: this MCP server is hosted (HTTP) and has no access to the user's files. ${fallback}`
    );
  }
  if (!isAbsolute(path)) throw new Error(`${param} must be an absolute path (got: ${path}).`);
}
