// Drives the real server through its routes with the send engine's ticks, in DB_MODE=shadow: every
// statement runs on both SQLite and Postgres and results are compared. No scheduler is started and
// nothing leaves the machine as long as the data has no usable account (see docs/postgres.md).
import { db } from "../src/db.js";
import fs from "node:fs";
import { sqlite } from "../src/db-sqlite.js";
import { diffTables, type ShadowDatabase } from "../src/db-shadow.js";
import { createServer } from "../src/server.js";
import { consolidateProfiles } from "../src/services/li-consolidate.js";
import { createAccount, nextForAccounts, recordResult, getAccount, releaseAcceptedMessages, setEnabled } from "../src/services/outreach.js";
import { checkRepliesTick, nextEmailEstimate, sendTick } from "../src/services/scheduler.js";

const PORT = Number(process.env.PORT ?? 3902);
const base = `http://127.0.0.1:${PORT}/api`;
const log: string[] = [];
async function call(method: string, path: string, body?: unknown, type = "application/json") {
  if (process.env.DRIVE_TRACE) console.error(method, path);
  const r = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { "content-type": type },
    body: body === undefined ? undefined : type === "application/json" ? JSON.stringify(body) : (body as string),
  });
  const text = await r.text();
  if (r.status >= 500) log.push(`${r.status} ${method} ${path}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const server = createServer().listen(PORT, async () => {
  try {
    await run();
  } catch (e) {
    log.push(`drive stopped: ${(e as Error).stack}`);
  }
  const shadow = db as unknown as ShadowDatabase;
  if (!shadow.stats) {
    console.log(JSON.stringify({ mode: "postgres", errors: log }, null, 1)); // no second base to compare
  } else {
    const s = shadow.stats;
    const schema = fs.readFileSync(new URL("../src/schema.pg.sql", import.meta.url), "utf8");
    const tables = s.stoppedBy ? "mirror stopped" : diffTables(sqlite, shadow.mirrorDb, schema);
    console.log(JSON.stringify({ statements: s.statements, distinct: s.distinct.size, mismatches: s.mismatches, stoppedBy: s.stoppedBy, tables, errors: log }, null, 1));
    if (process.env.DRIVE_SEEN) fs.writeFileSync(process.env.DRIVE_SEEN, JSON.stringify([...s.distinct]));
  }
  server.close();
  process.exit(0);
});

async function run() {
  // Reads over all existing data
  const all = (await call("GET", "/campaigns")) as Array<{ id: number }>;
  for (const path of ["/accounts", "/activity", "/activity?days=365", "/contacts?q=a", "/inbox/counts", "/li/accounts", "/li/status", "/settings", "/variable-instructions"]) await call("GET", path);
  for (const c of all) {
    await call("GET", `/campaigns/${c.id}`);
    await call("GET", `/campaigns/${c.id}/contacts`);
    await call("GET", `/campaigns/${c.id}/preview`);
  }
  await call("GET", "/inbox?status=todo");
  await call("GET", "/inbox?status=done");
  await call("GET", "/inbox");

  // A full LinkedIn + email sequence, written through the routes
  const li = createAccount("Banc", null);
  const steps = [
    { channel: "linkedin", li_action: "invite", subject: "", body: "", wait_days: 0 },
    { channel: "linkedin", li_action: "message", subject: "", body: "Hello {{first_name}} {{perso}}", wait_days: 0, branch: "accepted" },
    { channel: "email", subject: "Bonjour {{first_name}}", body: "Corps", wait_days: 0, branch: "not_accepted" },
  ];
  const { id } = await call("POST", "/campaigns", { name: "Banc ombre", description: "d", steps });
  await call("POST", `/campaigns/${id}/import?campaign_vars=perso`, "linkedin,first_name,last_name,company,perso,poste\nlinkedin.com/in/ada,Ada,L,Acme,phrase,Dev\nlinkedin.com/in/alan,Alan,T,Acme,autre,Dev\nlinkedin.com/in/kat,Kat,J,NASA,encore,Data\n", "text/csv");
  await call("PATCH", `/campaigns/${id}`, { description: "desc 2", priority: 1 });
  await call("PATCH", `/campaigns/${id}/steps/1`, { body: "Note {{first_name}}" });
  await call("PUT", `/variable-instructions/perso`, { instruction: "Une phrase" });
  const rows = (await call("GET", `/campaigns/${id}/contacts`)) as Array<{ cc_id: number; contact_id: number }>;
  const ids = rows.map((r) => r.cc_id);
  await call("PATCH", `/campaign-contacts/${ids[0]}/vars`, { vars: { perso: "retouchée" } });
  await call("PATCH", `/contacts/${rows[0].contact_id}`, { company: "Acme 2" });
  await call("GET", `/contacts?q=ada`);
  await call("POST", `/campaigns/${id}/launch-contacts`, { ids });
  await call("POST", `/campaigns/${id}/resume`);
  setEnabled(true);
  await sendTick();
  nextEmailEstimate();
  await call("GET", `/campaigns/${id}/contacts`);
  const account = getAccount(li.account.id)!;
  for (let i = 0; i < 12; i++) {
    const next = nextForAccounts([account], "extension") as { action?: { id: number; type: string } };
    if (!next.action) break;
    recordResult(account, next.action.id, { ok: i !== 1, error: i === 1 ? "échec simulé" : undefined } as never);
    await sendTick();
  }
  releaseAcceptedMessages();
  await call("POST", `/campaigns/${id}/set-status`, { ids: [ids[1]], status: "replied" });
  await call("POST", `/campaign-contacts/${ids[1]}/inbox`, { seen: true });
  await call("POST", `/campaign-contacts/${ids[1]}/inbox`, { done: true });
  await call("GET", "/inbox?status=done");
  await call("POST", `/campaigns/${id}/set-status`, { ids: [ids[2]], status: "opted_out" });
  await call("POST", `/campaigns/${id}/stop-contacts`, { ids: [ids[0]] });
  await checkRepliesTick();
  await sendTick();
  await call("POST", `/campaigns/${id}/pause`);
  await call("PUT", `/campaigns/${id}`, { name: "Banc ombre 2", steps });
  await call("POST", `/campaigns/${id}/archive`);
  await call("POST", `/campaigns/${id}/unarchive`);
  consolidateProfiles();
  await call("POST", `/campaigns/${id}/remove-contacts`, { ids: [ids[2]] });
  await call("GET", "/activity?days=2");
  await call("DELETE", `/campaigns/${id}`);
  await call("GET", "/campaigns");
}
