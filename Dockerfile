# Production image for Sequence Mail (Node + Express + SQLite).
# better-sqlite3 is native: keep build tools in case no prebuilt binary
# matches the platform.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first (Docker cache). tsx/typescript are devDependencies but
# needed at runtime (npm start = tsx src/index.ts), so install everything.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ENV NODE_ENV=production
# SQLite database lives outside the container (volume mounted on /data)
ENV DATA_DIR=/data
ENV PORT=3000

EXPOSE 3000
CMD ["npm", "start"]
