import type { Database as Sqlite } from "better-sqlite3";
import { PgDatabase, type Db, type Params, type Statement } from "./db-postgres.js";
import { insertTable } from "./sql-dialect.js";

// Shadow mode: SQLite stays the master and every statement is replayed on Postgres, results
// compared. Nothing here may touch sending: a Postgres failure stops the mirror (until the next
// start copies everything again), it never reaches the caller.

const BATCH = 200;
const KEEP_MISMATCHES = 500;

// Same value on both sides? JSON kept as text compares by content: key order and spacing differ
// (jsonb). Timestamps computed with a fraction are stored rounded on the Postgres side.
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1 && Math.abs(a) > 1e9;
  if (typeof a === "string" && typeof b === "string" && /^[[{]/.test(a) && /^[[{]/.test(b)) {
    try {
      return canon(JSON.parse(a)) === canon(JSON.parse(b));
    } catch {
      return false;
    }
  }
  return false;
}

function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

function sameRow(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every((k) => same(x[k], y[k]));
}

function sameRows(a: unknown[], b: unknown[], ordered: boolean): boolean {
  if (a.length !== b.length) return false;
  if (ordered) return a.every((r, i) => sameRow(r, b[i]));
  const left = [...b];
  return a.every((r) => {
    const i = left.findIndex((o) => sameRow(r, o));
    if (i < 0) return false;
    left.splice(i, 1);
    return true;
  });
}

// Rows that differ between the two bases, per table: the end state, whatever the path that led there
export function diffTables(sqlite: Sqlite, pg: PgDatabase, schema: string): Record<string, { sqlite: number; postgres: number; different: number }> {
  const out: Record<string, { sqlite: number; postgres: number; different: number }> = {};
  const key = (r: Record<string, unknown>) => (r.id !== undefined ? String(r.id) : canon(r));
  for (const table of tablesInOrder(schema)) {
    const left = sqlite.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
    const right = pg.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
    const byKey = new Map(right.map((r) => [key(r), r]));
    const different = left.filter((r) => !sameRow(r, byKey.get(key(r)))).length;
    if (different || left.length !== right.length) out[table] = { sqlite: left.length, postgres: right.length, different };
  }
  return out;
}

export class ShadowDatabase implements Db {
  private alive = true;
  private depth = 0;
  private mismatches = 0;
  stats = { statements: 0, mismatches: 0, stoppedBy: null as string | null, distinct: new Set<string>() };

  constructor(private sqlite: Sqlite, private pg: PgDatabase) {}

  get mirrorDb(): PgDatabase {
    return this.pg;
  }

  private stop(sql: string, e: unknown): void {
    if (!this.alive) return;
    this.alive = false;
    this.stats.stoppedBy = (e as Error).message.slice(0, 300);
    console.error(`[shadow] mirror stopped until next start: ${this.stats.stoppedBy}\n  ${sql.slice(0, 300)}`);
  }

  private report(sql: string, kind: string, detail: string): void {
    this.stats.mismatches++;
    console.error(`[shadow] ${kind}: ${sql.replace(/\s+/g, " ").slice(0, 200)}`);
    if (this.mismatches++ >= KEEP_MISMATCHES || this.depth > 0) return;
    try {
      this.pg.prepare("INSERT INTO shadow_mismatches (at, kind, sql, detail) VALUES (?, ?, ?, ?)").run(Date.now(), kind, sql.slice(0, 2000), detail.slice(0, 2000));
    } catch {
      /* the log must not stop the mirror */
    }
  }

  // An ON CONFLICT that does nothing still burns a sequence value on Postgres, not on SQLite:
  // each insert restarts the sequence from the id SQLite gave, or both sides would drift apart.
  private alignIds(sql: string, nextId: number): void {
    const table = insertTable(sql);
    if (!table || !this.alive) return;
    try {
      this.pg.prepare("SELECT setval(pg_get_serial_sequence(?, 'id'), ?, false)").get(table, nextId);
    } catch (e) {
      this.stop(sql, e);
    }
  }

  // Runs on Postgres what just ran on SQLite. `compare` gets its result.
  private mirror(sql: string, run: () => unknown, compare: (r: unknown) => void): void {
    if (!this.alive) return;
    this.stats.statements++;
    this.stats.distinct.add(sql);
    try {
      compare(run());
    } catch (e) {
      // A refused statement diverges from here on: comparisons would only be noise
      this.stop(sql, e);
    }
  }

  prepare(sql: string): Statement {
    const lite = this.sqlite.prepare(sql);
    const ordered = /\bORDER\s+BY\b/i.test(sql);
    const arbitrary = !ordered && /\bLIMIT\b/i.test(sql);
    const shadow = (): Statement | null => {
      if (!this.alive) return null;
      try {
        return this.pg.prepare(sql);
      } catch (e) {
        this.stop(sql, e);
        return null;
      }
    };
    return {
      get: (...params: Params) => {
        const out = lite.get(...params);
        const pg = shadow();
        if (pg) {
          this.mirror(sql, () => pg.get(...params), (r) => {
            // Without ORDER BY the row picked is arbitrary on both sides
            if (ordered ? !sameRow(out, r) : (out === undefined) !== (r === undefined)) this.report(sql, "get", `sqlite=${JSON.stringify(out)} pg=${JSON.stringify(r)}`);
          });
        }
        return out;
      },
      all: (...params: Params) => {
        const out = lite.all(...params);
        const pg = shadow();
        if (pg) {
          this.mirror(sql, () => pg.all(...params), (r) => {
            // A LIMIT without ORDER BY keeps arbitrary rows: only their number can be compared
            if (arbitrary ? out.length !== (r as unknown[]).length : !sameRows(out, r as unknown[], ordered)) this.report(sql, "all", `sqlite=${out.length} rows pg=${(r as unknown[]).length} rows`);
          });
        }
        return out;
      },
      run: (...params: Params) => {
        const out = lite.run(...params);
        const pg = shadow();
        if (pg) {
          if (out.changes > 0) this.alignIds(sql, Number(out.lastInsertRowid) - out.changes + 1);
          this.mirror(sql, () => pg.run(...params), (r) => {
            const res = r as typeof out;
            if (res.changes !== out.changes) this.report(sql, "changes", `sqlite=${out.changes} pg=${res.changes}`);
            else if (res.lastInsertRowid && Number(res.lastInsertRowid) !== Number(out.lastInsertRowid) && /^\s*INSERT/i.test(sql)) {
              this.report(sql, "id", `sqlite=${out.lastInsertRowid} pg=${res.lastInsertRowid}`);
            }
          });
        }
        return out;
      },
    };
  }

  exec(sql: string): void {
    this.sqlite.exec(sql);
    this.mirror(sql, () => this.pg.exec(sql), () => {});
  }

  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    // The Postgres side opens and closes with SQLite's, so a rolled-back transaction leaves no trace
    return this.sqlite.transaction((...args: A) => {
      const open = this.alive;
      const mark = `sh${this.depth}`;
      if (open) this.mirror("BEGIN", () => this.pg.exec(this.depth ? `SAVEPOINT ${mark}` : "BEGIN"), () => {});
      this.depth++;
      try {
        const out = fn(...args);
        this.depth--;
        if (open) this.mirror("COMMIT", () => this.pg.exec(this.depth ? `RELEASE ${mark}` : "COMMIT"), () => {});
        return out;
      } catch (e) {
        this.depth--;
        if (open) this.mirror("ROLLBACK", () => this.pg.exec(this.depth ? `ROLLBACK TO ${mark}` : "ROLLBACK"), () => {});
        throw e;
      }
    }) as unknown as (...args: A) => R;
  }
}

// Fresh copy of SQLite into the "sequence" schema, in one transaction: readers (Azerit) see the old
// copy until it commits. Refuses to touch a schema where Postgres is already the master.
export function copyToPostgres(sqlite: Sqlite, pg: PgDatabase, schema: string): number {
  const rows = pg.prepare("SELECT to_regclass('sequence.mirror_meta') AS t").get() as { t: string | null };
  if (rows.t) {
    const meta = pg.prepare("SELECT role FROM sequence.mirror_meta").get() as { role: string } | undefined;
    if (meta?.role !== "shadow") throw new Error(`schema "sequence" is ${meta?.role ?? "unknown"}: refusing to overwrite it`);
  } else {
    const any = pg.prepare("SELECT to_regclass('sequence.campaigns') AS t").get() as { t: string | null };
    if (any.t) throw new Error('schema "sequence" has tables but no mirror_meta: refusing to overwrite it');
  }
  let total = 0;
  pg.transaction(() => {
    pg.exec("DROP SCHEMA IF EXISTS sequence CASCADE; CREATE SCHEMA sequence; SET search_path = sequence");
    pg.exec(schema);
    pg.exec(`CREATE TABLE mirror_meta (role TEXT NOT NULL, copied_at BIGINT NOT NULL);
             CREATE TABLE shadow_mismatches (at BIGINT NOT NULL, kind TEXT NOT NULL, sql TEXT NOT NULL, detail TEXT NOT NULL)`);
    pg.prepare("INSERT INTO mirror_meta (role, copied_at) VALUES ('shadow', ?)").run(Date.now());
    for (const table of tablesInOrder(schema)) {
      const all = sqlite.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
      total += all.length;
      for (let i = 0; i < all.length; i += BATCH) {
        const part = all.slice(i, i + BATCH);
        const cols = Object.keys(part[0]);
        const row = `(${cols.map(() => "?").join(",")})`;
        pg.prepare(`INSERT INTO ${table} (${cols.join(",")}) VALUES ${part.map(() => row).join(",")}`).run(...part.flatMap((r) => cols.map((c) => r[c])));
      }
      if (/\bid BIGINT GENERATED/.test(schema.slice(schema.indexOf(`CREATE TABLE ${table} (`)).split(";")[0])) {
        pg.exec(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1, false)`);
      }
    }
  })();
  return total;
}

export function tablesInOrder(schema: string): string[] {
  return [...schema.matchAll(/^CREATE TABLE (\w+)/gm)].map((m) => m[1]);
}
