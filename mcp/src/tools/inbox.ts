/**
 * Prospect replies: unified inbox, a contact's thread, reply in the email thread.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../api.js";
import { isoDates } from "../lib.js";
import { handler, READ } from "./common.js";

const REPLY_STATUSES = ["replied", "opted_out", "bounced"] as const;

const repliesShape = {
  campaign_id: z.number().int().optional().describe("Limit to one campaign (default: all)."),
  status: z
    .union([z.enum(REPLY_STATUSES), z.array(z.enum(REPLY_STATUSES)).min(1)])
    .optional()
    .describe("Status(es): replied, opted_out, bounced. Default replied + opted_out."),
  since: z
    .union([z.number(), z.string()])
    .optional()
    .describe("Only replies since this date: ISO (\"2026-09-25\", \"2026-09-25T08:00:00Z\") or epoch ms."),
  limit: z.number().int().min(1).max(200).optional().describe("Max replies (default 50, max 200)."),
  include_text: z
    .boolean()
    .optional()
    .describe(
      "true = include the last email reply's text (read from Gmail, quotes stripped, 2000 chars max). Slower: keep limit reasonable."
    ),
};
type RepliesArgs = z.infer<z.ZodObject<typeof repliesShape>>;

const conversationShape = {
  cc_id: z.number().int().describe("Contact's campaign enrollment (cc_id from list_replies / list_campaign_contacts), NOT contact_id."),
  full_text: z
    .boolean()
    .optional()
    .describe("true = raw text of received messages, quotes included (default: quotes stripped)."),
};
type ConversationArgs = z.infer<z.ZodObject<typeof conversationShape>>;

const replyShape = {
  cc_id: z.number().int().describe("Contact's campaign enrollment (cc_id), NOT contact_id."),
  body: z
    .string()
    .min(1)
    .describe(
      "Reply body, as a template: {{first_name}}, {{company}}, custom fields, {{sender_name}}, {{link}}, {{signature}} (the thread account's signature, include if wanted)."
    ),
  subject: z.string().optional().describe("Subject. Default: \"Re: \" + last message's subject (keep the default to stay in the thread)."),
  dry_run: z
    .boolean()
    .optional()
    .describe("true by default: nothing is sent, the rendering is returned. false = real send, only after explicit user approval."),
};
type ReplyArgs = z.infer<z.ZodObject<typeof replyShape>>;

/** ISO date or epoch ms → epoch ms. */
function toEpochMs(value: number | string): number {
  if (typeof value === "number") return value;
  const ms = /^\d+$/.test(value.trim()) ? Number(value.trim()) : Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`Unreadable date for since: "${value}" (expected ISO, e.g. 2026-09-25, or epoch ms).`);
  return ms;
}

type ThreadMessage = Record<string, unknown> & { direction?: string; text?: unknown; text_clean?: unknown };

export function registerInboxTools(server: McpServer): void {
  server.registerTool(
    "list_replies",
    {
      title: "Replies received",
      description:
        "Unified inbox: contacts who replied (email or LinkedIn), all campaigns or one, newest first. Default statuses replied + opted_out (bounced on request). Each row: cc_id (for get_conversation and reply_to_contact), contact_id, campaign (non-null owner_ref = an Azerit client's campaign), contact, status, channel (email|linkedin), thread account (sender = Google, li_sender = LinkedIn), li_thread_url, replied_at. include_text: true adds the last email reply's text. Dates in ISO 8601 (UTC).",
      inputSchema: repliesShape,
      annotations: READ,
    },
    handler(async ({ campaign_id, status, since, limit, include_text }: RepliesArgs) => {
      const q = new URLSearchParams();
      if (campaign_id !== undefined) q.set("campaign_id", String(campaign_id));
      if (status !== undefined) q.set("status", (Array.isArray(status) ? status : [status]).join(","));
      if (since !== undefined) q.set("since", String(toEpochMs(since)));
      if (limit !== undefined) q.set("limit", String(limit));
      if (include_text) q.set("include_text", "1");
      const qs = q.toString();
      const rows = await api("GET", `/api/inbox${qs ? `?${qs}` : ""}`);
      if (!Array.isArray(rows)) return rows;
      return { returned: rows.length, replies: isoDates(rows) };
    })
  );

  server.registerTool(
    "get_conversation",
    {
      title: "Contact conversation",
      description:
        "Full thread of ONE contact in ONE campaign (key cc_id, NOT contact_id): campaign, contact, status, step, error; email_thread = Gmail thread messages in order (direction out/in, kind sent/reply/auto_reply/bounce, from, to, date, subject, text), absent without an email thread; steps_sent (email steps sent); linkedin (the sequence's LinkedIn invites/messages) and li_thread_url. By default received messages have quotes stripped (full_text: true for raw). Read before drafting a reply with reply_to_contact. Dates in ISO 8601 (UTC).",
      inputSchema: conversationShape,
      annotations: READ,
    },
    handler(async ({ cc_id, full_text }: ConversationArgs) => {
      const conv = (await api("GET", `/api/campaign-contacts/${cc_id}/conversation`)) as Record<string, unknown> | null;
      if (conv && Array.isArray(conv.email_thread) && !full_text) {
        conv.email_thread = (conv.email_thread as ThreadMessage[]).map((m) => {
          if (m.direction !== "in" || typeof m.text_clean !== "string" || !m.text_clean.trim()) return m;
          const { text_clean, ...rest } = m;
          return { ...rest, text: text_clean };
        });
      }
      return isoDates(conv);
    })
  );

  server.registerTool(
    "reply_to_contact",
    {
      title: "Reply to a contact",
      description:
        "Replies to the contact in their existing email thread: same Gmail thread, from the account that sent the sequence, replying to the last message (no unsubscribe link). Does not change the contact's status. dry_run defaults to true: nothing is sent and the rendering (from, to, subject, body) is returned. Show it to the user, then call again with dry_run: false only after their explicit approval. Fails if the contact has no email thread (LinkedIn-only contact: reply on LinkedIn, li_thread_url).",
      inputSchema: replyShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    handler(({ cc_id, body, subject, dry_run }: ReplyArgs) =>
      api("POST", `/api/campaign-contacts/${cc_id}/reply`, { json: { body, subject, dry_run: dry_run ?? true } })
    )
  );
}
