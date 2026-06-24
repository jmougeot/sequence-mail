# Extension Prospection LinkedIn

Exécute, **dans votre propre session LinkedIn**, les invitations et messages mis
en file depuis l'app *Enrichissement*. C'est l'équivalent « maison » du
multicanal de lemlist — sauf que tout tourne en local : **0 € de coût**, aucune
donnée ni cookie envoyés à un tiers.

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

1. Lancez l'app : `cd Enrichissement && npm run dev` (sert sur `localhost:3100`).
2. Connectez-vous à LinkedIn dans Chrome (session normale).
3. `chrome://extensions` → activez le **Mode développeur** → **Charger
   l'extension non empaquetée** → choisissez le dossier `Enrichissement/extension`.
4. Épinglez l'icône. Le popup montre l'état, les quotas du jour, et un bouton
   pause/activation.

## Usage

1. Dans l'app (`/leads.html`), faites une recherche, **cochez** les prospects.
2. Carte **Campagne LinkedIn** : choisissez *Invitation* ou *Message*, écrivez le
   gabarit (`{{first_name}}`, `{{company}}`…), **Mettre en file**.
3. Laissez un onglet Chrome ouvert. L'extension dépile au rythme autorisé. Suivez
   l'avancement dans le tableau de la carte et dans le popup.

## Limites à connaître

- **Messages** : LinkedIn ne les délivre qu'aux **relations de 1er niveau**. Pour
  un inconnu, il faut d'abord une invitation acceptée.
- **Invitations** : plafonnées par LinkedIn lui-même (~100–200/semaine), au-delà
  de nos propres quotas. On ne contourne pas cette limite serveur.
- **Maintenance** : LinkedIn change ses libellés/structure. Si un envoi échoue
  avec « bouton introuvable », ajustez les sélecteurs dans `content.js`
  (section « ZONE À MAINTENIR »).
