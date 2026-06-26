#!/usr/bin/env bash
#
# Bootstrap « clé en main » de Sequence Mail.
# Prépare une instance déployable (Docker + Caddy HTTPS) à partir des modèles
# versionnés : crée .env, génère le Caddyfile (domaine + hash du mot de passe) et
# renseigne le domaine public. Idempotent : relançable sans casser l'existant.
#
# Usage :  ./setup.sh        (interactif)
#          DOMAIN=go.x.com DASHBOARD_PASSWORD=secret ./setup.sh   (non interactif)
#
set -euo pipefail
cd "$(dirname "$0")"

err() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
ok()  { printf '\033[32m%s\033[0m\n' "$*"; }

# --- Pré-requis : Docker en marche (sert au hash bcrypt ET au déploiement) ---
if ! command -v docker >/dev/null 2>&1; then
  err "Docker est requis (génération du hash + déploiement). Installe-le puis relance."
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

# --- 2. Domaine public ---
DOMAIN="${DOMAIN:-}"
if [[ -z "$DOMAIN" ]]; then
  read -r -p "Domaine public de l'app (ex. go.mondomaine.com) : " DOMAIN
fi
DOMAIN="${DOMAIN// /}"
DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN%/}"
[[ -n "$DOMAIN" ]] || { err "Domaine requis."; exit 1; }

# --- 3. Mot de passe du dashboard ---
DASHBOARD_PASSWORD="${DASHBOARD_PASSWORD:-}"
if [[ -z "$DASHBOARD_PASSWORD" ]]; then
  read -r -s -p "Mot de passe du dashboard (utilisateur « admin ») : " DASHBOARD_PASSWORD; echo
fi
[[ -n "$DASHBOARD_PASSWORD" ]] || { err "Mot de passe requis."; exit 1; }

# --- 4. Hash bcrypt via l'image Caddy ---
echo "→ génération du hash bcrypt…"
CADDY_HASH="$(docker run --rm caddy:2 caddy hash-password --plaintext "$DASHBOARD_PASSWORD")"
[[ -n "$CADDY_HASH" ]] || { err "Échec de la génération du hash."; exit 1; }

# --- 5. Rendu du Caddyfile depuis le modèle ---
# Délimiteur « | » : absent de l'alphabet bcrypt et des noms de domaine, donc le
# hash ($, /, .) et le domaine passent tels quels sans échappement.
sed -e "s|__DOMAIN__|${DOMAIN}|g" -e "s|__CADDY_HASH__|${CADDY_HASH}|g" \
  Caddyfile.template > Caddyfile
ok "→ Caddyfile généré (domaine ${DOMAIN} + hash)"

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
ok "→ BASE_URL / VISIT_BASE_URL = https://${DOMAIN}"

cat <<MSG

$(ok "✅ Configuration prête.")

Il reste 2 choses, propres à TON instance :

  1) DNS — un enregistrement  A  ${DOMAIN} → IP du serveur  (proxy/Cloudflare désactivé).

  2) Google OAuth — dans .env, renseigne :
        GOOGLE_CLIENT_ID=...
        GOOGLE_CLIENT_SECRET=...
     (console.cloud.google.com → client OAuth « Web »)
     URI de redirection à autoriser : https://${DOMAIN}/auth/google/callback

Puis démarre l'instance :

     docker compose up -d --build
     docker compose logs -f app      # vérifier le démarrage

Ouvre ensuite https://${DOMAIN} → login « admin » + ton mot de passe.
MSG
