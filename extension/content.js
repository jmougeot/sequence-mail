/*
 * Partagé avec le runner (navigateurs serveur, runner/) qui l'injecte tel quel
 * dans ses pages avec un faux `chrome.runtime` : toute la connaissance de
 * l'interface LinkedIn vit dans CE fichier, pour les deux exécutants.
 * Reprise de Linkedin_mcp (plus robuste : shadow DOM, 404, messagerie).
 *
 * Content script injecté sur linkedin.com. Il exécute le geste demandé en
 * pilotant la VRAIE interface (clics, saisie, envoi) comme le ferait l'humain
 * connecté — c'est volontaire : c'est l'approche la moins détectable. Aucune
 * cadence ici : le serveur a déjà décidé qu'on avait le droit d'agir maintenant.
 *
 * ⚠️ ZONE À MAINTENIR : LinkedIn change régulièrement ses libellés et sa
 * structure. Si un envoi échoue avec « bouton introuvable », ce sont les
 * sélecteurs / textes ci-dessous (FR + EN) qu'il faut mettre à jour.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
// petite pause « humaine » entre deux gestes
const human = () => sleep(rand(700, 1800));

/** Attend qu'un élément satisfaisant `find()` apparaisse (polling), sinon null. */
async function waitFor(find, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const el = find();
    if (el) return el;
    await sleep(300);
  }
  return null;
}

/** Premier bouton/lien cliquable dont le texte OU l'aria-label matche la regex. */
function findClickable(re) {
  const nodes = document.querySelectorAll('button, a, [role="button"]');
  for (const el of nodes) {
    if (el.disabled || el.offsetParent === null) continue; // ignore masqués/désactivés
    const label = `${el.getAttribute("aria-label") || ""} ${el.textContent || ""}`.trim();
    if (re.test(label)) return el;
  }
  return null;
}

// --- Simulation « souris humaine » -------------------------------------------
// Un bot se trahit par : clic pile au centre, au pixel près, sans déplacement de
// curseur, avec un appui instantané. On corrige les trois : point aléatoire dans
// l'élément, trajectoire de curseur en plusieurs paliers, durée de pression
// variable. On garde en mémoire la dernière position pour enchaîner les gestes
// de façon cohérente (le curseur ne se téléporte pas).
let _lastPointer = { x: null, y: null };

/** Point légèrement aléatoire dans l'élément — jamais deux fois le même pixel. */
function jitterPoint(el) {
  const r = el.getBoundingClientRect();
  const padX = Math.min(r.width * 0.32, 14);
  const padY = Math.min(r.height * 0.32, 10);
  return {
    x: Math.round(r.left + r.width / 2 + rand(-padX, padX)),
    y: Math.round(r.top + r.height / 2 + rand(-padY, padY)),
  };
}

/** Déplace le curseur vers (x,y) en quelques mousemove intermédiaires, avec une
 *  trajectoire adoucie (smoothstep) et un léger bruit — comme une vraie main. */
async function moveMouseTo(x, y) {
  const from = _lastPointer.x == null
    ? { x: x - rand(80, 240), y: y - rand(60, 180) } // 1re fois : départ plausible hors cible
    : { x: _lastPointer.x, y: _lastPointer.y };
  const steps = 3 + Math.floor(rand(0, 4)); // 3 à 6 paliers
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t * t * (3 - 2 * t); // smoothstep : accélère puis ralentit
    const px = Math.round(from.x + (x - from.x) * ease + rand(-2, 2));
    const py = Math.round(from.y + (y - from.y) * ease + rand(-2, 2));
    const el = document.elementFromPoint(px, py) || document.body;
    const o = { bubbles: true, cancelable: true, view: window, clientX: px, clientY: py };
    el.dispatchEvent(new PointerEvent("pointermove", { ...o, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mousemove", o));
    await sleep(rand(12, 45));
  }
  _lastPointer = { x, y };
}

/** Appui souris « humain » sur (x,y) SANS le click final : survol → appui →
 *  durée de pression → relâche. Le déclenchement se fait ensuite au choix de
 *  l'appelant (click natif proven pour les boutons, click synthétique pour la
 *  liste de conversations où le natif n'a aucun effet). Évite tout double-tir. */
async function pressAt(el, x, y) {
  const o = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
  const p = { ...o, pointerId: 1, pointerType: "mouse", isPrimary: true };
  el.dispatchEvent(new PointerEvent("pointerover", p));
  el.dispatchEvent(new MouseEvent("mouseover", o));
  el.dispatchEvent(new PointerEvent("pointerdown", p));
  el.dispatchEvent(new MouseEvent("mousedown", o));
  try { el.focus && el.focus(); } catch {}
  await sleep(rand(80, 170)); // temps de pression
  el.dispatchEvent(new PointerEvent("pointerup", p));
  el.dispatchEvent(new MouseEvent("mouseup", o));
  return o;
}

/** Clic « humain » sur un vrai bouton (Message, Envoyer, Se connecter…) :
 *  défilement doux, déplacement du curseur vers un point aléatoire, hésitation,
 *  séquence d'appui souris, puis UN SEUL déclenchement via le .click() natif
 *  (celui qui a toujours fonctionné ici — pas de synthétique en plus, sinon on
 *  risquerait un double envoi). */
async function clickHuman(el) {
  try { el.scrollIntoView({ block: "center", behavior: "smooth" }); }
  catch { el.scrollIntoView({ block: "center" }); }
  await sleep(rand(400, 950)); // laisse le défilement se stabiliser (coords fiables)
  const { x, y } = jitterPoint(el);
  await moveMouseTo(x, y);
  await sleep(rand(50, 160)); // petite hésitation avant d'appuyer
  await pressAt(el, x, y);
  await sleep(rand(20, 70));
  el.click(); // déclenchement unique et éprouvé
}

/** Saisit du texte dans un textarea ou un contenteditable, en déclenchant les events React. */
async function typeInto(el, text) {
  el.focus();
  await sleep(rand(200, 500));
  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")
      || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
    setter.set.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    // contenteditable (éditeur LinkedIn) : on NE vide PAS via textContent (ça casse
    // la structure interne et laisse le modèle « vide » → bouton Envoyer grisé).
    // On efface proprement via l'éditeur, puis insertText, puis un InputEvent complet.
    try { document.execCommand("selectAll", false, null); document.execCommand("delete", false, null); } catch {}
    document.execCommand("insertText", false, text);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
  }
  await sleep(rand(400, 900));
}

/** Repli : simule un COLLAGE. De nombreux éditeurs (React/Quill) n'activent le
 *  bouton Envoyer que sur un vrai `paste` — on efface puis on colle le texte. */
async function pasteInto(el, text) {
  el.focus();
  try { document.execCommand("selectAll", false, null); document.execCommand("delete", false, null); } catch {}
  try {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
  } catch {}
  el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertFromPaste", data: text }));
  await sleep(rand(400, 800));
}

/** Page d'erreur LinkedIn (profil supprimé, URL erronée, slug renommé…).
 *  Marqueur n°1 : LinkedIn REDIRIGE vers /404/ — déterministe, prioritaire.
 *  Marqueur n°2 : le titre de l'onglet. Marqueur n°3 : la phrase d'erreur dans
 *  le DÉBUT du texte rendu (via readableText : le nouveau design l'affiche dans
 *  un shadow DOM, invisible pour querySelector/innerText — c'est ce qui faisait
 *  passer la page 404 pour un profil valide). On ne scanne que les ~1500
 *  premiers caractères : sur un vrai profil ils contiennent nom/titre, jamais
 *  cette phrase (un post qui la citerait arrive bien plus bas). */
const RE_NOT_FOUND = /(cette page n['’]existe pas|this page doesn['’]?t exist|page (est )?introuvable|page not found|profil introuvable|profile (was )?not found|ce profil n['’]est pas disponible|this profile is not available)/i;
function pageNotFound() {
  if (/^\/404\/?$/.test(location.pathname)) return true;
  if (/page not found|page introuvable|profil introuvable/i.test(document.title || "")) return true;
  const main = document.querySelector("main") || document.body;
  return RE_NOT_FOUND.test(readableText(main).slice(0, 1500));
}
// Le marqueur « (404) » est reconnu par le serveur : pas de pause de sécurité.
const NOT_FOUND_ERROR = "page LinkedIn introuvable (404) — l'URL n'existe pas, ou le profil a été supprimé/renommé";

// --- Libellés (FR + EN). À COMPLÉTER si LinkedIn change. ----------------------
const RE_CONNECT = /^(se connecter|connect|invitez|invite)\b/i;
const RE_MORE = /^(plus|more actions|more)\b/i;
const RE_MESSAGE = /(?:^|\b)(message|messagerie)\b/i;
const RE_ADD_NOTE = /(ajouter une note|add a note)/i;
const RE_SEND_NOTE = /(envoyer l.invitation|envoyer$|^envoyer\b|send invitation|^send$)/i;
const RE_SEND_NO_NOTE = /(envoyer sans note|send without)/i;
const RE_SEND_MSG = /(^envoyer$|^send$)/i;

/** Bouton « Message » DU PROFIL affiché — PAS le lien global « Messagerie » de
 *  la barre de navigation (en FR il matche le même mot et arrive plus tôt dans le
 *  DOM : on cliquait la mauvaise fenêtre → « zone de saisie introuvable »).
 *  On écarte donc tout lien vers /messaging/ (c'est la nav) et on privilégie le
 *  vrai bouton d'action du profil (« Message » / « Envoyer un message à … »). */
function findProfileMessageBtn() {
  const nodes = document.querySelectorAll('button, a, [role="button"]');
  for (const el of nodes) {
    if (el.disabled || el.offsetParent === null) continue;
    const href = el.getAttribute("href") || "";
    if (/\/messaging\b/.test(href)) continue; // lien de nav global → ignoré
    const label = `${el.getAttribute("aria-label") || ""} ${el.textContent || ""}`.trim();
    if (/^messagerie$/i.test(label)) continue; // libellé nav seul → ignoré
    if (/(?:^|\b)message\b/i.test(label) || /envoyer un message/i.test(label)) return el;
  }
  return null;
}

/** Bouton « Se connecter », éventuellement caché dans le menu « Plus ». */
async function findConnectButton() {
  let btn = findClickable(RE_CONNECT);
  if (btn) return btn;
  const more = findClickable(RE_MORE);
  if (more) {
    await clickHuman(more);
    await human();
    btn = await waitFor(() => findClickable(RE_CONNECT), 4000);
  }
  return btn;
}

/** Envoie une invitation (avec note optionnelle, tronquée à 200 caractères). */
async function doInvite(note) {
  // Déjà en relation / invitation déjà partie ? On considère l'action faite (pas d'erreur punitive).
  if (!findClickable(RE_CONNECT) && (findClickable(RE_MESSAGE) || findClickable(/en attente|pending/i))) {
    if (!(await findConnectButton())) return { ok: true, error: "déjà en relation ou invitation déjà envoyée (ignoré)" };
  }
  const connect = await findConnectButton();
  if (!connect) return { ok: false, error: "bouton « Se connecter » introuvable" };
  await clickHuman(connect);
  await human();

  const clean = (note || "").slice(0, 200).trim();
  if (clean) {
    const addNote = await waitFor(() => findClickable(RE_ADD_NOTE), 4000);
    if (addNote) {
      await clickHuman(addNote);
      const box = await waitFor(
        () => document.querySelector('textarea[name="message"], #custom-message, textarea#custom-message'),
        4000
      );
      if (!box) return { ok: false, error: "champ de note introuvable" };
      await typeInto(box, clean);
    }
  }
  // Envoyer (avec ou sans note)
  const send = await waitFor(() => findClickable(clean ? RE_SEND_NOTE : RE_SEND_NO_NOTE) || findClickable(RE_SEND_NOTE), 5000);
  if (!send) return { ok: false, error: "bouton « Envoyer » de l'invitation introuvable" };
  await clickHuman(send);
  await human();
  return { ok: true };
}

/** Envoie un message. Depuis un profil (le profil doit être une relation) ou,
 *  si inThread, directement dans un fil déjà ouvert (/messaging/thread/...). */
async function doMessage(text, inThread) {
  if (!text || !text.trim()) return { ok: false, error: "message vide" };
  if (!inThread) {
    const msgBtn = await waitFor(() => findProfileMessageBtn(), 6000);
    if (!msgBtn) {
      // Pas encore en relation (invitation en attente ou à envoyer) : le serveur
      // reporte le message de quelques heures, sans pause punitive.
      if (findClickable(RE_CONNECT) || findClickable(/en attente|pending/i)) {
        return { ok: false, retry: true, error: "pas encore en relation (invitation non acceptée)" };
      }
      return { ok: false, error: "bouton « Message » du profil introuvable" };
    }
    await clickHuman(msgBtn);
    await human();
  }
  // Dans un fil, le champ de saisie est déjà présent — pas de bouton à cliquer.

  const editor = await waitFor(
    () => document.querySelector('.msg-form__contenteditable [contenteditable="true"], div[role="textbox"][contenteditable="true"]'),
    6000
  );
  if (!editor) return { ok: false, error: "zone de saisie du message introuvable" };

  // Saisie par COLLAGE (méthode principale : plus robuste et plus humaine — un
  // vrai éditeur active le bouton Envoyer sur un paste).
  await pasteInto(editor, text.trim());
  let send = await waitFor(() => document.querySelector('button.msg-form__send-button:not([disabled])'), 4000);
  if (!send) {
    // Repli : saisie directe si le collage n'a pas réveillé l'éditeur.
    await typeInto(editor, text.trim());
    send = await waitFor(() => document.querySelector('button.msg-form__send-button:not([disabled])'), 4000);
  }
  if (!send) send = findClickable(RE_SEND_MSG);
  if (!send) return { ok: false, error: "le champ n'a pas été reconnu par LinkedIn (bouton Envoyer resté désactivé après collage et saisie)" };
  await clickHuman(send);
  await human();
  return { ok: true };
}

/**
 * Lit la conversation avec le profil affiché : ouvre l'overlay de messagerie
 * (clic « Message ») puis extrait les derniers messages du fil.
 * ⚠️ ZONE À MAINTENIR : sélecteurs de la messagerie LinkedIn.
 */
async function doReadMessages(limit = 25, inThread) {
  if (!inThread) {
    const msgBtn = await waitFor(() => findProfileMessageBtn(), 6000);
    if (!msgBtn) return { ok: false, error: "bouton « Message » du profil introuvable" };
    await clickHuman(msgBtn);
    await human();
  }
  // Dans un fil, le fil de discussion est déjà affiché.

  const list = await waitFor(
    () => document.querySelector(".msg-s-message-list, .msg-s-message-list-content"),
    8000
  );
  if (!list) return { ok: false, error: "fil de discussion introuvable (aucun historique avec ce profil ?)" };
  await sleep(rand(400, 900)); // laisse charger les derniers messages

  // Les messages consécutifs d'un même expéditeur sont groupés : le nom
  // n'apparaît que sur le premier — on le propage aux suivants.
  // Sélecteur unique (les deux ci-dessous matchaient la même ligne = doublons).
  let events = [...document.querySelectorAll("li.msg-s-event-listitem")];
  if (!events.length) events = [...document.querySelectorAll(".msg-s-event-listitem, li.msg-s-message-list__event")];
  const out = [];
  let lastSender = null;
  let lastTime = null;
  for (const ev of events) {
    const nameEl = ev.querySelector(".msg-s-message-group__name");
    if (nameEl) lastSender = nameEl.textContent.trim();
    const timeEl = ev.querySelector(".msg-s-message-group__timestamp, time");
    if (timeEl) lastTime = timeEl.textContent.trim();
    for (const body of ev.querySelectorAll(".msg-s-event-listitem__body")) {
      const text = body.innerText.trim();
      if (text) out.push({ sender: lastSender, time: lastTime, text });
    }
  }
  if (!out.length) return { ok: false, error: "aucun message lisible dans le fil (sélecteurs à mettre à jour ?)" };
  return { ok: true, data: { messages: out.slice(-limit) } };
}

/**
 * Liste les conversations récentes (la page https://www.linkedin.com/messaging/
 * doit être affichée — le background s'en charge).
 * ⚠️ ZONE À MAINTENIR : sélecteurs de la liste de conversations.
 */
async function doListConversations(limit = 15) {
  const list = await waitFor(
    () => document.querySelector(".msg-conversations-container__conversations-list, ul.msg-conversations-container__conversations-list"),
    10000
  );
  if (!list) return { ok: false, error: "liste de conversations introuvable (page messagerie non chargée ?)" };
  await sleep(rand(400, 900));

  const abs = (href) => {
    try { return href ? new URL(href, location.origin).href : null; } catch { return null; }
  };
  // Un seul niveau de sélection pour éviter les doublons (li + carte imbriquée
  // matchaient tous les deux la même conversation).
  let cards = [...document.querySelectorAll("li.msg-conversation-listitem")];
  if (!cards.length) cards = [...document.querySelectorAll(".msg-conversation-card")];
  const rows = cards.map((c) => {
    const threadA = c.querySelector('a[href*="/messaging/thread/"]') || (c.matches?.('a[href*="/messaging/thread/"]') ? c : null);
    const profA = c.querySelector('a[href*="/in/"]'); // parfois absent de la carte de liste
    return {
      name:
        c.querySelector(".msg-conversation-listitem__participant-names, .msg-conversation-card__participant-names")
          ?.innerText.trim() || null,
      // thread_url : le lien fiable dans la liste (répondre s'appuie dessus)
      thread_url: abs(threadA?.getAttribute("href")),
      profile_url: abs(profA?.getAttribute("href")),
      snippet: c.querySelector(".msg-conversation-card__message-snippet")?.innerText.trim() || null,
      time: c.querySelector(".msg-conversation-listitem__time-stamp, time")?.innerText.trim() || null,
      unread:
        !!c.querySelector(".notification-badge--show, .msg-conversation-card__unread-count") ||
        /unread/i.test(c.className || ""),
    };
  }).filter((c) => c.name);
  // Dédoublonnage de sécurité (par fil, sinon par nom+aperçu).
  const seen = new Set();
  const out = [];
  for (const c of rows) {
    const key = c.thread_url || `${c.name}|${c.snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  const trimmed = out.slice(0, limit);
  if (!trimmed.length) return { ok: false, error: "aucune conversation trouvée (sélecteurs à mettre à jour ?)" };
  return { ok: true, data: { conversations: trimmed } };
}

/**
 * Extrait les informations visibles du profil affiché (le background a déjà
 * navigué vers la page /in/...). Lecture pure du DOM, aucun clic.
 * ⚠️ ZONE À MAINTENIR : sélecteurs de la page profil LinkedIn.
 */

/** getElementById qui traverse les shadow roots ouverts (le nouveau design
 *  LinkedIn met les sections dans des composants — document.getElementById ne
 *  franchit pas ces frontières). */
function deepGetById(id, root = document, depth = 0) {
  if (!root || depth > 40) return null;
  const direct = root.getElementById ? root.getElementById(id) : null;
  if (direct) return direct;
  for (const host of root.querySelectorAll("*")) {
    if (!host.shadowRoot) continue;
    const r = deepGetById(id, host.shadowRoot, depth + 1);
    if (r) return r;
  }
  return null;
}

/** Section du profil repérée par son ancre (#about, #experience, #education…) —
 *  les ids d'ancre bougent moins que les classes CSS. */
function profileSection(id) {
  const anchor = deepGetById(id);
  return anchor ? anchor.closest("section") : null;
}

/** Items d'une section (expériences, formations…) : uniquement les <li> de
 *  premier niveau (les postes groupés imbriquent des <li> dans des <li> — on
 *  garde le parent, ses lignes incluent déjà les sous-postes). LinkedIn duplique
 *  chaque texte dans un .visually-hidden, donc on ne lit que les
 *  span[aria-hidden="true"] et on dédoublonne en gardant l'ordre. Chaque item
 *  devient UNE chaîne (lignes jointes, plafonnée à 500 caractères) — un tableau
 *  de tableaux non plafonné coûtait cher en tokens sans rien apporter. */
function sectionItems(section, max = 10) {
  if (!section) return null;
  const all = [...section.querySelectorAll("li.artdeco-list__item")];
  const outer = all.filter((li) => !all.some((other) => other !== li && other.contains(li)));
  const rows = outer.slice(0, max).map((li) => {
    const seen = new Set();
    const lines = [...li.querySelectorAll('span[aria-hidden="true"]')]
      .map((s) => s.innerText.trim().replace(/\s+/g, " "))
      .filter((t) => t && !seen.has(t) && (seen.add(t), true));
    return lines.length ? lines.join("\n").slice(0, 500) : null;
  }).filter(Boolean);
  return rows.length ? rows : null;
}

/** Texte lisible d'un nœud en reconstruisant l'ARBRE COMPOSÉ : shadow roots
 *  ouverts traversés RÉCURSIVEMENT (le nouveau design LinkedIn imbrique des
 *  composants à shadow root — innerText et textContent s'arrêtent à la première
 *  frontière : seule la carte du haut sortait, jamais Expérience/Formation),
 *  <slot> remplacés par leurs nœuds assignés (sinon le contenu projeté serait lu
 *  deux fois ou pas du tout), <style>/<script> ignorés, éléments display:none ou
 *  visibility:hidden ignorés. Un saut de ligne par élément bloc pour retrouver
 *  les lignes qu'innerText donnait — parseProfileText repère les titres de
 *  sections par LIGNE ENTIÈRE. Lignes vides et doublons consécutifs retirés
 *  (LinkedIn duplique beaucoup de texte pour l'accessibilité). */
function readableText(node) {
  if (!node) return "";
  const SKIP_TAG = /^(STYLE|SCRIPT|NOSCRIPT|TEMPLATE|IFRAME|SVG|CANVAS|VIDEO|AUDIO|CODE)$/i;
  const parts = [];
  const nl = () => { if (parts.length && parts[parts.length - 1] !== "\n") parts.push("\n"); };
  const walk = (n, depth) => {
    if (!n || depth > 80) return;
    if (n.nodeType === Node.TEXT_NODE) { if (n.data) parts.push(n.data); return; }
    if (n.nodeType === Node.DOCUMENT_FRAGMENT_NODE) { // shadow root passé en racine
      for (const c of n.childNodes) walk(c, depth + 1);
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    if (SKIP_TAG.test(n.tagName)) return;
    let st = null;
    try { st = getComputedStyle(n); } catch {}
    if (st && (st.display === "none" || st.visibility === "hidden")) return;
    const block = !st || !/^inline/.test(st.display || "");
    if (block) nl();
    if (n.tagName === "SLOT" && n.assignedNodes) {
      for (const a of n.assignedNodes({ flatten: true })) walk(a, depth + 1);
    } else if (n.shadowRoot) {
      for (const c of n.shadowRoot.childNodes) walk(c, depth + 1);
    } else {
      for (const c of n.childNodes) walk(c, depth + 1);
    }
    if (block || n.tagName === "BR") nl();
  };
  walk(node, 0);
  const lines = [];
  let prev = null;
  for (const l of parts.join("").split("\n")) {
    const line = l.trim().replace(/\s+/g, " ");
    if (!line || line === prev) continue;
    lines.push(line);
    prev = line;
  }
  return lines.join("\n");
}

/** Coupe le texte au début du pied de page LinkedIn — indispensable AVANT tout
 *  découpage par sections : le footer contient sa propre ligne « About » qui,
 *  sinon, aspire la liste des langues dans le champ à propos. */
function stripFooter(text) {
  for (const m of [
    "\nAbout\nAccessibility\n", "\nÀ propos\nAccessibilité\n",
    "\nSelect language\n", "\nSélectionnez la langue\n",
    "\nVisit our Help Center", "\nLinkedIn Corporation ©",
  ]) {
    const i = text.indexOf(m);
    if (i > 0) text = text.slice(0, i);
  }
  return text;
}

/**
 * Découpe le texte rendu d'un profil (nouveau design LinkedIn, classes CSS
 * inexploitables) en sections via leurs titres (FR + EN), et n'en garde que
 * l'essentiel : carte du haut, à propos, expériences, formation. L'activité,
 * les publications, les recommandations et le pied de page sont écartés — le
 * texte brut complet coûtait ~2 000 tokens par profil.
 * ⚠️ ZONE À MAINTENIR : libellés des titres de sections.
 */
function parseProfileText(raw) {
  raw = stripFooter(raw);
  const NOISE = /^(…\s*more|…\s*plus|…?\s*voir plus|Show all.*|Voir tout.*|Tout afficher|Afficher plus|Afficher les .{0,40}|Follow|Suivre|\+ ?Suivre|Message|Like|Comment|Repost|Send|J['’]aime|Commenter|Republier|Envoyer|·|•|.{0,80}et \d+ compétences? de plus|.{0,80}and \d+ (more )?skills?)$/i;
  const SECTION = [
    ["about", /^(About|Infos)$/i],
    ["activity", /^(Activity|Activité)$/i],
    ["experience", /^(Experience|Expérience)$/i],
    ["education", /^(Education|Formation)$/i],
    ["skip", /^(Licenses & certifications|Licences et certifications|Featured|Sélection|Projects|Projets|Skills( \(\d+\))?|Compétences( \(\d+\))?|Publications|Courses|Cours|Honors & awards|Prix et distinctions|Languages|Langues|Volunteering.*|Bénévolat|Recommendations|Recommandations|Interests|Centres d['’]intérêt|Causes|More profiles for you|Autres profils pour vous|People also viewed|Explore Premium profiles|Explorer les profils Premium|Autres pages consultées|Sales Insights|Key signals|Highlights|Points communs|People who can introduce you)$/i],
  ];
  const buckets = { top: [] };
  const seen = new Set();
  let cur = "top";
  for (const line of raw.split("\n")) {
    let isHeading = false;
    for (const [name, re] of SECTION) {
      // Chaque section n'est acceptée qu'une fois ("About" réapparaît dans le
      // pied de page — sans ce garde, il aspirerait tout le footer).
      if (re.test(line) && (name === "skip" || !seen.has(name))) {
        seen.add(name);
        cur = name;
        isHeading = true;
        break;
      }
    }
    if (isHeading) continue;
    if (cur === "activity" || cur === "skip") continue;
    if (NOISE.test(line)) continue;
    (buckets[cur] = buckets[cur] || []).push(line);
  }

  // — Carte du haut : nom / niveau de relation / titre / localisation / relations
  const top = buckets.top;
  const stop = top.findIndex((l) => /^(Contact info|Coordonnées)$/i.test(l));
  const head = stop > 0 ? top.slice(0, stop) : top.slice(0, 8);
  const out = { name: null, pronouns: null, degree: null, headline: null, location: null, connections: null, followers: null };
  const rest = [];
  for (const l of head) {
    const deg = /^[·•]?\s*(\d+(?:st|nd|rd|th)\+?|1er\+?|2e\+?|3e\+?)$/i.exec(l);
    if (deg) { out.degree = deg[1]; continue; }
    // ligne de pronoms (« He/Him », « Elle/Elle »…) — à part, sinon elle décale titre et localisation
    if (/^[A-Za-zÀ-ÿ]{2,12}\s?\/\s?[A-Za-zÀ-ÿ]{2,12}$/.test(l)) { out.pronouns = l; continue; }
    // Une vraie puce « 500 relations » / « 2 183 abonnés » est courte — sans ce
    // garde, une carte de suggestion (« Cole R. … 12 544 abonnés Suivre ») qui
    // se glisse avant « Coordonnées » dans l'ordre DOM serait prise pour la nôtre.
    if (l.length <= 48) {
      const con = /[\d,.\s]*\d\+?\s*(connections|relations)/i.exec(l);
      if (con) { out.connections = con[0]; continue; }
      const fol = /[\d,.\s]*\d\+?\s*(followers|abonnés)/i.exec(l);
      if (fol) { out.followers = fol[0]; continue; }
    }
    if (/^https?:\/\//i.test(l)) continue;
    rest.push(l);
  }
  out.name = rest[0] || null;
  out.headline = rest[1] || null;
  // La carte du haut peut intercaler la ligne « entreprise · école » avant la
  // localisation (fenêtre étroite) : on cherche une ligne qui RESSEMBLE à un
  // lieu (virgule, « Région »/« Area »…) avant de se rabattre sur la position.
  const locLike = (l) => /,|Région|Region|Area|Greater/i.test(l);
  // La ligne « entreprise · école » (reconnaissable à son « · ») s'intercale
  // souvent avant le lieu : on l'écarte. S'il reste une ligne qui RESSEMBLE à un
  // lieu on la prend, sinon la dernière (« France » seul : ni virgule ni
  // « Région ») — et null plutôt qu'un mauvais candidat.
  const locCand = rest.slice(2).filter((l) => !/·/.test(l));
  out.location = locCand.find(locLike) || locCand[locCand.length - 1] || null;
  const join = (k, cap) => (buckets[k] && buckets[k].length ? buckets[k].join("\n").slice(0, cap) : null);
  out.about = join("about", 1500);
  out.experience = join("experience", 3000);
  out.education = join("education", 2000);
  // Repli compact si aucune section exploitable : la carte du haut seulement —
  // JAMAIS le texte brut complet (le fil d'activité pèse des milliers de tokens).
  out.top_text = join("top", 2500);
  return out;
}
window.__liParseProfileText = parseProfileText; // exposé pour les tests hors navigateur

async function doViewProfile() {
  // Diagnostic temporaire : langue/visibilité/session pour comprendre les
  // lectures incomplètes. À retirer une fois la fonctionnalité stabilisée.
  const debug = {
    url: location.href,
    lang: document.documentElement.lang || null,
    visibilite_debut: document.visibilityState,
  };
  // Prêt quand le profil a du TEXTE rendu — on n'attend pas un sélecteur précis,
  // le DOM du profil change trop souvent pour conditionner la lecture dessus.
  const contentReady = () => {
    if (pageNotFound()) return { notFound: true }; // 404 rendue en cours d'attente → abandon immédiat
    const main = document.querySelector("main") || document.body;
    const text = readableText(main);
    return text.length > 600 ? { main, text } : null;
  };
  const ready = await waitFor(contentReady, 20000);
  if (ready && ready.notFound) return { ok: false, error: NOT_FOUND_ERROR };
  if (!ready) {
    const main = document.querySelector("main") || document.body;
    const diag =
      `readyState=${document.readyState}, title=« ${document.title} », ` +
      `h1 sur la page=${document.querySelectorAll("h1").length}, main=${!!document.querySelector("main")}, ` +
      `texte rendu=${readableText(main).length} caractères`;
    return { ok: false, error: `contenu du profil non rendu après 20 s (${diag})` };
  }

  // LinkedIn ne rend les sections du bas (Expérience, Formation…) qu'au
  // défilement, et la page GRANDIT pendant qu'on descend (activité, modules…).
  // On défile par paliers, comme des appuis sur Page ↓, jusqu'à avoir VU les
  // titres Expérience ET Formation, ou jusqu'à un bas de page stable (2 mesures
  // identiques). Plafond large : les fils d'activité fournis sont longs.
  // ⚠️ PAS de behavior:"smooth" ici — l'animation passe par requestAnimationFrame,
  // suspendu quand l'onglet n'est pas visible : le défilement ne se ferait jamais.
  const renderedText = () =>
    "\n" + stripFooter(readableText(document.querySelector("main") || document.body)) + "\n";
  const sectionsSeen = () => {
    const t = renderedText();
    return /\n(Experience|Expérience)\n/.test(t) && /\n(Education|Formation)\n/.test(t);
  };
  // Selon la variante de design, la page défile par la FENÊTRE (ancien design)
  // ou par un CONTENEUR interne (nouveau design : body = hauteur de la fenêtre,
  // window.scrollBy sans effet). On repère le vrai élément défilable.
  const isScrollable = (el) =>
    !!el &&
    el.clientHeight >= window.innerHeight * 0.5 &&
    el.scrollHeight > el.clientHeight + 200 &&
    (el === document.scrollingElement || /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY));
  const findScroller = () => {
    if (isScrollable(document.scrollingElement)) return document.scrollingElement;
    let best = null;
    for (const el of document.querySelectorAll("main, div")) {
      if (isScrollable(el) && (!best || el.scrollHeight > best.scrollHeight)) best = el;
    }
    return best || document.scrollingElement;
  };

  let stableBottom = 0;
  let maxY = 0;
  let scroller = findScroller();
  for (let i = 0; i < 30 && stableBottom < 2 && !sectionsSeen(); i++) {
    if (!scroller.isConnected) scroller = findScroller(); // re-rendu React : élément remplacé
    const before = scroller.scrollHeight;
    scroller.scrollTop += Math.round(window.innerHeight * rand(0.6, 0.9));
    await sleep(rand(250, 550));
    maxY = Math.max(maxY, scroller.scrollTop);
    const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 100;
    stableBottom = atBottom && scroller.scrollHeight === before ? stableBottom + 1 : 0;
  }
  // Sections toujours absentes (profil hors réseau, rendu paresseux dans la
  // fenêtre cachée…) : 2e passe PLUS LENTE depuis le haut — certains modules ne
  // se chargent qu'après un vrai temps de présence. Ne coûte rien aux profils
  // complets (la passe rapide leur suffit).
  if (!sectionsSeen()) {
    scroller.scrollTop = 0;
    await sleep(rand(1200, 2000));
    for (let i = 0; i < 10 && !sectionsSeen(); i++) {
      if (!scroller.isConnected) scroller = findScroller();
      scroller.scrollTop += Math.round(window.innerHeight * rand(0.5, 0.7));
      await sleep(rand(800, 1200));
      maxY = Math.max(maxY, scroller.scrollTop);
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 100) {
        const before = scroller.scrollHeight;
        await sleep(rand(1000, 1600)); // présence en bas de page — laisse arriver les modules
        if (scroller.scrollHeight === before) break; // rien ne vient plus
      }
    }
  }
  await sleep(rand(300, 700));
  scroller.scrollTop = 0;
  await sleep(rand(500, 900)); // laisse les sections révélées finir de charger
  debug.visibilite_fin = document.visibilityState;
  debug.conteneur = scroller === document.scrollingElement
    ? "fenêtre"
    : `${scroller.tagName}.${String(scroller.className || "").trim().slice(0, 50)}`;
  debug.defilement_max = maxY;
  debug.hauteur_page = scroller.scrollHeight;
  debug.hauteur_fenetre = window.innerHeight;
  debug.indice_deconnecte = !!findClickable(/s['’]identifier|^sign in$|s['’]inscrire|join now/i);

  const txt = (el) => {
    const t = el && el.innerText ? el.innerText.trim().replace(/\s+/g, " ") : "";
    return t || null;
  };

  // — Nom : h1 si le DOM en a un, sinon le titre de l'onglet « (3) Jean Dupont | LinkedIn »
  const h1 = document.querySelector("main h1, h1.text-heading-xlarge, .pv-text-details__left-panel h1");
  const nameFromTitle =
    (document.title || "").replace(/^\(\d+\)\s*/, "").replace(/\s*[|·–-]\s*LinkedIn.*$/i, "").trim() || null;

  // — Carte du haut (section contenant le h1, si h1 il y a)
  const topCard = (h1 && h1.closest("section")) || document.querySelector("main section");
  const headline = txt(topCard?.querySelector(".text-body-medium.break-words"));
  const place = txt(
    topCard?.querySelector(".text-body-small.inline.t-black--light.break-words, .text-body-small.t-black--light.break-words")
  );
  const degree = (txt(document.querySelector("span.dist-value")) || "").replace(/^·\s*/, "") || null;
  // relations / abonnés : on parcourt les puces de la carte du haut
  let connections = null;
  let followers = null;
  for (const li of topCard ? topCard.querySelectorAll("ul li") : []) {
    const t = txt(li);
    // > 80 caractères = pas une puce « 500 relations » mais un module entier
    // (nouveau design : topCard peut englober le fil d'activité — on a déjà vu
    // un post complet partir dans `connections`).
    if (!t || t.length > 80) continue;
    if (!connections && /relation|connection/i.test(t)) connections = t;
    else if (!followers && /abonné|follower/i.test(t)) followers = t;
  }

  // — Sections par ancre
  const aboutSec = profileSection("about");
  const about = txt(
    aboutSec?.querySelector('.inline-show-more-text span[aria-hidden="true"], [class*="inline-show-more-text"]')
  );

  const experience = sectionItems(profileSection("experience"));
  const education = sectionItems(profileSection("education"));

  const profile = {
    url: location.href,
    name: txt(h1) || nameFromTitle,
    headline,
    location: place,
    degree,           // « 1er », « 2e », « 3e » — null si hors réseau/non affiché
    connections,
    followers,
    about: about ? about.slice(0, 3000) : null,
    experience,
    education,
  };
  // Repli : si l'extraction DOM n'a rien donné (nouveau design LinkedIn), on
  // parse le texte rendu par sections et on ne garde que l'essentiel. Le texte
  // brut (page_text) ne part que si même ce découpage échoue (langue non gérée ?).
  if (!experience && !education) {
    const fullText = readableText(document.querySelector("main") || document.body);
    // Diagnostic : sépare « le texte n'est pas rendu » (fenêtre cachée ?) de
    // « le texte est là mais le découpage échoue » (libellés à mettre à jour).
    debug.longueur_texte = fullText.length;
    debug.sections_detectees = ["About", "Infos", "Experience", "Expérience", "Education", "Formation", "Activity", "Activité"]
      .filter((h) => new RegExp(`\\n${h}\\n`, "i").test(`\n${fullText}\n`));
    const parsed = parseProfileText(fullText);
    if (!profile.name) profile.name = parsed.name;
    if (!profile.headline) profile.headline = parsed.headline;
    if (!profile.location) profile.location = parsed.location;
    if (!profile.degree) profile.degree = parsed.degree;
    if (!profile.connections) profile.connections = parsed.connections;
    if (!profile.followers) profile.followers = parsed.followers;
    if (!profile.about) profile.about = parsed.about;
    profile.experience = parsed.experience;
    profile.education = parsed.education;
    if (!parsed.experience && !parsed.education && !parsed.about) {
      profile.page_text = parsed.top_text;
    }
  }
  // Le diagnostic n'est joint qu'aux lectures incomplètes (économie de tokens).
  if (!profile.experience && !profile.education) profile.debug = debug;
  // Champs vides retirés — des `"followers": null` en série gonflaient chaque réponse.
  for (const k of Object.keys(profile)) if (profile[k] == null) delete profile[k];
  return { ok: true, data: { profile } };
}

const norm = (s) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Clic « musclé » qui déclenche vraiment la navigation SPA de LinkedIn.
 * LinkedIn n'expose ni lien ni id dans la liste : le fil s'ouvre au clic JS,
 * et le gestionnaire est sur un élément ENFANT — cliquer le <li> parent ne le
 * déclenche pas. On vise donc l'élément réellement sous le centre de la carte
 * (elementFromPoint) et on émet la séquence pointer+souris complète, qui remonte
 * jusqu'au bon gestionnaire.
 */
async function robustClick(container) {
  try { container.scrollIntoView({ block: "center", behavior: "smooth" }); }
  catch { container.scrollIntoView({ block: "center" }); }
  await sleep(rand(350, 750)); // stabilisation du défilement
  const r = container.getBoundingClientRect();
  // point aléatoire dans la moitié haute de la carte (là où se trouve le nom/handler),
  // jamais pile au centre : plus proche d'un vrai clic.
  const x = Math.round(r.left + rand(r.width * 0.2, r.width * 0.8));
  const y = Math.round(r.top + rand(8, Math.min(Math.max(r.height - 6, 10), 40)));
  let el = document.elementFromPoint(x, y);
  if (!el || !container.contains(el)) el = container;
  await moveMouseTo(x, y);            // déplacement de curseur humain vers la carte
  await sleep(rand(40, 140));         // hésitation
  const o = await pressAt(el, x, y);  // survol → appui → relâche (positions cohérentes)
  // ici le click SYNTHÉTIQUE est nécessaire : LinkedIn n'ouvre pas le fil sur un
  // .click() natif du <li> (le gestionnaire est sur un enfant, capté par elementFromPoint).
  el.dispatchEvent(new MouseEvent("click", o));
}

/** Nom du contact affiché dans l'en-tête du fil actuellement ouvert (best-effort). */
function openThreadName() {
  const sels = [
    ".msg-thread .msg-entity-lockup__entity-title",
    ".msg-title-bar__details h2",
    ".msg-title-bar h2",
    ".scaffold-layout__detail h2",
    ".msg-thread h2",
  ];
  for (const s of sels) {
    const e = document.querySelector(s);
    if (e && e.textContent.trim()) return e.textContent.trim();
  }
  return null;
}

/** Ouvre la conversation dont le participant correspond à `name`, sur la page
 *  messagerie déjà chargée (le background y a navigué). Vérifie que le fil s'est
 *  bien ouvert AVANT d'autoriser l'écriture — jamais d'envoi au mauvais contact. */
async function openConversationByName(name) {
  const list = await waitFor(
    () => document.querySelector(".msg-conversations-container__conversations-list, ul.msg-conversations-container__conversations-list"),
    10000
  );
  if (!list) return { ok: false, error: "messagerie non chargée" };
  await sleep(rand(800, 1600));

  const want = norm(name);
  const nameOf = (c) =>
    norm(c.querySelector(".msg-conversation-listitem__participant-names, .msg-conversation-card__participant-names")?.textContent);

  const pick = () => {
    const cards = [...document.querySelectorAll("li.msg-conversation-listitem")];
    return (
      cards.find((c) => nameOf(c) === want) ||
      cards.find((c) => nameOf(c).startsWith(want)) ||
      cards.find((c) => nameOf(c).includes(want)) ||
      null
    );
  };
  const card = await waitFor(pick, 6000);
  if (!card) return { ok: false, error: `conversation avec « ${name} » introuvable dans la liste` };

  await robustClick(card);
  await human();

  // Vérifie que le BON fil est ouvert : en-tête au nom voulu OU le panneau de
  // détail contient ce nom, ET le champ de saisie est présent.
  const ok = await waitFor(() => {
    const composer = document.querySelector('.msg-form__contenteditable [contenteditable="true"], div[role="textbox"][contenteditable="true"]');
    if (!composer) return false;
    const title = norm(openThreadName());
    if (title && (title === want || title.includes(want) || want.includes(title))) return true;
    const detail = document.querySelector(".msg-thread, .scaffold-layout__detail");
    return detail ? norm(detail.textContent).includes(want) : false;
  }, 9000);

  if (!ok) {
    return {
      ok: false,
      error: `impossible d'ouvrir la conversation de « ${name} » : LinkedIn n'a pas réagi au clic (il exige peut-être un vrai clic humain). Aucun message envoyé.`,
    };
  }
  return { ok: true };
}

// Garde anti-doublon : le background peut ré-injecter content.js si le script du
// manifest tarde (onglet endormi) — on ne doit jamais enregistrer deux listeners,
// sinon chaque action serait exécutée deux fois (double envoi !).
if (!window.__liMcpListenerRegistered) {
  window.__liMcpListenerRegistered = true;
  registerLiListener();
}

function registerLiListener() {
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "li-action") {
    const { action } = msg;
    (async () => {
      try {
        // Sécurité : si LinkedIn affiche un contrôle de sécurité / captcha, on s'arrête net.
        if (/checkpoint|captcha|challenge/i.test(location.href)) {
          sendResponse({ ok: false, error: "contrôle de sécurité LinkedIn détecté — pause" });
          return;
        }
        // Page 404 (profil supprimé, URL erronée) sur une action qui a navigué
        // vers une URL précise : échec IMMÉDIAT, sans attendre les timeouts de
        // sélecteurs (~20 s) — et sans pause punitive côté serveur.
        if ((action.type === "view_profile" || action.linkedin || action.thread) && pageNotFound()) {
          sendResponse({ ok: false, error: NOT_FOUND_ERROR });
          return;
        }
        // Mode « conversation ouverte » (le plus fiable) : on agit directement
        // dans le fil affiché, sans navigation ni clic sur la liste.
        if (action.open && (action.type === "message" || action.type === "read_messages")) {
          if (!/\/messaging\//.test(location.href)) {
            sendResponse({ ok: false, error: "aucune conversation ouverte à l'écran (ouvre la conversation LinkedIn voulue d'abord)" });
            return;
          }
          const r = action.type === "read_messages"
            ? await doReadMessages(action.limit, true)
            : await doMessage(action.body, true);
          sendResponse(r);
          return;
        }
        // Ciblage par NOM (secondaire) : on ouvre la conversation puis on agit dans le fil.
        if (action.conv_name && (action.type === "message" || action.type === "read_messages")) {
          const opened = await openConversationByName(action.conv_name);
          if (!opened.ok) { sendResponse(opened); return; }
          const r = action.type === "read_messages"
            ? await doReadMessages(action.limit, true)
            : await doMessage(action.body, true);
          sendResponse(r);
          return;
        }
        const inThread = !!action.thread; // action ciblant un fil (/messaging/thread/...)
        const r =
          action.type === "message" ? await doMessage(action.body, inThread)
          : action.type === "read_messages" ? await doReadMessages(action.limit, inThread)
          : action.type === "list_conversations" ? await doListConversations(action.limit)
          : action.type === "view_profile" ? await doViewProfile()
          : await doInvite(action.body);
        sendResponse(r);
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true; // réponse asynchrone
  }
});
}
