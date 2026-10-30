// Statements are written in the SQL shared by SQLite and Postgres (ON CONFLICT, IS NOT DISTINCT
// FROM, CASE…); what still differs is rewritten here: placeholders, LIKE's case rule, empty IN
// lists. Named parameters (@name) keep one Postgres number per name.

export type PgStatement = { text: string; names: string[] | null; count: number };

const TOKEN = /'(?:[^']|'')*'|--[^\n]*|\?|@[a-zA-Z_]\w*|\bLIKE\b|\bIN\s*\(\s*\)/g;

export function toPg(sql: string): PgStatement {
  let n = 0;
  const names: string[] = [];
  const text = sql.replace(TOKEN, (m) => {
    if (m === "?") return `$${++n}`;
    if (m[0] === "@") {
      const name = m.slice(1);
      if (!names.includes(name)) names.push(name);
      return `$${names.indexOf(name) + 1}`;
    }
    if (m === "LIKE") return "ILIKE"; // SQLite's LIKE ignores ASCII case
    if (/^IN\s*\(/.test(m)) return "IN (NULL)"; // SQLite accepts an empty list, Postgres refuses it
    return m;
  });
  return { text, names: names.length ? names : null, count: n || names.length };
}

// Tables with an `id` column: their INSERTs report the new id (lastInsertRowid)
const ID_TABLES = new Set([
  "accounts", "campaigns", "steps", "contacts", "campaign_contacts", "messages", "li_actions", "li_accounts", "li_log", "visits",
]);

// The table an INSERT adds ids to
export function insertTable(sql: string): string | null {
  const m = /^\s*INSERT\s+INTO\s+"?(\w+)/i.exec(sql);
  return m && ID_TABLES.has(m[1]) ? m[1] : null;
}

export function insertReturnsId(sql: string): boolean {
  return insertTable(sql) !== null && !/\bRETURNING\b/i.test(sql);
}
