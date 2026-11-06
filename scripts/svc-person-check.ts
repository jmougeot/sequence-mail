// Checks Azerit's service routes (/api/svc/campaigns/:id/*) since they name candidates by person
// (campaign_contacts.person_id, 7 Nov 2026), and, on Postgres, the migration that fills it.
//   npx tsx scripts/svc-person-check.ts                       SQLite, in a temporary folder
//   DB_MODE=postgres POSTGRES_URL=postgres://…/x_test npx tsx scripts/svc-person-check.ts [previous-migrations.pg.sql]
// On Postgres it rebuilds the schema "sequence" (and public.lead_people) of the database given,
// whose name must contain "test". The optional file is the previous version's migrations.pg.sql
// (git show <commit>:Sequence-mail/src/migrations.pg.sql), replayed on the migrated base: the
// previous Sequence Mail must still start on it. Exits 1 on the first failed run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Client from "pg-native";

const mode = process.env.DB_MODE ?? "sqlite";
const url = process.env.POSTGRES_URL ?? "";
const KEY = "svc-person-check";
process.env.SERVICE_API_KEY = KEY;
const failures: string[] = [];
let passed = 0;
// every pg-native client stays referenced for the whole run: one collected while its end() is still
// under way crashes the process (same as retire() in src/db-postgres.ts)
const clients: Client[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(`${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}
const src = (f: string) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

if (mode === "sqlite") {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "svc-person-check-"));
} else if (mode === "postgres") {
  if (!/test/i.test(new URL(url).pathname)) throw new Error("POSTGRES_URL: a database whose name contains « test », it is rebuilt");
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "svc-person-check-")); // SQLite is opened anyway
  migrationCheck();
  freshSchema();
} else {
  throw new Error("DB_MODE: sqlite or postgres");
}

/** A client on the test database, schema "sequence" first. */
function pg(): Client {
  const c = new Client();
  clients.push(c);
  c.connectSync(url);
  c.querySync("SET client_min_messages = warning");
  c.querySync("CREATE SCHEMA IF NOT EXISTS sequence");
  c.querySync("SET search_path = sequence");
  return c;
}

function freshSchema(): void {
  const c = pg();
  c.querySync("DROP SCHEMA sequence CASCADE; DROP TABLE IF EXISTS public.lead_people; CREATE SCHEMA sequence; SET search_path = sequence");
  c.querySync(src("schema.pg.sql"));
  c.querySync("CREATE TABLE mirror_meta (role TEXT NOT NULL, copied_at BIGINT NOT NULL); INSERT INTO mirror_meta VALUES ('primary', 0)");
  c.end();
}

/**
 * The migration on a base as the previous version left it (lead key, no person on enrollments):
 * person by key first, contact as fallback, only lines with a key; idempotent; without
 * lead_people; then the previous migrations replayed.
 */
function migrationCheck(): void {
  freshSchema();
  const c = pg();
  // the previous version's structure: no person on enrollments nor history
  c.querySync(`DROP INDEX idx_cc_person; DROP INDEX idx_enrollment_history_person;
    ALTER TABLE campaign_contacts DROP COLUMN person_id; ALTER TABLE enrollment_history DROP COLUMN person_id`);
  c.querySync(`
    CREATE TABLE public.lead_people (lead_key TEXT, person_id BIGINT);
    INSERT INTO public.lead_people VALUES ('k1', 1), ('k2', 2), ('k3', 3), ('k3', 33), ('k8', 8);
    INSERT INTO campaigns (id, name, owner_ref, external_ref) VALUES (1, 'Poste', 'azerit:u:1', 'job:1'), (2, 'Offres', 'azerit:u:1', NULL);
    INSERT INTO contacts (id, linkedin, person_id) VALUES
      (1, 'in/c1', NULL), (2, 'in/c2', 20), (3, 'in/c3', 30), (4, 'in/c4', NULL), (5, 'in/c5', NULL), (6, 'in/c6', 60);
    INSERT INTO campaign_contacts (id, campaign_id, contact_id, status, external_key) VALUES
      (1, 1, 1, 'held', 'k1'),          -- key only
      (2, 1, 2, 'in_progress', 'k2'),   -- key 2, contact 20: the key wins
      (3, 1, 3, 'completed', 'k3'),     -- key giving two people: the contact (30)
      (4, 1, 4, 'pending', 'k-none'),   -- nothing: unresolved, active
      (5, 1, 5, 'completed', 'k-none2'),-- nothing: unresolved, other
      (6, 1, 6, 'held', NULL),          -- no key: left alone
      (7, 2, 2, 'in_progress', NULL);   -- prospection: left alone
    INSERT INTO enrollment_history (campaign_id, owner_ref, contact_id, external_key, status, removed_at) VALUES
      (1, 'azerit:u:1', 2, 'k2', 'stopped', 1),       -- key 2 over contact 20
      (1, 'azerit:u:1', 6, NULL, 'stopped', 2),       -- no key: left alone
      (1, 'azerit:u:1', 999, 'k8', 'completed', 3),   -- contact gone, key 8
      (1, 'azerit:u:1', 999, 'k-none', 'completed', 4);
  `);
  const migrations = src("migrations.pg.sql");
  const people = (table: string) =>
    Object.fromEntries(
      (c.querySync(`SELECT ${table === "campaign_contacts" ? "id" : "removed_at"} AS k, person_id FROM ${table} ORDER BY 1`) as Array<{
        k: string;
        person_id: string | null;
      }>).map((r) => [Number(r.k), r.person_id == null ? null : Number(r.person_id)])
    );
  c.querySync(migrations);
  const ccWanted = { 1: 1, 2: 2, 3: 30, 4: null, 5: null, 6: null, 7: null };
  const hWanted = { 1: 2, 2: null, 3: 8, 4: null };
  check("migration: enrollments by key, then contact, keyed lines only", JSON.stringify(people("campaign_contacts")) === JSON.stringify(ccWanted), people("campaign_contacts"));
  check("migration: history by key, then contact, keyed lines only", JSON.stringify(people("enrollment_history")) === JSON.stringify(hWanted), people("enrollment_history"));
  const keys = c.querySync("SELECT COUNT(*) AS n FROM campaign_contacts WHERE external_key IS NOT NULL")[0] as { n: string };
  check("migration: lead keys kept", Number(keys.n) === 5, keys);

  c.querySync(migrations);
  check("migration: idempotent", JSON.stringify(people("campaign_contacts")) === JSON.stringify(ccWanted), people("campaign_contacts"));

  // the previous Azerit enrolls by key after the deployment: taken at the next start
  c.querySync("INSERT INTO contacts (id, linkedin) VALUES (7, 'in/c7'); INSERT INTO campaign_contacts (id, campaign_id, contact_id, status, external_key) VALUES (8, 1, 7, 'held', 'k1')");
  c.querySync(migrations);
  check("migration: a key-only enrollment made later, at the next start", people("campaign_contacts")[8] === 1, people("campaign_contacts"));
  // without lead_people (dropped by Azerit's migration): the contact decides
  c.querySync("DROP TABLE public.lead_people; INSERT INTO campaign_contacts (id, campaign_id, contact_id, status, external_key) VALUES (9, 2, 6, 'held', 'k9')");
  c.querySync(migrations);
  const after = people("campaign_contacts");
  check("migration: without lead_people, the contact", after[9] === 60, after);
  check("migration: earlier choices unchanged", after[2] === 2 && after[3] === 30 && after[4] === null, after);

  const previous = process.argv[2];
  if (previous) {
    let error = "";
    try {
      c.querySync(fs.readFileSync(previous, "utf8"));
      c.querySync(fs.readFileSync(previous, "utf8"));
      c.querySync(migrations);
    } catch (e) {
      error = (e as Error).message;
    }
    check("migration: the previous migrations replay on the migrated base, then these again", !error, error);
    const cols = c.querySync(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'sequence'
         AND table_name IN ('campaign_contacts', 'enrollment_history') AND column_name IN ('external_key', 'person_id') ORDER BY 1, 2`
    ) as Array<{ table_name: string; column_name: string }>;
    check("migration: external_key and person_id on both tables", cols.length === 4, cols);
  }
  c.end();
}

const { db } = await import("../src/db.js");
const { createServer } = await import("../src/server.js");
const { importContacts } = await import("../src/services/contacts.js");
const { archiveEnrollments } = await import("../src/services/history.js");

const OWNER = "azerit:u:1";
const server = createServer().listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/svc`;

async function call(method: string, p: string, body?: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const target = method === "GET" ? `${base}${p}${p.includes("?") ? "&" : "?"}owner=${encodeURIComponent(OWNER)}` : base + p;
  const r = await fetch(target, {
    method,
    headers: { "content-type": "application/json", "x-service-key": KEY },
    body: method === "GET" ? undefined : JSON.stringify({ owner: OWNER, ...body }),
  });
  return { status: r.status, json: await r.json() };
}
const li = (slug: string) => `https://www.linkedin.com/in/${slug}`;
const ccs = (campaign: number) =>
  (db.prepare("SELECT id, contact_id, status, person_id, external_key FROM campaign_contacts WHERE campaign_id = ? ORDER BY id").all(campaign) as Array<{
    id: number;
    contact_id: number;
    status: string;
    person_id: number | null;
    external_key: string | null;
  }>).map((r) => ({ ...r, id: Number(r.id), person_id: r.person_id == null ? null : Number(r.person_id) }));

try {
  const steps = [
    { channel: "linkedin", li_action: "invite", body: "" },
    { channel: "linkedin", li_action: "message", body: "Bonjour {{first_name}} {{perso}}", wait_days: 1 },
  ];
  const made = await call("POST", "/campaigns", { external_ref: "job:1", name: "Poste", steps });
  const job = Number(made.json.id);
  check("campaign created", made.status === 200 && job > 0, made);

  // Prospection (Offres) for the same owner: Bob's contact belongs to person 202
  const prosp = Number(
    db.prepare("INSERT INTO campaigns (name, status, owner_ref) VALUES ('Offres', 'paused', ?)").run(OWNER).lastInsertRowid
  );
  const bob = (await importContacts(prosp, [{ linkedin: li("bob"), first_name: "Bob" }], { withIds: true })).contact_ids![0]!;
  db.prepare("UPDATE contacts SET person_id = 202 WHERE id = ?").run(bob);

  // 1. new form
  let r = await call("POST", `/campaigns/${job}/hold`, {
    contacts: [{ person_id: 101, key: "k101", first_name: "Ada", linkedin: li("ada"), vars: { perso: "un" } }],
  });
  const ada = r.json.results?.[0];
  check("hold: new form held, key and person in the result", ada?.status === "held" && ada.key === "k101" && ada.person_id === 101 && ada.cc_id > 0, r.json);
  check("hold: enrollment carries person and key", ccs(job).some((c) => c.id === ada?.cc_id && c.person_id === 101 && c.external_key === "k101"), ccs(job));

  // 2. same person again, another LinkedIn: her enrollment back, nothing created
  r = await call("POST", `/campaigns/${job}/hold`, {
    contacts: [{ person_id: "101", key: "k101-github", first_name: "Ada", linkedin: li("ada-2"), vars: { perso: "deux" } }],
  });
  check("hold twice: same enrollment", r.json.results?.[0]?.cc_id === ada?.cc_id && r.json.results[0].status === "held", r.json);
  check("hold twice: one enrollment for the person", ccs(job).filter((c) => c.person_id === 101).length === 1, ccs(job));
  check("hold twice: no contact for the other LinkedIn", !db.prepare("SELECT 1 FROM contacts WHERE linkedin = ?").get(li("ada-2")));
  check("hold twice: vars rewritten, first key kept", ccs(job).find((c) => c.person_id === 101)?.external_key === "k101" && (db.prepare("SELECT vars FROM campaign_contacts WHERE id = ?").get(ada?.cc_id) as { vars: string }).vars.includes("deux"), ccs(job));

  // 3. on another person's contact (Bob = 202 in prospection): the enrollment is 303's
  r = await call("POST", `/campaigns/${job}/hold`, { contacts: [{ person_id: 303, key: "k303", first_name: "Bobby", linkedin: li("bob") }] });
  const p303 = r.json.results?.[0];
  check("hold on another person's contact: held, signalled", p303?.status === "held" && p303.contact_person_id === 202, r.json);
  check("hold on another person's contact: contact keeps its person", Number((db.prepare("SELECT person_id FROM contacts WHERE id = ?").get(bob) as { person_id: number }).person_id) === 202);
  r = await call("POST", `/campaigns/${job}/launch`, { person_ids: [303], keys: ["k303"] });
  check("launch by person on a shared contact", JSON.stringify(r.json.launched) === "[303]", r.json);
  r = await call("POST", `/campaigns/${job}/vars`, { person_id: 303, key: "k303", vars: { perso: "trois" } });
  check("vars by person on a shared contact", r.status === 200 && r.json.ok === true, r.json);
  check("vars written", (db.prepare("SELECT vars FROM campaign_contacts WHERE id = ?").get(p303?.cc_id) as { vars: string }).vars.includes("trois"));
  // a sent invitation, so that removing the enrollment leaves a history line
  db.prepare("INSERT INTO li_actions (campaign_contact_id, step_number, linkedin, type, status, sent_at) VALUES (?, 1, ?, 'invite', 'sent', 5)").run(p303?.cc_id, li("bob"));
  r = await call("POST", `/campaigns/${job}/stop`, { person_ids: [303], keys: ["k303"] });
  check("stop by person on a shared contact", r.json.stopped === 1, r.json);
  archiveEnrollments("cc.id = ?", p303?.cc_id);
  const h = db.prepare("SELECT person_id, external_key FROM enrollment_history WHERE contact_id = ?").get(bob) as
    | { person_id: number; external_key: string }
    | undefined;
  check("history: the enrollment's person and key, not the contact's", Number(h?.person_id) === 303 && h?.external_key === "k303", h);

  // 4. another person on a contact already enrolled here for someone: refused
  await call("POST", `/campaigns/${job}/hold`, { contacts: [{ person_id: 505, key: "k505", linkedin: li("dora") }] });
  r = await call("POST", `/campaigns/${job}/hold`, { contacts: [{ person_id: 606, key: "k606", linkedin: li("dora") }] });
  check("hold on a contact enrolled for another person: refused", r.json.results?.[0]?.status === "rejected" && r.json.results[0].enrolled_person_id === 505, r.json);

  // 5. the same person twice in one request, a row with neither person nor key
  r = await call("POST", `/campaigns/${job}/hold`, {
    contacts: [{ person_id: 707, key: "k707", linkedin: li("eve") }, { person_id: 707, key: "k707", linkedin: li("eve") }, { linkedin: li("x") }],
  });
  const statuses = (r.json.results as Array<{ status: string }>).map((x) => x.status).sort();
  check("hold: duplicate person and empty row refused", JSON.stringify(statuses) === '["held","rejected","rejected"]', r.json);

  // 6. a person enrolled twice (older base): launched once, not twice
  await call("POST", `/campaigns/${job}/hold`, { contacts: [{ person_id: 404, key: "k404", linkedin: li("finn") }] });
  await call("POST", `/campaigns/${job}/hold`, { contacts: [{ key: "k404-old", linkedin: li("finn-old") }] });
  db.prepare("UPDATE campaign_contacts SET person_id = 404 WHERE campaign_id = ? AND external_key = 'k404-old'").run(job);
  r = await call("POST", `/campaigns/${job}/launch`, { person_ids: [404] });
  const twice = ccs(job).filter((c) => c.person_id === 404).map((c) => c.status);
  check("launch: one of a person's two enrollments", JSON.stringify(r.json.launched) === "[404]" && JSON.stringify(twice) === '["pending","held"]', { r: r.json, twice });
  r = await call("POST", `/campaigns/${job}/launch`, { person_ids: [404] });
  check("launch: not the second one", JSON.stringify(r.json.launched) === "[]", r.json);

  // 7. the previous Azerit: keys only, as before
  r = await call("POST", `/campaigns/${job}/hold`, { contacts: [{ key: "kold", first_name: "Carl", linkedin: li("carl"), vars: { perso: "x" } }] });
  check("old form: held by key", r.json.results?.[0]?.status === "held" && r.json.results[0].key === "kold", r.json);
  check("old form: no person on the enrollment", ccs(job).find((c) => c.external_key === "kold")?.person_id === null);
  r = await call("POST", `/campaigns/${job}/launch`, { keys: ["kold", "unknown"] });
  check("old form: launch by key", JSON.stringify(r.json.launched) === '["kold"]', r.json);
  r = await call("POST", `/campaigns/${job}/vars`, { key: "kold", vars: { perso: "y" } });
  check("old form: vars by key", r.status === 200 && r.json.ok === true, r.json);
  r = await call("POST", `/campaigns/${job}/vars`, { key: "unknown", vars: { perso: "y" } });
  check("old form: vars of an unknown key → 404", r.status === 404, r);
  r = await call("POST", `/campaigns/${job}/stop`, { keys: ["kold"] });
  check("old form: stop by key", r.json.stopped === 1, r.json);
  r = await call("POST", `/campaigns/${job}/launch`, {});
  check("launch without keys nor person_ids → 400", r.status === 400, r);
  r = await call("POST", `/campaigns/${job}/launch`, { person_ids: ["x"] });
  check("launch with a bad person_id → 400", r.status === 400, r);

  // 7b. keys beside person_ids reach the enrollments of the previous Azerit left without a person
  const loose = async (key: string, slug: string) => {
    const x = await call("POST", `/campaigns/${job}/hold`, { contacts: [{ key, linkedin: li(slug) }] });
    return Number(x.json.results?.[0]?.cc_id);
  };
  const row = (id: number) => ccs(job).find((c) => c.id === id);
  // stop, two people asked: every running one under their keys stopped, none tied
  const amb = await loose("kamb", "hal");
  r = await call("POST", `/campaigns/${job}/stop`, { person_ids: [901, 902], keys: ["kamb", "kx"] });
  check("stop, two people: the enrollment without a person under their keys stopped", r.json.stopped === 1 && row(amb)?.status === "stopped", { r: r.json, row: row(amb) });
  check("stop, two people: not tied to either", row(amb)?.person_id === null, row(amb));
  // stop, one person: stopped and tied
  const st = await loose("ks", "sam");
  await call("POST", `/campaigns/${job}/launch`, { keys: ["ks"] });
  r = await call("POST", `/campaigns/${job}/stop`, { person_ids: [941], keys: ["ks"] });
  check("stop, one person: stopped and tied to her", r.json.stopped === 1 && row(st)?.status === "stopped" && row(st)?.person_id === 941, { r: r.json, row: row(st) });
  // launch, two people asked: which key is whose is unknown, held and returned
  const lu = await loose("ku1", "uma");
  r = await call("POST", `/campaigns/${job}/launch`, { person_ids: [911, 912], keys: ["ku1"] });
  check("launch, two people: nothing launched by key, returned in unresolved", JSON.stringify(r.json.launched) === "[]" && r.json.unresolved?.length === 1 && r.json.unresolved[0].key === "ku1" && r.json.unresolved[0].cc_id === lu, r.json);
  check("launch, two people: still held, without a person", row(lu)?.status === "held" && row(lu)?.person_id === null, row(lu));
  // launch, one person: tied, launched as hers
  r = await call("POST", `/campaigns/${job}/launch`, { person_ids: [911], keys: ["ku1"] });
  check("launch, one person: tied and launched", JSON.stringify(r.json.launched) === "[911]" && !r.json.unresolved && row(lu)?.status === "pending" && row(lu)?.person_id === 911, { r: r.json, row: row(lu) });
  // launch, one person who already has her enrollment: hers goes, the other is returned, not tied
  await call("POST", `/campaigns/${job}/hold`, { contacts: [{ person_id: 921, key: "k921", linkedin: li("vic") }] });
  const lv = await loose("k921-old", "vic-old");
  r = await call("POST", `/campaigns/${job}/launch`, { person_ids: [921], keys: ["k921", "k921-old"] });
  check("launch, enrolled person: hers launched, the other returned", JSON.stringify(r.json.launched) === "[921]" && r.json.unresolved?.[0]?.cc_id === lv, r.json);
  check("launch, enrolled person: one enrollment for her, the other untouched", ccs(job).filter((c) => c.person_id === 921).length === 1 && row(lv)?.status === "held" && row(lv)?.person_id === null, ccs(job));
  // vars: the key is hers, tied and written
  const vv = await loose("kv", "wes");
  r = await call("POST", `/campaigns/${job}/vars`, { person_id: 931, key: "kv", vars: { perso: "quatre" } });
  check("vars by person, enrollment without a person under her key: written and tied", r.status === 200 && row(vv)?.person_id === 931 && (db.prepare("SELECT vars FROM campaign_contacts WHERE id = ?").get(vv) as { vars: string }).vars.includes("quatre"), { r: r.json, row: row(vv) });
  r = await call("POST", `/campaigns/${job}/vars`, { person_id: 932, key: "unknown", vars: { perso: "x" } });
  check("vars by person, nothing under person nor key → 404", r.status === 404, r);
  // hold by person: her key's enrollment without a person comes back, no second one
  const hh = await loose("kh", "lou");
  r = await call("POST", `/campaigns/${job}/hold`, { contacts: [{ person_id: 971, key: "kh", linkedin: li("lou-2"), vars: { perso: "cinq" } }] });
  check("hold by person, her key's enrollment without a person: the same one, tied", r.json.results?.[0]?.cc_id === hh && r.json.results[0].status === "held" && row(hh)?.person_id === 971, { r: r.json, row: row(hh) });
  check("hold by person, her key's enrollment: no contact for the other LinkedIn", !db.prepare("SELECT 1 FROM contacts WHERE linkedin = ?").get(li("lou-2")));
  // two people with the same key in one request: the first takes it, the second is refused
  const hd = await loose("kd", "max");
  r = await call("POST", `/campaigns/${job}/hold`, {
    contacts: [{ person_id: 981, key: "kd", linkedin: li("max-2") }, { person_id: 982, key: "kd", linkedin: li("max-3") }],
  });
  check("hold, one key for two people: the first gets it", r.json.results?.[0]?.cc_id === hd && row(hd)?.person_id === 981, { r: r.json, row: row(hd) });
  check("hold, one key for two people: the second refused", r.json.results?.[1]?.status === "rejected" && r.json.results[1].enrolled_person_id === 981, r.json);

  // 7c. the lead key of a held enrollment: kept when found by person, written when it had none,
  // written over when found by contact (as before 7 Nov 2026)
  r = await call("POST", `/campaigns/${job}/hold`, { contacts: [{ person_id: 951, key: "k951a", linkedin: li("ivy") }] });
  await call("POST", `/campaigns/${job}/hold`, { contacts: [{ person_id: 951, key: "k951b", linkedin: li("ivy-2") }] });
  check("key: kept when found by person", row(Number(r.json.results?.[0]?.cc_id))?.external_key === "k951a", ccs(job));
  r = await call("POST", `/campaigns/${job}/launch`, { keys: ["k951a"] });
  check("key: the previous Azerit still launches by the first", JSON.stringify(r.json.launched) === '["k951a"]', r.json);
  r = await call("POST", `/campaigns/${job}/hold`, { contacts: [{ person_id: 961, linkedin: li("kim") }] });
  const nk = Number(r.json.results?.[0]?.cc_id);
  await call("POST", `/campaigns/${job}/hold`, { contacts: [{ person_id: 961, key: "k961", linkedin: li("kim") }] });
  check("key: written when the enrollment had none", row(nk)?.external_key === "k961", row(nk));
  const oc = await loose("kc1", "jo");
  await loose("kc2", "jo");
  check("key: written over when found by contact (old form)", row(oc)?.external_key === "kc2", row(oc));

  // 8. enroll (launches at once)
  r = await call("POST", `/campaigns/${job}/enroll`, { contacts: [{ person_id: 808, key: "k808", linkedin: li("gus") }] });
  check("enroll: pending", r.json.results?.[0]?.status === "pending", r.json);
  r = await call("POST", `/campaigns/${job}/enroll`, { contacts: [{ person_id: 808, key: "k808", linkedin: li("gus") }] });
  check("enroll twice: same enrollment, already launched", r.json.results?.[0]?.error === "déjà lancé" && ccs(job).filter((c) => c.person_id === 808).length === 1, r.json);

  // 9. lists: key and person, Azerit's enrollments only
  const listed = await call("GET", `/campaigns/${job}/contacts`);
  const rows = listed.json.contacts as Array<{ key: string | null; person_id: number | null }>;
  check("contacts: key and person", rows.some((x) => x.key === "k303" && x.person_id === 303) && rows.some((x) => x.key === "kold" && x.person_id === null), rows);
  check("contacts: never the contact's person", !rows.some((x) => x.person_id === 202), rows);
  const camp = await call("GET", `/campaigns/${job}`);
  check("campaign: key, person and vars", (camp.json.contacts as Array<any>).some((x) => x.key === "k303" && x.person_id === 303 && x.vars.perso === "trois"), camp.json.contacts);
  check("campaign: as many lines as the contacts list", camp.json.contacts.length === rows.length, { camp: camp.json.contacts.length, rows: rows.length });

  // 10. the prospection campaign of the same owner: invisible to Azerit, even with a person on its contact
  const pl = await call("GET", `/campaigns/${prosp}/contacts`);
  check("prospection: no candidate listed", pl.json.contacts?.length === 0, pl.json);
  const pc = await call("GET", `/campaigns/${prosp}`);
  check("prospection: no candidate in the campaign", pc.json.contacts?.length === 0, pc.json);
  r = await call("POST", `/campaigns/${prosp}/launch`, { person_ids: [202] });
  check("prospection: not launched by person", JSON.stringify(r.json.launched) === "[]" && ccs(prosp)[0].status === "held", r.json);
  r = await call("POST", `/campaigns/${prosp}/stop`, { person_ids: [202] });
  check("prospection: not stopped by person", r.json.stopped === 0, r.json);
} catch (e) {
  failures.push(`stopped: ${(e as Error).stack}`);
}
server.close();
console.log(`${mode}: ${passed} ok, ${failures.length} failed`);
for (const f of failures) console.log(`  FAILED ${f}`);
process.exit(failures.length ? 1 : 0);
