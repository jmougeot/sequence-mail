# Sequence Mail — MCP server

Exposes Sequence Mail (campaigns, contacts, replies, Google and LinkedIn accounts) as
**MCP tools** for Claude Desktop, Claude Code or any MCP client. Read **and** write:
everything runs from Claude without the web UI (account connection, campaigns, import,
export, replies), except two steps the user does by hand (see [Outside Claude](#outside-claude)).

The server never touches the SQLite database: it calls the app's **HTTP API** (stdio
transport, or HTTP for a remote agent). It works against a local instance
(`http://localhost:3000`) as well as a deployed one (`https://go.yourdomain.com`).

## Install

```bash
cd Sequence-mail/mcp
npm install
npm run build      # compiles to dist/
```

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `SEQUENCE_MAIL_BASE_URL` | Sequence Mail app URL | `http://localhost:3000` |
| `SEQUENCE_MAIL_BASIC_AUTH` | `user:pass` if the app is behind basic auth (production behind Caddy) | — |
| `SEQUENCE_MAIL_PUBLIC_URL` | App URL as seen from a browser, for links given to the user (Google OAuth, server address in the extension). Set it when the MCP reaches the app over an internal network (`mcp` container: `http://sequence-app:3000`) | `SEQUENCE_MAIL_BASE_URL` |
| `MCP_HTTP_PORT` | Serve MCP over HTTP (remote agent) instead of stdio. In this mode `csv_path` and `file_path` are refused (no access to the user's files) | — |

> Locally the app has no auth, so `SEQUENCE_MAIL_BASE_URL` is enough (the default works
> if the app runs on port 3000). For production, set the public URL **and**
> `SEQUENCE_MAIL_BASIC_AUTH` (the same `admin:password` as the dashboard).
> **The Sequence Mail app must be running**: the MCP is an adapter, not a standalone server.

## Connect it

### Claude Code

```bash
# absolute path to the build
claude mcp add sequence-mail -- node /path/to/Sequence-mail/mcp/dist/index.js

# against production:
claude mcp add sequence-mail \
  -e SEQUENCE_MAIL_BASE_URL=https://go.yourdomain.com \
  -e SEQUENCE_MAIL_BASIC_AUTH=admin:password \
  -- node /path/to/Sequence-mail/mcp/dist/index.js
```

### Claude Desktop

In `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "sequence-mail": {
      "command": "node",
      "args": ["/absolute/path/to/Sequence-mail/mcp/dist/index.js"],
      "env": {
        "SEQUENCE_MAIL_BASE_URL": "http://localhost:3000"
      }
    }
  }
}
```

Restart the client: the `sequence-mail` tools appear.

## Tools

The server also sends **instructions** on initialization (`src/instructions.ts`): safety
rules first, then ids, campaign and reply flows. Every MCP client loads them; keep them
under 2,000 characters (Claude Code truncates at 2,048).

**Campaigns** — `list_campaigns` (archived hidden by default, `include_archived`),
`get_campaign` (with the sequence's variables and their instructions), `list_variable_instructions`,
`set_variable_instruction`, `get_activity` (log: totals and events over N days),
`preview_campaign` (empty variables across all contacts, skipped steps, rendered steps),
`preview_email`, `send_test_email` (`[TEST]` email of a step, `dry_run` by default),
`create_campaign` (with `contacts`: create and import in one call), `update_campaign`
(only provided fields change), `update_step` (a single step), `delete_campaign`,
`pause_campaign`, `resume_campaign`, `archive_campaign`, `unarchive_campaign`.

**Contacts** — `list_campaign_contacts` (`status`/`search` filters, paginated `limit`/`offset`,
returns `{ total, returned, offset, contacts }`), `search_contacts` (all campaigns),
`export_campaign_contacts` (CSV as text or local file), `import_contacts` (list of JSON
objects), `import_contacts_csv` (`csv` text or local file `csv_path`), `attio_sync`,
`launch_contacts` (`cc_ids`, or `all_held` + `limit`; `campaign_id` accepts a list),
`stop_contacts`, `set_contacts_status`, `remove_contacts`, `update_contact`.

**Replies** — `list_replies` (unified inbox, reply text optional), `get_conversation`
(a contact's full thread), `reply_to_contact` (reply in the Gmail thread, `dry_run` by default).

**Google accounts** — `list_accounts`, `connect_google_account` (OAuth link + steps),
`update_account` (`account_id` accepts a list), `delete_google_account` (account must be
deactivated first; erases its send history), `get_settings` (settings, server timezone,
send window open or not, estimated next send).

**LinkedIn** — `linkedin_status`, `linkedin_toggle`, `list_linkedin_accounts`,
`create_linkedin_account` (plain-text token + extension linking steps),
`update_linkedin_account` (name, active, extension/server mode, proxy, caps, warm-up),
`rotate_linkedin_token`, `delete_linkedin_account`.

### Good to know

- **Nothing is sent on creation.** A campaign starts `paused`, its contacts `held`. Full
  flow: `create_campaign` (with contacts, or `import_contacts` / `import_contacts_csv`
  later) → `preview_campaign` → `launch_contacts` (moves to `pending` and reactivates the
  campaign) → `resume_campaign` if paused. Sends then follow the app's send window,
  quotas and warm-up.
- **Compact results.** Single-line JSON without empty fields (`null`, `""`, empty array
  or object): a missing field is empty. `false` and `0` are kept, except `list_campaigns`
  counters and rates and `list_campaign_contacts` visit counters, omitted when 0.
- **Campaign variables.** A custom field belongs to the contact and applies in all its
  campaigns. `campaign_vars` (on `create_campaign`, `import_contacts`,
  `import_contacts_csv`) attaches the named fields to the enrollment instead: `{{hook}}`
  can then differ per campaign for the same contact, and overrides the contact field of
  the same name at send time. `list_campaign_contacts` returns them in `vars`.
- **Conditional blocks.** `{{if variable}}…{{else}}…{{end}}` in a subject or body: the
  first text is sent if the variable is set for the contact, the second otherwise (the
  French `{{si}}…{{sinon}}…{{fin}}` is still accepted). `preview_campaign` only counts an
  empty variable for contacts who will get the text containing it, and flags a block
  left without `{{end}}`.
- **Send window.** Its hours are in server time: `get_settings` gives the timezone
  (`server.timezone`, `utc_offset`), whether the window is open and the earliest next send.
- **Two distinct ids**:
  - `contact_id` = the **global** contact → `update_contact`, `preview_email`, `send_test_email`;
  - `cc_id` = the **enrollment in a campaign** → `launch_contacts`, `stop_contacts`,
    `set_contacts_status`, `remove_contacts`, `get_conversation`, `reply_to_contact`.
- **Real sends**: `reply_to_contact` and `send_test_email` default to `dry_run: true`
  (render without sending); pass `dry_run: false` to send. They are annotated
  `openWorldHint`, like `launch_contacts` and `resume_campaign`.
- Destructive tools (`delete_campaign`, `delete_google_account`, `delete_linkedin_account`,
  `rotate_linkedin_token`, `remove_contacts`, `set_contacts_status`, `stop_contacts`,
  `update_campaign`) are annotated `destructiveHint`, so clients can ask for confirmation.
- **Local files** (`csv_path`, `file_path`) are read/written by the MCP process, so only
  when it runs locally (stdio). Windows-1252 CSVs (French Excel exports) are detected;
  exports are UTF-8 with BOM (Excel-readable), `;` delimiter optional.
- Newer tools (`list_replies`, `get_conversation`, `search_contacts`, `get_activity`,
  LinkedIn accounts) return dates as **ISO 8601 UTC**; older tools keep the API's epoch ms.

### Outside Claude

- **Google account**: one OAuth consent click per account, on the link from
  `connect_google_account` (the same link reconnects an expired account).
- **LinkedIn account**: install the Chrome extension (`Sequence-mail/extension`) once per
  account and paste the token from `create_linkedin_account`.

## Development

```bash
npm run dev        # tsx, no build
npm run typecheck  # tsc --noEmit
```

Layout: `src/index.ts` (server setup, stdio/HTTP transports), `src/api.ts` (app HTTP
client), `src/instructions.ts` (guide sent to clients), `src/lib.ts` (pure functions:
CSV, filters, dates), `src/tools/*.ts` (one file per domain: campaigns, contacts,
replies, Google accounts, LinkedIn).
