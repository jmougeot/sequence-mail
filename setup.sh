#!/usr/bin/env bash
#
# Bootstrap « clé en main » de Sequence Mail : configure puis démarre une instance
# Docker + Caddy (HTTPS automatique). Idempotent : relançable sans casser l'existant.
#
# Usage :  ./setup.sh        (interactif : deux questions, Entrée = valeur par défaut)
#          DOMAIN=go.x.com DASHBOARD_PASSWORD=secret ./setup.sh   (non interactif)
#
# Sans domaine, l'instance est servie sur <ip>.sslip.io (HTTPS compris).
# Sans mot de passe, il est généré et affiché à la fin.
#
set -euo pipefail
cd "$(dirname "$0")"

err() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
ok()  { printf '\033[32m%s\033[0m\n' "$*"; }

# Questions lues sur le terminal, même quand le script arrive par `curl | bash`
ask() { # ask VARIABLE "question" [-s]
  local __v="$1" __q="$2" __flag="${3:-}" __ans=""
  if [[ -r /dev/tty ]]; then
    # shellcheck disable=SC2229
    read -r $__flag -p "$__q" __ans </dev/tty || true
    [[ "$__flag" == "-s" ]] && echo
  fi
  printf -v "$__v" '%s' "$__ans"
}

# --- Pré-requis : Docker en marche ---
if ! command -v docker >/dev/null 2>&1; then
  err "Docker est requis. Sur Linux : curl -fsSL https://get.docker.com | sh"
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  err "Le démon Docker ne tourne pas. Démarre Docker puis relance ./setup.sh."
  exit 1
fi

# --- 1. .env (depuis le modèle, sans écraser un .env existant) ---
if [[ ! -f .env ]]; then
  cp .env.example .env
  ok "→ .env créé depuis .env.example"
else
  ok "→ .env déjà présent (conservé)"
fi

# --- 2. Domaine public (par défaut <ip>.sslip.io) ---
DOMAIN="${DOMAIN:-}"
[[ -n "$DOMAIN" ]] || ask DOMAIN "Domaine pointant vers ce serveur (Entrée = aucun, <ip>.sslip.io) : "
DOMAIN="${DOMAIN// /}"
DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN%/}"
if [[ -z "$DOMAIN" ]]; then
  IP="$(curl -fsS4 --max-time 10 https://api.ipify.org || true)"
  [[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { err "IP publique introuvable : relance avec DOMAIN=…"; exit 1; }
  DOMAIN="${IP//./-}.sslip.io"
fi

# --- 3. Mot de passe du dashboard (généré si vide) ---
DASHBOARD_PASSWORD="${DASHBOARD_PASSWORD:-}"
[[ -n "$DASHBOARD_PASSWORD" ]] || ask DASHBOARD_PASSWORD "Mot de passe du dashboard (Entrée = généré) : " -s
GENERATED=0
if [[ -z "$DASHBOARD_PASSWORD" ]]; then
  DASHBOARD_PASSWORD="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20 || true)"
  GENERATED=1
fi

# --- 4. Hash bcrypt via l'image Caddy ---
echo "→ génération du hash bcrypt…"
CADDY_HASH="$(docker run --rm caddy:2 caddy hash-password --plaintext "$DASHBOARD_PASSWORD")"
[[ -n "$CADDY_HASH" ]] || { err "Échec de la génération du hash."; exit 1; }

# --- 5. Rendu du Caddyfile depuis le modèle ---
# Délimiteur « | » : absent de l'alphabet bcrypt et des noms de domaine, donc le
# hash ($, /, .) et le domaine passent tels quels sans échappement.
sed -e "s|__DOMAIN__|${DOMAIN}|g" -e "s|__CADDY_HASH__|${CADDY_HASH}|g" \
  Caddyfile.template > Caddyfile
ok "→ Caddyfile généré (${DOMAIN})"

# --- 6. Injecter le domaine public dans .env (BASE_URL / VISIT_BASE_URL) ---
set_env() { # set_env CLE VALEUR : remplace la ligne si présente, sinon l'ajoute
  local key="$1" val="$2"
  if grep -q "^${key}=" .env; then
    sed -i.bak "s|^${key}=.*|${key}=${val}|" .env && rm -f .env.bak
  else
    printf '%s=%s\n' "$key" "$val" >> .env
  fi
}
set_env BASE_URL "https://${DOMAIN}"
set_env VISIT_BASE_URL "https://${DOMAIN}"

# --- 7. Démarrage (image précompilée ; build local seulement si elle est indisponible) ---
echo "→ démarrage…"
docker compose pull --ignore-pull-failures --quiet
docker compose up -d

echo "→ attente du certificat HTTPS (jusqu'à 2 min)…"
CODE=000
for _ in $(seq 1 40); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "https://${DOMAIN}/" || true)"
  [[ "$CODE" == 401 || "$CODE" == 200 ]] && break
  sleep 3
done

echo
if [[ "$CODE" == 401 || "$CODE" == 200 ]]; then
  ok "✅ Sequence Mail est en ligne : https://${DOMAIN}"
else
  err "L'instance tourne, mais https://${DOMAIN} ne répond pas encore."
  err "Vérifie le DNS (A ${DOMAIN} → IP du serveur) et les ports 80/443, puis : docker compose logs caddy"
fi
cat <<MSG

  Identifiant : admin
  Mot de passe : $([[ $GENERATED == 1 ]] && echo "$DASHBOARD_PASSWORD   (généré, à conserver)" || echo "celui que tu as choisi")

Dernière étape, dans Paramètres : coller les identifiants OAuth Google
(la page donne les liens et l'URI de redirection https://${DOMAIN}/auth/google/callback).

Mise à jour :  docker compose pull && docker compose up -d
MSG
