# Sequence Mail

Outil de séquences email (cold outreach) multi-comptes Google Workspace : campagnes indépendantes, import CSV / Attio, détection automatique des réponses, répartition de charge entre comptes, protection de la délivrabilité — et **moteur de recherche B2B intégré** (recherche d'entreprises françaises + emails des dirigeants, sans outil payant).

## Déploiement clé en main (Docker + HTTPS auto)

Pour héberger une instance en ligne (dashboard + suivi des liens) sur n'importe quel
petit VPS avec Docker :

```bash
git clone <repo> && cd Sequence-mail
./setup.sh                    # demande domaine + mot de passe dashboard → génère .env et Caddyfile
nano .env                     # coller GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (cf. ci-dessous)
docker compose up -d --build  # Caddy obtient le certificat HTTPS tout seul (~30 s)
```

`setup.sh` produit un `Caddyfile` local (domaine + hash bcrypt du mot de passe, non
versionné) et renseigne `BASE_URL`/`VISIT_BASE_URL`. Le suivi (`/p/`, `/t/`) est
public ; le dashboard est protégé (`admin` + le mot de passe choisi).

**Deux pré-requis incompressibles, propres à chaque instance** (aucune image ne peut
les fournir à ta place) :
- un **domaine** pointant vers le serveur : enregistrement `A  go.mondomaine.com → IP`
  (proxy/Cloudflare désactivé, sinon Caddy ne peut pas obtenir le certificat) ;
- des **identifiants Google OAuth** à toi (console.cloud.google.com → client « Web »),
  URI de redirection `https://<ton-domaine>/auth/google/callback`.

Options avancées (prod partagée derrière un Caddy existant, sauvegardes, import d'une
base SQLite existante) : voir **`DEPLOY.md`** / **`DEPLOY-SHARED.md`**.

## Démarrage

```bash
npm install
cp .env.example .env   # puis renseigner GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
npm start              # ouvre http://localhost:3000
```

### Configuration Google (obligatoire)

1. Sur [console.cloud.google.com](https://console.cloud.google.com), créer un projet et activer l'**API Gmail**.
2. Créer des identifiants **OAuth client ID** de type *Web application*, avec l'URI de redirection `http://localhost:3000/auth/google/callback`.
3. Copier le client ID / secret dans `.env`.
4. Sur le tableau de bord, cliquer **« + Connecter un compte Google »** pour chaque adresse Google Workspace à utiliser pour les envois.

**Pour que la connexion dure indéfiniment** : sur l'écran *OAuth consent screen* de la console Google, l'application ne doit pas rester en mode **Testing** (les jetons y expirent au bout de 7 jours et il faudrait reconnecter les comptes chaque semaine). Deux options :
- *User type: Internal* (recommandé avec Google Workspace) : seuls les comptes de votre organisation peuvent se connecter, aucune expiration, aucune validation Google ;
- ou *Publishing status: In production* pour un user type External.

Une fois cela fait, les jetons sont rafraîchis automatiquement et persistés en base : aucune reconnexion n'est nécessaire. Si Google révoque malgré tout un accès (changement de mot de passe, révocation manuelle…), le compte se désactive proprement dans le dashboard ; le reconnecter le réactive.

### Configuration Attio (bonus, optionnel)

Renseigner `ATTIO_API_KEY` dans `.env`, puis utiliser le formulaire « Synchroniser depuis Attio » du tableau de bord en indiquant le slug de l'attribut statut (ex. `stage`) et les valeurs à importer.

**Mise à jour retour vers Attio** : en renseignant `ATTIO_STAGE_ATTRIBUTE` (slug d'un attribut *texte* sur l'objet « people »), l'avancement de chaque contact est écrit automatiquement sur sa fiche Attio : « Étape 2/3 envoyée », « A répondu ✅ », « Séquence terminée », « Échec d'envoi ⚠️ ». La base SQLite reste la source de vérité (transactions, aucune perte en cas d'incident) ; Attio est un miroir temps réel.

## Fonctionnement

### Campagnes et séquences
- Chaque campagne est indépendante et contient une séquence d'étapes (email initial + relances avec délai en jours).
- Les corps et sujets acceptent des variables : `{{first_name}}`, `{{last_name}}`, `{{company}}`, `{{email}}`, `{{sender_name}}` et toute colonne supplémentaire du CSV.
- Une relance **sans sujet** part dans le même fil Gmail (`Re:`, en-têtes `In-Reply-To`/`References`), ce qui améliore la délivrabilité et le taux de réponse.
- **A/B test** : l'étape 1 peut avoir un « Sujet B ». Chaque contact reçoit alors aléatoirement (50/50) la variante A ou B, conservée pour toute sa séquence, et le tableau de bord affiche le taux de réponse de chaque variante.

### Import des contacts
- **CSV** : colonnes `email` (obligatoire), `first_name`, `last_name`, `company` ; toute autre colonne devient une variable de template. Les doublons (même email déjà inscrit à la campagne) sont ignorés.
- **Attio** : import des personnes dont un attribut de statut CRM correspond aux valeurs choisies.
- **Prospection intégrée** : depuis la page Prospection (voir ci-dessous), sans CSV.

### Prospection B2B (page « Prospection »)

Moteur de recherche B2B interne, 100 % gratuit (pas de FullEnrich/ContactOut/Lemlist) :

1. **Recherche en trois choix** : un secteur, une fourchette de taille d'entreprise et une
   catégorie de personne → les prospects s'affichent sous les résultats. Deux familles de catégories :
   - **Dirigeants** (Président/CEO, Directeur général, Gérant…) : immédiat, depuis l'API publique
     [Recherche d'Entreprises](https://recherche-entreprises.api.gouv.fr) de l'État (toutes les
     entreprises françaises, dirigeants et fonctions inclus, sans clé ni quota payant) ;
   - **Par fonction** (Commerciaux/Sales, Marketing, RH, Tech…) : ces personnes ne figurent pas dans
     la base officielle ; elles sont trouvées via une recherche web ciblée sur les profils
     (`site:linkedin.com/in`), dont on extrait nom, poste et URL LinkedIn — lancé automatiquement
     pour chaque entreprise de la page. Chaque fonction est étendue à ses **synonymes FR + EN**
     (« commercial » couvre aussi sales, ventes, business developer, account executive/manager) et
     plusieurs requêtes sont fusionnées — la combinée en `OR`, une par synonyme, 2 pages côté API —
     pour remonter le plus de profils possible par entreprise.
   Filtres avancés repliés : mots-clés, code NAF précis, départements, code postal, chiffre d'affaires.
2. **Enrichissement local** d'une sélection, au choix (cases à cocher) :
   - **LinkedIn** (par défaut) : profil de chaque dirigeant trouvé via les moteurs de recherche
     publics (Yahoo → Ecosia → Bing → DuckDuckGo, avec quarantaine automatique du moteur qui
     bloque) ; le slug du profil doit correspondre au nom, sinon on ne garde rien — mieux vaut pas
     de LinkedIn qu'un mauvais ;
   - **Emails** : découverte du **site web** (domaines devinés et validés par le contenu, sinon
     recherche web hors annuaires, corrigeable à la main d'un clic), **crawl léger** (contact,
     mentions légales, équipe) pour récolter les emails publiés et le pattern d'adressage
     (`prenom.nom@`…), puis génération de l'email de chaque dirigeant, **vérifié par SMTP**
     (RCPT TO + détection de catch-all) quand le port 25 sortant est ouvert — rarement le cas sur
     une connexion résidentielle (email alors « probable ») ; depuis un VPS, la plupart passent en
     « vérifié ».
3. **Exploitation** : filtre par intitulé de poste (Président, Gérant, Directeur Général…), par
   fiabilité d'email ou présence de LinkedIn, sur la recherche en cours ou toute la base accumulée.
   Puis, pour la sélection (ou tout le tableau filtré) :
   - **export CSV** (séparateur `;`, BOM Excel) avec LinkedIn, email, poste, entreprise, SIREN,
     ville, NAF, effectif — l'email n'est pas requis ;
   - ou **ajout à une campagne** : les contacts avec email arrivent en statut « non lancé » avec
     les variables `{{poste}}`, `{{ville}}` et `{{site_web}}` en plus des standards, et passent
     par la vérification MX comme un import CSV.

**Moteur de recherche LinkedIn** — deux modes, choisis automatiquement :
- **Avec une clé d'API** (recommandé) : si `GOOGLE_SEARCH_API_KEY`+`GOOGLE_SEARCH_CX`, `SERPER_API_KEY`
  ou `BRAVE_SEARCH_API_KEY` est dans `.env`, l'API correspondante est utilisée (priorité Google CSE >
  Serper > Brave, avec bascule si l'une échoue). Plus fiable, légal, et titres JSON propres pour
  extraire nom/poste. Google Programmable Search offre 100 requêtes/jour gratuites, Serper 2 500
  requêtes offertes, Brave 2 000/mois — voir `.env.example`. Un badge dans l'UI indique le mode actif.
- **Sans clé** (par défaut) : scraping de moteurs publics (Yahoo en tête, Ecosia/Bing/DDG en secours
  avec quarantaine automatique du moteur qui bloque). Gratuit mais moins fiable — Google y bloque les
  requêtes automatisées, d'où le recours à Yahoo. On ne scrape jamais LinkedIn directement (CGU) ;
  on ne fait que retrouver l'URL publique des profils via la recherche web.

Limites assumées : couverture France uniquement (base SIRENE/RNE). La recherche par fonction trouve
les profils bien référencés, pas l'organigramme complet.

### Gestion des réponses
- Le système interroge les boîtes connectées toutes les ~4–7 minutes.
- Dès qu'un contact répond (n'importe quel message du fil qui ne vient pas du compte émetteur), il passe au statut `replied` et est **retiré du workflow** : plus aucune relance ne lui sera envoyée, même après l'envoi de la dernière étape.
- **Détection des refus** : si la réponse contient une demande de désinscription ou un refus (« pas intéressé », « ne plus me contacter », « unsubscribe », etc.), le contact passe en `opted_out`, est ajouté à la liste globale `do_not_contact` (exclu de toutes les campagnes actuelles et futures, y compris lors d'imports ultérieurs) et sa fiche Attio est taguée « Pas intéressé / désinscrit 🚫 ».
- **Détection des bounces** (signaux serveur uniquement) : un message dont l'expéditeur est `mailer-daemon`/`postmaster` (convention RFC 5321) ou l'adresse NDR fixe d'Exchange passe le contact en `bounced`. Si le bounce est **permanent** (code DSN 5.X.X, « user unknown »…), l'adresse est blacklistée définitivement ; un échec temporaire (boîte pleine…) arrête la séquence sans blacklister. Les bounces sont exclus du taux de réponse.
- **Réponses automatiques (OOO)** : détectées uniquement par les signaux machine — en-tête `Auto-Submitted` (RFC 3834, posé par Gmail/Outlook), `X-Autoreply`, `Precedence: auto_reply`, ou préfixe de sujet généré par le client (« Automatic reply: », « Réponse automatique : »). La relance est alors reportée d'environ 7 jours. **Aucune analyse du texte humain** : « je suis en déplacement, appelez-moi » est une vraie réponse et arrête la séquence. En cas de doute, le système choisit toujours l'arrêt de la séquence (échec côté sûr).
- La classification opt-out ignore le texte cité (`>` et « Le … a écrit : ») : une mention de désinscription présente dans *votre propre template* cité dans la réponse ne déclenche rien.

### Répartition entre comptes
- Le premier email d'un contact part du compte **le moins chargé** du jour (équilibrage automatique).
- Les relances partent toujours **du même compte** que le premier email (continuité du fil).
- Quota quotidien par compte configurable depuis le tableau de bord (défaut : `DEFAULT_DAILY_LIMIT`).
- Chaque compte a son **nom d'expéditeur** (champ « De ») et sa **signature**, configurables dans le tableau de bord. La signature s'insère à l'emplacement de `{{signature}}` dans le corps des étapes (libre à vous de l'omettre, ex. sur une relance) et accepte les variables. Le template peut aussi utiliser `{{sender_name}}` pour mentionner l'expéditeur dans le corps.

### Délivrabilité
- **Warm-up automatique** : chaque compte démarre à 10 emails/jour puis gagne +5/semaine jusqu'à son quota configuré (désactivable par compte dans Paramètres pour les boîtes déjà rodées).
- **Vérification MX à l'import** : les adresses dont le domaine n'a pas de serveur mail sont rejetées avant tout envoi (rapport d'import détaillé), ce qui élimine la majorité des bounces.
- Fenêtre d'envoi configurable (`SEND_WINDOW_START`/`END`, heures locales), envois en semaine uniquement par défaut.
- Délai aléatoire de 90 à 420 s entre deux envois d'un même compte (`MIN_GAP_SECONDS`/`MAX_GAP_SECONDS`).
- Jitter de 0 à 4 h sur la planification des relances : aucun envoi à heure fixe.
- Emails en texte brut, envoyés via l'API Gmail (réputation du domaine préservée, pas de SMTP tiers).
- Petit volume par tick (max 5 envois) avec pauses aléatoires entre chaque.

### Fiabilité
- Toutes les données (comptes, campagnes, contacts, statuts, historique des envois) sont stockées dans **SQLite** (`data/sequence-mail.db`, mode WAL).
- Au redémarrage, le scheduler reprend exactement où il s'était arrêté : rien n'est perdu, aucun email n'est renvoyé en double (l'état est mis à jour transactionnellement après chaque envoi).
- En cas d'échec d'envoi, 3 tentatives espacées de 1–2 h, puis le contact passe en `failed` avec le message d'erreur visible via l'API.

## API

| Méthode | Route | Description |
|---|---|---|
| GET | `/auth/google` | Connecter un compte Google |
| GET | `/api/accounts` | Liste des comptes d'envoi |
| PATCH | `/api/accounts/:id` | Modifier quota / actif |
| GET | `/api/campaigns` | Campagnes + statistiques (taux de réponse, progression, volume) |
| POST | `/api/campaigns` | Créer une campagne `{ name, steps: [{subject, body, wait_days}] }` |
| POST | `/api/campaigns/:id/pause` · `/resume` | Mettre en pause / reprendre |
| POST | `/api/campaigns/:id/import` | Importer un CSV (body brut, `Content-Type: text/csv`) |
| POST | `/api/campaigns/:id/attio-sync` | `{ status_attribute, statuses[] }` |
| GET | `/api/campaigns/:id/contacts` | Détail par contact (statut, étape, émetteur, erreurs) |
| GET | `/api/b2b/search` | Recherche d'entreprises (`q`, `section`, `naf`, `effectifs`, `departements`, `code_postal`, `ca_min/max`, `page`) |
| POST | `/api/b2b/enrich` | Enrichir `{ sirens[], linkedin?, emails?, people? }` (`people` = fonction à chercher, ex. `"commercial"`) — job de fond, suivi via `GET /api/b2b/enrich/status` |
| GET | `/api/b2b/leads` | Prospects (`role`, `status`, `linkedin=1`, `source`, `siren`, `sirens`, `ids`, `q`) |
| GET | `/api/b2b/leads.csv` | Export CSV des prospects (mêmes filtres) |
| PATCH | `/api/b2b/companies/:siren` | Corriger le domaine `{ domain }` |
| POST | `/api/b2b/export` | Ajouter `{ campaign_id, lead_ids[] }` à une campagne |
