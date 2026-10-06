/**
 * Campagnes : lecture, activité, aperçu et email de test, création, édition,
 * pause/reprise, archivage, suppression.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, ApiError } from "../api.js";
import { isoDates } from "../lib.js";
import { handler, READ } from "./common.js";

// Une étape de séquence : email (sujet + corps) ou action LinkedIn.
const stepSchema = z.object({
  subject: z.string().optional().describe("Sujet de l'email. Obligatoire pour l'étape 1 quand channel=email."),
  subject_b: z
    .string()
    .optional()
    .describe("Variante B du sujet (A/B test 50/50), étape 1 email uniquement."),
  body: z
    .string()
    .optional()
    .describe(
      "Corps du message. Variables : {{first_name}}, {{last_name}}, {{company}}, {{email}}, {{sender_name}}, {{link}}, {{signature}} + toute colonne CSV. Une relance email sans sujet part dans le même fil (Re:). Pour une invitation LinkedIn, la note est facultative."
    ),
  wait_days: z
    .number()
    .int()
    .optional()
    .describe("Jours d'attente avant cette étape. Ignoré pour l'étape 1 (toujours 0). Défaut 3."),
  channel: z.enum(["email", "linkedin"]).optional().describe("Canal de l'étape. Défaut « email »."),
  li_action: z
    .enum(["invite", "message"])
    .optional()
    .describe("Action LinkedIn quand channel=linkedin : « invite » (avec note) ou « message »."),
});

const EVENT_TYPES = ["email_sent", "replied", "opted_out", "bounced", "li_invite", "li_message", "visit"] as const;

const activityShape = {
  days: z.number().int().min(1).max(90).optional().describe("Période en jours jusqu'à maintenant (défaut 7, max 90)."),
  campaign_id: z.number().int().optional().describe("Limiter à une campagne (défaut : toutes)."),
  event_types: z
    .array(z.enum(EVENT_TYPES))
    .min(1)
    .optional()
    .describe("Ne garder que ces types d'événements dans la liste (les totaux restent complets)."),
  events_limit: z
    .number()
    .int()
    .min(0)
    .max(300)
    .optional()
    .describe("Nombre max d'événements rendus, du plus récent au plus ancien (défaut 100 ; 0 = totaux seuls)."),
};
type ActivityArgs = z.infer<z.ZodObject<typeof activityShape>>;

const testEmailShape = {
  to: z.string().email().describe("Destinataire du test (en général l'adresse de l'utilisateur)."),
  campaign_id: z.number().int().describe("Campagne dont on teste une étape."),
  step_number: z.number().int().min(1).optional().describe("Étape à tester (défaut 1). Doit être une étape email."),
  account_id: z
    .number()
    .int()
    .optional()
    .describe("Compte d'envoi (list_accounts). Défaut : 1er compte actif autorisé par la campagne."),
  contact_id: z
    .number()
    .int()
    .optional()
    .describe(
      "Contact GLOBAL (contact_id, pas cc_id) dont les variables remplissent le template. Défaut : 1er contact de la campagne, sinon un contact d'exemple."
    ),
  variant: z.enum(["A", "B"]).optional().describe("Variante du sujet pour une campagne en A/B test."),
  dry_run: z
    .boolean()
    .optional()
    .describe("true par défaut : rien n'est envoyé, le rendu est renvoyé. false = envoi réel, après accord explicite de l'utilisateur."),
};
type TestEmailArgs = z.infer<z.ZodObject<typeof testEmailShape>>;

export function registerCampaignTools(server: McpServer): void {
  // ---------------------------------------------------------------- lecture

  server.registerTool(
    "list_campaigns",
    {
      title: "Lister les campagnes",
      description:
        "Liste toutes les campagnes avec leurs statistiques : statut (active/paused/archived), nombre de contacts par état, emails envoyés, visites du lien {{link}}, taux de réponse (global et par variante A/B), progression. À utiliser pour avoir une vue d'ensemble avant toute action.",
      inputSchema: {},
      annotations: READ,
    },
    handler(async () => api("GET", "/api/campaigns"))
  );

  server.registerTool(
    "get_campaign",
    {
      title: "Détail d'une campagne",
      description:
        "Renvoie le détail d'une campagne et la liste ordonnée de ses étapes (sujet, corps, wait_days, channel, li_action). À utiliser avant de modifier une campagne (update_campaign attend la séquence complète).",
      inputSchema: { campaign_id: z.number().int().describe("Identifiant de la campagne.") },
      annotations: READ,
    },
    handler(({ campaign_id }: { campaign_id: number }) => api("GET", `/api/campaigns/${campaign_id}`))
  );

  server.registerTool(
    "get_activity",
    {
      title: "Journal d'activité",
      description:
        "Ce qui s'est passé sur une période (défaut 7 jours), toutes campagnes ou une seule : totaux (emails envoyés, réponses, désinscriptions, bounces, invitations et messages LinkedIn, visites du lien hors robots) et liste d'événements du plus récent au plus ancien (type, campagne, contact avec cc_id et contact_id, étape, compte). Le serveur rend au plus 300 événements ; events_limit réduit encore la liste. Dates en ISO 8601 (UTC).",
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
      title: "Aperçu d'un email",
      description:
        "Rend un sujet et un corps avec les variables résolues, sur un vrai contact de la campagne (ou un contact d'exemple), signature du compte incluse. Sans effet de bord. Utile pour vérifier le rendu d'un template avant de créer/modifier une campagne ; pour tester une étape existante telle qu'elle partira, voir send_test_email.",
      inputSchema: {
        subject: z.string().optional().describe("Sujet à prévisualiser."),
        body: z.string().optional().describe("Corps à prévisualiser."),
        account_id: z.number().int().optional().describe("Compte d'envoi pour la signature (défaut : premier actif)."),
        campaign_id: z.number().int().optional().describe("Campagne dont on prend le 1er contact comme exemple."),
        contact_id: z.number().int().optional().describe("Contact global (contact_id) précis à utiliser comme exemple."),
      },
      annotations: READ,
    },
    handler((args: Record<string, unknown>) => api("POST", "/api/preview", { json: args }))
  );

  server.registerTool(
    "send_test_email",
    {
      title: "Email de test d'une étape",
      description:
        "Rend une étape email d'une campagne exactement comme le scheduler (variables du contact, {{sender_name}}, {{link}} d'exemple, {{signature}} ; une relance sans sujet devient « Re: » + sujet de l'étape 1) et l'envoie à l'adresse « to », sujet préfixé [TEST]. Ne touche ni quotas, ni statuts, ni historique. dry_run vaut true par défaut : rien n'est envoyé et le rendu (from, to, subject, body) est renvoyé. Pour envoyer réellement : montre d'abord ce rendu, puis rappelle avec dry_run: false après accord explicite de l'utilisateur. Refusé pour une étape LinkedIn (le corps rendu figure dans l'erreur).",
      inputSchema: testEmailShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    handler(async ({ dry_run, ...rest }: TestEmailArgs) => {
      try {
        return await api("POST", "/api/test-email", { json: { ...rest, dry_run: dry_run ?? true } });
      } catch (err) {
        const rendered = err instanceof ApiError ? (err.data as { rendered_body?: unknown } | null)?.rendered_body : undefined;
        if (typeof rendered === "string") throw new Error(`${err instanceof Error ? err.message : err}\n\nCorps rendu :\n${rendered}`);
        throw err;
      }
    })
  );

  // ---------------------------------------------------------------- écriture

  server.registerTool(
    "create_campaign",
    {
      title: "Créer une campagne",
      description:
        "Crée une campagne avec sa séquence d'étapes. La campagne démarre EN PAUSE ('paused') et sans contact — aucun email n'est envoyé tant que des contacts ne sont pas importés (import_contacts / import_contacts_csv) puis lancés (launch_contacts). La 1re étape email doit avoir un sujet ; chaque étape doit avoir un corps (sauf une invitation LinkedIn dont la note est facultative).",
      inputSchema: {
        name: z.string().describe("Nom de la campagne."),
        steps: z.array(stepSchema).min(1).describe("Séquence ordonnée d'étapes (au moins une)."),
        account_ids: z
          .array(z.number().int())
          .min(1)
          .optional()
          .describe("Comptes d'envoi autorisés (ids de list_accounts). Omis = tous les comptes, y compris les futurs."),
        li_account_ids: z
          .array(z.number().int())
          .min(1)
          .optional()
          .describe("Comptes LinkedIn autorisés (ids de list_linkedin_accounts). Omis = tous les comptes LinkedIn."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handler((args: unknown) => api("POST", "/api/campaigns", { json: args }))
  );

  server.registerTool(
    "update_campaign",
    {
      title: "Modifier une campagne",
      description:
        "Remplace le nom et TOUTE la séquence d'une campagne (y compris en cours). Les étapes sont remplacées intégralement : récupère d'abord la séquence via get_campaign, modifie-la, puis renvoie-la entière. Les contacts gardent leur avancement ; les prochains envois utilisent le nouveau contenu.",
      inputSchema: {
        campaign_id: z.number().int().describe("Identifiant de la campagne."),
        name: z.string().describe("Nom (potentiellement inchangé)."),
        steps: z.array(stepSchema).min(1).describe("Séquence complète qui remplace l'existante."),
        account_ids: z
          .union([z.array(z.number().int()).min(1), z.null()])
          .optional()
          .describe("Comptes d'envoi autorisés (ids de list_accounts). null = tous les comptes ; omis = sélection inchangée."),
        li_account_ids: z
          .union([z.array(z.number().int()).min(1), z.null()])
          .optional()
          .describe(
            "Comptes LinkedIn autorisés (ids de list_linkedin_accounts). null = tous ; omis = inchangé. Un contact déjà abordé reste à son compte."
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handler(
      ({
        campaign_id,
        name,
        steps,
        account_ids,
        li_account_ids,
      }: {
        campaign_id: number;
        name: string;
        steps: unknown;
        account_ids?: number[] | null;
        li_account_ids?: number[] | null;
      }) =>
        api("PUT", `/api/campaigns/${campaign_id}`, {
          json: {
            name,
            steps,
            ...(account_ids === undefined ? {} : { account_ids }),
            ...(li_account_ids === undefined ? {} : { li_account_ids }),
          },
        })
    )
  );

  server.registerTool(
    "delete_campaign",
    {
      title: "Supprimer une campagne",
      description:
        "Supprime DÉFINITIVEMENT une campagne, ses étapes, les inscriptions de contacts et l'historique d'envois associé (cascade). Les contacts globaux sont conservés. Irréversible — à confirmer avec l'utilisateur avant d'appeler.",
      inputSchema: { campaign_id: z.number().int().describe("Identifiant de la campagne à supprimer.") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handler(({ campaign_id }: { campaign_id: number }) => api("DELETE", `/api/campaigns/${campaign_id}`))
  );

  server.registerTool(
    "pause_campaign",
    {
      title: "Mettre en pause une campagne",
      description: "Passe la campagne en statut 'paused' : aucun nouvel envoi tant qu'elle n'est pas reprise.",
      inputSchema: { campaign_id: z.number().int().describe("Identifiant de la campagne.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler(({ campaign_id }: { campaign_id: number }) => api("POST", `/api/campaigns/${campaign_id}/pause`))
  );

  server.registerTool(
    "resume_campaign",
    {
      title: "Reprendre une campagne",
      description:
        "Passe la campagne en statut 'active' : les envois (emails et actions LinkedIn) reprennent pour les contacts en 'pending'/'in_progress', dans la fenêtre d'envoi et selon les quotas. Déclenche de vrais envois : à confirmer avec l'utilisateur.",
      inputSchema: { campaign_id: z.number().int().describe("Identifiant de la campagne.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    handler(({ campaign_id }: { campaign_id: number }) => api("POST", `/api/campaigns/${campaign_id}/resume`))
  );

  server.registerTool(
    "archive_campaign",
    {
      title: "Archiver une campagne",
      description:
        "Passe la campagne en statut 'archived' : elle reste consultable (séquence, contacts, statistiques) et rangée à part dans l'app, mais n'envoie plus rien et ne peut être ni reprise ni relancée tant qu'elle est archivée. Rien n'est supprimé. À préférer à delete_campaign pour ranger une campagne terminée.",
      inputSchema: { campaign_id: z.number().int().describe("Identifiant de la campagne.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler(({ campaign_id }: { campaign_id: number }) => api("POST", `/api/campaigns/${campaign_id}/archive`))
  );

  server.registerTool(
    "unarchive_campaign",
    {
      title: "Désarchiver une campagne",
      description: "Sort la campagne des archives : elle revient en statut 'paused', sans aucun envoi (resume_campaign pour la reprendre).",
      inputSchema: { campaign_id: z.number().int().describe("Identifiant de la campagne.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler(({ campaign_id }: { campaign_id: number }) => api("POST", `/api/campaigns/${campaign_id}/unarchive`))
  );
}
