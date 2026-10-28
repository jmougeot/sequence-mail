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
  // Dernier essai à l'échéance : dans un onglet en arrière-plan, Chrome peut
  // retarder les minuteries au-delà du délai, et la boucle sortirait sans revoir la page.
  return find() || null;
}

/** La page se dessine encore : requestAnimationFrame tourne. Chrome le gèle dans un
 *  onglet caché (fenêtre réduite ou recouverte) ; la messagerie LinkedIn, qui en
 *  dépend, n'y apparaît alors jamais — autant le dire tout de suite. */
function rendering(timeout = 1500) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), timeout);
    requestAnimationFrame(() => { clearTimeout(t); resolve(true); });
  });
}

/** Élément actif, descendu dans les shadow roots (document.activeElement s'arrête à l'hôte). */
function activeDeep() {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

/** Racines de recherche : le document d'abord, puis les shadow roots ouverts
 *  (le nouveau design LinkedIn y rend la fenêtre d'invitation, invisible pour
 *  document.querySelectorAll). Le document en premier : ce qu'on y trouvait
 *  reste prioritaire. */
function searchRoots(root = document, depth = 0, out = []) {
  out.push(root);
  if (depth > 40) return out;
  for (const host of root.querySelectorAll("*")) if (host.shadowRoot) searchRoots(host.shadowRoot, depth + 1, out);
  return out;
}
const deepQueryAll = (sel) => searchRoots().flatMap((r) => [...r.querySelectorAll(sel)]);

/** Affiché : offsetParent suffit dans le document ; dans un shadow root il peut
 *  valoir null pour un élément visible (fenêtre en position fixe), d'où les rects. */
function isShown(el) {
  if (el.offsetParent !== null) return true;
  return el.getRootNode() !== document && el.getClientRects().length > 0;
}

/** Premier bouton/lien cliquable dont le texte OU l'aria-label matche la regex. */
function findClickable(re) {
  const nodes = deepQueryAll('button, a, [role="button"]');
  for (const el of nodes) {
    if (el.disabled || !isShown(el)) continue; // ignore masqués/désactivés
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
  if (await realClick(el)) return;
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

// --- Vrais gestes ---------------------------------------------------------------
// Souris, molette et clavier joués par le background via le débogueur de Chrome
// (événements isTrusted, comme une vraie main — cf. background.js « Vrais gestes »).
// Ici on mesure la cible et on vérifie ; tout refus ou doute → gestes simulés comme avant.
// Le runner (faux chrome.runtime, sans sendMessage) n'en a pas : gestes simulés.
const canRealInput = () => typeof chrome !== "undefined" && !!(chrome.runtime && chrome.runtime.sendMessage && chrome.runtime.id);

async function realInput(cmd) {
  if (!canRealInput()) return false;
  try {
    const r = await chrome.runtime.sendMessage({ type: "real-input", vw: window.innerWidth, vh: window.innerHeight, ...cmd });
    return Boolean(r && r.ok);
  } catch {
    return false;
  }
}

// Dernier survol réel : avant d'appuyer, le vrai curseur doit être sur la cible.
let lastTrustedPath = [];
document.addEventListener("mousemove", (e) => { if (e.isTrusted) lastTrustedPath = e.composedPath(); }, { capture: true, passive: true });

/** Élément sous (x,y), descendu dans les shadow roots ouverts. */
function deepElementFromPoint(x, y) {
  let el = document.elementFromPoint(x, y);
  while (el && el.shadowRoot) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}

/** `node` est-il `el` ou à l'intérieur (en traversant les shadow roots) ? */
function composedContains(el, node) {
  for (let n = node; n; n = n.parentNode || n.host) if (n === el) return true;
  return false;
}

/** Amène `el` à l'écran à la molette, la main d'abord posée sur le contenu. Faux si la
 *  molette n'a rien fait défiler (curseur sur un bandeau fixe, onglet caché…). */
async function realScrollIntoView(el) {
  for (let i = 0; i < 4; i++) {
    const r = el.getBoundingClientRect();
    if (r.top >= 70 && r.bottom <= window.innerHeight - 40) return true;
    const x = Math.min(window.innerWidth - 20, Math.max(20, r.left + r.width / 2 + rand(-60, 60)));
    if (!(await realInput({ op: "move", x, y: window.innerHeight * rand(0.4, 0.7) }))) return false;
    if (!(await realInput({ op: "wheel", dy: r.top + r.height / 2 - window.innerHeight * rand(0.35, 0.6) }))) return false;
    await sleep(rand(300, 650));
    if (Math.abs(el.getBoundingClientRect().top - r.top) < 2) return false;
  }
  const r = el.getBoundingClientRect();
  return r.top >= 0 && r.bottom <= window.innerHeight;
}

/** Vrai clic : défilement à la molette, trajectoire de main vers un point de la cible,
 *  hésitation, appui. Avant d'appuyer, la cible doit être sous le curseur (survol réel
 *  reçu ; onglet caché, où Chrome retient les survols : élément sous le point). Une fois
 *  l'appui parti, jamais de second clic simulé (pas de double envoi). Faux = rien appuyé. */
async function realClick(el) {
  if (!canRealInput()) return false;
  if (!(await realScrollIntoView(el))) {
    try { el.scrollIntoView({ block: "center" }); } catch {}
    await sleep(rand(300, 600));
  }
  const { x, y } = jitterPoint(el);
  if (x < 1 || y < 1 || x > window.innerWidth - 1 || y > window.innerHeight - 1) return false;
  if (!composedContains(el, deepElementFromPoint(x, y))) return false; // recouvert (fenêtre, bandeau)
  if (!(await realInput({ op: "move", x, y }))) return false;
  await sleep(rand(70, 220)); // hésitation avant d'appuyer
  const onTarget = document.visibilityState === "hidden"
    ? composedContains(el, deepElementFromPoint(x, y))
    : lastTrustedPath.includes(el);
  if (!onTarget) return false;
  // Appui refusé (débogueur détaché entre le déplacement et l'appui) : rien n'a été cliqué,
  // l'appelant reprend en simulé. Avant, « vrai » quand même : ni clic réel ni repli.
  return realInput({ op: "press" });
}

// Texte déposé d'un coup par le débogueur (événements de confiance, sans touche). Vrai : touche
// par touche à la place (rythme humain, mais disposition de clavier à imiter et 1 à 2 min par message).
const TYPE_KEY_BY_KEY = false;

/** Texte dans un champ vide : clic réel dedans si besoin, puis insertion par le débogueur. Vrai si
 *  le champ contient exactement `text` ensuite (sinon l'appelant remplace par la saisie simulée). */
async function realFill(el, text) {
  const fieldText = () => (el.tagName === "TEXTAREA" || el.tagName === "INPUT" ? el.value : el.innerText) || "";
  if (!canRealInput() || normWords(fieldText())) return false; // brouillon déjà là : saisie simulée, qui remplace
  const focused = () => composedContains(el, activeDeep());
  if (!focused()) {
    await realClick(el);
    await sleep(rand(200, 500));
  }
  if (!focused()) return false;
  if (!(await realInput({ op: TYPE_KEY_BY_KEY ? "type" : "insert", text }))) return false;
  await sleep(rand(300, 700));
  return normWords(fieldText()) === normWords(text);
}

/** Échap au vrai clavier, sinon simulé. */
async function pressEscape() {
  if (await realInput({ op: "key", key: "Escape" })) return;
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
}

/** Avant d'agir sur un profil : le temps de le lire. Un arrêt sur le haut de la page,
 *  un à trois défilements vers le bas, puis retour en haut (8 à 25 s en tout). À la vraie
 *  molette ; à défaut, défilement direct (scrollTop), qui marche aussi dans un onglet caché. */
async function glanceProfile() {
  if (!/^\/in\//.test(location.pathname)) return;
  await sleep(rand(3000, 7000));
  const scroller = [document.scrollingElement, ...document.querySelectorAll("main")].find(
    (el) => el && el.scrollHeight > el.clientHeight + 200 &&
      (el === document.scrollingElement || /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY))
  );
  if (!scroller) return;
  const steps = 1 + Math.floor(rand(0, 3));
  if (await realInput({ op: "move", x: window.innerWidth * rand(0.35, 0.65), y: window.innerHeight * rand(0.45, 0.75) })) {
    let wheeled = true;
    for (let i = 0; i < steps && wheeled; i++) {
      const before = scroller.scrollTop;
      wheeled = (await realInput({ op: "wheel", dy: window.innerHeight * rand(0.4, 0.9) })) && scroller.scrollTop !== before;
      await sleep(rand(1500, 4500));
    }
    if (wheeled) {
      for (let i = 0; i < 3 && scroller.scrollTop > 0; i++) {
        await realInput({ op: "wheel", dy: -scroller.scrollTop - rand(50, 200) });
        await sleep(rand(400, 900));
      }
      await sleep(rand(800, 2000));
      return;
    }
  }
  for (let i = 0; i < steps; i++) {
    // par petits pas, comme une molette
    const target = scroller.scrollTop + Math.round(window.innerHeight * rand(0.4, 0.9));
    while (scroller.scrollTop < target - 5) {
      const before = scroller.scrollTop;
      scroller.scrollTop += Math.round(rand(60, 140));
      if (scroller.scrollTop === before) break; // bas de page
      await sleep(rand(30, 90));
    }
    await sleep(rand(1500, 4500));
  }
  while (scroller.scrollTop > 0) {
    const before = scroller.scrollTop;
    scroller.scrollTop -= Math.round(rand(150, 300));
    if (scroller.scrollTop === before) break;
    await sleep(rand(20, 60));
  }
  await sleep(rand(800, 2000));
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
  return RE_NOT_FOUND.test(readableText(main, 3000).slice(0, 1500));
}
// Contrôle de sécurité LinkedIn : /checkpoint/… (défi, captcha, vérification), /authwall.
const RE_SECURITY_PATH = /^\/(checkpoint|authwall)(\/|$)/i;
// Le marqueur « (404) » est reconnu par le serveur : pas de pause de sécurité.
const NOT_FOUND_ERROR = "page LinkedIn introuvable (404) — l'URL n'existe pas, ou le profil a été supprimé/renommé";

// --- Libellés (FR + EN). À COMPLÉTER si LinkedIn change. ----------------------
const RE_CONNECT = /^(se connecter|connect|invitez|inviter|invite)\b/i;
const RE_MORE = /^(plus|more actions|more)\b/i;
const RE_ADD_NOTE = /(ajouter une note|add a note)/i;
const RE_SEND_NOTE = /(envoyer l.invitation|envoyer$|^envoyer\b|send invitation|^send$)/i;
const RE_SEND_NO_NOTE = /(envoyer sans note|send without)/i;
const RE_SEND_MSG = /(^envoyer$|^send$)/i;
const RE_PENDING = /^(en attente|pending)\b/i;

/** Bouton « Message » DU PROFIL affiché — PAS le lien global « Messagerie » de
 *  la barre de navigation (en FR il matche le même mot et arrive plus tôt dans le
 *  DOM : on cliquait la mauvaise fenêtre → « zone de saisie introuvable »).
 *  On écarte donc tout lien vers /messaging/ (c'est la nav) et on privilégie le
 *  vrai bouton d'action du profil (« Message » / « Envoyer un message à … »).
 *  Cherché aussi dans les shadow roots (nouveau design), jamais dans la colonne
 *  de droite ni sur un bouton qui nomme quelqu'un d'autre (cf. findOwnClickable). */
function findProfileMessageBtn() {
  const me = profileName();
  for (const el of deepQueryAll('button, a, [role="button"]')) {
    if (el.disabled || !isShown(el) || el.closest("aside")) continue;
    const href = el.getAttribute("href") || "";
    if (/\/messaging\/?$/.test(href.split("?")[0])) continue; // lien de nav global → ignoré
    const aria = el.getAttribute("aria-label") || "";
    const label = `${aria} ${el.textContent || ""}`.trim();
    if (/^messagerie$/i.test(label)) continue; // libellé nav seul → ignoré
    if (!/(?:^|\b)message\b/i.test(label) && !/envoyer un message/i.test(label)) continue;
    const who = messagee(aria);
    if (who && me && !who.startsWith(me) && !me.startsWith(who)) continue; // « Message Jean » sur « Jean Dupont, PhD »
    return el;
  }
  return null;
}

/** Personne nommée par un libellé « Message X » / « Envoyer un message à X », sinon null. */
function messagee(label) {
  const m = label.match(/^(?:message|envoyer un message à)\s+(.+)$/i);
  return m ? normWords(m[1]) : null;
}

/** Degré de relation affiché à côté du nom (« · 1st », « · 2e »…) : 1, 2, 3, ou null s'il n'est pas lu. */
function profileDegree() {
  const main = document.querySelector("main") || document.body;
  const m = /[·•]\s*(1st|2nd|3rd|1er|2e|3e)\b/i.exec(readableText(main, 2000).slice(0, 800));
  return m ? Number(m[1][0]) : null;
}

/** Pas encore en relation : « Se connecter » / « En attente » affiché, ou degré 2 ou 3.
 *  Le degré compte quand ces boutons sont rangés dans « Plus » : seuls « Message »
 *  (lien /messaging/compose/, qui mène à une rédaction impossible) et « Suivre » restent visibles. */
const notConnected = () =>
  Boolean(findOwnClickable(RE_CONNECT) || findOwnClickable(RE_PENDING)) || profileDegree() > 1;

/** Bouton « Message » du profil, éventuellement rangé dans le menu « Plus ».
 *  `pending` : pas encore en relation (« Se connecter » / « En attente » affiché,
 *  y compris dans le menu, relevé avant de le refermer). LinkedIn affiche aussi
 *  « Message » sur certains profils hors relation (lien /messaging/compose/) :
 *  `pending` prime alors, c'est à l'appelant de ne pas écrire. */
async function findMessageButton(timeout = 6000) {
  let btn = await waitFor(() => findProfileMessageBtn(), timeout);
  if (btn) return { btn, pending: notConnected() };
  if (notConnected()) return { btn: null, pending: true };
  const more = findProfileMore();
  if (!more) return { btn: null, pending: false };
  await clickHuman(more);
  await human();
  btn = await waitFor(() => findProfileMessageBtn(), 3000);
  if (btn) return { btn, pending: false };
  const pending = notConnected();
  await dismissDialog(); // referme le menu
  return { btn: null, pending };
}

/** Zone de saisie de la conversation qu'on vient d'ouvrir. D'autres bulles de
 *  messagerie peuvent déjà être ouvertes : on prend celle qui a le focus (LinkedIn
 *  le donne à la nouvelle), sinon la dernière affichée — jamais la première du
 *  document, qui peut appartenir à une autre conversation. */
function findEditor() {
  const editors = deepQueryAll('.msg-form__contenteditable[contenteditable="true"], .msg-form__contenteditable [contenteditable="true"], div[role="textbox"][contenteditable="true"]')
    .filter(isShown);
  const focused = activeDeep();
  const active = editors.find((e) => e === focused || e.contains(focused));
  return active || editors[editors.length - 1] || null;
}

/** État de la page quand la zone de saisie manque, joint à l'erreur (cf. inviteDiagnostic). */
function messageDiagnostic(clicked) {
  const all = deepQueryAll('[contenteditable="true"]');
  const bubbles = deepQueryAll(".msg-overlay-conversation-bubble, .msg-convo-wrapper");
  const what = clicked
    ? `${clicked.tagName.toLowerCase()} « ${(clicked.getAttribute("aria-label") || clicked.textContent || "").trim().replace(/\s+/g, " ").slice(0, 30)} »${/\/messaging\/compose/.test(clicked.getAttribute("href") || "") ? " (lien compose)" : ""}`
    : "aucun (fil déjà ouvert)";
  return [
    `clic sur ${what}`,
    `onglet ${document.visibilityState}${document.hasFocus() ? "" : " sans focus"} ${innerWidth}×${innerHeight} en ${screenX},${screenY}`,
    `page ${location.pathname}`,
    `${all.length} champ(s) éditable(s) dont ${all.filter(isShown).length} affiché(s)`,
    `${bubbles.length} bulle(s) de messagerie`,
  ].join(" ; ");
}

/** Bouton Envoyer actif du même formulaire que l'éditeur. */
function findSendButton(editor) {
  const form = editor.closest("form") || threadRoot(editor);
  const btn = form.querySelector("button.msg-form__send-button:not([disabled])");
  if (btn) return btn;
  return [...form.querySelectorAll("button")].find(
    (b) => !b.disabled && isShown(b) && RE_SEND_MSG.test(`${b.getAttribute("aria-label") || ""} ${b.textContent || ""}`.trim())
  ) || null;
}

/** Nom du profil ouvert, lu dans le titre de l'onglet (« (3) Prénom Nom | LinkedIn »). */
function profileName() {
  return normWords(document.title.replace(/^\(\d+\)\s*/, "").split("|")[0]);
}

/** Personne nommée par un libellé « Invite X to connect » / « Inviter X à … », sinon null. */
function invitee(label) {
  const m = label.match(/^(?:invite|invitez|inviter)\s+(.+?)\s+(?:to connect|à (?:se connecter|rejoindre|vous connecter))/i);
  return m ? normWords(m[1]) : null;
}

/** Comme findClickable, mais seulement parmi les actions DU PROFIL ouvert :
 *  jamais dans la colonne de droite (<aside> : suggestions « Connect » d'autres
 *  personnes, et la messagerie avec son bouton « Send »), ni un bouton qui nomme
 *  quelqu'un d'autre. Sur un profil dont le « Se connecter » est rangé sous
 *  « Plus », on cliquait la suggestion d'à côté : l'invitation partait au
 *  mauvais destinataire. */
function findOwnClickable(re) {
  const me = profileName();
  for (const el of deepQueryAll('button, a, [role="button"]')) {
    if (el.disabled || !isShown(el) || el.closest("aside")) continue;
    const aria = el.getAttribute("aria-label") || "";
    if (!re.test(`${aria} ${el.textContent || ""}`.trim())) continue;
    const who = invitee(aria);
    if (who && me && who !== me) continue;
    return el;
  }
  return null;
}

/** Bouton « Plus » DU PROFIL, dans <main>. La barre de navigation du haut a aussi
 *  son « More », placé avant dans la page : on ouvrait le menu de LinkedIn, où
 *  « Se connecter » n'est jamais (« bouton introuvable » et pause de sécurité). */
function findProfileMore() {
  const main = document.querySelector("main");
  const inMain = (el) => {
    for (let n = el; n; n = n.parentNode || n.host) if (n === main) return true;
    return false;
  };
  for (const el of deepQueryAll('button, a, [role="button"]')) {
    if (el.disabled || !isShown(el) || el.closest("aside, header, nav, [role='navigation']")) continue;
    if (main && !inMain(el)) continue;
    if (RE_MORE.test(`${el.getAttribute("aria-label") || ""} ${el.textContent || ""}`.trim())) return el;
  }
  return null;
}

/** Bouton « Se connecter » du profil, éventuellement caché dans le menu « Plus ». */
async function findConnectButton() {
  let btn = findOwnClickable(RE_CONNECT);
  if (btn) return btn;
  const more = findProfileMore();
  if (more) {
    await clickHuman(more);
    await human();
    btn = await waitFor(() => findOwnClickable(RE_CONNECT), 4000);
  }
  return btn;
}

// Limite LinkedIn d'une note d'invitation (compte gratuit ; Premium : 300).
const NOTE_MAX = 200;
const RE_DISMISS = /^(ignorer|fermer|dismiss|close)\b/i;

const SEL_OPEN = '[role="dialog"], dialog[open], .artdeco-modal, [role="menu"], .artdeco-dropdown__content--is-open';

/** Ferme la fenêtre ou le menu affiché : Échap d'abord ; s'il reste ouvert, son bouton
 *  « Fermer »/« Ignorer » À LUI. Avant, le premier bouton « Ignorer » visible de toute la page
 *  était cliqué : celui d'une suggestion « Vous connaissez peut-être » de la colonne de droite
 *  l'écartait pour de bon (un vrai geste, enregistré par LinkedIn). */
async function dismissDialog() {
  await pressEscape();
  await human();
  const open = deepQueryAll(SEL_OPEN).find(isShown);
  if (!open) return;
  const btn = searchRoots(open)
    .flatMap((r) => [...r.querySelectorAll("button[aria-label]")])
    .find((b) => isShown(b) && RE_DISMISS.test(b.getAttribute("aria-label") || ""));
  if (!btn) return;
  await clickHuman(btn);
  await human();
}

/** État de la page quand le bouton d'envoi manque, joint à l'erreur : de quoi
 *  comprendre l'échec depuis Sequence Mail sans avoir vu l'onglet. */
function inviteDiagnostic(connect) {
  const roots = searchRoots();
  const dialog = deepQueryAll('[role="dialog"], dialog[open], .artdeco-modal').find(isShown);
  const buttons = (dialog ? [...dialog.querySelectorAll("button, a")] : [])
    .filter(isShown)
    .map((b) => (b.getAttribute("aria-label") || b.textContent || "").trim().replace(/\s+/g, " ").slice(0, 30))
    .filter(Boolean)
    .slice(0, 6);
  const text = (dialog ? dialog.textContent : "").trim().replace(/\s+/g, " ").slice(0, 80);
  const clicked = connect
    ? `${connect.tagName.toLowerCase()} « ${(connect.getAttribute("aria-label") || connect.textContent || "").trim().slice(0, 40)} »`
    : "aucun (page d'invitation)";
  return [
    `clic sur ${clicked}`,
    `onglet ${document.visibilityState} ${innerWidth}×${innerHeight}`,
    `page ${location.pathname}`,
    `${roots.length - 1} shadow root(s)`,
    dialog ? `fenêtre « ${text} » [${buttons.join(" | ")}]` : "aucune fenêtre affichée",
  ].join(" ; ");
}

/** Fenêtre de travail rendue visible par le background (rien côté runner, sans fenêtre). */
function showWorkWindow() {
  if (!chrome.runtime.sendMessage) return Promise.resolve();
  return new Promise((r) => chrome.runtime.sendMessage({ type: "li-show-for-message" }, () => { void chrome.runtime.lastError; r(); }));
}

/** Boutons du profil visibles quand « Se connecter » manque : de quoi corriger la détection. */
function connectDiagnostic() {
  const labels = deepQueryAll('button, a, [role="button"]')
    .filter((el) => isShown(el) && !el.closest("aside, header, nav"))
    .map((el) => (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40))
    .filter(Boolean)
    .slice(0, 12);
  return [
    `onglet ${document.visibilityState}`,
    `degré ${profileDegree() ?? "?"}`,
    `page ${location.pathname}`,
    `boutons [${labels.join(" | ")}]`,
  ].join(" ; ");
}

/** Envoie une invitation, avec la note si LinkedIn la permet. Une note trop
 *  longue n'est jamais tronquée, et un compte gratuit à court de notes (LinkedIn
 *  affiche alors une offre Premium au lieu du champ) n'échoue pas : dans les deux
 *  cas l'invitation part sans note, et le verdict le dit. */
async function doInvite(note, target) {
  // Page d'invitation (/preload/custom-invite/?vanityName=…) : sur le nouveau profil, « Se
  // connecter » est un lien qui y mène en rechargeant l'onglet ; le background renvoie alors
  // l'action au content script de cette page, fenêtre d'invitation déjà ouverte.
  const invitePage = /^\/preload\/custom-invite\b/.test(location.pathname);
  if (invitePage) {
    const vanity = normSlug(new URLSearchParams(location.search).get("vanityName"));
    const want = normSlug(((target || "").match(/\/in\/([^/?#]+)/) || [])[1]);
    const base = (x) => x.replace(/-(?=[0-9a-f]*\d)[0-9a-f]{5,}$/, "");
    if (vanity && want && base(vanity) !== base(want)) {
      return { ok: false, error: `page d'invitation d'un autre profil (${vanity}) — rien envoyé` };
    }
    const ready = await waitFor(() => findOwnClickable(RE_SEND_NO_NOTE) || findOwnClickable(RE_ADD_NOTE), 10000);
    if (!ready) {
      return { ok: false, error: `fenêtre d'invitation non rendue (invitation peut-être déjà partie) ; ${connectDiagnostic()}` };
    }
  }
  // Déjà en relation (1er degré) ou invitation déjà partie (« En attente », parfois sous « Plus ») :
  // l'action est considérée faite. Un bouton « Message » ne le prouve pas (Premium, profil
  // ouvert, et en français le lien « Messagerie » de la barre du haut) : il ne compte plus.
  const already = () => Boolean(findOwnClickable(RE_PENDING)) || profileDegree() === 1;
  const skipped = { ok: true, error: "déjà en relation ou invitation déjà envoyée (ignoré)" };
  if (!invitePage && !findOwnClickable(RE_CONNECT) && already()) return skipped;
  let connect = invitePage ? null : await findConnectButton();
  if (!invitePage && !connect) {
    if (already()) return skipped;
    // Menu « Plus » pas rendu dans un onglet caché : fenêtre de travail montrée, menu rouvert.
    await pressEscape();
    await showWorkWindow();
    await human();
    connect = await findConnectButton();
    if (!connect && already()) return skipped;
  }
  if (!invitePage && !connect) return { ok: false, error: `bouton « Se connecter » introuvable ; ${connectDiagnostic()}` };
  if (connect) {
    await clickHuman(connect);
    await human();
  }

  let clean = (note || "").trim();
  let dropped = null; // pourquoi l'invitation part sans la note demandée
  if (clean.length > NOTE_MAX) {
    dropped = `note de ${clean.length} caractères, LinkedIn en accepte ${NOTE_MAX}`;
    clean = "";
  }
  let noted = false;
  if (clean) {
    const addNote = await waitFor(() => findOwnClickable(RE_ADD_NOTE), 4000);
    if (!addNote) {
      dropped = "option « Ajouter une note » absente";
    } else {
      await clickHuman(addNote);
      // champ VISIBLE : l'offre Premium peut laisser un formulaire de note masqué dans la page
      const box = await waitFor(() => {
        return deepQueryAll('textarea[name="message"], #custom-message').find(isShown) || null;
      }, 4000);
      if (box) {
        if (!(await realFill(box, clean))) await typeInto(box, clean);
        noted = true;
      } else {
        dropped = "plus de note personnalisée disponible sur ce compte (offre Premium affichée)";
        await dismissDialog();
        // l'offre a pu refermer la fenêtre d'invitation : on la rouvre
        if (!findOwnClickable(RE_SEND_NO_NOTE)) {
          const again = await findConnectButton();
          if (again) {
            await clickHuman(again);
            await human();
          }
        }
      }
    }
  }
  // Envoyer (avec ou sans note). Certains profils envoient l'invitation dès le
  // clic sur « Se connecter », sans fenêtre : le bouton passe alors « En attente ».
  const send = await waitFor(
    () =>
      findOwnClickable(noted ? RE_SEND_NOTE : RE_SEND_NO_NOTE) ||
      findOwnClickable(RE_SEND_NOTE) ||
      (noted ? null : findOwnClickable(RE_PENDING)),
    10000
  );
  if (!send) return { ok: false, error: `bouton « Envoyer » de l'invitation introuvable — ${inviteDiagnostic(connect)}` };
  if (RE_PENDING.test(`${send.getAttribute("aria-label") || ""} ${send.textContent || ""}`.trim())) {
    dropped = dropped || (clean ? "LinkedIn l'a envoyée dès le clic sur « Se connecter »" : null);
    return dropped ? { ok: true, error: `invitation envoyée sans note — ${dropped}` } : { ok: true };
  }
  await clickHuman(send);
  await human();
  return dropped ? { ok: true, error: `invitation envoyée sans note — ${dropped}` } : { ok: true };
}

// --- Garde-fou d'un message servi par Sequence Mail ---------------------------
// On relit la conversation ouverte juste avant d'écrire : c'est la seule source
// sûre (la lecture de la messagerie ne passe qu'au plus toutes les 2 h, et rate une
// réponse si l'utilisateur a lui-même répondu entre-temps).

const normWords = (s) =>
  String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
// Repère d'un message dans le fil : ses 200 premiers caractères, espaces et accents normalisés
// (60 confondaient deux étapes à la même phrase d'ouverture : la relance passait pour déjà envoyée).
const textKey = (s) => normWords(s).slice(0, 200);

/** Conversation qui contient l'éditeur (bulle de messagerie ou page /messaging). */
function threadRoot(editor) {
  return editor.closest(".msg-overlay-conversation-bubble, .msg-convo-wrapper, .msg-thread, .scaffold-layout__detail") || document;
}

/** Messages du fil, dans l'ordre : { mine: true | false | null (auteur illisible), text }. */
function threadMessages(root, meName) {
  const events = [...root.querySelectorAll(".msg-s-event-listitem")];
  // LinkedIn marque les messages reçus (--other) ; à défaut, le nom de l'auteur.
  const marked = events.some((ev) => ev.classList.contains("msg-s-event-listitem--other"));
  const me = normWords(meName);
  const out = [];
  let sender = null; // les messages consécutifs d'un même auteur ne répètent pas son nom
  for (const ev of events) {
    const nameEl = ev.querySelector(".msg-s-message-group__name") || ev.closest("li")?.querySelector(".msg-s-message-group__name");
    if (nameEl) sender = nameEl.textContent.trim();
    let mine = null;
    if (marked) mine = !ev.classList.contains("msg-s-event-listitem--other");
    else if (sender && /^(vous|you)$/i.test(sender)) mine = true;
    else if (sender && me) mine = normWords(sender).startsWith(me);
    for (const body of ev.querySelectorAll(".msg-s-event-listitem__body")) {
      const t = (body.innerText || body.textContent || "").trim();
      if (t) out.push({ mine, text: t });
    }
  }
  return out;
}

/**
 * Décide, dans la conversation ouverte, si le message peut partir. `guard` vient
 * du serveur : ce que la séquence a déjà envoyé à ce contact (`sent`, dans
 * l'ordre) et `fresh` (la relation vient de notre invitation). Rend null s'il
 * faut envoyer, sinon le verdict — et rien n'est écrit :
 *  - ce texte est déjà dans le fil, de notre main : exécution précédente dont le
 *    verdict s'est perdu → action faite, pas de doublon ;
 *  - le contact a écrit depuis notre premier envoi → il a répondu (la séquence
 *    s'arrête). Sans repère dans le fil : n'importe quel message de lui après
 *    une relance ou une nouvelle relation, sinon le dernier message du fil ;
 *  - un message de notre main que la séquence n'a pas écrit (à la main, autre
 *    campagne) → on lui a déjà écrit : rien envoyé, la séquence s'arrête ;
 *  - fil illisible alors qu'on lui a déjà écrit, ou auteurs indéterminés → on
 *    n'envoie pas, par précaution.
 */
async function threadGuard(editor, text, guard, meName) {
  const sent = (guard.sent || []).filter((s) => s && s.body);
  const followup = sent.some((s) => s.type === "message");
  const root = threadRoot(editor);
  let msgs = threadMessages(root, meName);
  if (!msgs.length) {
    // le fil se charge parfois après l'éditeur ; un fil vide doit l'être vraiment
    await waitFor(() => root.querySelector(".msg-s-event-listitem__body"), 6000);
    msgs = threadMessages(root, meName);
  }
  if (!msgs.length) {
    return followup
      ? { ok: false, error: "conversation illisible alors qu'un message est déjà parti — rien envoyé par précaution" }
      : null;
  }
  const key = textKey(text);
  const anchors = new Set(sent.map((s) => textKey(s.body)).filter(Boolean));
  // Un texte écrit par la séquence est de notre main, quel que soit le nom affiché.
  for (const m of msgs) if (anchors.has(textKey(m.text)) || textKey(m.text) === key) m.mine = true;
  if (msgs.some((m) => m.mine && textKey(m.text) === key)) {
    return { ok: true, error: "déjà présent dans la conversation (exécution précédente) — pas renvoyé" };
  }
  const first = msgs.findIndex((m) => anchors.has(textKey(m.text)));
  const scope = first >= 0 ? msgs.slice(first + 1) : followup || guard.fresh ? msgs : msgs.slice(-1);
  const theirs = scope.filter((m) => m.mine === false);
  if (theirs.length) {
    return {
      ok: false,
      replied: true,
      reply_text: theirs[theirs.length - 1].text.slice(0, 2000),
      error: "le contact a écrit dans la conversation — message non envoyé",
    };
  }
  const others = msgs.filter((m) => !anchors.has(textKey(m.text)));
  if (others.some((m) => m.mine === true)) {
    return {
      ok: false,
      already_messaged: true,
      error: "déjà un message de notre part dans la conversation, hors séquence — message non envoyé",
    };
  }
  if (others.some((m) => m.mine === null)) {
    return { ok: false, error: "auteur des messages de la conversation illisible — rien envoyé par précaution" };
  }
  return null;
}

/** Envoie un message. Depuis un profil (le profil doit être une relation) ou,
 *  si inThread, directement dans un fil déjà ouvert (/messaging/thread/...).
 *  `guard` (actions servies par Sequence Mail) : conversation relue avant
 *  d'écrire, cf. threadGuard ; `meName` = profil connecté. */
async function doMessage(text, inThread, guard, meName) {
  if (!text || !text.trim()) return { ok: false, error: "message vide" };
  let msgClicked = null;
  if (!inThread) {
    const { btn: msgBtn, pending } = await findMessageButton();
    // Pas encore en relation (invitation en attente ou à envoyer) : le serveur
    // reporte le message de quelques heures, sans pause punitive.
    if (pending) return { ok: false, retry: true, error: "pas encore en relation (invitation non acceptée)" };
    if (!msgBtn) return { ok: false, error: "bouton « Message » du profil introuvable" };
    // Fenêtre de travail rendue visible par le background juste avant d'ouvrir la messagerie.
    await showWorkWindow();
    // « non rendue » : le serveur y voit un échec passager et réessaie plus tard.
    if (!(await rendering())) {
      return { ok: false, error: `messagerie non rendue : onglet caché (fenêtre de travail réduite ou recouverte) — rien envoyé ; ${messageDiagnostic(null)}` };
    }
    msgClicked = msgBtn;
    await clickHuman(msgBtn);
    await human();
  }
  // Dans un fil, le champ de saisie est déjà présent — pas de bouton à cliquer.

  // 25 s : la bulle ouverte par « Message » met jusqu'à ~9 s à afficher son champ
  // sur un profil fraîchement chargé (mesuré en onglet visible).
  const editor = await waitFor(findEditor, 25000);
  if (!editor) return { ok: false, error: `zone de saisie du message introuvable — ${messageDiagnostic(msgClicked)}` };

  if (guard) {
    const stop = await threadGuard(editor, text, guard, meName);
    if (stop) return stop;
  }

  // Saisie par COLLAGE (méthode principale : plus robuste et plus humaine — un
  // vrai éditeur active le bouton Envoyer sur un paste).
  // Clic dans le champ d'abord : sans curseur dedans (onglet en arrière-plan),
  // l'éditeur ignore le collage comme la saisie et Envoyer reste grisé.
  await clickHuman(editor);
  // Insertion réelle d'abord ; sinon collage, qui remplace ce qui a pu être déposé.
  let send = (await realFill(editor, text.trim())) ? await waitFor(() => findSendButton(editor), 4000) : null;
  if (!send) {
    await pasteInto(editor, text.trim());
    send = await waitFor(() => findSendButton(editor), 4000);
  }
  if (!send) {
    // Repli : saisie directe si le collage n'a pas réveillé l'éditeur.
    await typeInto(editor, text.trim());
    send = await waitFor(() => findSendButton(editor), 4000);
  }
  if (!send) return { ok: false, error: "le champ n'a pas été reconnu par LinkedIn (bouton Envoyer resté désactivé après collage et saisie)" };
  // Le champ doit contenir exactement le message (ni tronqué, ni en double) avant d'envoyer.
  if (normWords(editor.innerText) !== normWords(text)) {
    await typeInto(editor, text.trim());
    send = await waitFor(() => findSendButton(editor), 4000);
    if (!send || normWords(editor.innerText) !== normWords(text)) {
      try { document.execCommand("selectAll", false, null); document.execCommand("delete", false, null); } catch {}
      return { ok: false, error: "texte mal saisi dans le champ (différent du message) — rien envoyé" };
    }
  }
  await clickHuman(send);
  // Parti = LinkedIn vide le champ (ou le retire) et le message apparaît dans le fil.
  const root = threadRoot(editor);
  const gone = await waitFor(() => {
    if (!editor.isConnected || !normWords(editor.innerText)) return true;
    return threadMessages(root, meName).some((m) => textKey(m.text) === textKey(text));
  }, 10000);
  if (!gone) return { ok: false, error: `« Envoyer » cliqué mais le message est resté dans le champ — ${messageDiagnostic(msgClicked)}` };
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
    const { btn: msgBtn } = await findMessageButton();
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
  // Sélecteur unique : un message matché deux fois sort en double. La classe
  // était sur le <li> ; depuis octobre 2026 elle est sur un <div> dans
  // li.msg-s-message-list__event (nom, heure et texte y sont tous).
  let events = [...document.querySelectorAll(".msg-s-event-listitem")];
  if (!events.length) events = [...document.querySelectorAll("li.msg-s-message-list__event")];
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

const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  janvier: 0, fevrier: 1, mars: 2, avril: 3, mai: 4, juin: 5, juillet: 6, aout: 7, septembre: 8, octobre: 9, novembre: 10, decembre: 11,
};

/** « Connected on October 20, 2026 » / « … 20 octobre 2026 » → minuit local (ms), sinon null. */
function parseConnectedOn(line) {
  const t = normWords(line);
  let m = t.match(/([a-z]+) (\d{1,2}), (\d{4})/);
  if (m && m[1] in MONTHS) return new Date(+m[3], MONTHS[m[1]], +m[2]).getTime();
  m = t.match(/(\d{1,2})(?:er)? ([a-z]+) (\d{4})/);
  if (m && m[2] in MONTHS) return new Date(+m[3], MONTHS[m[2]], +m[1]).getTime();
  return null;
}

/** Relations affichées : slug → jour de mise en relation (null si la date n'est pas lue).
 *  La date est la seule ligne « connect… / relation… + année » de la carte : on remonte
 *  depuis le lien du profil tant que la zone n'en contient pas deux (sinon : carte voisine). */
function connectionCards() {
  const main = document.querySelector("main") || document.body;
  const out = new Map();
  for (const a of main.querySelectorAll('a[href*="/in/"]')) {
    const slug = normSlug(a.pathname.split("/")[2] || "");
    if (!slug || out.has(slug)) continue;
    let on = null;
    let n = a;
    for (let i = 0; i < 8 && n && n !== main; i++, n = n.parentElement) {
      const lines = (n.innerText || "").split("\n").filter((l) => /connect|relation/i.test(l) && /\d{4}/.test(l));
      if (lines.length > 1) break;
      if (lines.length === 1) {
        on = parseConnectedOn(lines[0]);
        break;
      }
    }
    out.set(slug, on);
  }
  return out;
}

let connectionsApiWhy = null; // pourquoi l'API n'a pas servi : joint à l'échec si la page ne sert pas non plus

/** Relations par l'API interne que la page « Relations » appelle elle-même : pages de 40
 *  triées par ajout récent, heure exacte. Ne dépend ni du défilement ni de l'affichage, qui
 *  ne se font pas dans une fenêtre réduite (seules les 10 premières cartes y sortaient).
 *  null si l'API ne répond pas comme prévu : on se rabat alors sur la page. */
async function connectionsFromApi(since) {
  connectionsApiWhy = null;
  const headers = voyagerHeaders();
  if (!headers) {
    connectionsApiWhy = "cookie JSESSIONID illisible";
    return null;
  }
  const out = [];
  // Relations dont le profil n'est pas lisible (sans identifiant public) : sans lien /in/, rien à
  // rapprocher d'un contact. La lecture ne garantit alors que ce qui est plus récent que la
  // dernière d'entre elles — l'une d'elles pourrait être un contact qui vient d'accepter.
  let unresolved = 0;
  let unresolvedAt = 0;
  const covers = (from) => (unresolved ? Math.max(from, unresolvedAt) : from);
  for (let start = 0; start < 400; start += 40) {
    let j;
    try {
      const r = await fetch(
        `${location.origin}/voyager/api/relationships/dash/connections?decorationId=com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-16&count=40&q=search&sortType=RECENTLY_ADDED&start=${start}`,
        { credentials: "include", headers }
      );
      if (!r.ok) {
        connectionsApiWhy = `HTTP ${r.status} à la page ${start / 40 + 1}`;
        return null;
      }
      j = await r.json();
    } catch (e) {
      connectionsApiWhy = `requête échouée à la page ${start / 40 + 1} (${e && e.message ? e.message : e})`;
      return null;
    }
    const inc = j.included || [];
    const profiles = new Map(inc.filter((x) => x.publicIdentifier).map((p) => [p.entityUrn, p]));
    const conns = new Map(inc.filter((x) => "createdAt" in x).map((c) => [c.entityUrn, c]));
    const urns = (j.data && j.data["*elements"]) || [];
    for (const u of urns) {
      const c = conns.get(u);
      if (!c || typeof c.createdAt !== "number") {
        // format inattendu : on ne s'y fie pas
        connectionsApiWhy = `format inattendu à la page ${start / 40 + 1} (${c ? "date absente" : "relation absente"})`;
        return null;
      }
      const p = profiles.get(c.connectedMember || c["*connectedMemberResolutionResult"]);
      if (!p) {
        unresolved++;
        unresolvedAt = Math.max(unresolvedAt, c.createdAt);
        continue;
      }
      out.push({ slug: normSlug(p.publicIdentifier), connected_on: c.createdAt });
    }
    const oldest = out.length ? Math.min(...out.map((c) => c.connected_on)) : null;
    if (urns.length < 40) return { connections: out, connections_from: covers(0), unresolved }; // liste entière lue
    if (oldest < since) return { connections: out, connections_from: covers(oldest), unresolved };
    await sleep(rand(600, 1400));
  }
  return { connections: out, connections_from: out.length ? covers(Math.min(...out.map((c) => c.connected_on))) : null, unresolved };
}

/**
 * Lit la page « Relations » (triée par ajout récent) en descendant jusqu'à `since` (ms) :
 * le serveur n'a besoin que des relations nouées depuis ses invitations en attente.
 * `connections_from` = jour le plus ancien que la lecture garantit (0 = liste entière,
 * null = dates illisibles : le serveur ne s'y fie pas).
 * ⚠️ ZONE À MAINTENIR : libellés « Connected on … » et défilement de la liste.
 */
async function doListConnections(since) {
  const api = await connectionsFromApi(since);
  if (api) return { ok: true, data: { ...api, source: "api" } };
  const ready = await waitFor(() => connectionCards().size > 0, 15000);
  if (!ready) {
    return {
      ok: false,
      error: `liste des relations introuvable (page non chargée ?)${connectionsApiWhy ? ` ; API : ${connectionsApiWhy}` : ""}`,
    };
  }
  let cards = connectionCards();
  const oldest = () => {
    const d = [...cards.values()].filter((x) => x != null);
    return d.length ? Math.min(...d) : null;
  };
  let stale = 0;
  for (let i = 0; i < 40 && stale < 3; i++) {
    const o = oldest();
    if (o != null && o < since) break;
    // La liste défile par la page ou par <main> selon le design ; chargement de 10 en 10.
    for (const el of [document.scrollingElement, ...document.querySelectorAll("main")]) if (el) el.scrollTop = el.scrollHeight;
    const more = findClickable(/^(show more results|load more|afficher plus de résultats|voir plus de résultats)/i);
    if (more) more.click();
    await sleep(rand(1200, 2000));
    const before = cards.size;
    cards = connectionCards();
    stale = cards.size === before ? stale + 1 : 0;
  }
  const head = readableText(document.querySelector("main") || document.body, 1200).slice(0, 400);
  const tm = /([\d][\d,.\s ]*)\s+(connections|relations)/i.exec(head);
  const total = tm ? Number(tm[1].replace(/\D/g, "")) : null;
  const o = oldest();
  let from = null;
  if (![...cards.values()].some((d) => d == null)) {
    if (o != null && o < since) from = o;
    else if (total && cards.size >= total) from = 0;
    else from = o;
  }
  return {
    ok: true,
    data: {
      connections: [...cards].map(([slug, on]) => ({ slug, connected_on: on })),
      connections_from: from,
      total,
      api_issue: connectionsApiWhy, // pourquoi l'API n'a pas servi (null si elle a servi : on ne passe pas ici)
    },
  };
}

/** Invitations envoyées encore en attente, lues par l'API du gestionnaire d'invitations
 *  (aucune navigation) : le serveur y voit si une invitation est vraiment partie.
 *  `since` (ms) : seules les invitations plus récentes intéressent le serveur — la liste
 *  (des plus récentes aux plus anciennes) n'est lue que jusque-là.
 *  `complete` = toute la liste lue, `reached` = lue jusqu'à `since`. Format inattendu →
 *  échec, on ne s'y fie pas. */
async function doListSentInvitations(since) {
  const headers = voyagerHeaders();
  if (!headers) return { ok: false, error: "invitations envoyées : session illisible" };
  const out = [];
  for (let start = 0; start < 2000; start += 100) {
    let j;
    try {
      const r = await fetch(
        `${location.origin}/voyager/api/relationships/sentInvitationViewsV2?count=100&invitationType=CONNECTION&q=invitationType&start=${start}`,
        { credentials: "include", headers }
      );
      if (!r.ok) return { ok: false, error: `invitations envoyées : HTTP ${r.status}` };
      j = await r.json();
    } catch (e) {
      return { ok: false, error: `invitations envoyées : ${String(e && e.message ? e.message : e)}` };
    }
    const inc = j.included || [];
    const profiles = new Map(inc.filter((x) => x.publicIdentifier).map((p) => [p.entityUrn, p.publicIdentifier]));
    const page = [];
    for (const i of inc.filter((x) => /\.invitation\.Invitation$/.test(x.$type || ""))) {
      const slug = profiles.get(i["*toMember"]);
      if (!slug) return { ok: false, error: "invitations envoyées : format inattendu" };
      page.push({ slug: normSlug(slug), sent_at: typeof i.sentTime === "number" ? i.sentTime : null });
    }
    out.push(...page);
    if (((j.data && j.data["*elements"]) || []).length < 100) return { ok: true, data: { invitations: out, complete: true } };
    // Page datée, triée de la plus récente à la plus ancienne, et dont la dernière précède
    // `since` : la suite est plus ancienne encore. Tri non vérifié → on lit tout.
    const dated = page.length && page.every((i, k) => i.sent_at != null && (k === 0 || i.sent_at <= page[k - 1].sent_at));
    if (since && dated && page[page.length - 1].sent_at < since) {
      return { ok: true, data: { invitations: out, complete: false, reached: true } };
    }
    await sleep(rand(800, 1500));
  }
  return { ok: true, data: { invitations: out, complete: false } };
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
function readableText(node, limit = Infinity) {
  if (!node) return "";
  const SKIP_TAG = /^(STYLE|SCRIPT|NOSCRIPT|TEMPLATE|IFRAME|SVG|CANVAS|VIDEO|AUDIO|CODE)$/i;
  const parts = [];
  // `limit` : on s'arrête dès que ce nombre de caractères est lu (texte brut, doublons compris).
  // Les appelants qui ne regardent que le haut de la page (404, degré de relation, en-tête)
  // scrutaient tout <main>, getComputedStyle sur chaque nœud, toutes les 300 ms.
  let count = 0;
  const nl = () => { if (parts.length && parts[parts.length - 1] !== "\n") parts.push("\n"); };
  const walk = (n, depth) => {
    if (!n || depth > 80 || count >= limit) return;
    if (n.nodeType === Node.TEXT_NODE) { if (n.data) { parts.push(n.data); count += n.data.length; } return; }
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
  // Diagnostic joint aux seules lectures incomplètes (langue, visibilité, défilement) :
  // de quoi comprendre une lecture partielle sans voir l'onglet. Gardé à dessein.
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
    const text = readableText(main, 1500);
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

// --- Identité : quel profil LinkedIn est connecté dans CETTE page ? ----------
// C'est le garde-fou « bon compte » : avant toute action servie par Sequence
// Mail, on relit le profil connecté et on refuse d'agir s'il n'est pas celui
// attendu. Lecture par l'API interne que la page LinkedIn appelle elle-même au
// chargement (/voyager/api/me) — aucun clic, rien de visible.

// Instance de page imitée, une par page affichée (le client web en tire une par vue).
let pageInstance = { path: null, urn: null };

/** En-têtes des appels à l'API interne, calqués sur ceux que la page LinkedIn envoie elle-même :
 *  jeton CSRF, langue, version du client lue dans la page (<meta name="applicationInstance">),
 *  suivi d'écran (x-li-track) et instance de page (clé selon la page, identifiant tiré au hasard).
 *  Sans ces en-têtes, nos requêtes se distinguaient de celles du client. Imitation : les valeurs
 *  suivent le format observé, pas une spécification. null si la session est illisible. */
function voyagerHeaders() {
  const m = document.cookie.match(/(?:^|;\s*)JSESSIONID="?([^";]+)"?/);
  if (!m) return null;
  const h = {
    "csrf-token": m[1],
    accept: "application/vnd.linkedin.normalized+json+2.1",
    "x-restli-protocol-version": "2.0.0",
  };
  const lang = (document.documentElement.lang || navigator.language || "en-US").replace("-", "_");
  h["x-li-lang"] = /_/.test(lang)
    ? lang
    : { fr: "fr_FR", en: "en_US", de: "de_DE", es: "es_ES", it: "it_IT", pt: "pt_BR", nl: "nl_NL" }[lang] || "en_US";
  let version = null;
  try {
    version = JSON.parse(document.querySelector('meta[name="applicationInstance"]')?.content || "null")?.version || null;
  } catch {
    // méta absente ou illisible : pas de x-li-track plutôt qu'une version inventée
  }
  if (version) {
    const dpr = window.devicePixelRatio || 1;
    h["x-li-track"] = JSON.stringify({
      clientVersion: version,
      mpVersion: version,
      osName: "web",
      timezoneOffset: -new Date().getTimezoneOffset() / 60,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      deviceFormFactor: "DESKTOP",
      mpName: "voyager-web",
      displayDensity: dpr,
      displayWidth: Math.round(screen.width * dpr),
      displayHeight: Math.round(screen.height * dpr),
    });
  }
  if (pageInstance.path !== location.pathname) {
    const key = /^\/in\//.test(location.pathname) ? "d_flagship3_profile_view_base"
      : /^\/messaging/.test(location.pathname) ? "d_flagship3_messaging"
      : /connections/.test(location.pathname) ? "d_flagship3_people_connections"
      : /^\/mynetwork/.test(location.pathname) ? "d_flagship3_people"
      : "d_flagship3_feed";
    const id = crypto.getRandomValues(new Uint8Array(16));
    pageInstance = { path: location.pathname, urn: `urn:li:page:${key};${btoa(String.fromCharCode(...id))}` };
  }
  h["x-li-page-instance"] = pageInstance.urn;
  return h;
}

/** Slug canonique (« jean-dupont-123 ») : décodé, en minuscules. */
function normSlug(s) {
  let out = String(s || "").trim();
  try {
    out = decodeURIComponent(out);
  } catch {
    // slug mal encodé : gardé tel quel
  }
  return out.replace(/\/+$/, "").toLowerCase();
}

/** Premier objet (profondeur limitée) qui porte un publicIdentifier. */
function findMiniProfile(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 6) return null;
  if (typeof node.publicIdentifier === "string" && node.publicIdentifier) return node;
  for (const v of Array.isArray(node) ? node : Object.values(node)) {
    const hit = findMiniProfile(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** URL de photo (≈200 px) d'une VectorImage LinkedIn, sinon null. */
function pictureUrl(profile) {
  const find = (node, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 4) return null;
    if (typeof node.rootUrl === "string" && Array.isArray(node.artifacts)) return node;
    for (const v of Object.values(node)) {
      const hit = find(v, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  const img = find(profile.picture || profile.profilePicture);
  if (!img || !img.artifacts.length) return null;
  const art = [...img.artifacts].sort((a, b) => Math.abs((a.width || 0) - 200) - Math.abs((b.width || 0) - 200))[0];
  return art && art.fileIdentifyingUrlPathSegment ? img.rootUrl + art.fileIdentifyingUrlPathSegment : null;
}

/** Profil connecté, gardé quelques heures par le background tant que la session LinkedIn
 *  ne change pas (cf. background.js whoamiCache) : un appel d'API de moins par action. */
async function cachedWhoami() {
  if (canRealInput()) {
    try {
      const c = await chrome.runtime.sendMessage({ type: "whoami-cache-get" });
      if (c && c.data) return { ok: true, data: c.data };
    } catch {}
  }
  const me = await doWhoami();
  if (me.ok && canRealInput()) chrome.runtime.sendMessage({ type: "whoami-cache-set", data: me.data }).catch(() => {});
  return me;
}

async function doWhoami() {
  const headers = voyagerHeaders();
  if (!headers) return { ok: false, error: "cookie JSESSIONID absent — pas connecté à LinkedIn ?" };
  let r;
  try {
    r = await fetch(`${location.origin}/voyager/api/me`, { credentials: "include", headers });
  } catch (e) {
    return { ok: false, error: `lecture du profil connecté impossible (${e && e.message ? e.message : e})` };
  }
  if (!r.ok) return { ok: false, error: `lecture du profil connecté impossible (HTTP ${r.status})` };
  const p = findMiniProfile(await r.json().catch(() => null));
  if (!p) return { ok: false, error: "profil connecté introuvable dans la réponse LinkedIn" };
  const name = [p.firstName, p.lastName].filter((x) => typeof x === "string" && x).join(" ") || null;
  return { ok: true, data: { slug: normSlug(p.publicIdentifier), name, avatar: pictureUrl(p) } };
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
        // Chemin seulement : un slug de profil contenant « challenge » n'est pas un contrôle.
        if (RE_SECURITY_PATH.test(location.pathname)) {
          sendResponse({ ok: false, error: "contrôle de sécurité LinkedIn détecté — pause" });
          return;
        }
        if (action.type === "whoami") {
          sendResponse(await doWhoami());
          return;
        }
        // Action servie par Sequence Mail (elle porte `expect_member`) : on ne
        // joue rien tant que le profil connecté n'est pas vérifié. Autre profil
        // → refus ; profil illisible → refus aussi (dans le doute, on n'envoie pas).
        let member = null;
        if ("expect_member" in action) {
          const me = await cachedWhoami();
          if (!me.ok) {
            sendResponse({ ok: false, identity_unknown: true, error: me.error });
            return;
          }
          member = me.data;
          if (action.expect_member && normSlug(action.expect_member) !== member.slug) {
            sendResponse({
              ok: false,
              wrong_account: true,
              member,
              error: `connecté à LinkedIn en tant que « ${member.slug} » au lieu de « ${normSlug(action.expect_member)} » — rien envoyé`,
            });
            return;
          }
        }
        const respond = (r) => sendResponse(member ? { ...r, member } : r);
        // Page 404 (profil supprimé, URL erronée) sur une action qui a navigué
        // vers une URL précise : échec IMMÉDIAT, sans attendre les timeouts de
        // sélecteurs (~20 s) — et sans pause punitive côté serveur.
        if ((action.type === "view_profile" || action.linkedin || action.thread) && pageNotFound()) {
          respond({ ok: false, error: NOT_FOUND_ERROR });
          return;
        }
        // Mode « conversation ouverte » (le plus fiable) : on agit directement
        // dans le fil affiché, sans navigation ni clic sur la liste.
        if (action.open && (action.type === "message" || action.type === "read_messages")) {
          if (!/\/messaging\//.test(location.href)) {
            respond({ ok: false, error: "aucune conversation ouverte à l'écran (ouvre la conversation LinkedIn voulue d'abord)" });
            return;
          }
          const r = action.type === "read_messages"
            ? await doReadMessages(action.limit, true)
            : await doMessage(action.body, true);
          respond(r);
          return;
        }
        // Ciblage par NOM (secondaire) : on ouvre la conversation puis on agit dans le fil.
        if (action.conv_name && (action.type === "message" || action.type === "read_messages")) {
          const opened = await openConversationByName(action.conv_name);
          if (!opened.ok) { respond(opened); return; }
          const r = action.type === "read_messages"
            ? await doReadMessages(action.limit, true)
            : await doMessage(action.body, true);
          respond(r);
          return;
        }
        const inThread = !!action.thread; // action ciblant un fil (/messaging/thread/...)
        if ((action.type === "invite" || (action.type === "message" && !inThread)) && action.linkedin) await glanceProfile();
        const r =
          action.type === "message" ? await doMessage(action.body, inThread, action.guard, member && member.name)
          : action.type === "read_messages" ? await doReadMessages(action.limit, inThread)
          : action.type === "list_conversations" ? await doListConversations(action.limit)
          : action.type === "list_connections" ? await doListConnections(action.since)
          : action.type === "list_sent_invitations" ? await doListSentInvitations(action.since)
          : action.type === "view_profile" ? await doViewProfile()
          : await doInvite(action.body, action.linkedin);
        respond(r);
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true; // réponse asynchrone
  }
});
}
