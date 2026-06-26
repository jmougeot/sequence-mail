# Extension Prospection LinkedIn

Exécute, **dans votre propre session LinkedIn**, les invitations et messages mis
en file depuis l'app *Sequence Mail* (étapes LinkedIn des campagnes). C'est
l'équivalent « maison » du multicanal de lemlist — la cadence reste pilotée par le
serveur : aucune donnée ni cookie envoyés à un tiers.

## Le principe anti-ban

La règle d'or : **l'extension n'envoie jamais quand elle veut.** À chaque tick
(~1 min), elle demande au serveur local « ai-je le droit d'agir maintenant ? ».
Le serveur (`outreach.ts`) répond en appliquant :

- **plafonds journaliers** par type (par défaut 20 invitations, 40 messages) ;
- **warm-up** : on démarre à 5/jour et on monte progressivement (LinkedIn
  repère les pics) ;
- **plage horaire ouvrée** seulement (9h–18h, lun–ven par défaut) ;
- **délai aléatoire** entre deux actions (90–240 s, jamais régulier) ;
- **pause de sécurité longue** (60 min) dès qu'une action échoue, et arrêt net
  si LinkedIn affiche un contrôle de sécurité / captcha.

Tous ces réglages sont dans `.env` (préfixe `LI_`). **Les baisser est sûr ; les
gonfler augmente le risque de restriction du compte.**

Le geste lui-même est joué en **pilotant la vraie interface** (clic « Se
connecter » / « Message », saisie, envoi) plutôt qu'en tapant l'API interne :
c'est plus lent mais beaucoup moins détectable.

## Installation

1. Connectez-vous à LinkedIn dans Chrome (session normale).
2. `chrome://extensions` → activez le **Mode développeur** → **Charger
   l'extension non empaquetée** → choisissez le dossier `Sequence-mail/extension`.
3. Épinglez l'icône. Le popup montre l'état, les quotas du jour, et un bouton
   pause/activation.
4. **Adresse du serveur** (champ en bas du popup) : par défaut l'extension vise la
   prod partagée `https://sequence.example.com`. Pour développer en local, lancez
   `cd Sequence-mail && npm run dev` (sert sur `localhost:3000`) et mettez
   `http://localhost:3000` dans ce champ, puis **OK**.
5. **Mot de passe d'accès** (prod uniquement) : la prod est protégée par mot de
   passe (Caddy `basic_auth`). Saisissez l'utilisateur (`admin` par défaut) et le
   **même mot de passe** que pour ouvrir le dashboard, puis **OK**. Sans lui,
   l'extension reçoit un **401** et reste « non détectée ». En local, laissez vide.

> Le serveur ne « voit » l'extension comme **connectée** (page *Réglages* de l'app)
> qu'une fois qu'elle l'a interrogé — c'est-à-dire au prochain tick (~1 min) après
> l'avoir fait pointer vers le bon serveur (avec le mot de passe si prod). Le domaine
> doit aussi figurer dans `host_permissions` du `manifest.json` (déjà le cas pour
> `sequence.example.com` et `localhost`).

## Usage

1. Dans l'app (`/campaigns.html`), ajoutez à une séquence une **étape LinkedIn**
   (*Invitation* ou *Message*) avec son gabarit (`{{first_name}}`, `{{company}}`…).
2. Quand un contact atteint cette étape, le serveur la met en file LinkedIn.
3. Laissez un onglet Chrome ouvert. L'extension dépile au rythme autorisé. Suivez
   l'état « Extension connectée » et les quotas du jour dans **Réglages**
   (`/settings.html`) et dans le popup.

## Limites à connaître

- **Messages** : LinkedIn ne les délivre qu'aux **relations de 1er niveau**. Pour
  un inconnu, il faut d'abord une invitation acceptée.
- **Invitations** : plafonnées par LinkedIn lui-même (~100–200/semaine), au-delà
  de nos propres quotas. On ne contourne pas cette limite serveur.
- **Maintenance** : LinkedIn change ses libellés/structure. Si un envoi échoue
  avec « bouton introuvable », ajustez les sélecteurs dans `content.js`
  (section « ZONE À MAINTENIR »).
