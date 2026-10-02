/**
 * Réponses des prospects : boîte de réception unifiée, fil d'un contact,
 * réponse dans le fil email.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../api.js";
import { isoDates } from "../lib.js";
import { handler, READ } from "./common.js";

const REPLY_STATUSES = ["replied", "opted_out", "bounced"] as const;

const repliesShape = {
  campaign_id: z.number().int().optional().describe("Limiter à une campagne (défaut : toutes)."),
  status: z
    .union([z.enum(REPLY_STATUSES), z.array(z.enum(REPLY_STATUSES)).min(1)])
    .optional()
    .describe("Statut(s) : replied, opted_out, bounced. Défaut replied + opted_out."),
  since: z
    .union([z.number(), z.string()])
    .optional()
    .describe("Seulement les réponses depuis cette date : ISO (« 2026-09-25 », « 2026-09-25T08:00:00Z ») ou epoch ms."),
  limit: z.number().int().min(1).max(200).optional().describe("Nombre max de réponses (défaut 50, max 200)."),
  include_text: z
    .boolean()
    .optional()
    .describe(
      "true = joint le texte de la dernière réponse email (lu dans Gmail, citations retirées, 2000 car. max) — plus lent : garde un limit raisonnable."
    ),
};
type RepliesArgs = z.infer<z.ZodObject<typeof repliesShape>>;

const conversationShape = {
  cc_id: z.number().int().describe("Inscription du contact à la campagne (cc_id de list_replies / list_campaign_contacts), PAS contact_id."),
  full_text: z
    .boolean()
    .optional()
    .describe("true = texte brut des messages reçus, citations comprises (défaut : texte nettoyé des citations)."),
};
type ConversationArgs = z.infer<z.ZodObject<typeof conversationShape>>;

const replyShape = {
  cc_id: z.number().int().describe("Inscription du contact à la campagne (cc_id), PAS contact_id."),
  body: z
    .string()
    .min(1)
    .describe(
      "Corps de la réponse. C'est un template : {{first_name}}, {{company}}, champs personnalisés, {{sender_name}}, {{link}}, {{signature}} (signature du compte du fil, à inclure si souhaitée)."
    ),
  subject: z.string().optional().describe("Sujet. Défaut : « Re: » + sujet du dernier message du fil (garder le défaut pour rester dans le fil)."),
  dry_run: z
    .boolean()
    .optional()
    .describe("true par défaut : rien n'est envoyé, le rendu est renvoyé. false = envoi réel, seulement après accord explicite de l'utilisateur."),
};
type ReplyArgs = z.infer<z.ZodObject<typeof replyShape>>;

/** Date ISO ou epoch ms → epoch ms. */
function toEpochMs(value: number | string): number {
  if (typeof value === "number") return value;
  const ms = /^\d+$/.test(value.trim()) ? Number(value.trim()) : Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`Date illisible pour since : « ${value} » (attendu ISO, ex. 2026-09-25, ou epoch ms).`);
  return ms;
}

type ThreadMessage = Record<string, unknown> & { direction?: string; text?: unknown; text_clean?: unknown };

export function registerInboxTools(server: McpServer): void {
  server.registerTool(
    "list_replies",
    {
      title: "Réponses reçues",
      description:
        "Boîte de réception unifiée : contacts qui ont répondu (email ou LinkedIn), toutes campagnes ou une seule, du plus récent au plus ancien. Par défaut statuts replied + opted_out (bounced sur demande). Chaque ligne : cc_id (pour get_conversation et reply_to_contact), contact_id, campagne (owner_ref non nul = campagne d'un client Azerit), contact, statut, channel (email|linkedin), compte du fil (sender = Google, li_sender = LinkedIn), li_thread_url, replied_at. include_text: true joint le texte de la dernière réponse email. Dates en ISO 8601 (UTC).",
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
      title: "Conversation d'un contact",
      description:
        "Fil complet d'UN contact dans UNE campagne (clé cc_id, PAS contact_id) : campagne, contact, statut, étape, erreur ; email_thread = messages du fil Gmail dans l'ordre (direction out/in, kind sent/reply/auto_reply/bounce, from, to, date, subject, text) ou null sans fil email ; steps_sent (étapes email envoyées) ; linkedin (invitations/messages LinkedIn de la séquence) et li_thread_url. Par défaut, le texte des messages reçus est nettoyé des citations (full_text: true pour le brut). À lire avant de rédiger une réponse avec reply_to_contact. Dates en ISO 8601 (UTC).",
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
      title: "Répondre à un contact",
      description:
        "Répond au contact dans son fil email existant : même thread Gmail, depuis le compte qui a envoyé la séquence, en réponse au dernier message (sans lien de désinscription). Ne change pas le statut du contact. dry_run vaut true par défaut : rien n'est envoyé et le rendu (from, to, subject, body) est renvoyé — montre-le à l'utilisateur, puis rappelle avec dry_run: false seulement après son accord explicite. Échoue si le contact n'a pas de fil email (contact joint uniquement sur LinkedIn : répondre depuis LinkedIn, li_thread_url).",
      inputSchema: replyShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    handler(({ cc_id, body, subject, dry_run }: ReplyArgs) =>
      api("POST", `/api/campaign-contacts/${cc_id}/reply`, { json: { body, subject, dry_run: dry_run ?? true } })
    )
  );
}
