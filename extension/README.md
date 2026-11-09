# Extension Prospection LinkedIn

Exécute, **dans votre propre session LinkedIn**, les invitations et messages mis
en file depuis l'app *Sequence Mail* (étapes LinkedIn des campagnes). C'est
l'équivalent « maison » du multicanal de lemlist — la cadence reste pilotée par le
serveur : aucune donnée ni cookie envoyés à un tiers.

## Le principe anti-ban

La règle d'or : **l'extension n'envoie jamais quand elle veut.** À chaque tick
(~1 min), elle demande au serveur local « ai-je le droit d'agir maintenant ? ».
Le serveur (`outreach.ts`) répond en appliquant :

- **plafonds journaliers** par type (par défaut 20 invitations, 40 messages),
  tirés chaque jour entre 85 et 100 % du plafond (pas de plafond hebdomadaire :
  seul le quota du jour compte) ;
- **plage horaire** décalée chaque jour (début plus tard, fin plus tôt, jusqu'à 75 min),
  tirée à part pour chaque profil LinkedIn : deux comptes n'ouvrent plus à la même
  minute (25 min d'écart en moyenne avec 75 min de décalage) ;
- **sessions courtes** puis **repos** : taille de session, écart entre deux actions et
  durée du repos suivent une loi à longue traîne (log-normale décalée) plutôt qu'un
  tirage uniforme — surtout des valeurs courtes, parfois de longues. Plancher à la
  moitié du minimum configuré, plafond à 4 fois le maximum pour l'écart, 3 fois pour le
  repos, 2 fois pour la taille de session. La moyenne reste celle du tirage uniforme
  d'avant (5 % plus basse pour l'écart) : le débit ne baisse pas. Avec les réglages par
  défaut (sessions de 2 à 5 actions espacées de 2 à 7 min, repos de 1 h à 2 h 30) : des
  écarts de 1 à 28 min, 4 min 15 s environ en moyenne. La messagerie n'est lue qu'au
  plus toutes les 2 h, hors repos, une fois pour tout le profil LinkedIn ;
- **lecture du profil** (arrêt, défilement, retour en haut) avant chaque invitation
  ou message ;
- **vrais gestes, et seulement eux** (0.7.0) : clics, molette, touches et collage passent par
  le débogueur de Chrome (permission `debugger`) et sortent comme ceux d'une vraie souris et
  d'un vrai clavier (`isTrusted`, trajectoire à 60 Hz). Il n'y a plus aucun geste simulé
  (événement fabriqué par la page, `el.click()`, `scrollTop`). Ce qui empêchait le vrai geste
  est corrigé avant de renoncer : cible ramenée à l'écran à la vraie molette, autre point de la
  cible si un bandeau la recouvre, nouvelle mesure si le survol n'est pas arrivé, trois essais.
  Sans vrai geste possible (débogueur refusé ou tenu par DevTools, cible hors de l'écran…),
  l'action s'arrête **sans rien envoyer** : le serveur la reprend 5 à 10 min plus tard, sans
  pause de sécurité ni échec, et ne met le contact en échec qu'au 4e refus de suite (« vrais
  gestes impossibles 4 fois de suite »). Le popup affiche alors « Envoi en pause : vrais gestes
  indisponibles (raison) ». Le débogueur n'accepte que des commandes `Input.*`. Le bandeau
  « a commencé le débogage de ce navigateur » n'apparaît pas avec
  `--silent-debugger-extension-api` (lanceur `scripts/macos-chrome-linkedin-launcher.sh`) ;
  fermé, il coupe les vrais gestes pendant 1 h (donc les envois) ;
- **collage du texte** : le message (ou la note) est collé par Cmd+V (Ctrl+V hors Mac) : un
  `paste` puis un `input` `insertFromPaste` de confiance, comme une personne qui colle. Un
  brouillon déjà dans le champ est d'abord effacé au vrai clavier (Cmd+A, Retour arrière). Le
  presse-papiers de la personne est lu juste avant (document `offscreen.html`, permissions
  `clipboardRead`/`clipboardWrite`), le message y est écrit Cmd déjà enfoncé, V suit en
  quelques ms (`paste_ms`), puis l'ancien contenu (texte, HTML) est remis. Le champ est relu
  avant tout clic sur Envoyer : s'il diffère du message (un Cmd+C de la personne pile à ce
  moment), il est vidé et rien ne part. Presse-papiers impossible à rendre tel quel (image,
  fichier) : le texte est déposé sans passer par lui (`Input.insertText`) plutôt que d'écraser
  ce que la personne a copié. `TYPE_KEY_BY_KEY` dans `content.js` remplace le collage par une
  frappe touche par touche ;
- **fenêtre de travail entière à l'écran** : un vrai clic ne tombe jamais au-delà du bord de
  l'écran (chaque point est vérifié contre `screen.avail*`, sinon « cible hors écran »). Une
  fenêtre neuve est posée en bas à droite, entière ; une fenêtre qui déborde (ancien placement
  « dans le coin ») y est ramenée ; une fenêtre déjà entière à l'écran ne bouge jamais. Pour un
  message dans un onglet caché, elle ne passe au premier plan que si l'ordinateur est inutilisé
  depuis 60 s (`chrome.idle`) : jamais pendant que la personne tape ;
- **traçabilité** : chaque verdict porte `gestures` (`real`, `simulated` — toujours 0, un
  événement non fiable vu pendant l'action y serait compté —, `refused_reason`, `tab_hidden`,
  `fill`, `paste_ms`, `clipboard`). Le serveur l'écrit dans une ligne `[linkedin] gestes …` et
  dans `li_actions.gestures` (JSON) ;
- **reprise à l'heure du serveur** : quand `/api/li/next` répond « attendre N s », l'extension
  se réveille à cet instant (alarme, minuterie sous 30 s) au lieu d'attendre le tick suivant ;
  après chaque action, elle redemande quelques secondes plus tard. Le tick d'une minute reste ;
- **pause de sécurité** (`LI_PAUSE_AFTER_ERROR_MIN`, 15 min par défaut) dès qu'une action
  échoue (hors refus faute de vrais gestes, cf. plus haut), et arrêt net si LinkedIn affiche un
  contrôle de sécurité / captcha.

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
   Tant qu'aucun mot de passe d'accès, ni jeton de compte, ni autre serveur n'est
   réglé, l'extension n'interroge rien et le popup n'affiche que la vue « Azerit »
   (c'est ce que voient les utilisateurs d'Azerit, pour qui elle ne sert qu'à
   relier leur LinkedIn) : ouvrez **Advanced settings** pour les champs ci-dessous.

   **Connexion automatique (compte Azerit exécuté par l'extension)** : si le
   propriétaire du compte figure dans `LI_EXTENSION_OWNERS` (`.env` de Sequence
   Mail, ex. `azerit:u:1`), relier LinkedIn depuis Azerit (Réglages → LinkedIn)
   suffit : l'extension reçoit le jeton de son compte, le compte reste en mode
   extension, et elle se connecte seule au tick suivant, sans mot de passe
   (Caddy laisse passer `/api/li/{next,result,inbox,status}` porteurs d'un
   jeton). Les étapes 4 et 5 ci-dessous sont alors inutiles.

   Ce jeton s'ajoute à celui du popup (compte Sequence Mail) : l'extension
   envoie les deux jetons dans chaque requête (`X-LI-Account: a,b`) et c'est le
   serveur qui choisit le compte qui agit (celui resté le plus longtemps sans
   envoyer), une action au plus par tick. Comme ils envoient depuis le même
   profil LinkedIn, il leur impose des quotas du jour, un délai entre deux
   actions et des pauses de sécurité communs (dès que le profil de chacun est
   connu, c'est-à-dire après sa première action).
4. **Adresse du serveur** (champ en bas du popup) : par défaut l'extension vise la
   prod partagée `https://sequence.example.com`. Pour développer en local, construisez
   le **build de développement** (`./make-dev.sh` → dossier `extension-dev`, à charger
   à la place de `extension`), lancez `cd Sequence-mail && npm run dev` (sert sur
   `localhost:3000`) et mettez `http://localhost:3000` dans ce champ, puis **OK**.
   L'extension distribuée ne connaît ni `localhost` ni `127.0.0.1` : ni pont
   d'appairage ni remise de session vers une page servie en local (elle obtiendrait
   sinon les cookies LinkedIn de la personne), ni requêtes vers un serveur local.
5. **Mot de passe d'accès** (prod uniquement) : la prod est protégée par mot de
   passe (Caddy `basic_auth`). Saisissez l'utilisateur (`admin` par défaut) et le
   **même mot de passe** que pour ouvrir le dashboard, puis **OK**. Sans lui,
   l'extension reçoit un **401** et reste « non détectée ». En local, laissez vide.

> Le serveur ne « voit » l'extension comme **connectée** (page *Réglages* de l'app)
> qu'une fois qu'elle l'a interrogé — c'est-à-dire au prochain tick (~1 min) après
> l'avoir fait pointer vers le bon serveur (avec le mot de passe si prod). Le domaine
> doit aussi figurer dans `host_permissions` du `manifest.json` (déjà le cas pour
> `sequence.example.com` ; `localhost` seulement dans le build de développement).

## Usage

1. Dans l'app (`/campaigns`), ajoutez à une séquence une **étape LinkedIn**
   (*Invitation* ou *Message*) avec son gabarit (`{{first_name}}`, `{{company}}`…).
2. Quand un contact atteint cette étape, le serveur la met en file LinkedIn.
3. Laissez un onglet Chrome ouvert. L'extension dépile au rythme autorisé. Suivez
   l'état « Extension connectée » et les quotas du jour dans **Réglages**
   (`/settings`) et dans le popup.

## Quand une action échoue

Un refus faute de vrais gestes n'est pas un échec : rien n'est parti, l'action revient seule
quelques minutes plus tard. Après 4 refus de suite, elle passe en échec comme les autres.

Le popup liste sous « À faire à la main » chaque invitation ou message en échec :
lien vers le profil LinkedIn, texte à copier, et bouton **Fait à la main**. Ce bouton
enregistre l'action comme envoyée (`POST /api/li/result` avec `done_by_hand`) : le
contact sort de l'échec et passe à l'étape suivante, sans compter dans les quotas
du jour. Tant qu'on ne clique pas, le contact reste en échec.

## Limites à connaître

- **Messages** : LinkedIn ne les délivre qu'aux **relations de 1er niveau**. Pour
  un inconnu, il faut d'abord une invitation acceptée.
- **Invitations** : plafonnées par LinkedIn lui-même (~100–200/semaine), au-delà
  de nos propres quotas. On ne contourne pas cette limite serveur.
- **Notes d'invitation** : 200 caractères (compte gratuit), et quelques notes
  personnalisées par mois seulement. Une note trop longue n'est jamais tronquée,
  et quand LinkedIn affiche l'offre Premium au lieu du champ, l'invitation part
  **sans note** (le verdict le signale) plutôt que d'échouer.
- **Avant chaque message** servi par le serveur, `content.js` relit la
  conversation ouverte (`threadGuard`) : si le contact a écrit depuis notre
  premier envoi, rien ne part et la séquence s'arrête (« a répondu ») ; si le
  texte y est déjà (verdict perdu, action rejouée), il n'est pas renvoyé ; si
  la conversation est illisible, rien ne part par précaution.
- **Maintenance** : LinkedIn change ses libellés/structure. Si un envoi échoue
  avec « bouton introuvable », ajustez les sélecteurs dans `content.js`
  (section « ZONE À MAINTENIR »).
