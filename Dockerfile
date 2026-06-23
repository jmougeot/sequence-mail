# Image de production pour Sequence Mail (Node + Express + SQLite).
# better-sqlite3 est natif : on garde les outils de build au cas où le binaire
# précompilé ne correspond pas à la plateforme du VPS.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dépendances d'abord (cache Docker). tsx/typescript sont en devDependencies et
# sont nécessaires à l'exécution (npm start = tsx src/index.ts) → on installe tout.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ENV NODE_ENV=production
# Base SQLite persistée hors du conteneur (volume monté sur /data)
ENV DATA_DIR=/data
ENV PORT=3000

EXPOSE 3000
CMD ["npm", "start"]
