/**
 * Désinscriptions, rangées par propriétaire. La base de contacts est partagée
 * entre le tableau de bord (owner_ref NULL) et les clients d'Azerit
 * (« azerit:u:12 »…) : un candidat qui répond « pas intéressé » au poste d'un
 * client ne doit pas disparaître des campagnes des autres, qui n'en sauraient
 * rien. Un refus vaut donc pour le propriétaire de la campagne où il a été
 * exprimé, et pour lui seul :
 *   - tableau de bord : contacts.do_not_contact (la liste historique) ;
 *   - client          : une ligne de owner_opt_outs.
 */
import { db } from "../db.js";
import { cancelLinkedInActions } from "./outreach.js";

/**
 * Condition SQL « ce contact accepte encore les envois de cette campagne »
 * (alias attendus : c = contacts, cp = campaigns).
 */
export const NOT_OPTED_OUT = `(CASE WHEN cp.owner_ref IS NULL THEN c.do_not_contact = 0
  ELSE NOT EXISTS (SELECT 1 FROM owner_opt_outs oo WHERE oo.owner_ref = cp.owner_ref AND oo.contact_id = c.id) END)`;

/** Le contact s'est-il désinscrit auprès de ce propriétaire ? */
export function isOptedOut(contactId: number, ownerRef: string | null): boolean {
  if (ownerRef == null) {
    const row = db.prepare("SELECT do_not_contact FROM contacts WHERE id = ?").get(contactId) as
      | { do_not_contact: number }
      | undefined;
    return Boolean(row?.do_not_contact);
  }
  return Boolean(db.prepare("SELECT 1 FROM owner_opt_outs WHERE owner_ref = ? AND contact_id = ?").get(ownerRef, contactId));
}

/**
 * Désinscrit le contact d'une inscription auprès du propriétaire de sa
 * campagne, et arrête ses autres séquences en cours chez ce même propriétaire
 * (actions LinkedIn en file annulées). L'inscription elle-même garde le statut
 * que l'appelant lui a donné (opted_out, bounced…).
 */
export function optOutFromCampaignOf(ccId: number, reason: string): void {
  const cc = db
    .prepare("SELECT cc.contact_id, cp.owner_ref FROM campaign_contacts cc JOIN campaigns cp ON cp.id = cc.campaign_id WHERE cc.id = ?")
    .get(ccId) as { contact_id: number; owner_ref: string | null } | undefined;
  if (!cc) return;
  db.transaction(() => {
    if (cc.owner_ref == null) {
      db.prepare("UPDATE contacts SET do_not_contact = 1 WHERE id = ?").run(cc.contact_id);
    } else {
      db.prepare("INSERT OR IGNORE INTO owner_opt_outs (owner_ref, contact_id, reason) VALUES (?, ?, ?)").run(
        cc.owner_ref,
        cc.contact_id,
        reason.slice(0, 200)
      );
    }
    const others = db
      .prepare(
        `SELECT cc.id FROM campaign_contacts cc JOIN campaigns cp ON cp.id = cc.campaign_id
         WHERE cc.contact_id = ? AND cp.owner_ref IS ? AND cc.id <> ?
           AND cc.status IN ('held', 'pending', 'in_progress', 'awaiting_li')`
      )
      .all(cc.contact_id, cc.owner_ref, ccId) as Array<{ id: number }>;
    const stop = db.prepare("UPDATE campaign_contacts SET status = 'stopped', next_send_at = NULL, error = ? WHERE id = ?");
    for (const { id } of others) {
      stop.run(`désinscrit (${reason})`.slice(0, 300), id);
      cancelLinkedInActions("campaign_contact_id = ?", id, "contact désinscrit");
    }
    cancelLinkedInActions("campaign_contact_id = ?", ccId, `désinscrit (${reason})`);
  })();
}
