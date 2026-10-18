#!/usr/bin/env bash
#
# One-shot setup for Sequence Mail: configures and starts Docker + Caddy
# (automatic HTTPS). Idempotent: safe to re-run.
#
# Usage:  ./setup.sh        (interactive: two questions, Enter = default)
#         DOMAIN=go.example.com DASHBOARD_PASSWORD=secret ./setup.sh   (non-interactive)
#
# No domain: served on <ip>.sslip.io (with HTTPS).
# No password: one is generated and printed at the end.
#
set -euo pipefail
cd "$(dirname "$0")"

err() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
ok()  { printf '\033[32m%s\033[0m\n' "$*"; }

# Read answers from the terminal, even when the script comes through `curl | bash`
ask() { # ask VARIABLE "question" [-s]
  local __v="$1" __q="$2" __flag="${3:-}" __ans=""
  if [[ -r /dev/tty ]]; then
    # shellcheck disable=SC2086,SC2229 # $__flag is empty or -s: must stay unquoted
    read -r $__flag -p "$__q" __ans </dev/tty || true
    [[ "$__flag" == "-s" ]] && echo
  fi
  printf -v "$__v" '%s' "$__ans"
}

# --- Prerequisite: Docker running ---
if ! command -v docker >/dev/null 2>&1; then
  err "Docker is required. On Linux: curl -fsSL https://get.docker.com | sh"
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  err "The Docker daemon is not running. Start Docker, then re-run ./setup.sh."
  exit 1
fi

# --- 1. .env from the template (never overwrites an existing one) ---
if [[ ! -f .env ]]; then
  cp .env.example .env
  ok "→ .env created from .env.example"
else
  ok "→ .env already exists (kept)"
fi

# --- 2. Public domain (default <ip>.sslip.io) ---
DOMAIN="${DOMAIN:-}"
[[ -n "$DOMAIN" ]] || ask DOMAIN "Domain pointing to this server (Enter = none, use <ip>.sslip.io): "
DOMAIN="${DOMAIN// /}"
DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN%/}"
if [[ -z "$DOMAIN" ]]; then
  IP="$(curl -fsS4 --max-time 10 https://api.ipify.org || true)"
  [[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { err "Could not detect the public IP: re-run with DOMAIN=…"; exit 1; }
  DOMAIN="${IP//./-}.sslip.io"
fi

# --- 3. Dashboard password (generated if empty) ---
DASHBOARD_PASSWORD="${DASHBOARD_PASSWORD:-}"
[[ -n "$DASHBOARD_PASSWORD" ]] || ask DASHBOARD_PASSWORD "Dashboard password (Enter = generate one): " -s
GENERATED=0
if [[ -z "$DASHBOARD_PASSWORD" ]]; then
  DASHBOARD_PASSWORD="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20 || true)"
  GENERATED=1
fi

# --- 4. bcrypt hash via the Caddy image ---
echo "→ generating the bcrypt hash…"
CADDY_HASH="$(docker run --rm caddy:2 caddy hash-password --plaintext "$DASHBOARD_PASSWORD")"
[[ -n "$CADDY_HASH" ]] || { err "Failed to generate the password hash."; exit 1; }

# --- 5. Render the Caddyfile from the template ---
# "|" delimiter: absent from bcrypt and domain names, so no escaping needed.
sed -e "s|__DOMAIN__|${DOMAIN}|g" -e "s|__CADDY_HASH__|${CADDY_HASH}|g" \
  Caddyfile.template > Caddyfile
ok "→ Caddyfile generated (${DOMAIN})"

# --- 6. Write the public domain into .env (BASE_URL / VISIT_BASE_URL) ---
set_env() { # set_env KEY VALUE: replace the line if present, else append it
  local key="$1" val="$2"
  if grep -q "^${key}=" .env; then
    sed -i.bak "s|^${key}=.*|${key}=${val}|" .env && rm -f .env.bak
  else
    printf '%s=%s\n' "$key" "$val" >> .env
  fi
}
set_env BASE_URL "https://${DOMAIN}"
set_env VISIT_BASE_URL "https://${DOMAIN}"

# --- 7. Start (prebuilt image; local build only if it can't be pulled) ---
echo "→ starting…"
docker compose pull --ignore-pull-failures --quiet
docker compose up -d

# localhost: Caddy uses its internal CA, so skip certificate verification there.
CURL_TLS=()
[[ "$DOMAIN" == localhost || "$DOMAIN" == *.localhost ]] && CURL_TLS=(-k)

echo "→ waiting for the HTTPS certificate (up to 2 min)…"
CODE=000
for _ in $(seq 1 40); do
  CODE="$(curl -s ${CURL_TLS[@]+"${CURL_TLS[@]}"} -o /dev/null -w '%{http_code}' --max-time 5 "https://${DOMAIN}/" || true)"
  [[ "$CODE" == 401 || "$CODE" == 200 ]] && break
  sleep 3
done

echo
if [[ "$CODE" == 401 || "$CODE" == 200 ]]; then
  ok "✅ Sequence Mail is live: https://${DOMAIN}"
else
  err "The instance is running, but https://${DOMAIN} is not responding yet."
  err "Check DNS (A ${DOMAIN} → server IP) and ports 80/443, then: docker compose logs caddy"
fi
cat <<MSG

  Username: admin
  Password: $([[ $GENERATED == 1 ]] && echo "$DASHBOARD_PASSWORD   (generated, keep it safe)" || echo "the one you chose")

Last step, in Settings: paste your Google OAuth credentials
(the page gives the links and the redirect URI https://${DOMAIN}/auth/google/callback).

Update:  docker compose pull && docker compose up -d
MSG
