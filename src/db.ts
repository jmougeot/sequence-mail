import fs from "node:fs";
import { PgDatabase, type Db } from "./db-postgres.js";
import { sqlite } from "./db-sqlite.js";
import { copyToPostgres, ShadowDatabase } from "./db-shadow.js";

// Where the data lives, set by DB_MODE: "sqlite" (default), "shadow" (SQLite is the master, Postgres
// follows and is compared) or "postgres". The whole code reads and writes through this `db`.
const mode = process.env.DB_MODE ?? "sqlite";
const url = process.env.POSTGRES_URL ?? "";
const schema = () => fs.readFileSync(new URL("./schema.pg.sql", import.meta.url), "utf8");

function open(): Db {
  if (mode === "sqlite") return sqlite as unknown as Db;
  if (!url) throw new Error(`DB_MODE=${mode} needs POSTGRES_URL`);
  if (mode === "postgres") {
    const pg = new PgDatabase({ url, reconnectMs: 60_000, statementTimeoutMs: 30_000 });
    const meta = pg.prepare("SELECT role FROM mirror_meta").get() as { role: string } | undefined;
    if (meta?.role !== "primary") throw new Error('DB_MODE=postgres: schema "sequence" is not marked primary (see docs/postgres.md)');
    return pg;
  }
  if (mode === "shadow") {
    try {
      const pg = new PgDatabase({ url, reconnectMs: 0, statementTimeoutMs: 2_000 });
      const start = Date.now();
      const copier = new PgDatabase({ url, reconnectMs: 0, statementTimeoutMs: 120_000 });
      const rows = copyToPostgres(sqlite, copier, schema());
      copier.close();
      console.log(`[shadow] ${rows} rows copied to Postgres in ${Date.now() - start} ms`);
      return new ShadowDatabase(sqlite, pg);
    } catch (e) {
      // SQLite is the master: sending goes on without the mirror
      console.error(`[shadow] not started: ${(e as Error).message}`);
      return sqlite as unknown as Db;
    }
  }
  throw new Error(`Unknown DB_MODE: ${mode}`);
}

export const db = open();
