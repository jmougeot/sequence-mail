import fs from "node:fs";
import Client from "pg-native";
import { insertReturnsId, toPg, type PgStatement } from "./sql-dialect.js";

// A better-sqlite3 look-alike on Postgres: same synchronous prepare/get/all/run/transaction, so the
// send engine keeps its guarantee that nothing interleaves inside a transaction. pg-native is the
// synchronous libpq binding; one connection, used by one thread, as with SQLite.

export type Params = unknown[];
export type RunResult = { changes: number; lastInsertRowid: number | bigint };
export type Statement = {
  get(...params: Params): unknown;
  all(...params: Params): unknown[];
  run(...params: Params): RunResult;
};
export type Db = {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R;
};

const INT8 = 20;
const NUMERIC = 1700;
const BOOL = 16;

// Integers, sums and comparisons read back as SQLite returns them: numbers and 0/1. Epoch ms fit a
// double.
const types = {
  getTypeParser(oid: number) {
    if (oid === INT8 || oid === NUMERIC) return (v: string) => Number(v);
    if (oid === BOOL) return (v: string) => (v === "t" ? 1 : 0);
    if (oid === 21 || oid === 23 || oid === 26 || oid === 700 || oid === 701) return (v: string) => Number(v);
    return (v: string) => v;
  },
};

// Every column is an integer or text: a computed delay (now + rand() * 1000) is stored rounded.
function bind(v: unknown): unknown {
  if (typeof v === "number") return Number.isNaN(v) ? null : Number.isInteger(v) ? v : Math.round(v);
  if (typeof v === "string") return v.includes("\0") ? v.replaceAll("\0", "") : v;
  if (typeof v === "bigint") return v.toString();
  if (v === null) return null;
  throw new TypeError(`SQLite3 can only bind numbers, strings, bigints, buffers, and null (got ${typeof v})`);
}

function values(stmt: PgStatement, params: Params): unknown[] {
  if (stmt.names) {
    const obj = (params[0] ?? {}) as Record<string, unknown>;
    return stmt.names.map((n) => {
      if (!(n in obj)) throw new RangeError(`Missing named parameter "${n}"`);
      return bind(obj[n]);
    });
  }
  if (params.length !== stmt.count) throw new RangeError(`Expected ${stmt.count} parameters, got ${params.length}`);
  return params.map(bind);
}

const CONNECTION_LOST = /server closed|connection|terminating|no connection|EOF|broken pipe/i;
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export type PgOptions = {
  url: string;
  // How long a statement waits for Postgres to come back. Primary: long, because a send already
  // made must be recorded. Shadow: zero, the mirror must never delay anything.
  reconnectMs: number;
  statementTimeoutMs: number;
};

// libpq closes its uv handle asynchronously and frees it with the JS object: a client collected
// before the event loop gets there is a SIGSEGV in uv_run. It stays referenced for that long.
const retiring = new Set<Client>();
function retire(client: Client): void {
  retiring.add(client);
  try {
    client.end();
  } catch {
    /* already gone */
  }
  setTimeout(() => retiring.delete(client), 1000).unref();
}

export class PgDatabase implements Db {
  private client: Client;
  private depth = 0;

  constructor(private opts: PgOptions) {
    this.client = this.connect();
  }

  private connect(): Client {
    const client = new Client({ types });
    client.connectSync(this.opts.url);
    try {
      client.querySync("SET search_path = sequence");
      client.querySync(`SET statement_timeout = ${this.opts.statementTimeoutMs}`);
      client.querySync("SET lock_timeout = 5000");
    } catch (e) {
      retire(client);
      throw e;
    }
    return client;
  }

  private query(text: string, vals?: unknown[]) {
    const deadline = Date.now() + this.opts.reconnectMs;
    for (;;) {
      try {
        return this.client.querySync(text, vals);
      } catch (e) {
        const lost = CONNECTION_LOST.test((e as Error).message);
        // Inside a transaction its work is gone with the connection: only the caller can restart it
        if (!lost || this.depth > 0 || Date.now() >= deadline) throw e;
        sleep(500);
        try {
          const client = this.connect();
          retire(this.client);
          this.client = client;
        } catch {
          /* still down: next round */
        }
      }
    }
  }

  prepare(sql: string): Statement {
    const stmt = toPg(sql);
    const returning = insertReturnsId(sql);
    const text = returning ? `${stmt.text.trimEnd().replace(/;$/, "")} RETURNING id` : stmt.text;
    return {
      get: (...params) => this.query(text, values(stmt, params))[0],
      all: (...params) => this.query(text, values(stmt, params)),
      run: (...params) => {
        const rows = this.query(text, values(stmt, params));
        const id = returning ? (rows[0]?.id as number | undefined) : undefined;
        return { changes: Number(this.client.pq.cmdTuples()) || 0, lastInsertRowid: id ?? 0 };
      },
    };
  }

  exec(sql: string): void {
    this.query(sql);
  }

  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args) => {
      const save = `s${this.depth}`;
      this.query(this.depth ? `SAVEPOINT ${save}` : "BEGIN");
      this.depth++;
      try {
        const out = fn(...args);
        this.depth--;
        this.query(this.depth ? `RELEASE ${save}` : "COMMIT");
        return out;
      } catch (e) {
        this.depth = Math.max(0, this.depth - 1);
        try {
          this.query(this.depth ? `ROLLBACK TO ${save}` : "ROLLBACK");
        } catch {
          /* connection lost: the transaction is gone anyway */
        }
        throw e;
      }
    };
  }

  close(): void {
    retire(this.client);
  }
}

export function loadSchema(pg: PgDatabase, schemaUrl: URL): void {
  pg.exec(fs.readFileSync(schemaUrl, "utf8"));
}
