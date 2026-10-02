/**
 * Comptes d'envoi Google : liste, connexion (lien OAuth), réglages ; paramètres de l'app.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, PUBLIC_URL } from "../api.js";
import { handler, READ } from "./common.js";

/** Hôte joignable seulement depuis un réseau interne (ex. http://sequence-app:3000) ? */
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
      title: "Lister les comptes d'envoi",
      description:
        "Liste les comptes Google connectés : id, email, nom d'expéditeur, signature, quota quotidien, quota effectif du jour (warm-up appliqué), envois déjà faits aujourd'hui, actif/inactif, warm-up on/off. Pour en ajouter un : connect_google_account.",
      inputSchema: {},
      annotations: READ,
    },
    handler(async () => api("GET", "/api/accounts"))
  );

  server.registerTool(
    "connect_google_account",
    {
      title: "Connecter un compte Google",
      description:
        "Donne le lien OAuth à ouvrir dans un navigateur pour connecter (ou reconnecter, s'il a expiré) un compte d'envoi Google Workspace, avec la marche à suivre. Le clic d'autorisation Google se fait forcément hors de Claude, par l'utilisateur. N'a aucun effet tant que le lien n'est pas ouvert ; ensuite list_accounts montre le compte.",
      inputSchema: {},
      annotations: READ,
    },
    handler(async () => {
      const url = `${PUBLIC_URL}/auth/google`;
      let googleConfigured: boolean | undefined;
      try {
        googleConfigured = ((await api("GET", "/api/settings")) as { google_configured?: boolean })?.google_configured;
      } catch {
        // app injoignable : on donne quand même le lien
      }
      const lines = [
        `Lien de connexion Google : ${url}`,
        "",
        "Marche à suivre (dans le navigateur de l'utilisateur) :",
        "1. Ouvrir le lien ci-dessus.",
        "2. Si une fenêtre d'identification apparaît, saisir l'utilisateur et le mot de passe du dashboard Sequence Mail.",
        "3. Choisir le compte Google Workspace qui enverra les emails.",
        "4. Accepter les autorisations demandées (envoyer des emails, lire Gmail pour détecter les réponses, adresse email). Le navigateur revient sur la page Réglages de l'app, compte connecté.",
        "5. Revenir ici : list_accounts affiche le nouveau compte (id, quota, warm-up).",
        "",
        "- Un compte par passage : recommencer pour chaque adresse d'envoi.",
        "- Le même lien reconnecte un compte expiré ou révoqué (choisir la même adresse) : ses réglages sont conservés et il est réactivé.",
        "- Un nouveau compte démarre avec le warm-up (quota quotidien qui monte progressivement) ; quota, nom d'expéditeur et signature se règlent avec update_account.",
      ];
      if (googleConfigured === false) {
        lines.push(
          "",
          "ATTENTION : l'app n'a pas d'identifiants OAuth Google configurés (GOOGLE_CLIENT_ID…) : le lien échouera tant que ce n'est pas réglé côté serveur."
        );
      }
      if (looksInternal(PUBLIC_URL)) {
        lines.push(
          "",
          `ATTENTION : ${PUBLIC_URL} ressemble à une adresse interne, injoignable depuis un navigateur. Utiliser l'URL publique de l'app (variable SEQUENCE_MAIL_PUBLIC_URL du MCP).`
        );
      }
      return lines.join("\n");
    })
  );

  server.registerTool(
    "update_account",
    {
      title: "Modifier un compte d'envoi",
      description:
        "Met à jour un compte Google connecté : quota quotidien, actif/inactif, nom d'expéditeur, signature, warm-up on/off. Seuls les champs fournis sont modifiés.",
      inputSchema: {
        account_id: z.number().int().describe("Identifiant du compte (list_accounts)."),
        daily_limit: z.number().int().optional().describe("Quota d'envoi quotidien."),
        active: z.boolean().optional().describe("Activer/désactiver le compte pour les envois."),
        from_name: z.string().optional().describe("Nom affiché dans le champ « De »."),
        signature: z.string().optional().describe("Signature (insérée via {{signature}})."),
        warmup: z.boolean().optional().describe("Activer la montée en charge progressive."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler(({ account_id, ...body }: { account_id: number } & Record<string, unknown>) =>
      api("PATCH", `/api/accounts/${account_id}`, { json: body })
    )
  );

  server.registerTool(
    "delete_google_account",
    {
      title: "Supprimer un compte d'envoi",
      description:
        "Supprime DÉFINITIVEMENT un compte Google, qui doit être désactivé au préalable (update_account active: false). Efface aussi son historique d'envois (le compteur « emails envoyés » des campagnes baisse ; statuts et taux de réponse inchangés), arrête ses contacts encore en séquence (leurs relances ne peuvent partir que de lui), détache son fil Gmail et le retire des sélections de comptes des campagnes (une sélection vidée repasse à « tous les comptes »). Irréversible : annoncer ces effets (nombre d'envois et de contacts, via list_campaign_contacts) et obtenir l'accord explicite de l'utilisateur avant d'appeler.",
      inputSchema: { account_id: z.number().int().describe("Identifiant du compte (list_accounts).") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handler(({ account_id }: { account_id: number }) => api("DELETE", `/api/accounts/${account_id}`))
  );

  server.registerTool(
    "get_settings",
    {
      title: "Paramètres de l'app",
      description:
        "Paramètres effectifs (lecture seule, issus du .env) : réglages de délivrabilité (fenêtre d'envoi, quotas, délais, warm-up), si Google et Attio sont configurés.",
      inputSchema: {},
      annotations: READ,
    },
    handler(async () => api("GET", "/api/settings"))
  );
}
