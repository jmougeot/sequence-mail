# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private vulnerability reporting instead: go to the **Security** tab of this repository and click **Report a vulnerability**. You'll get a reply as soon as possible, and a fix will be published before details are disclosed.

## Self-hosted instances

Each instance is run by its owner. Its security relies on:

- the dashboard password set for Caddy (choose a strong one),
- keeping the `.env` file secret: it holds OAuth credentials and API keys, so never commit or share it,
- keeping the instance up to date (`docker compose pull && docker compose up -d`).
