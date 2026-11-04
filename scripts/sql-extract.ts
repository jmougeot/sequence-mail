// Lists every SQL statement in src/ (the argument of each .prepare()/.exec() call), with its
// location. ${...} interpolations are kept as markers. Used by sql-check.ts.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export type Stmt = { file: string; line: number; sql: string; dynamic: boolean; kind: "prepare" | "exec" };

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

export function extract(root = "src"): { stmts: Stmt[]; unresolved: string[] } {
  const stmts: Stmt[] = [];
  const unresolved: string[] = [];
  for (const file of walk(root)) {
    const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const name = n.expression.name.text;
        if ((name === "prepare" || name === "exec") && n.arguments.length === 1) {
          const a = n.arguments[0];
          const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
          const push = (sql: string, dynamic: boolean) => stmts.push({ file, line, sql, dynamic, kind: name });
          if (ts.isStringLiteralLike(a)) push(a.text, false);
          else if (ts.isTemplateExpression(a)) {
            push(a.head.text + a.templateSpans.map((s) => `/*\${${s.expression.getText()}}*/` + s.literal.text).join(""), true);
          } else if (name === "prepare") unresolved.push(`${file}:${line} ${a.getText().slice(0, 80)}`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { stmts, unresolved };
}

if (process.argv[1]?.endsWith("sql-extract.ts")) {
  const { stmts, unresolved } = extract();
  console.log(JSON.stringify({ count: stmts.length, unresolved, stmts }, null, 1));
}
