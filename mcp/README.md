# Sequence Mail — serveur MCP

Expose Sequence Mail (campagnes, contacts, réponses, comptes Google et LinkedIn)
comme **tools MCP**, utilisables depuis Claude Desktop, Claude Code ou tout client
MCP. Lecture **et** écriture : tout se pilote depuis Claude, sans l'interface web
(connexion des comptes, campagnes, import, export, réponses et messages), à deux
gestes près faits par l'utilisateur (voir « Hors Claude »).

Le serveur ne touche pas la base SQLite : il appelle l'**API HTTP** de l'app
(transport stdio côté MCP, ou HTTP pour un agent distant). Il marche donc aussi bien contre une instance locale
(`http://localhost:3000`) que contre la prod déployée (`https://go.…`).

## Installation

```bash
cd Sequence-mail/mcp
npm install
npm run build      # compile vers dist/
```

## Configuration

| Variable | Rôle | Défaut |
|---|---|---|
| `SEQUENCE_MAIL_BASE_URL` | URL de l'app Sequence Mail | `http://localhost:3000` |
| `SEQUENCE_MAIL_BASIC_AUTH` | `user:pass` si l'app est protégée par basic auth (prod derrière Caddy) | — |
| `SEQUENCE_MAIL_PUBLIC_URL` | URL de l'app vue d'un navigateur, pour les liens donnés à l'utilisateur (OAuth Google, adresse du serveur dans l'extension). À renseigner quand le MCP parle à l'app par un réseau interne (conteneur `mcp` : `http://sequence-app:3000`) | `SEQUENCE_MAIL_BASE_URL` |
| `MCP_HTTP_PORT` | Sert le MCP en HTTP (agent distant) au lieu de stdio. Dans ce mode, `csv_path` et `file_path` sont refusés (pas d'accès aux fichiers de l'utilisateur) | — |

> En local, l'app n'a pas d'auth → seule `SEQUENCE_MAIL_BASE_URL` suffit (et le
> défaut convient si l'app tourne sur le port 3000). Pour viser la prod, renseigne
> l'URL publique **et** `SEQUENCE_MAIL_BASIC_AUTH` (le même `admin:motdepasse` que
> le dashboard). **Prérequis : l'app Sequence Mail doit tourner** — le MCP est un
> adaptateur, pas un serveur autonome.

## Brancher le serveur

### Claude Code

```bash
# chemin absolu vers le build
claude mcp add sequence-mail -- node /chemin/vers/Sequence-mail/mcp/dist/index.js

# en visant la prod :
claude mcp add sequence-mail \
  -e SEQUENCE_MAIL_BASE_URL=https://go.votre-domaine.com \
  -e SEQUENCE_MAIL_BASIC_AUTH=admin:motdepasse \
  -- node /chemin/vers/Sequence-mail/mcp/dist/index.js
```

### Claude Desktop

Dans `claude_desktop_config.json` (Réglages → Developer → Edit Config) :

```json
{
  "mcpServers": {
    "sequence-mail": {
      "command": "node",
      "args": ["/chemin/absolu/vers/Sequence-mail/mcp/dist/index.js"],
      "env": {
        "SEQUENCE_MAIL_BASE_URL": "http://localhost:3000"
      }
    }
  }
}
```

Redémarre le client : les tools `sequence-mail` apparaissent.

## Tools exposés

Le serveur envoie aussi des **instructions** à l'initialisation (`src/instructions.ts`) :
flux d'une campagne et des réponses, identifiants, règles de sécurité. Tout client
MCP les charge.

**Campagnes** — `list_campaigns`, `get_campaign`, `get_activity` (journal : totaux et
événements sur N jours), `preview_email`, `send_test_email` (email `[TEST]` d'une étape,
`dry_run` par défaut), `create_campaign`, `update_campaign`, `delete_campaign`,
`pause_campaign`, `resume_campaign`, `archive_campaign`, `unarchive_campaign`.

**Contacts** — `list_campaign_contacts` (filtres `status`/`search`, paginé `limit`/`offset`,
renvoie `{ total, returned, offset, contacts }`), `search_contacts` (toutes campagnes),
`export_campaign_contacts` (CSV en texte ou fichier local), `import_contacts` (liste
d'objets JSON), `import_contacts_csv` (texte `csv` ou fichier local `csv_path`),
`attio_sync`, `launch_contacts` (`cc_ids`, ou `all_held` + `limit`), `stop_contacts`,
`set_contacts_status`, `remove_contacts`, `update_contact`.

**Réponses** — `list_replies` (boîte de réception unifiée, texte des réponses en option),
`get_conversation` (fil complet d'un contact), `reply_to_contact` (réponse dans le fil
Gmail, `dry_run` par défaut).

**Comptes Google** — `list_accounts`, `connect_google_account` (lien OAuth + marche à
suivre), `update_account`, `delete_google_account` (compte désactivé au préalable ; efface
son historique d'envois), `get_settings`.

**LinkedIn** — `linkedin_status`, `linkedin_toggle`, `list_linkedin_accounts`,
`create_linkedin_account` (jeton en clair + étapes de liaison de l'extension),
`update_linkedin_account` (nom, actif, mode extension/serveur, proxy, plafonds,
warm-up), `rotate_linkedin_token`, `delete_linkedin_account`.

### À savoir

- **Aucun envoi à la création.** Une campagne naît `paused`, sans contact. Le flux
  complet : `create_campaign` → `import_contacts` / `import_contacts_csv` (contacts en
  `held`) → `preview_email` / `send_test_email` → `launch_contacts` (passe en `pending`
  et réactive la campagne) → `resume_campaign` si elle est en pause. Les envois
  respectent ensuite la fenêtre d'envoi, les quotas et le warm-up de l'app.
- **Réponses** : `list_replies` → `get_conversation` → `reply_to_contact`.
- **Deux identifiants distincts** :
  - `contact_id` = le contact **global** → `update_contact`, `preview_email`,
    `send_test_email` ;
  - `cc_id` = l'**inscription à une campagne** → `launch_contacts`, `stop_contacts`,
    `set_contacts_status`, `remove_contacts`, `get_conversation`, `reply_to_contact`.
- **Envois réels** : `reply_to_contact` et `send_test_email` sont en `dry_run: true`
  par défaut (rendu sans envoi) ; il faut passer `dry_run: false` pour envoyer. Ils sont
  annotés `openWorldHint`, comme `launch_contacts` et `resume_campaign`.
- Les tools destructifs (`delete_campaign`, `delete_google_account`, `delete_linkedin_account`,
  `rotate_linkedin_token`, `remove_contacts`, `set_contacts_status`, `stop_contacts`,
  `update_campaign`) sont annotés `destructiveHint` — les clients peuvent demander
  confirmation avant exécution.
- **Fichiers locaux** (`csv_path`, `file_path`) : lus/écrits par le process MCP, donc
  seulement quand il tourne en local (stdio). Un CSV en Windows-1252 (export Excel
  français) est reconnu ; l'export écrit de l'UTF-8 avec BOM (lisible par Excel),
  séparateur `;` en option.
- Les tools ajoutés (`list_replies`, `get_conversation`, `search_contacts`,
  `get_activity`, comptes LinkedIn) rendent les dates en **ISO 8601 UTC** ; les tools
  historiques gardent les epoch ms de l'API.

### Hors Claude

- **Compte Google** : un clic d'autorisation OAuth par compte, sur le lien donné par
  `connect_google_account` (le même lien reconnecte un compte expiré).
- **Compte LinkedIn** : installer l'extension Chrome (`Sequence-mail/extension`) une fois
  par compte et y coller le jeton donné par `create_linkedin_account`.

## Développement

```bash
npm run dev        # tsx, sans build
npm run typecheck  # tsc --noEmit
```

Organisation : `src/index.ts` (construction du serveur et transports stdio/HTTP),
`src/api.ts` (client HTTP de l'app), `src/instructions.ts` (guide envoyé aux clients),
`src/lib.ts` (fonctions pures : CSV, filtres, dates), `src/tools/*.ts` (un fichier
par domaine : campagnes, contacts, réponses, comptes Google, LinkedIn).

> Le code de prospection B2B (recherche d'entreprises, enrichissement d'emails)
> n'est **pas** dans Sequence Mail mais dans le projet `Enrichissement/` (port 3100).
> Ce serveur MCP ne couvre donc que les campagnes / contacts / réponses / comptes.
