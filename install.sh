#!/usr/bin/env bash
#
# One-command install of Sequence Mail on a fresh Linux server:
#
#   curl -fsSL https://raw.githubusercontent.com/jmougeot/sequence-mail/main/install.sh | sudo bash
#
# Installs Docker if needed, downloads Sequence Mail into /opt/sequence-mail, then
# runs ./setup.sh (optional domain, generated password, automatic HTTPS).
# Pass DOMAIN=… and DASHBOARD_PASSWORD=… to skip the questions.
#
set -euo pipefail

REPO="jmougeot/sequence-mail"
DIR="${SEQUENCE_DIR:-/opt/sequence-mail}"

[[ $(id -u) == 0 ]] || { echo "Run as root (… | sudo bash)." >&2; exit 1; }

if ! command -v docker >/dev/null 2>&1; then
  echo "→ installing Docker…"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null 2>&1 || true

# Sources only: an existing install keeps its .env, Caddyfile and database
echo "→ downloading into ${DIR}…"
mkdir -p "$DIR"
curl -fsSL "https://github.com/${REPO}/archive/refs/heads/main.tar.gz" | tar -xz -C "$DIR" --strip-components=1

exec env DOMAIN="${DOMAIN:-}" DASHBOARD_PASSWORD="${DASHBOARD_PASSWORD:-}" bash "$DIR/setup.sh"
