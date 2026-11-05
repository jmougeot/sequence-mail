/**
 * Memory of deleted enrollments. Removing contacts from a campaign or deleting a campaign cascades
 * to their LinkedIn actions and emails: without a trace, a candidate Azerit had contacted would go
 * back to "never contacted". Before such a DELETE, one line per enrollment that had activity
 * (invite or message sent, email sent, reply) goes to enrollment_history, append only.
 */
import { db } from "../db.js";

/**
 * Copies the enrollments matched by `where` (alias cc = campaign_contacts) into the history. Call
 * it in the same transaction as the DELETE it precedes.
 */
export function archiveEnrollments(where: string, ...params: unknown[]): number {
  const { changes } = db
    .prepare(
      `INSERT INTO enrollment_history (campaign_id, owner_ref, external_ref, contact_id, external_key, status,
         invited_at, messaged_at, emailed_at, replied_at, removed_at)
       SELECT * FROM (
         SELECT cc.campaign_id, cp.owner_ref, cp.external_ref, cc.contact_id, cc.external_key, cc.status,
           (SELECT MIN(a.sent_at) FROM li_actions a WHERE a.campaign_contact_id = cc.id AND a.type = 'invite' AND a.status = 'sent') AS invited_at,
           (SELECT MAX(a.sent_at) FROM li_actions a WHERE a.campaign_contact_id = cc.id AND a.type = 'message' AND a.status = 'sent') AS messaged_at,
           (SELECT MAX(m.sent_at) FROM messages m WHERE m.campaign_contact_id = cc.id) AS emailed_at,
           cc.replied_at, CAST(? AS BIGINT) AS removed_at
         FROM campaign_contacts cc JOIN campaigns cp ON cp.id = cc.campaign_id
         WHERE ${where}
       ) h
       WHERE h.invited_at IS NOT NULL OR h.messaged_at IS NOT NULL OR h.emailed_at IS NOT NULL
          OR h.replied_at IS NOT NULL OR h.status IN ('replied', 'opted_out')`
    )
    .run(Date.now(), ...params);
  return changes;
}
