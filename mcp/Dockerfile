# Sequence Mail MCP server over HTTP (Streamable transport) for remote clients
# such as a hosted agent. Locally (Claude Code) the same code runs over stdio;
# this container only serves HTTP.
FROM node:22-bookworm-slim

WORKDIR /app

# Dependencies first (Docker cache). tsc is a devDependency, used for the build.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV MCP_HTTP_PORT=8790
EXPOSE 8790
CMD ["node", "dist/index.js"]
