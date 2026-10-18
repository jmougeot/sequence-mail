#!/usr/bin/env bash
#
# Installation de Sequence Mail sur un serveur Linux neuf, en une commande :
#
#   curl -fsSL https://raw.githubusercontent.com/jmougeot/sequence-mail/main/install.sh | sudo bash
#
# Installe Docker si besoin, télécharge Sequence Mail dans /opt/sequence-mail puis
# lance ./setup.sh (domaine facultatif, mot de passe généré, HTTPS automatique).
# DOMAIN=… et DASHBOARD_PASSWORD=… évitent les questions.
#
set -euo pipefail

REPO="jmougeot/sequence-mail"
DIR="${SEQUENCE_DIR:-/opt/sequence-mail}"

[[ $(id -u) == 0 ]] || { echo "À lancer en root (… | sudo bash)." >&2; exit 1; }

if ! command -v docker >/dev/null 2>&1; then
  echo "→ installation de Docker…"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null 2>&1 || true

# Sources (sans écraser .env, Caddyfile ni la base d'une installation existante)
echo "→ téléchargement dans ${DIR}…"
mkdir -p "$DIR"
curl -fsSL "https://github.com/${REPO}/archive/refs/heads/main.tar.gz" | tar -xz -C "$DIR" --strip-components=1

exec env DOMAIN="${DOMAIN:-}" DASHBOARD_PASSWORD="${DASHBOARD_PASSWORD:-}" bash "$DIR/setup.sh"
