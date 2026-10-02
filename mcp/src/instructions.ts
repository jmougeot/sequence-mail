/**
 * Guide d'utilisation envoyé à tout client MCP à l'initialisation
 * (champ `instructions`) : flux, identifiants, règles de sécurité.
 */
export const INSTRUCTIONS = `Sequence Mail : prospection multicanale (emails Gmail + LinkedIn), pilotable entièrement par ces tools, comme lemlist.

IDENTIFIANTS
- contact_id = le contact global (update_contact, preview_email, send_test_email).
- cc_id = l'inscription d'un contact à UNE campagne (launch_contacts, stop_contacts, set_contacts_status, remove_contacts, get_conversation, reply_to_contact).
- list_campaign_contacts, list_replies et search_contacts donnent les deux. Ne jamais inventer un id : le relire avec un tool de lecture.

CAMPAGNE
1. list_accounts / list_linkedin_accounts : comptes d'envoi disponibles.
2. create_campaign : naît en pause, sans contact.
3. import_contacts (liste JSON) ou import_contacts_csv (texte ou fichier local) : contacts en « held », rien ne part.
4. preview_email, puis send_test_email (dry_run d'abord) pour valider le rendu.
5. launch_contacts (cc_ids, ou all_held + limit) : contacts en « pending », la campagne repasse active.
6. resume_campaign si la campagne est en pause. Les envois suivent la fenêtre d'envoi, les quotas et le warm-up.
Suivi : list_campaigns, list_campaign_contacts (filtres status/search, paginé : ne pas tout charger), get_activity, export_campaign_contacts.

RÉPONSES
list_replies (include_text: true pour lire les réponses) → get_conversation (cc_id) → reply_to_contact (dry_run par défaut, puis dry_run: false). Une demande de désinscription : set_contacts_status opted_out.

SÉCURITÉ (obligatoire)
- Avant toute action qui envoie ou détruit : montrer un aperçu (preview_email, dry_run, nombre de contacts concernés) et obtenir l'accord EXPLICITE de l'utilisateur pour : launch_contacts, resume_campaign, reply_to_contact et send_test_email en envoi réel (dry_run: false), delete_campaign, delete_google_account, delete_linkedin_account, rotate_linkedin_token, remove_contacts, set_contacts_status opted_out.
- Ne jamais lancer plus de contacts que demandé : all_held avec limit, et annoncer le nombre avant.
- Un accord vaut pour l'action montrée, pas pour les suivantes.

HORS CLAUDE (gestes de l'utilisateur)
- Compte Google : connect_google_account donne un lien ; un clic d'autorisation OAuth par compte (le même lien reconnecte un compte expiré).
- Compte LinkedIn : create_linkedin_account donne un jeton ; installer l'extension Chrome une fois par compte et y coller le jeton.`;
