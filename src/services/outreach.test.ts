// Verdicts of the Chrome extension on /api/li/result: refusal for lack of real gestures (no penalty,
// failed at the 4th in a row) and the gestures kept on the action. On a throwaway SQLite base.
//   npm test
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sm-test-"));
process.env.DB_MODE ??= "sqlite"; // DB_MODE=postgres POSTGRES_URL=… : the same tests on Postgres

const { db } = await import("../db.js");
const { createServer } = await import("../server.js");
const { createAccount, getAccount, parseGestures } = await import("./outreach.js");

let server: Server;
let base = "";
const { account, token } = createAccount("Test");

before(async () => {
  server = createServer().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});

let actionId = 0;
let ccId = 0;
beforeEach(() => {
  // One contact in a LinkedIn step, its invite served to the extension (status "sending", 1 attempt)
  const campaign = Number(db.prepare(`INSERT INTO campaigns (name, status) VALUES ('c', 'active')`).run().lastInsertRowid);
  const contact = Number(
    db.prepare(`INSERT INTO contacts (first_name, linkedin) VALUES ('Jean', ?)`).run(`https://www.linkedin.com/in/jean-${campaign}`).lastInsertRowid
  );
  ccId = Number(
    db
      .prepare(`INSERT INTO campaign_contacts (campaign_id, contact_id, status, current_step, li_account_id) VALUES (?, ?, 'awaiting_li', 0, ?)`)
      .run(campaign, contact, account.id).lastInsertRowid
  );
  actionId = Number(
    db
      .prepare(
        `INSERT INTO li_actions (campaign_contact_id, step_number, linkedin, type, body, status, attempts, lease_at, li_account_id)
         VALUES (?, 1, ?, 'invite', 'Bonjour', 'sending', 1, ?, ?)`
      )
      .run(ccId, `https://www.linkedin.com/in/jean-${campaign}`, Date.now(), account.id).lastInsertRowid
  );
  db.prepare(`UPDATE li_accounts SET paused_until = NULL, next_allowed_at = NULL WHERE id = ?`).run(account.id);
});

async function verdict(body: Record<string, unknown>) {
  const r = await fetch(`${base}/api/li/result`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-li-account": token },
    body: JSON.stringify({ id: actionId, ...body }),
  });
  assert.equal(r.status, 200, await r.text());
}

const action = () =>
  db.prepare(`SELECT status, attempts, ui_failures, real_input_refusals, error, gestures, lease_at FROM li_actions WHERE id = ?`).get(actionId) as {
    status: string;
    attempts: number;
    ui_failures: number;
    real_input_refusals: number;
    error: string | null;
    gestures: string | null;
    lease_at: number | null;
  };
const contactStatus = () => (db.prepare(`SELECT status FROM campaign_contacts WHERE id = ?`).get(ccId) as { status: string }).status;
const serveAgain = () => db.prepare(`UPDATE li_actions SET status = 'sending', attempts = attempts + 1, lease_at = ? WHERE id = ?`).run(Date.now(), actionId);

const refusal = {
  ok: false,
  no_real_input: true,
  error: "vrais gestes impossibles (cible hors écran) — rien envoyé",
  gestures: { real: 2, simulated: 0, refused_reason: "cible hors écran", tab_hidden: true },
};

test("refus faute de vrais gestes : remis en file sans pénalité", async () => {
  const t0 = Date.now();
  await verdict(refusal);
  const a = action();
  assert.equal(a.status, "pending");
  assert.equal(a.attempts, 0, "attempts not consumed");
  assert.equal(a.ui_failures, 0);
  assert.equal(a.real_input_refusals, 1);
  assert.equal(a.lease_at, null);
  assert.match(a.error ?? "", /cible hors écran.*refus 1\/4/);
  assert.equal(contactStatus(), "awaiting_li");
  const acc = getAccount(account.id)!;
  assert.equal(acc.paused_until, null, "no safety pause");
  assert.ok(acc.next_allowed_at! >= t0 + 5 * 60_000 - 1000 && acc.next_allowed_at! <= Date.now() + 10 * 60_000, "account waits 5-10 min");
});

test("4e refus de suite : contact en échec, motif explicite, toujours sans pause", async () => {
  for (let i = 0; i < 4; i++) {
    if (i) serveAgain();
    await verdict(refusal);
  }
  const a = action();
  assert.equal(a.status, "failed");
  assert.equal(a.real_input_refusals, 4);
  assert.match(a.error ?? "", /vrais gestes impossibles 4 fois de suite/);
  assert.equal(contactStatus(), "failed");
  assert.equal(getAccount(account.id)!.paused_until, null);
});

test("les refus ne comptent que de suite", async () => {
  await verdict(refusal);
  serveAgain();
  await verdict(refusal);
  serveAgain();
  // a passing interface failure in between starts the count over
  await verdict({ ok: false, error: "bouton « Se connecter » introuvable" });
  assert.equal(action().real_input_refusals, 0);
  assert.equal(action().ui_failures, 1);
});

test("une erreur ordinaire garde son traitement (échec + pause)", async () => {
  await verdict({ ok: false, error: "quelque chose d'inattendu" });
  assert.equal(action().status, "failed");
  assert.ok((getAccount(account.id)!.paused_until ?? 0) > Date.now());
});

test("gestes stockés sur l'action et écrits au journal", async () => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await verdict({ ok: true, gestures: { real: 14, simulated: 0, fill: "paste", paste_ms: 6, clipboard: "restauré", junk: "x" } });
  } finally {
    console.log = log;
  }
  const a = action();
  assert.equal(a.status, "sent");
  assert.deepEqual(JSON.parse(a.gestures!), { real: 14, simulated: 0, fill: "paste", paste_ms: 6, clipboard: "restauré" });
  assert.ok(lines.some((l) => /^\[linkedin\] gestes action=\d+ type=invite .*real=14 simulated=0 .*paste_ms=6/.test(l)), lines.join("\n"));
});

test("geste simulé repéré : compté et signalé", async () => {
  const warns: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
  try {
    await verdict({ ok: true, gestures: { real: 3, simulated: 1, simulated_types: { click: 1 } } });
  } finally {
    console.warn = warn;
  }
  assert.equal(JSON.parse(action().gestures!).simulated, 1);
  assert.ok(warns.some((l) => /gestes .*simulated=1 simulés=click:1/.test(l)));
});

test("le refus porte ses gestes (raison, onglet caché)", async () => {
  await verdict(refusal);
  assert.deepEqual(JSON.parse(action().gestures!), refusal.gestures);
});

test("parseGestures : rien de malformé", () => {
  assert.equal(parseGestures(null), null);
  assert.equal(parseGestures({ real: "x", simulated: 0 }), null);
  assert.equal(parseGestures([1, 2]), null);
  assert.deepEqual(parseGestures({ real: 1, simulated: 0, tab_hidden: "yes", refused_reason: "r".repeat(500) }), {
    real: 1,
    simulated: 0,
    refused_reason: "r".repeat(200),
  });
});
