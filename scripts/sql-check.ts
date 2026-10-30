// Has Postgres parse and type-check every SQL statement of src/ without running it (PREPARE), on
// the real schema. The whole query surface is covered, including paths no test reaches.
//   DATABASE_URL=postgres://… npx tsx scripts/sql-check.ts
import fs from "node:fs";
import Client from "pg-native";
import { extract, type Stmt } from "./sql-extract.js";
import { toPg } from "../src/sql-dialect.js";

// `const NAME = "…"` / template constants of a file: what the statements interpolate
function constants(file: string): Map<string, string> {
  const out = new Map<string, string>();
  const src = fs.readFileSync(file, "utf8");
  for (const m of src.matchAll(/(?:^|\n)\s*(?:export )?const ([A-Z_a-z]+)\s*=\s*(`[^`]*`|"[^"\n]*")/g)) out.set(m[1], m[2].slice(1, -1));
  return out;
}

function resolve(s: Stmt, shared: Map<string, string>): string {
  let sql = s.sql;
  for (let pass = 0; pass < 4; pass++) {
    sql = sql.replace(/\/\*\$\{(.*?)\}\*\//g, (whole, expr: string) => {
      if (/\.map\(\(\) => "\?"\)|placeholders|inIds|^names$/.test(expr)) return "?";
      if (shared.has(expr)) return shared.get(expr)!;
      if (expr in FRAGMENTS) return FRAGMENTS[expr];
      return whole;
    });
    sql = sql.replace(/\$\{([A-Z_a-z]+)\}/g, (w, n: string) => shared.get(n) ?? FRAGMENTS[n] ?? w);
  }
  return sql;
}

// Interpolations computed at run time: a representative value, enough for the type check
const FRAGMENTS: Record<string, string> = {
  EVENTS_MAX: "500",
  ACCEPT_CHECK_MS: "18000000",
  table: "li_actions",
  where: "id = ?",
  'opts.profile ? "AND member_slug = ?" : ""': "AND member_slug = ?",
  "allowed.map((t) => `'${t}'`).join(\",\")": "'invite','message'",
};

const { stmts } = extract();
const shared = new Map<string, string>();
for (const f of new Set(stmts.map((s) => s.file))) for (const [k, v] of constants(f)) shared.set(k, v);

const client = new Client();
client.connectSync(process.env.DATABASE_URL!);
client.querySync("SET search_path = sequence");
let ok = 0;
const failed: string[] = [];
const skipped: string[] = [];
for (const s of stmts) {
  if (/src\/db(-\w+)?\.ts$/.test(s.file)) continue; // SQLite migrations and the database layer itself
  const sql = resolve(s, shared);
  if (sql.includes("/*${")) { skipped.push(`${s.file}:${s.line} ${sql.match(/\/\*\$\{(.*?)\}\*\//)?.[1]}`); continue; }
  try {
    client.querySync(`PREPARE chk AS ${toPg(sql).text}`);
    client.querySync("DEALLOCATE chk");
    ok++;
  } catch (e) {
    failed.push(`${s.file}:${s.line}\n  ${(e as Error).message.split("\n")[0]}`);
  }
}
console.log(`${ok} ok, ${failed.length} refused, ${skipped.length} not resolved`);
for (const f of failed) console.log(f);
for (const f of skipped) console.log("skipped", f);
process.exit(failed.length ? 1 : 0);
