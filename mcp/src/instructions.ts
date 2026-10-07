/**
 * Guide d'utilisation envoyé à tout client MCP à l'initialisation
 * (champ `instructions`) : règles de sécurité, identifiants, flux.
 *
 * Rester sous 2 000 caractères, sécurité en tête : les clients tronquent un
 * guide plus long (Claude Code le coupe à 2 048) et la fin n'est alors pas lue.
 */
export const INSTRUCTIONS = `Sequence Mail : prospection multicanale (emails Gmail + LinkedIn), pilotable par ces tools.

SÉCURITÉ (obligatoire)
- Accord EXPLICITE de l'utilisateur, après un aperçu (preview_campaign, dry_run, nombre de contacts), avant : launch_contacts, resume_campaign, reply_to_contact et send_test_email en dry_run: false, remove_contacts, set_contacts_status opted_out, rotate_linkedin_token, tout delete_*.
- Jamais plus de contacts lancés que demandé (all_held avec limit) ; annoncer le nombre avant.
- Un accord vaut pour l'action montrée, pas pour les suivantes.
- Ranger une campagne : archive_campaign. delete_campaign seulement sur demande explicite de suppression définitive.

IDENTIFIANTS
- contact_id = contact global (update_contact, preview_email, send_test_email).
- cc_id = inscription d'un contact à UNE campagne (launch/stop/remove_contacts, set_contacts_status, get_conversation, reply_to_contact).
- Ne jamais inventer un id : le lire (list_campaign_contacts, list_replies, search_contacts).

CAMPAGNE
1. list_accounts, list_linkedin_accounts : comptes d'envoi.
2. create_campaign, contacts compris : naît en pause, contacts en « held », rien ne part. Ajouts : import_contacts, import_contacts_csv.
3. preview_campaign : variables vides sur tous les contacts, rendu des étapes.
4. launch_contacts (une ou plusieurs campagnes) ; resume_campaign si elle est en pause.
get_settings : fuseau du serveur, fenêtre d'envoi, prochain envoi. Modifier : update_step (une étape), update_campaign. Suivi : list_campaigns, list_campaign_contacts (paginé), get_activity.

RÉPONSES
list_replies (include_text) → get_conversation → reply_to_contact (dry_run d'abord).

Résultats : champ absent = vide ; compteur absent de list_campaigns = 0.
Hors Claude : connect_google_account donne un lien OAuth à ouvrir ; create_linkedin_account, un jeton à coller dans l'extension Chrome.`;
