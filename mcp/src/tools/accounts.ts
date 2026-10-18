/**
 * Google sending accounts: list, connect (OAuth link), settings; app settings.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, PUBLIC_URL } from "../api.js";
import { isoDates } from "../lib.js";
import { handler, READ } from "./common.js";

/** Host only reachable from an internal network (e.g. http://sequence-app:3000)? */
export function looksInternal(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return !host.includes(".") && host !== "localhost";
  } catch {
    return true;
  }
}

export function registerAccountTools(server: McpServer): void {
  server.registerTool(
    "list_accounts",
    {
      title: "List sending accounts",
      description:
        "Lists connected Google accounts: id, email, sender name, signature, daily quota, today's effective quota (with warm-up), sends so far today, active/inactive, warm-up on/off. To add one: connect_google_account.",
      inputSchema: {},
      annotations: READ,
    },
    handler(async () => api("GET", "/api/accounts"))
  );

  server.registerTool(
    "connect_google_account",
    {
      title: "Connect a Google account",
      description:
        "Gives the OAuth link to open in a browser to connect (or reconnect, if expired) a Google Workspace sending account, with instructions. The Google consent click is necessarily done by the user, outside Claude. No effect until the link is opened; then list_accounts shows the account.",
      inputSchema: {},
      annotations: READ,
    },
    handler(async () => {
      const url = `${PUBLIC_URL}/auth/google`;
      let googleConfigured: boolean | undefined;
      try {
        googleConfigured = ((await api("GET", "/api/settings")) as { google_configured?: boolean })?.google_configured;
      } catch {
        // app unreachable: still give the link
      }
      const lines = [
        `Google connection link: ${url}`,
        "",
        "Steps (in the user's browser):",
        "1. Open the link above.",
        "2. If a login prompt appears, enter the Sequence Mail dashboard username and password.",
        "3. Pick the Google Workspace account that will send the emails.",
        "4. Accept the requested permissions (send emails, read Gmail to detect replies, email address). The browser returns to the app's Settings page, account connected.",
        "5. Come back here: list_accounts shows the new account (id, quota, warm-up).",
        "",
        "- One account per pass: repeat for each sending address.",
        "- The same link reconnects an expired or revoked account (pick the same address): its settings are kept and it is reactivated.",
        "- A new account starts with warm-up (daily quota ramping up); quota, sender name and signature are set with update_account.",
      ];
      if (googleConfigured === false) {
        lines.push(
          "",
          "WARNING: the app has no Google OAuth credentials configured (GOOGLE_CLIENT_ID…): the link will fail until this is set on the server."
        );
      }
      if (looksInternal(PUBLIC_URL)) {
        lines.push(
          "",
          `WARNING: ${PUBLIC_URL} looks like an internal address, unreachable from a browser. Use the app's public URL (the MCP's SEQUENCE_MAIL_PUBLIC_URL variable).`
        );
      }
      return lines.join("\n");
    })
  );

  server.registerTool(
    "update_account",
    {
      title: "Update a sending account",
      description:
        "Updates a connected Google account: daily quota, active/inactive, sender name, signature, warm-up on/off. Only provided fields change. account_id accepts a list to apply the same settings to several accounts in one call.",
      inputSchema: {
        account_id: z
          .union([z.number().int(), z.array(z.number().int()).min(1)])
          .describe("Account id (list_accounts), or a list of ids to set the same way."),
        daily_limit: z.number().int().optional().describe("Daily sending quota."),
        active: z.boolean().optional().describe("Enable/disable the account for sending."),
        from_name: z.string().optional().describe("Name shown in the \"From\" field."),
        signature: z.string().optional().describe("Signature (inserted via {{signature}})."),
        warmup: z.boolean().optional().describe("Enable progressive warm-up."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler(async ({ account_id, ...fields }: { account_id: number | number[] } & Record<string, unknown>) => {
      const body = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      if (!Object.keys(body).length) throw new Error("No field to update.");
      if (!Array.isArray(account_id)) return api("PATCH", `/api/accounts/${account_id}`, { json: body });
      const ids = [...new Set(account_id)];
      for (const id of ids) await api("PATCH", `/api/accounts/${id}`, { json: body });
      return { ok: true, updated: ids };
    })
  );

  server.registerTool(
    "delete_google_account",
    {
      title: "Delete a sending account",
      description:
        "PERMANENTLY deletes a Google account, which must be deactivated first (update_account active: false). Also erases its send history (campaigns' \"emails sent\" counter drops; statuses and reply rates unchanged), stops its contacts still in sequence (their follow-ups can only come from it), detaches its Gmail thread and removes it from campaigns' account selections (an emptied selection reverts to \"all accounts\"). Irreversible: state these effects (number of sends and contacts, via list_campaign_contacts) and get the user's explicit approval before calling.",
      inputSchema: { account_id: z.number().int().describe("Account id (list_accounts).") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handler(({ account_id }: { account_id: number }) => api("DELETE", `/api/accounts/${account_id}`))
  );

  server.registerTool(
    "get_settings",
    {
      title: "App settings",
      description:
        "Effective settings (read-only, from .env) and send clock. server: server time, its timezone (timezone, utc_offset) and local_time. Send window hours (deliverability.sendWindowStart / sendWindowEnd) are in the deliverability.sendWindowTimezone timezone, not the server's or the user's. send_window: open, with closes_at if open or opens_at otherwise. next_email: earliest_at = earliest next email send (estimate: due contacts, window, quotas and account rest), due_now = emails due right now, reason if nothing to send or a quota blocks. Then deliverability (quotas, delays, warm-up) and whether Google and Attio are configured. Dates in ISO 8601 (UTC).",
      inputSchema: {},
      annotations: READ,
    },
    handler(async () => isoDates(await api("GET", "/api/settings")))
  );
}
