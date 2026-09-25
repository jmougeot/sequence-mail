# Navigateurs serveur des comptes LinkedIn (Playwright + Chromium + Xvfb).
# Contexte de build = Sequence-mail/ (pour embarquer extension/content.js, le
# code d'interface LinkedIn partagé avec l'extension Chrome).
#
#   docker compose -f docker-compose.server.yml up -d --build li-runner
#
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /runner
COPY runner/package.json runner/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY runner/runner.mjs ./
COPY extension/content.js ./content.js

ENV NODE_ENV=production
ENV PROFILES_DIR=/data/profiles
# Fenêtre réelle dans un écran virtuel : moins détectable qu'un headless.
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1366x820x24", "node", "runner.mjs"]
