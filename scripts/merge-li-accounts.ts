/**
 * One LinkedIn account per LinkedIn profile: merges the dashboard's (ownerless) account into the
 * owner's account that sends from the same profile. The server does it by itself (start-up, every
 * few minutes, session hand-over) for the owners of LI_DASHBOARD_OWNERS; this script is the manual,
 * verbose way (see src/services/li-consolidate.ts for the rules).
 *
 *   DATA_DIR=… npx tsx scripts/merge-li-accounts.ts [--owner azerit:u:1]          # dry run: nothing is written
 *   DATA_DIR=… npx tsx scripts/merge-li-accounts.ts [--owner azerit:u:1] --apply  # backs the base up, then merges
 *
 * --owner: owners allowed to absorb a dashboard account (comma-separated; default LI_DASHBOARD_OWNERS).
 */
import path from "node:path";
import { config } from "../src/config.js";
import { db } from "../src/db.js";
import { consolidateProfiles } from "../src/services/li-consolidate.js";

const apply = process.argv.includes("--apply");
const i = process.argv.indexOf("--owner");
const owners = i >= 0 ? process.argv[i + 1].split(",").map((s) => s.trim()).filter(Boolean) : config.linkedin.dashboardOwners;
if (!owners.length) {
  console.log("No owner: pass --owner <owner_ref> or set LI_DASHBOARD_OWNERS.");
  process.exit(1);
}

if (apply) {
  const backup = path.join(path.dirname(db.name), `backup-${new Date().toISOString().replace(/[:.]/g, "-")}-pre-merge-li.db`);
  db.prepare("VACUUM INTO ?").run(backup);
  console.log(`Backup: ${backup}`);
}
const { merged, skipped } = consolidateProfiles({ owners, dryRun: !apply });
for (const m of merged) {
  console.log(
    `#${m.from.id} ${m.from.name} → #${m.into.id} ${m.into.name} (${m.profile}): ${m.actions} actions, ${m.sends} sends, ${m.contacts} contacts, ` +
      `${m.campaigns} campaign(s); dashboard campaigns ${m.serves_dashboard ? "served" : "NOT served (merged account was inactive)"}`
  );
}
for (const s of skipped) console.log(`left alone — ${s}`);
if (!merged.length) console.log("Nothing to merge.");
else console.log(apply ? "Merged." : "Dry run: nothing written. Add --apply to merge.");
