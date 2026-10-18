# Sequence Mail

*[Français](README.fr.md)*

**Self-hosted cold outreach: multi-account Gmail sequences + LinkedIn steps, on your own server.**
A free, open-source alternative to lemlist / Instantly-style tools. Your data stays in one SQLite file on your server, and emails go out through the Gmail API of your own Google accounts.

- **Sequences**: an initial email plus follow-ups (wait N days). Follow-ups can stay in the same Gmail thread (`Re:`), and you can A/B test subject lines.
- **Multi-channel**: mix email steps with LinkedIn steps (connection request, message) in the same sequence.
- **Reply detection**: inboxes are checked every ~4–7 min. A reply stops the sequence for that contact. Opt-outs ("not interested", "unsubscribe"…) are blacklisted, bounces are detected from server signals only, and auto-replies (OOO) postpone the next step instead of stopping it.
- **Deliverability**: automatic warm-up (5/day, +5 every week), per-account daily quotas, a sending window, weekdays only, random 90–420 s gaps between sends, MX check on import, plain-text emails and one-click unsubscribe (RFC 8058).
- **Multi-account**: the first email goes from the least-loaded account, and follow-ups from the same account. Each account has its own sender name and signature.
- **Personalized link** `{{link}}`: a unique tracked link per prospect, with security scanners (Safe Links…) filtered out.
- **Drive it from Claude**: an MCP server exposes campaigns, contacts, replies and accounts as tools ([`mcp/`](mcp/README.md)).
- **Import**: CSV (any extra column becomes a template variable) or Attio CRM. Conditional blocks are available: `{{si company}}…{{sinon}}…{{fin}}` (French keywords for *if / else / end*).

> The dashboard UI is in French for now; English is on the roadmap.

## Quick start

**On a server** (any Linux VPS, 1 GB RAM is enough), one command:

```bash
curl -fsSL https://raw.githubusercontent.com/jmougeot/sequence-mail/main/install.sh | sudo bash
```

It installs Docker if needed, pulls the prebuilt image and puts the app online over HTTPS. It asks two questions, and both are optional:
- **domain**: without one, the app is served on `<ip>.sslip.io`. With a domain, first create an `A` record `go.yourdomain.com → server IP` (Cloudflare proxy off);
- **dashboard password**: if left empty, one is generated and printed.

Non-interactive: `curl -fsSL …/install.sh | sudo DOMAIN=go.yourdomain.com DASHBOARD_PASSWORD=… bash`.
To update: `cd /opt/sequence-mail && docker compose pull && docker compose up -d`.

**Locally**, to try it:

```bash
docker run -d --name sequence-mail -p 127.0.0.1:3000:3000 -v sequence-data:/data ghcr.io/jmougeot/sequence-mail
```

Then open http://localhost:3000. Tracked links (`{{link}}`) need a public address, so they only work with the server install.

On a server, the tracked-link route (`/p/`) is public. Everything else sits behind the dashboard password (user `admin`).

### Google setup (the only manual step)

Emails are sent through the Gmail API with **your own** OAuth credentials. The **Paramètres** (Settings) page walks you through the steps and shows the redirect URI to copy:

1. [Enable the Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com) in a Google Cloud project.
2. Set the [Audience](https://console.cloud.google.com/auth/audience): *Internal* if you use Google Workspace, otherwise *External* and then "Publish app". In *Testing* mode, connections expire after 7 days.
3. [Create an OAuth client](https://console.cloud.google.com/auth/clients/create) of type *Web application*, with the redirect URI shown in Settings.
4. Paste the client ID and secret into **Settings**. You can also set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env`, which takes precedence.
5. Click **"+ Connecter un compte Google"** for each sending address.

Tokens are refreshed automatically and stored in the database. If Google revokes access (password change…), the account is disabled cleanly, and reconnecting it brings it back.

### LinkedIn steps (optional)

LinkedIn actions run in **your own LinkedIn session** through a Chrome extension ([`extension/`](extension/README.md)). The server decides when an action may happen. Conservative limits apply: 20 invites and 40 messages per day, working hours only, random 90–240 s gaps, and a long pause on any error or security check.

1. In `chrome://extensions`, turn on Developer mode, click "Load unpacked" and select `extension/`.
2. If you use your own domain, add it to `host_permissions` in `extension/manifest.json`.
3. In the popup's *Advanced settings*, enter your server URL and the dashboard credentials. Then create a LinkedIn account in Settings and paste its token.

> ⚠️ Automating LinkedIn is against LinkedIn's User Agreement and can get an account restricted. Keep the default limits and use at your own risk.

## Configuration

Everything has sensible defaults. The optional settings live in `.env` (see [`.env.example`](.env.example)):

| Variable | Default | |
|---|---|---|
| `DEFAULT_DAILY_LIMIT` | 40 | emails per account per day (also editable per account in the UI) |
| `SEND_WINDOW_START` / `END` / `TZ` | 9 / 18 / Europe/Paris | sending window |
| `WEEKDAYS_ONLY` | true | no sends on weekends |
| `WARMUP_START` / `WARMUP_RAMP` | 5 / 5 | warm-up: starting volume, weekly increase |
| `VISIT_DEST_URL` | — | where `{{link}}` redirects after logging the visit (your website) |
| `LI_INVITES_PER_DAY` / `LI_MESSAGES_PER_DAY` | 20 / 40 | LinkedIn limits |
| `ATTIO_API_KEY` | — | Attio import + stage sync |

## How it works

- **Stack**: Node 22, Express and SQLite (WAL), behind Caddy for automatic HTTPS. A single container plus Caddy.
- **Reliability**: state is updated transactionally after every send, so a restart resumes exactly where it stopped and nothing is sent twice. A failed send is retried 3 times, 1–2 h apart.
- **Scheduling**: follow-ups get 0–4 h of random jitter (no fixed-time sends), with at most 5 sends per tick and random pauses between them.
- **Reply handling** is deliberately conservative. Free-text human replies always stop the sequence. Only machine signals (`Auto-Submitted`, `X-Autoreply`, DSN codes) are treated as auto-replies or bounces.

## Development

```bash
npm install
cp .env.example .env
npm run dev              # http://localhost:3000
```

The HTTP API is used by the dashboard, the MCP server and the extension: see `src/server.ts` and `src/services/*-routes.ts`.

## License

MIT
