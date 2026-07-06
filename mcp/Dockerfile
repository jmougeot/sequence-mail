# Serveur MCP Sequence Mail en mode HTTP (transport Streamable) pour clients
# distants — ici l'agent Ruby hébergé. En local (Claude Code), le même code tourne
# en stdio via ~/.config/sequence-mail-mcp.sh ; ce conteneur ne sert que le HTTP.
FROM node:22-bookworm-slim

WORKDIR /app

# Dépendances d'abord (cache Docker). tsc est en devDependency et sert au build.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV MCP_HTTP_PORT=8790
EXPOSE 8790
CMD ["node", "dist/index.js"]
