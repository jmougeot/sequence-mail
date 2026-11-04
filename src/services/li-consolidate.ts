/**
 * One LinkedIn account per LinkedIn profile.
 *
 * A profile linked from the dashboard (ownerless account) and from Azerit (owner account) ends up
 * with two accounts. The dashboard's is merged into the owner's, which then takes the dashboard's
 * campaigns too (serves_dashboard). Only owners listed in LI_DASHBOARD_OWNERS may absorb one: a
 * client's account never takes the dashboard's campaigns.
 *
 * Run at start-up, regularly, and when Azerit hands a session over (and by
 * scripts/merge-li-accounts.ts). Safe at any time: the merged account's actions, sends and
 * contacts move to the kept one and its token stays valid (li_token_aliases), so an action leased
 * before the merge is reported with the same token to the same account.
 */
import { config } from "../config.js";
import { db } from "../db.js";

export interface Merge {
  profile: string;
  from: { id: number; name: string };
  into: { id: number; name: string };
  actions: number;
  sends: number;
  contacts: number;
  campaigns: number;
  serves_dashboard: boolean;
}

interface Row {
  id: number;
  name: string;
  owner_ref: string | null;
  member_slug: string;
  token_hash: string;
  active: number;
  paused_until: number | null;
  next_allowed_at: number | null;
}

class DryRun extends Error {}

const count = (table: string, id: number) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE li_account_id = ?`).get(id) as { n: number }).n;

export function consolidateProfiles(opts: { owners?: string[]; profile?: string; dryRun?: boolean } = {}): { merged: Merge[]; skipped: string[] } {
  const owners = opts.owners ?? config.linkedin.dashboardOwners;
  const merged: Merge[] = [];
  const skipped: string[] = [];
  if (!owners.length) return { merged, skipped };

  const rows = db
    .prepare(
      `SELECT id, name, owner_ref, member_slug, token_hash, active, paused_until, next_allowed_at
       FROM li_accounts WHERE member_slug IS NOT NULL ${opts.profile ? "AND member_slug = ?" : ""} ORDER BY id`
    )
    .all(...(opts.profile ? [opts.profile] : [])) as Row[];

  for (const old of rows.filter((a) => a.owner_ref == null)) {
    const keepers = rows.filter((a) => a.member_slug === old.member_slug && a.owner_ref != null && owners.includes(a.owner_ref));
    if (keepers.length !== 1) {
      if (keepers.length) skipped.push(`#${old.id} ${old.name} (${old.member_slug}): ${keepers.length} accounts of dashboard owners on that profile`);
      continue;
    }
    const keep = keepers[0];
    if (db.prepare("SELECT 1 FROM li_actions WHERE li_account_id = ? AND status = 'sending'").get(old.id)) {
      skipped.push(`#${old.id} ${old.name} (${old.member_slug}): an action is being sent, merged at the next pass`);
      continue;
    }
    try {
      db.transaction(() => {
        const moved = { actions: count("li_actions", old.id), sends: count("li_log", old.id), contacts: count("campaign_contacts", old.id) };
        for (const table of ["li_actions", "li_log", "campaign_contacts"]) {
          db.prepare(`UPDATE ${table} SET li_account_id = ? WHERE li_account_id = ?`).run(keep.id, old.id);
        }
        let campaigns = 0;
        const withOld = db
          .prepare("SELECT id, li_account_ids FROM campaigns WHERE li_account_ids IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(li_account_ids) WHERE value = CAST(? AS TEXT))")
          .all(old.id) as Array<{ id: number; li_account_ids: string }>;
        for (const c of withOld) {
          const ids = [...new Set((JSON.parse(c.li_account_ids) as number[]).map((x) => (x === old.id ? keep.id : x)))];
          db.prepare("UPDATE campaigns SET li_account_ids = ? WHERE id = ?").run(JSON.stringify(ids), c.id);
          campaigns++;
        }
        db.prepare("INSERT INTO li_token_aliases (token_hash, li_account_id) VALUES (?, ?) ON CONFLICT (token_hash) DO UPDATE SET li_account_id = excluded.li_account_id").run(old.token_hash, keep.id);
        // Aliases that pointed to the merged account follow it.
        db.prepare("UPDATE li_token_aliases SET li_account_id = ? WHERE li_account_id = ?").run(keep.id, old.id);
        // The kept account serves the dashboard's campaigns only if the merged one did, and must not act
        // earlier or resume sooner than the merged one would have.
        db.prepare(
          `UPDATE li_accounts SET serves_dashboard = MAX(serves_dashboard, ?), paused_until = MAX(COALESCE(paused_until, 0), ?),
             next_allowed_at = MAX(COALESCE(next_allowed_at, 0), ?) WHERE id = ?`
        ).run(old.active ? 1 : 0, old.paused_until ?? 0, old.next_allowed_at ?? 0, keep.id);
        db.prepare("DELETE FROM li_accounts WHERE id = ?").run(old.id);
        merged.push({
          profile: old.member_slug,
          from: { id: old.id, name: old.name },
          into: { id: keep.id, name: keep.name },
          ...moved,
          campaigns,
          serves_dashboard: Boolean(old.active),
        });
        if (opts.dryRun) throw new DryRun();
      })();
    } catch (e) {
      if (!(e instanceof DryRun)) throw e;
    }
  }
  return { merged, skipped };
}
