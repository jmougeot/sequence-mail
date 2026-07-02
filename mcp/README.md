# Sequence Mail — serveur MCP

Expose Sequence Mail (campagnes, contacts, comptes d'envoi) comme **tools MCP**,
utilisables depuis Claude Desktop, Claude Code ou tout client MCP. Lecture **et**
écriture.

Le serveur ne touche pas la base SQLite : il appelle l'**API HTTP** de l'app
(transport stdio côté MCP). Il marche donc aussi bien contre une instance locale
(`http://localhost:3000`) que contre la prod déployée (`https://go.…`).

## Installation

```bash
cd Sequence-mail/mcp
npm install
npm run build      # compile vers dist/
```

## Configuration

Deux variables d'environnement :

| Variable | Rôle | Défaut |
|---|---|---|
| `SEQUENCE_MAIL_BASE_URL` | URL de l'app Sequence Mail | `http://localhost:3000` |
| `SEQUENCE_MAIL_BASIC_AUTH` | `user:pass` si l'app est protégée par basic auth (prod derrière Caddy) | — |

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

**Lecture** — `list_campaigns`, `get_campaign`, `list_campaign_contacts`,
`list_accounts`, `get_settings`, `preview_email`, `linkedin_status`.

**Écriture** — `create_campaign`, `update_campaign`, `delete_campaign`,
`pause_campaign`, `resume_campaign`, `import_contacts_csv`, `attio_sync`,
`launch_contacts`, `stop_contacts`, `set_contacts_status`, `remove_contacts`,
`update_contact`, `update_account`, `linkedin_toggle`.

### À savoir

- **Aucun envoi à la création.** Une campagne naît `paused`, sans contact. Le flux
  complet : `create_campaign` → `import_contacts_csv` (contacts en `held`) →
  `launch_contacts` (passe en `pending`) → `resume_campaign`. Les envois respectent
  ensuite la fenêtre d'envoi, les quotas et le warm-up de l'app.
- **Deux identifiants distincts** dans `list_campaign_contacts` :
  - `contact_id` = le contact **global** → utilisé par `update_contact` ;
  - `cc_id` = l'**inscription à la campagne** → utilisé par `launch_contacts`,
    `stop_contacts`, `set_contacts_status`, `remove_contacts`.
- Les tools destructifs (`delete_campaign`, `remove_contacts`, `set_contacts_status`,
  `stop_contacts`, `update_campaign`) sont annotés `destructiveHint` côté MCP — les
  clients peuvent demander confirmation avant exécution.

## Développement

```bash
npm run dev        # tsx, sans build
npm run typecheck  # tsc --noEmit
```

> Le code de prospection B2B (recherche d'entreprises, enrichissement d'emails)
> n'est **pas** dans Sequence Mail mais dans le projet `Enrichissement/` (port 3100).
> Ce serveur MCP ne couvre donc que les campagnes / contacts / comptes.
