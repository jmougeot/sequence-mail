/**
 * LinkedIn channel: overall status, master switch, and LinkedIn accounts
 * (creation with extension token, settings, token rotation, deletion).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, ApiError, PUBLIC_URL } from "../api.js";
import { isoDates } from "../lib.js";
import { handler, READ } from "./common.js";

const liAccountId = z.number().int().describe("LinkedIn account id (list_linkedin_accounts).");

const updateShape = {
  li_account_id: liAccountId,
  name: z.string().min(1).optional().describe("New account name."),
  active: z
    .boolean()
    .optional()
    .describe("false = the account stops acting; true = reactivates it (and lifts an ongoing safety pause)."),
  mode: z
    .enum(["extension", "server"])
    .optional()
    .describe(
      "Who runs it: \"extension\" (the user's Chrome) or \"server\" (server-side browser; needs a session handed over by the extension: session.stored). Prefer the extension's \"Confier ce compte au serveur\" (hand over to server) button, which sends the session and switches the mode."
    ),
  proxy: z
    .union([z.string(), z.null()])
    .optional()
    .describe("Server-mode proxy: http://user:password@host:port (or https://, socks5://). null or \"\" removes it."),
  invites_per_day: z
    .union([z.number().int().min(0), z.null()])
    .optional()
    .describe("Daily invitation cap. null = app default."),
  messages_per_day: z
    .union([z.number().int().min(0), z.null()])
    .optional()
    .describe("Daily message cap. null = app default."),
};
type UpdateArgs = z.infer<z.ZodObject<typeof updateShape>>;

/** Steps to link a LinkedIn account to the Chrome extension with its token. */
function extensionSteps(token: string): string[] {
  return [
    `Account token: ${token} — shown only once (lost → rotate_linkedin_token).`,
    "1. In Chrome, log in to LinkedIn with this account's profile (several LinkedIn accounts = one Chrome profile per account).",
    "2. Install the extension (once per Chrome profile): chrome://extensions → enable Developer mode → \"Load unpacked\" → folder Sequence-mail/extension. Pin it.",
    "3. Open the extension popup (if only the \"Azerit\" view shows, click \"Advanced settings\"), then:",
    `   - "Adresse du serveur" (server address): ${PUBLIC_URL} → OK;`,
    "   - \"Mot de passe d'accès\" (access password, protected instance): dashboard username and password → OK (leave empty locally);",
    "   - \"Jeton du compte LinkedIn\" (LinkedIn account token): the token above → OK.",
    "4. Keep a Chrome tab open: at the next tick (~1 min), list_linkedin_accounts shows connected: true and the detected LinkedIn profile (member).",
    "5. Optional: the popup's \"Confier ce compte au serveur\" (hand over to server) button → server mode, the server acts without this Chrome staying open (don't log out of LinkedIn afterwards). Requires server_mode_ready: true in linkedin_status.",
    "Then: the campaign must allow this account (li_account_ids of create_campaign / update_campaign; omitted = all accounts). Quotas and proxy: update_linkedin_account.",
  ];
}

export function registerLinkedinTools(server: McpServer): void {
  server.registerTool(
    "linkedin_status",
    {
      title: "LinkedIn channel status",
      description:
        "LinkedIn automation status, multi-account: master switch, today's totals, queue, server_mode_ready (server mode available), and per-account detail (accounts: id, name, extension connected, today's quotas, safety pause, attached contacts).",
      inputSchema: {},
      annotations: READ,
    },
    handler(async () => api("GET", "/api/li/status"))
  );

  server.registerTool(
    "linkedin_toggle",
    {
      title: "Enable/disable the LinkedIn channel",
      description:
        "Enables or pauses LinkedIn automation for ALL accounts (master switch). Returns the new state. For a single account: update_linkedin_account { active }.",
      inputSchema: { enabled: z.boolean().describe("true to enable, false to pause.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler(({ enabled }: { enabled: boolean }) => api("POST", "/api/li/toggle", { json: { enabled } }))
  );

  server.registerTool(
    "list_linkedin_accounts",
    {
      title: "LinkedIn accounts",
      description:
        "Lists LinkedIn accounts: id (for campaigns' li_account_ids and the *_linkedin_account tools), name, detected LinkedIn profile (member), active, mode (extension|server), connected (runner seen within 2 min), session (server mode: state, stored or not), proxy, caps and today's sends, queue, attached contacts. Non-null owner_ref = an Azerit client's account (managed from Azerit). Dates in ISO 8601 (UTC).",
      inputSchema: {},
      annotations: READ,
    },
    handler(async () => isoDates(await api("GET", "/api/li/accounts")))
  );

  server.registerTool(
    "create_linkedin_account",
    {
      title: "Create a LinkedIn account",
      description:
        "Creates a LinkedIn sending account and returns its token IN CLEAR (shown only once) with the steps to link it: install the Chrome extension once and paste the token (done by the user, outside Claude). Starts with default caps. Give the token and steps to the user.",
      inputSchema: {
        name: z.string().min(1).describe("Account name (e.g. the name of the person whose LinkedIn profile it is)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handler(async ({ name }: { name: string }) => {
      const { token, ...account } = (await api("POST", "/api/li/accounts", { json: { name } })) as Record<string, unknown> & {
        token: string;
      };
      return { token, account: isoDates(account), next_steps: extensionSteps(token) };
    })
  );

  server.registerTool(
    "update_linkedin_account",
    {
      title: "Update a LinkedIn account",
      description:
        "Updates a LinkedIn account: name, active/inactive, mode (extension|server), proxy, daily invitation and message caps (null = app default). Only provided fields change. Returns the account state.",
      inputSchema: updateShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler(async ({ li_account_id, ...fields }: UpdateArgs) => {
      const body = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      if (!Object.keys(body).length) throw new Error("No field to update.");
      return isoDates(await api("PATCH", `/api/li/accounts/${li_account_id}`, { json: body }));
    })
  );

  server.registerTool(
    "rotate_linkedin_token",
    {
      title: "Rotate LinkedIn token",
      description:
        "Replaces a LinkedIn account's extension token (lost or leaked). The old one stops working IMMEDIATELY: the extension using it is refused until the new token is pasted into its popup. A server-mode account keeps acting (the server doesn't use this token). Confirm with the user.",
      inputSchema: { li_account_id: liAccountId },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    handler(async ({ li_account_id }: { li_account_id: number }) => {
      const { token } = (await api("POST", `/api/li/accounts/${li_account_id}/token`)) as { token: string };
      return {
        token,
        next_steps:
          "Shown only once. In this account's extension popup: field \"Jeton du compte LinkedIn\" (LinkedIn account token) → paste the new token → OK.",
      };
    })
  );

  server.registerTool(
    "delete_linkedin_account",
    {
      title: "Delete a LinkedIn account",
      description:
        "PERMANENTLY deletes a LinkedIn account that hasn't done anything yet. The app refuses if the account has already acted or has contacts (their messages can only come from it): deactivate it instead with update_linkedin_account { active: false }. Confirm with the user.",
      inputSchema: { li_account_id: liAccountId },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handler(async ({ li_account_id }: { li_account_id: number }) => {
      try {
        return await api("DELETE", `/api/li/accounts/${li_account_id}`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          throw new Error(
            `${err.message}\nTip: deactivate it instead with update_linkedin_account { li_account_id: ${li_account_id}, active: false }; its contacts stay attached to this account.`
          );
        }
        throw err;
      }
    })
  );
}
