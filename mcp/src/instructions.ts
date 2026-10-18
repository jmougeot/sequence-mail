/**
 * Usage guide sent to every MCP client at initialization (`instructions` field):
 * safety rules, ids, flows.
 *
 * Keep it under 2,000 characters, safety first: clients truncate longer guides
 * (Claude Code cuts at 2,048) and the end is then never read.
 */
export const INSTRUCTIONS = `Sequence Mail: multichannel outreach (Gmail emails + LinkedIn), driven by these tools.

SAFETY (mandatory)
- EXPLICIT user approval, after a preview (preview_campaign, dry_run, contact count), before: launch_contacts, resume_campaign, reply_to_contact and send_test_email with dry_run: false, remove_contacts, set_contacts_status opted_out, rotate_linkedin_token, any delete_*.
- Never launch more contacts than asked (all_held with limit); state the count first.
- An approval covers the action shown, not the next ones.
- To put a campaign away: archive_campaign. delete_campaign only on an explicit request for permanent deletion.

IDS
- contact_id = global contact (update_contact, preview_email, send_test_email).
- cc_id = a contact's enrollment in ONE campaign (launch/stop/remove_contacts, set_contacts_status, get_conversation, reply_to_contact).
- Never invent an id: read it (list_campaign_contacts, list_replies, search_contacts).

CAMPAIGN
1. list_accounts, list_linkedin_accounts: sending accounts.
2. create_campaign, with description and contacts: starts paused, contacts "held", nothing is sent. Add more: import_contacts, import_contacts_csv.
3. preview_campaign: empty variables across all contacts, rendered steps.
4. launch_contacts (one or more campaigns); resume_campaign if paused.
get_settings: server timezone, send window, next send. Edit: update_step (one step), update_campaign. A contact goes in the campaign whose description (list_campaigns) fits it. Tracking: list_campaigns, list_campaign_contacts (paginated), get_activity.

REPLIES
list_replies (include_text) → get_conversation → reply_to_contact (dry_run first).

Results: missing field = empty; missing list_campaigns counter = 0.
Outside Claude: connect_google_account gives an OAuth link to open; create_linkedin_account, a token to paste into the Chrome extension.`;
