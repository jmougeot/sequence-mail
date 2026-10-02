/**
 * Canal LinkedIn : état général, interrupteur, et comptes LinkedIn (création
 * avec jeton d'extension, réglages, régénération du jeton, suppression).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, ApiError, PUBLIC_URL } from "../api.js";
import { isoDates } from "../lib.js";
import { handler, READ } from "./common.js";

const liAccountId = z.number().int().describe("Identifiant du compte LinkedIn (list_linkedin_accounts).");

const updateShape = {
  li_account_id: liAccountId,
  name: z.string().min(1).optional().describe("Nouveau nom du compte."),
  active: z
    .boolean()
    .optional()
    .describe("false = le compte n'agit plus ; true = le réactive (et lève une pause de sécurité en cours)."),
  mode: z
    .enum(["extension", "server"])
    .optional()
    .describe(
      "Qui exécute : « extension » (Chrome de l'utilisateur) ou « server » (navigateur serveur, nécessite une session transmise par l'extension : session.stored). Préférer le bouton « Confier ce compte au serveur » de l'extension, qui transmet la session et bascule le mode."
    ),
  proxy: z
    .union([z.string(), z.null()])
    .optional()
    .describe("Proxy du mode serveur : http://utilisateur:motdepasse@hôte:port (ou https://, socks5://). null ou \"\" le retire."),
  invites_per_day: z
    .union([z.number().int().min(0), z.null()])
    .optional()
    .describe("Plafond d'invitations par jour (avant warm-up). null = défaut de l'app."),
  messages_per_day: z
    .union([z.number().int().min(0), z.null()])
    .optional()
    .describe("Plafond de messages par jour (avant warm-up). null = défaut de l'app."),
  restart_warmup: z.boolean().optional().describe("true = recommence la montée en charge progressive à partir d'aujourd'hui."),
};
type UpdateArgs = z.infer<z.ZodObject<typeof updateShape>>;

/** Étapes pour relier un compte LinkedIn à l'extension Chrome avec son jeton. */
function extensionSteps(token: string): string[] {
  return [
    `Jeton du compte : ${token} — affiché une seule fois (perdu → rotate_linkedin_token).`,
    "1. Dans Chrome, se connecter à LinkedIn avec le profil de ce compte (plusieurs comptes LinkedIn = un profil Chrome par compte).",
    "2. Installer l'extension (une fois par profil Chrome) : chrome://extensions → activer le Mode développeur → « Charger l'extension non empaquetée » → dossier Sequence-mail/extension. L'épingler.",
    "3. Ouvrir le popup de l'extension (si seule la vue « Azerit » s'affiche, cliquer « Advanced settings »), puis :",
    `   - Adresse du serveur : ${PUBLIC_URL} → OK ;`,
    "   - Mot de passe d'accès (prod protégée) : utilisateur et mot de passe du dashboard → OK (laisser vide en local) ;",
    "   - Jeton du compte LinkedIn : le jeton ci-dessus → OK.",
    "4. Laisser un onglet Chrome ouvert : au prochain tick (~1 min), list_linkedin_accounts montre connected: true et le profil LinkedIn détecté (member).",
    "5. Facultatif : bouton « Confier ce compte au serveur » du popup → mode serveur, le serveur agit sans que ce Chrome reste ouvert (ne pas se déconnecter de LinkedIn ensuite). Nécessite server_mode_ready: true dans linkedin_status.",
    "Ensuite : la campagne doit autoriser ce compte (li_account_ids de create_campaign / update_campaign ; omis = tous les comptes). Quotas et proxy : update_linkedin_account.",
  ];
}

export function registerLinkedinTools(server: McpServer): void {
  server.registerTool(
    "linkedin_status",
    {
      title: "État du canal LinkedIn",
      description:
        "État de l'automatisation LinkedIn, multi-comptes : interrupteur général, totaux du jour, file, server_mode_ready (mode serveur disponible), et détail par compte LinkedIn (accounts : id, nom, extension connectée, quotas du jour, pause de sécurité, contacts attachés).",
      inputSchema: {},
      annotations: READ,
    },
    handler(async () => api("GET", "/api/li/status"))
  );

  server.registerTool(
    "linkedin_toggle",
    {
      title: "Activer/désactiver le canal LinkedIn",
      description:
        "Active ou met en pause l'automatisation LinkedIn de TOUS les comptes (interrupteur général). Renvoie le nouvel état. Pour un seul compte : update_linkedin_account { active }.",
      inputSchema: { enabled: z.boolean().describe("true pour activer, false pour mettre en pause.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler(({ enabled }: { enabled: boolean }) => api("POST", "/api/li/toggle", { json: { enabled } }))
  );

  server.registerTool(
    "list_linkedin_accounts",
    {
      title: "Comptes LinkedIn",
      description:
        "Liste les comptes LinkedIn : id (pour li_account_ids des campagnes et les tools *_linkedin_account), nom, profil LinkedIn détecté (member), actif, mode (extension|server), connected (exécutant vu il y a moins de 2 min), session (mode serveur : état, stockée ou non), proxy, plafonds et envois du jour, file, contacts attachés. owner_ref non nul = compte d'un client Azerit (géré depuis Azerit). Dates en ISO 8601 (UTC).",
      inputSchema: {},
      annotations: READ,
    },
    handler(async () => isoDates(await api("GET", "/api/li/accounts")))
  );

  server.registerTool(
    "create_linkedin_account",
    {
      title: "Créer un compte LinkedIn",
      description:
        "Crée un compte LinkedIn d'envoi et renvoie son jeton EN CLAIR (affiché une seule fois) avec les étapes pour le relier : installer l'extension Chrome une fois et y coller le jeton (geste fait par l'utilisateur, hors de Claude). Démarre avec le warm-up et les plafonds par défaut. Donne le jeton et les étapes à l'utilisateur.",
      inputSchema: {
        name: z.string().min(1).describe("Nom du compte (ex. le nom de la personne dont c'est le profil LinkedIn)."),
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
      title: "Modifier un compte LinkedIn",
      description:
        "Modifie un compte LinkedIn : nom, actif/inactif, mode (extension|server), proxy, plafonds quotidiens d'invitations et de messages (null = défaut de l'app), redémarrage du warm-up. Seuls les champs fournis changent. Renvoie l'état du compte.",
      inputSchema: updateShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler(async ({ li_account_id, ...fields }: UpdateArgs) => {
      const body = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      if (!Object.keys(body).length) throw new Error("Aucun champ à modifier.");
      return isoDates(await api("PATCH", `/api/li/accounts/${li_account_id}`, { json: body }));
    })
  );

  server.registerTool(
    "rotate_linkedin_token",
    {
      title: "Régénérer le jeton LinkedIn",
      description:
        "Remplace le jeton d'extension d'un compte LinkedIn (jeton perdu ou divulgué). L'ancien cesse IMMÉDIATEMENT de marcher : l'extension qui l'utilise est refusée jusqu'à ce que le nouveau jeton soit collé dans son popup. Un compte en mode serveur continue d'agir (le serveur n'utilise pas ce jeton). À confirmer avec l'utilisateur.",
      inputSchema: { li_account_id: liAccountId },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    handler(async ({ li_account_id }: { li_account_id: number }) => {
      const { token } = (await api("POST", `/api/li/accounts/${li_account_id}/token`)) as { token: string };
      return {
        token,
        next_steps:
          "Affiché une seule fois. Dans le popup de l'extension de ce compte : champ « Jeton du compte LinkedIn » → coller le nouveau jeton → OK.",
      };
    })
  );

  server.registerTool(
    "delete_linkedin_account",
    {
      title: "Supprimer un compte LinkedIn",
      description:
        "Supprime DÉFINITIVEMENT un compte LinkedIn qui n'a encore rien fait. L'app refuse si le compte a déjà agi ou a des contacts (leurs messages ne peuvent partir que de lui) : le désactiver alors avec update_linkedin_account { active: false }. À confirmer avec l'utilisateur.",
      inputSchema: { li_account_id: liAccountId },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handler(async ({ li_account_id }: { li_account_id: number }) => {
      try {
        return await api("DELETE", `/api/li/accounts/${li_account_id}`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          throw new Error(
            `${err.message}\nConseil : désactive-le plutôt avec update_linkedin_account { li_account_id: ${li_account_id}, active: false } — ses contacts restent attachés à ce compte.`
          );
        }
        throw err;
      }
    })
  );
}
