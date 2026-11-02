/*
 * Service worker : la boucle de fond. À intervalle régulier, il demande au
 * serveur local la prochaine action AUTORISÉE (le serveur impose quotas, plage
 * horaire et délais — l'extension ne décide jamais d'envoyer d'elle-même).
 * Quand une action est servie, il pilote un onglet LinkedIn pour l'exécuter via
 * le content script, puis renvoie le verdict au serveur.
 *
 * Sécurité : une seule action à la fois, et toute erreur remontée déclenche côté
 * serveur une longue pause. On n'insiste jamais. Avant chaque action, le content
 * script vérifie que le profil LinkedIn connecté est celui du compte
 * (`expect_member`) ; le verdict renvoie ce profil au serveur.
 *
 * Pont Azerit : sur app.azerit.tech, la page demande (via azerit-bridge.js) de
 * relier le LinkedIn de ce navigateur au compte Azerit connecté ; on capture la
 * session et le profil, et on les remet à Azerit avec le code d'appairage
 * fourni par la page.
 */
const DEFAULT_SERVER = "https://sequence.example.com"; // prod partagée Sequence Mail (réglable dans le popup — ex. http://localhost:3000 en local)
const ALARM = "li-tick";
// Build de développement (make-dev.sh) : Azerit et Sequence Mail en local sont aussi acceptés.
// Jamais dans l'extension distribuée : une page servie en local pourrait sinon demander, par le
// pont, la remise de la session LinkedIn de la personne (cookies compris).
const DEV_ORIGINS = false;
const LOCAL_URLS = DEV_ORIGINS ? ["http://localhost/*", "http://127.0.0.1/*"] : [];
// Origines de l'app Azerit autorisées à demander la remise de session.
const AZERIT_ORIGIN = DEV_ORIGINS
  ? /^(https:\/\/app\.azerit\.tech|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/
  : /^https:\/\/app\.azerit\.tech$/;

let busy = false; // garde-fou : jamais deux actions en parallèle
let reloadPending = false; // rechargement demandé depuis le popup pendant une action

/** Adresse du serveur, réglable depuis le popup (sinon valeur par défaut). */
async function getServer() {
  const { server } = await chrome.storage.local.get("server");
  return (server || DEFAULT_SERVER).replace(/\/+$/, "");
}

/**
 * En-têtes d'authentification : mot de passe de la prod (Caddy basic_auth),
 * réglé depuis le popup, et jeton du compte LinkedIn servi.
 */
async function authHeaders(token) {
  const { authUser, authPass } = await chrome.storage.local.get(["authUser", "authPass"]);
  const h = {};
  if (authPass) h.Authorization = "Basic " + btoa(`${authUser || "admin"}:${authPass}`);
  // Sans jeton, le serveur sert le compte principal (derrière le mot de passe).
  if (token) h["X-LI-Account"] = token;
  return h;
}

/**
 * Comptes servis par ce navigateur : celui du popup (jeton collé depuis les
 * Réglages de Sequence Mail) et celui d'Azerit (jeton reçu à l'appairage).
 * Le serveur choisit lequel agit et leur impose des quotas et délais communs
 * (même profil LinkedIn).
 */
async function accountTokens() {
  const { liToken, azeritToken } = await chrome.storage.local.get(["liToken", "azeritToken"]);
  const tokens = [...new Set([liToken, azeritToken].filter(Boolean))];
  return tokens.length ? tokens : [undefined];
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  injectAzeritBridge();
});

/**
 * Chrome n'injecte les content scripts que dans les pages chargées APRÈS
 * l'installation (ou le rechargement) de l'extension : un onglet Azerit déjà
 * ouvert ne la verrait pas (« Receiving end does not exist »). On y pose le
 * pont à la main — il n'a pas de déclaration globale, une double pose est sans
 * effet de bord.
 */
async function injectAzeritBridge() {
  const tabs = await chrome.tabs.query({
    url: ["https://app.azerit.tech/*", ...LOCAL_URLS],
  });
  for (const tab of tabs) {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["azerit-bridge.js"] }).catch(() => {});
  }
}
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) tick();
});

/**
 * Ce navigateur exécute-t-il des actions pour Sequence Mail ? La prod est
 * derrière un mot de passe (Caddy), sauf pour l'exécutant qui présente le jeton
 * de son compte. Sans mot de passe d'accès, ni jeton, ni autre serveur choisi,
 * aucune requête ne peut aboutir : c'est le cas d'un utilisateur d'Azerit dont
 * l'extension ne sert qu'à relier son LinkedIn (les navigateurs serveur
 * envoient à sa place), elle n'interroge donc rien. Le jeton arrive seul à
 * l'appairage depuis Azerit quand le compte est exécuté par l'extension.
 */
async function isExecutor() {
  const { server, authPass, liToken, azeritToken } = await chrome.storage.local.get(["server", "authPass", "liToken", "azeritToken"]);
  const custom = Boolean(server) && server.replace(/\/+$/, "") !== DEFAULT_SERVER;
  return Boolean(authPass) || Boolean(liToken) || Boolean(azeritToken) || custom;
}

async function getEnabled() {
  const { enabled } = await chrome.storage.local.get("enabled");
  return enabled !== false; // activé par défaut
}

async function setStatus(status) {
  await chrome.storage.local.set({ lastStatus: { ...status, at: Date.now() } });
}

async function tick() {
  if (busy) return;
  await detachIfIdle().catch(() => {});
  if (!(await getEnabled())) {
    await setStatus({ kind: "off", text: "Extension en pause" });
    return;
  }
  if (!(await isExecutor())) {
    await setStatus({ kind: "idle", text: "Relié à Azerit — rien à exécuter dans ce navigateur" });
    return;
  }
  busy = true;
  const SERVER = await getServer();
  try {
    await setStatus(await serve(SERVER, await accountTokens()));
  } catch (e) {
    await setStatus({ kind: "err", text: `Serveur injoignable (${SERVER}). Lancez l'app Sequence Mail.` });
  } finally {
    busy = false;
    if (reloadPending) chrome.runtime.reload();
  }
}

/**
 * Demande au serveur la prochaine action et la joue ; rend l'état à afficher.
 * Tous les jetons partent ensemble : le serveur choisit le compte qui agit
 * (quotas, délais, ordre) et dit lequel (`account`, rang du jeton) ; le
 * verdict repart avec ce seul jeton.
 */
async function serve(SERVER, tokens) {
  const r = await fetch(`${SERVER}/api/li/next`, { headers: await authHeaders(tokens.filter(Boolean).join(",")) });
  if (r.status === 401) {
    const { error } = await r.json().catch(() => ({}));
    return { kind: "err", text: error || "Accès refusé (401) — renseignez le mot de passe d'accès dans le popup." };
  }
  const res = await r.json();
  if (res.error) return { kind: "err", text: res.error };
  const auth = await authHeaders(tokens[res.account ?? 0]);
  if (res.action && res.action.type === "sync_inbox") {
    // Lecture de la messagerie : le serveur y cherche les réponses des contacts.
    await setStatus({ kind: "run", text: res.action.connections_only ? "Lecture des relations…" : "Lecture de la messagerie…" });
    const r = await runInbox(res.action);
    await fetch(`${SERVER}/api/li/inbox`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({
        ok: r.ok,
        conversations: r.data && r.data.conversations,
        error: r.error,
        member: r.member,
        wrong_account: r.wrong_account,
        connections: r.connections && r.connections.connections,
        connections_from: r.connections ? r.connections.connections_from : undefined,
        connections_error: r.connections_error,
        connections_only: res.action.connections_only || undefined,
        sent_invitations: r.sent_invitations && r.sent_invitations.invitations,
        sent_invitations_complete: r.sent_invitations ? r.sent_invitations.complete : undefined,
        sent_invitations_since: r.sent_invitations && r.sent_invitations.reached ? res.action.sent_invitations_since : undefined,
      }),
    });
    if (res.action.connections_only) {
      return r.ok
        ? { kind: "ok", text: "Relations lues" }
        : { kind: "err", text: `Relations : ${r.error || "illisibles"}` };
    }
    return r.ok
      ? { kind: "ok", text: "Messagerie lue" }
      : { kind: "err", text: `Messagerie : ${r.error || "illisible"}` };
  }
  if (res.action) {
    await setStatus({ kind: "run", text: `${res.action.type === "invite" ? "Invitation" : "Message"} en cours…` });
    const verdict = await runAction(res.action);
    await postVerdict(`${SERVER}/api/li/result`, auth, {
      id: res.action.id,
      ok: verdict.ok,
      // version jointe aux échecs : on sait quelle extension a échoué sans voir le Chrome
      error: !verdict.ok && verdict.error ? `${verdict.error} [ext ${chrome.runtime.getManifest().version}]` : verdict.error,
      retry: verdict.retry,
      member: verdict.member,
      wrong_account: verdict.wrong_account,
      identity_unknown: verdict.identity_unknown,
      replied: verdict.replied,
      reply_text: verdict.reply_text,
      already_messaged: verdict.already_messaged,
    });
    if (verdict.ok) return { kind: "ok", text: "Dernière action : réussie" };
    // Invitation pas encore acceptée : le serveur reporte le message, ce n'est pas un échec.
    if (verdict.retry) return { kind: "wait", text: "Message reporté : invitation pas encore acceptée" };
    return { kind: "err", text: `Échec : ${verdict.error || "inconnu"}` };
  }
  if (res.wait != null) return { kind: "wait", text: `${res.reason} — reprise dans ~${Math.ceil(res.wait / 60)} min` };
  return { kind: "idle", text: res.reason || "File vide" };
}

/**
 * Verdict d'une action jouée : perdu, l'action repasserait en file et le
 * message repartirait. Quelques essais rapprochés (le service worker ne vit pas
 * longtemps) ; au-delà, content.js retrouve le message dans la conversation
 * et ne le renvoie pas.
 */
async function postVerdict(url, auth, body) {
  for (const wait of [0, 2000, 5000, 10000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify(body),
      });
      if (r.ok || (r.status >= 400 && r.status < 500)) return;
    } catch {
      // réseau : nouvel essai
    }
  }
  throw new Error("verdict non transmis");
}

/**
 * Onglet de travail : seul dans sa propre fenêtre Chrome, réduite, créée par
 * l'extension. Les onglets LinkedIn de la personne ne sont jamais touchés (avant,
 * le premier trouvé était pris et emmené sur le profil d'un prospect), et un clic
 * par erreur dans une fenêtre réduite est peu probable. Fermée, elle est recréée
 * à l'action suivante. L'onglet est protégé de l'économiseur de mémoire, qui le
 * déchargerait entre deux actions.
 */
const WORK_TAB = "workTab";
// Taille d'un écran d'ordinateur : sans elle Chrome crée la fenêtre en 500×677, et
// à cette largeur LinkedIn ouvre « Message » en page entière (/messaging/compose/)
// au lieu de la bulle. Jamais réduite : posée dans un coin de l'écran, où la personne
// peut la laisser (cf. showForMessage). `v` : une fenêtre notée par une version plus
// ancienne (500 px, ou réduite) est recréée.
const WORK_WINDOW = { width: 1280, height: 900, v: 3 };

async function ensureTab() {
  // En storage.local (survit au rechargement de l'extension). Après un redémarrage
  // de Chrome, les identifiants repartent de zéro : on ne reprend l'onglet que
  // s'il est encore seul dans la fenêtre notée, jamais un onglet de la personne.
  const { [WORK_TAB]: saved } = await chrome.storage.local.get(WORK_TAB);
  if (saved) {
    const tab = await chrome.tabs.get(saved.tabId).catch(() => null);
    const alone = tab && tab.windowId === saved.windowId && (await chrome.tabs.query({ windowId: tab.windowId })).length === 1;
    if (alone && saved.v === WORK_WINDOW.v) return tab;
    if (alone) await chrome.windows.remove(tab.windowId).catch(() => {});
  }
  const win = await chrome.windows.create({
    url: "https://www.linkedin.com/feed/",
    focused: false,
    width: WORK_WINDOW.width,
    height: WORK_WINDOW.height,
  });
  const tab = win.tabs[0];
  await chrome.storage.local.set({ [WORK_TAB]: { tabId: tab.id, windowId: win.id, v: WORK_WINDOW.v } });
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  await waitForLoad(tab.id, true);
  await placeInCorner(win.id, tab.id);
  return tab;
}

/**
 * Messages seulement : LinkedIn dessine sa messagerie (bulle ou page) via
 * requestAnimationFrame, que Chrome gèle dans un onglet caché (fenêtre réduite
 * ou entièrement recouverte — sur macOS, une fenêtre recouverte est « occluded ») :
 * la zone de saisie n'apparaît alors jamais. Les invitations n'en dépendent pas.
 * Appelée par le content script juste avant d'ouvrir la messagerie, pour que la
 * fenêtre ne gêne que quelques secondes : si l'onglet est déjà visible (un coin
 * dégagé suffit, c'est l'état recherché), rien ; sinon la fenêtre est posée dans
 * le coin bas droit de l'écran ; si elle reste recouverte, elle passe au premier
 * plan le temps du message, et la fenêtre suivante reprend le devant ensuite.
 * Rend la fonction qui termine l'affichage.
 */
const MESSAGE_CORNER = { width: 320, height: 260 };

async function showForMessage(tab) {
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  if (!win) return async () => {};
  if (await waitVisible(tab.id, 300)) return async () => {};
  if (win.state === "minimized") await chrome.windows.update(win.id, { state: "normal" }).catch(() => {});
  await placeInCorner(win.id, tab.id);
  if (await waitVisible(tab.id, 1500)) return async () => {};
  await chrome.windows.update(win.id, { focused: true }).catch(() => {});
  await waitVisible(tab.id, 1500);
  return async () => {
    await chrome.windows.update(win.id, { focused: false }).catch(() => {});
  };
}

/** Pose la fenêtre de travail en bas à droite, un coin seulement à l'écran. */
async function placeInCorner(winId, tabId) {
  const area = await screenArea(tabId);
  const left = Math.max(area.left, area.left + area.width - MESSAGE_CORNER.width);
  const top = Math.max(area.top, area.top + area.height - MESSAGE_CORNER.height);
  await chrome.windows.update(winId, { left, top, width: WORK_WINDOW.width, height: WORK_WINDOW.height }).catch(() => {});
}

/** Vrai dès que l'onglet est rendu (document.visibilityState « visible »), au plus tard après `ms`. */
async function waitVisible(tabId, ms) {
  const until = Date.now() + ms;
  do {
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => document.visibilityState === "visible" });
      if (r && r.result) return true;
    } catch {
      // onglet sans page scriptable
    }
    await new Promise((r) => setTimeout(r, 250));
  } while (Date.now() < until);
  return false;
}

/** Zone utile de l'écran, lue dans l'onglet de travail (le service worker n'a pas `screen`). */
async function screenArea(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({ left: screen.availLeft, top: screen.availTop, width: screen.availWidth, height: screen.availHeight }),
    });
    if (r && r.result && r.result.width > 0) return r.result;
  } catch {
    // onglet sans page scriptable : valeurs d'un écran courant
  }
  return { left: 0, top: 0, width: 1440, height: 900 };
}

/** Attend que l'onglet ait fini de charger. À appeler AVANT la navigation (tabs.update, reload)
 *  puis à attendre : posé après, l'écouteur manquait le « complete » d'un chargement rapide et
 *  l'on attendait les 25 s de secours. `settled` : l'onglet vient d'être créé, s'il est déjà
 *  chargé il n'y a rien à attendre. */
function waitForLoad(tabId, settled = false) {
  return new Promise((resolve) => {
    const finish = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve();
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    // filet de sécurité : on ne reste pas bloqué si l'événement manque
    const timer = setTimeout(finish, 25000);
    if (settled) chrome.tabs.get(tabId).then((t) => { if (t && t.status === "complete") finish(); }, () => {});
  });
}

// --- Vrais gestes (chrome.debugger) ------------------------------------------
// Un clic ou une touche simulés depuis la page sont marqués isTrusted = false, sans
// position écran, pression ni touche enfoncée : un script LinkedIn le voit en une ligne.
// Envoyés par le protocole DevTools, ils sortent de Chrome comme ceux d'une vraie souris
// et d'un vrai clavier (mesuré : mêmes propriétés que la main de l'utilisateur). Le
// content script mesure la cible, le background joue le geste ; refus ou échec → le
// content script revient aux gestes simulés.
// Le débogueur reste attaché le temps d'une session (bandeau « débogage » de Chrome) :
// attaché AVANT la navigation, la page visitée naît avec le bandeau, sans redimensionnement
// au moment d'agir ; détaché après DEBUGGER_IDLE_MS sans action.
const DEBUGGER_IDLE_MS = 12 * 60_000;
// Bandeau fermé par la personne (« Annuler ») : pas de nouvel attachement avant ce délai.
const DEBUGGER_REFUSED_MS = 60 * 60_000;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const between = (a, b) => a + Math.random() * (b - a);
// Tirage log-normal autour d'une médiane (rythmes humains : beaucoup de valeurs proches, quelques longues)
const lognormal = (median, sigma, min, max) => {
  const u = 1 - Math.random(), v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.min(max, Math.max(min, median * Math.exp(sigma * z)));
};

async function debuggerState() {
  const { dbg } = await chrome.storage.session.get("dbg");
  return dbg || {};
}
async function setDebuggerState(patch) {
  await chrome.storage.session.set({ dbg: { ...(await debuggerState()), ...patch } });
}

chrome.debugger.onDetach.addListener(async (source, reason) => {
  const st = await debuggerState();
  if (source.tabId !== st.tabId) return;
  await setDebuggerState({ tabId: null, ...(reason === "canceled_by_user" ? { refusedAt: Date.now() } : {}) });
});

/** Attache le débogueur à l'onglet de travail (sans effet s'il l'est déjà). Faux si refusé. */
async function attachDebugger(tabId) {
  const st = await debuggerState();
  if (st.refusedAt && Date.now() - st.refusedAt < DEBUGGER_REFUSED_MS) return false;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (e) {
    if (!/already attached/i.test(String(e && e.message))) return false;
  }
  await setDebuggerState({ tabId, lastUse: Date.now() });
  return true;
}

/** Détache le débogueur après une session (appelé à chaque tick). */
async function detachIfIdle() {
  const st = await debuggerState();
  if (!st.tabId || Date.now() - (st.lastUse || 0) < DEBUGGER_IDLE_MS) return;
  await chrome.debugger.detach({ tabId: st.tabId }).catch(() => {});
  await setDebuggerState({ tabId: null });
}

async function cdp(tabId, method, params) {
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (e) {
    if (!/not attached/i.test(String(e && e.message)) || !(await attachDebugger(tabId))) throw e;
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  }
}

// Dernière position du curseur dans l'onglet de travail (CSS px de la fenêtre de la page).
const cursor = { x: null, y: null };

function startCursor(vw, vh) {
  if (cursor.x == null) Object.assign(cursor, { x: between(0.3, 0.7) * vw, y: between(0.25, 0.65) * vh });
}

/** Trajectoire de main : courbe de Bézier légèrement arquée, vitesse « minimum jerk »
 *  (accélère puis freine), un point toutes les ~16 ms comme une souris réelle (60 Hz),
 *  coordonnées au sous-pixel avec un léger tremblement. Durée selon la distance (Fitts). */
function mousePath(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return [to];
  const duration = Math.min(1300, Math.max(140, (120 + 105 * Math.log2(1 + dist / 10)) * between(0.8, 1.25)));
  const n = Math.max(3, Math.round(duration / 16.7));
  const nx = -dy / dist, ny = dx / dist; // perpendiculaire
  const bend = between(-0.18, 0.18) * dist;
  const c1 = { x: from.x + dx * between(0.15, 0.4) + nx * bend, y: from.y + dy * between(0.15, 0.4) + ny * bend };
  const c2 = { x: from.x + dx * between(0.6, 0.85) + nx * bend * between(0.2, 0.9), y: from.y + dy * between(0.6, 0.85) + ny * bend * between(0.2, 0.9) };
  const pts = [];
  for (let i = 1; i <= n; i++) {
    const s = i / n;
    const t = 10 * s ** 3 - 15 * s ** 4 + 6 * s ** 5;
    const u = 1 - t;
    const shake = i === n ? 0 : between(-0.35, 0.35);
    pts.push({
      x: u ** 3 * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * to.x + shake,
      y: u ** 3 * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * to.y + shake,
    });
  }
  return pts;
}

async function moveTo(tabId, x, y, vw, vh) {
  startCursor(vw, vh);
  const clamp = (v, max) => Math.min(max - 1, Math.max(1, v));
  const to = { x: clamp(x, vw), y: clamp(y, vh) };
  const from = { x: cursor.x, y: cursor.y };
  let pts = mousePath(from, to);
  // Sur un long trajet, la main dépasse parfois un peu la cible puis revient.
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  if (dist > 160 && Math.random() < 0.35) {
    const k = between(4, 12) / dist;
    const over = { x: clamp(to.x + (to.x - from.x) * k + between(-3, 3), vw), y: clamp(to.y + (to.y - from.y) * k + between(-3, 3), vh) };
    pts = [...mousePath(from, over), ...mousePath(over, to)];
  }
  for (const p of pts) {
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button: "none", buttons: 0 });
    await sleepMs(between(14.5, 18.5));
  }
  Object.assign(cursor, to);
}

/** Appui et relâche du bouton gauche là où est le curseur (80–150 ms, comme mesuré). */
async function press(tabId) {
  const at = { x: cursor.x, y: cursor.y };
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", buttons: 1, clickCount: 1, force: 0.5 });
  await sleepMs(between(80, 150));
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y + between(0, 0.3), button: "left", buttons: 0, clickCount: 1 });
}

/** Défilement à la molette/pavé tactile : une rafale d'à-coups décroissants (inertie). */
async function wheel(tabId, dy, vw, vh) {
  startCursor(vw, vh);
  const n = Math.round(Math.min(40, Math.max(6, Math.abs(dy) / 25)));
  const w = Array.from({ length: n }, (_, i) => (1 - i / n) ** 1.6);
  const sum = w.reduce((a, b) => a + b, 0);
  for (const wi of w) {
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x: cursor.x, y: cursor.y, button: "none", deltaX: 0, deltaY: (dy * wi) / sum });
    await sleepMs(between(14.5, 18.5));
  }
}

// Touches d'un clavier US (QWERTY), une seule disposition d'un bout à l'autre (la table mêlait
// AZERTY et QWERTY) : code physique, keyCode et touche de base (`unshifted` : ce que donne la
// touche sans Maj). Les autres caractères (accents…) arrivent comme d'un sélecteur de
// caractères, sans touche.
function keyFor(ch) {
  const up = ch.toUpperCase();
  if (/^[a-z]$/i.test(ch)) return { code: `Key${up}`, vk: up.charCodeAt(0), shift: ch !== ch.toLowerCase(), unshifted: ch.toLowerCase() };
  if (/^[0-9]$/.test(ch)) return { code: `Digit${ch}`, vk: ch.charCodeAt(0), shift: false, unshifted: ch };
  const plain = {
    " ": ["Space", 32], ",": ["Comma", 188], ".": ["Period", 190], "-": ["Minus", 189], "'": ["Quote", 222],
    ";": ["Semicolon", 186], "/": ["Slash", 191], "=": ["Equal", 187], "[": ["BracketLeft", 219], "]": ["BracketRight", 221],
    "\\": ["Backslash", 220], "`": ["Backquote", 192],
  };
  // caractères tapés avec Maj : [code, keyCode, touche de base]
  const shifted = {
    "!": ["Digit1", 49, "1"], "@": ["Digit2", 50, "2"], "#": ["Digit3", 51, "3"], "$": ["Digit4", 52, "4"], "%": ["Digit5", 53, "5"],
    "^": ["Digit6", 54, "6"], "&": ["Digit7", 55, "7"], "*": ["Digit8", 56, "8"], "(": ["Digit9", 57, "9"], ")": ["Digit0", 48, "0"],
    "_": ["Minus", 189, "-"], "+": ["Equal", 187, "="], ":": ["Semicolon", 186, ";"], '"': ["Quote", 222, "'"], "<": ["Comma", 188, ","],
    ">": ["Period", 190, "."], "?": ["Slash", 191, "/"], "{": ["BracketLeft", 219, "["], "}": ["BracketRight", 221, "]"], "~": ["Backquote", 192, "`"],
  };
  if (plain[ch]) return { code: plain[ch][0], vk: plain[ch][1], shift: false, unshifted: ch };
  if (shifted[ch]) return { code: shifted[ch][0], vk: shifted[ch][1], shift: true, unshifted: shifted[ch][2] };
  return null;
}

async function key(tabId, type, k, extra = {}) {
  await cdp(tabId, "Input.dispatchKeyEvent", { type, key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, ...extra });
}

/** Tape `text` touche par touche, au rythme mesuré sur une vraie frappe : ~165 ms entre
 *  deux touches (100–570), chaque touche enfoncée ~100 ms, des pauses après la
 *  ponctuation et de temps en temps pour réfléchir. Retour à la ligne = Maj+Entrée
 *  (Entrée seule enverrait le message). */
async function typeText(tabId, text) {
  const SHIFT = { key: "Shift", code: "ShiftLeft", vk: 16 };
  for (const ch of Array.from(text)) {
    if (ch === "\r") continue;
    const hold = lognormal(100, 0.35, 40, 260);
    if (ch === "\n") {
      await key(tabId, "rawKeyDown", SHIFT, { modifiers: 8 });
      await sleepMs(between(40, 110));
      await key(tabId, "keyDown", { key: "Enter", code: "Enter", vk: 13 }, { modifiers: 8, text: "\r", unmodifiedText: "\r" });
      await sleepMs(hold);
      await key(tabId, "keyUp", { key: "Enter", code: "Enter", vk: 13 }, { modifiers: 8 });
      await sleepMs(between(30, 90));
      await key(tabId, "keyUp", SHIFT);
    } else {
      const k = keyFor(ch);
      if (!k) {
        await cdp(tabId, "Input.insertText", { text: ch });
      } else {
        const mods = k.shift ? 8 : 0;
        if (k.shift) {
          await key(tabId, "rawKeyDown", SHIFT, { modifiers: 8 });
          await sleepMs(between(40, 120));
        }
        const kk = { key: ch, code: k.code, vk: k.vk };
        await key(tabId, "keyDown", kk, { modifiers: mods, text: ch, unmodifiedText: k.unshifted });
        await sleepMs(hold);
        await key(tabId, "keyUp", kk, { modifiers: mods });
        if (k.shift) {
          await sleepMs(between(20, 70));
          await key(tabId, "keyUp", SHIFT);
        }
      }
    }
    let gap = lognormal(165, 0.4, 70, 600) - hold;
    if (/[.!?…]/.test(ch)) gap += between(300, 1100);
    else if (/[,;:\n]/.test(ch)) gap += between(150, 600);
    else if (ch === " " && Math.random() < 0.08) gap += between(300, 1500);
    if (Math.random() < 0.015) gap += between(1000, 2500); // on relit, on réfléchit
    await sleepMs(Math.max(15, gap));
  }
}

/** Dépose `text` d'un coup : événements beforeinput/input de confiance, sans touche, comme un
 *  collage, une dictée ou un remplissage automatique. Pas de disposition de clavier à imiter,
 *  pas de session de frappe de plusieurs minutes. Une courte pause avant, le temps de « coller ». */
async function insertText(tabId, text) {
  await sleepMs(lognormal(600, 0.4, 250, 2000));
  await cdp(tabId, "Input.insertText", { text });
}

/** Touche isolée (Échap…). */
async function pressKey(tabId, name) {
  const keys = { Escape: { key: "Escape", code: "Escape", vk: 27 }, Tab: { key: "Tab", code: "Tab", vk: 9 } };
  const k = keys[name];
  if (!k) throw new Error(`touche inconnue : ${name}`);
  await key(tabId, "rawKeyDown", k);
  await sleepMs(lognormal(95, 0.3, 50, 200));
  await key(tabId, "keyUp", k);
}

/** Geste demandé par le content script de l'onglet de travail. */
async function realInput(tabId, msg) {
  if (!(await attachDebugger(tabId))) return { ok: false, error: "débogueur indisponible" };
  await setDebuggerState({ lastUse: Date.now() });
  const vw = Number(msg.vw) || 1280, vh = Number(msg.vh) || 800;
  if (msg.op === "move") await moveTo(tabId, Number(msg.x), Number(msg.y), vw, vh);
  else if (msg.op === "press") await press(tabId);
  else if (msg.op === "wheel") await wheel(tabId, Number(msg.dy), vw, vh);
  else if (msg.op === "type") await typeText(tabId, String(msg.text || ""));
  else if (msg.op === "insert") await insertText(tabId, String(msg.text || ""));
  else if (msg.op === "key") await pressKey(tabId, msg.key);
  else return { ok: false, error: `geste inconnu : ${msg.op}` };
  await setDebuggerState({ lastUse: Date.now() });
  return { ok: true };
}

// Profil connecté lu par l'API LinkedIn (/voyager/api/me) : gardé quelques heures au lieu
// d'un appel avant chaque action, tant que la session LinkedIn (cookie li_at) est la même.
// Un autre compte connecté entre-temps change le cookie : nouvelle lecture.
const WHOAMI_TTL_MS = 4 * 3600_000;

async function sessionKey() {
  const c = await chrome.cookies.get({ url: "https://www.linkedin.com", name: "li_at" }).catch(() => null);
  if (!c || !c.value) return null;
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(c.value));
  return [...new Uint8Array(h)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function whoamiCache(msg) {
  const key = await sessionKey();
  if (!key) return { data: null };
  if (msg.type === "whoami-cache-set") {
    if (msg.data && msg.data.slug) await chrome.storage.session.set({ whoami: { key, data: msg.data, at: Date.now() } });
    return { ok: true };
  }
  const { whoami } = await chrome.storage.session.get("whoami");
  const fresh = whoami && whoami.key === key && Date.now() - whoami.at < WHOAMI_TTL_MS;
  return { data: fresh ? whoami.data : null };
}

/** Envoie un message au content script, avec quelques essais (script pas encore prêt). */
async function sendToTab(tabId, payload, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, payload);
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return { ok: false, error: "content script injoignable" };
}

/**
 * Exécute une action : on amène l'onglet sur le profil cible, puis le content
 * script y joue le geste humain (clic Se connecter / Message, saisie, envoi).
 */
// Fin d'affichage de la fenêtre montrée pour le message en cours (cf. showForMessage).
let pendingHide = async () => {};

async function runAction(action) {
  try {
    const tab = await ensureTab();
    await attachDebugger(tab.id); // avant la navigation : la page naît avec le bandeau
    let loaded = waitForLoad(tab.id);
    await chrome.tabs.update(tab.id, { url: profileUrl(action.linkedin) });
    await loaded;
    await new Promise((r) => setTimeout(r, 3500 + Math.random() * 4500)); // laisse l'UI se stabiliser
    const res = await sendToTab(tab.id, { type: "li-action", action });
    if (res.ok || res.error !== "content script injoignable") return res;
    // content.js absent de la page (onglet déchargé, ou extension rechargée) :
    // rien n'a été joué, un rechargement l'y remet.
    loaded = waitForLoad(tab.id);
    await chrome.tabs.reload(tab.id);
    await loaded;
    await new Promise((r) => setTimeout(r, 2500 + Math.random() * 2500));
    return await sendToTab(tab.id, { type: "li-action", action }, 10);
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  } finally {
    await pendingHide();
    pendingHide = async () => {};
  }
}

/** Lit la page « Relations » et joint ce qu'elle donne à `r` (`connections`). Un échec n'est pas
 *  avalé : il part au serveur (`connections_error`), qui le garde et l'affiche dans l'état du compte. */
async function addConnections(tabId, action, r) {
  try {
    const loaded = waitForLoad(tabId);
    await chrome.tabs.update(tabId, { url: "https://www.linkedin.com/mynetwork/invite-connect/connections/" });
    await loaded;
    await new Promise((res) => setTimeout(res, 2500 + Math.random() * 2500));
    const c = await sendToTab(tabId, {
      type: "li-action",
      action: { type: "list_connections", since: action.connections_since, expect_member: action.expect_member ?? null },
    });
    if (c && c.ok && c.data) {
      r.connections = c.data;
      if (c.member) r.member = c.member;
      // Page lue mais sans dates : inutilisable pour le serveur ; on lui dit aussi pourquoi l'API n'a pas servi.
      if (c.data.connections_from == null) {
        r.connections_error = `relations lues sans dates exploitables${c.data.api_issue ? ` ; API : ${c.data.api_issue}` : ""}`;
      }
    } else {
      r.connections_error = (c && c.error) || "réponse vide de la page";
      if (c && c.wrong_account) {
        r.wrong_account = true;
        r.member = c.member;
      }
    }
  } catch (e) {
    r.connections_error = String(e && e.message ? e.message : e);
  }
  if (r.connections_error) r.connections_error += ` [ext ${chrome.runtime.getManifest().version}]`;
}

/** Ouvre la messagerie et en lit la liste des conversations récentes. Sur demande du serveur, lit
 *  aussi la page « Relations » (ou elle seule, `connections_only` : une actualisation avant un
 *  message dont on ne sait pas encore si l'invitation a été acceptée). */
async function runInbox(action) {
  try {
    const tab = await ensureTab();
    await attachDebugger(tab.id);
    if (action.connections_only) {
      const r = {};
      await addConnections(tab.id, action, r);
      r.ok = Boolean(r.connections) && !r.connections_error;
      r.error = r.connections_error;
      return r;
    }
    const loaded = waitForLoad(tab.id);
    await chrome.tabs.update(tab.id, { url: "https://www.linkedin.com/messaging/" });
    await loaded;
    await new Promise((r) => setTimeout(r, 2500 + Math.random() * 2500));
    const r = await sendToTab(tab.id, {
      type: "li-action",
      action: { type: "list_conversations", limit: action.limit || 40, expect_member: action.expect_member ?? null },
    });
    // Relations nouées depuis les invitations en attente : le serveur y voit qui a accepté
    // sans ouvrir chaque profil. Un échec ici ne gâche pas la lecture de la messagerie.
    if (action.connections_since) {
      if (r.ok) await addConnections(tab.id, action, r);
      else r.connections_error = `non tentée : messagerie illisible (${r.error || "?"}) [ext ${chrome.runtime.getManifest().version}]`;
    }
    // Invitations encore en attente (API, sans navigation) : le serveur y vérifie qu'une
    // invitation est vraiment partie.
    if (r.ok && action.sent_invitations) {
      const s = await sendToTab(tab.id, {
        type: "li-action",
        action: { type: "list_sent_invitations", since: action.sent_invitations_since ?? null, expect_member: action.expect_member ?? null },
      }).catch(() => null);
      if (s && s.ok && s.data) r.sent_invitations = s.data;
    }
    return r;
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

/** Normalise l'URL de profil (force https www, garde le slug /in/...). */
function profileUrl(url) {
  try {
    const u = new URL(url);
    return `https://www.linkedin.com${u.pathname.replace(/\/+$/, "")}/`;
  } catch {
    return url;
  }
}

// --- Remise de session (app Azerit) ------------------------------------------

const SAME_SITE = { no_restriction: "None", lax: "Lax", strict: "Strict" };

/**
 * Session LinkedIn de ce navigateur (cookies linkedin.com + user-agent) et
 * profil réellement connecté, lu dans un onglet LinkedIn.
 */
async function captureLinkedIn() {
  const cookies = (await chrome.cookies.getAll({ domain: "linkedin.com" })).map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expirationDate,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: SAME_SITE[c.sameSite],
  }));
  if (!cookies.some((c) => c.name === "li_at")) {
    return { ok: false, error: "Vous n'êtes pas connecté à LinkedIn dans ce navigateur : connectez-vous sur linkedin.com puis réessayez." };
  }
  // Exécutant : son onglet de travail. Sinon (utilisateur d'Azerit qui ne fait que relier son
  // LinkedIn) : un onglet temporaire en arrière-plan, refermé aussitôt — avant, la fenêtre de
  // travail était créée pour lui et restait ouverte dans un coin de l'écran.
  const executor = await isExecutor();
  let temp = null;
  try {
    const tab = executor
      ? await ensureTab()
      : (temp = await chrome.tabs.create({ url: "https://www.linkedin.com/feed/", active: false }));
    if (temp) await waitForLoad(temp.id, true);
    const whoami = { type: "li-action", action: { type: "whoami" } };
    let me = await sendToTab(tab.id, whoami, 3);
    if (!me.ok && me.error === "content script injoignable") {
      // Onglet LinkedIn ouvert avant l'installation (ou le rechargement) de
      // l'extension : content.js n'y est pas. Un rechargement l'y remet (pas de
      // ré-injection : content.js, partagé avec le runner, déclare des globales).
      const loaded = waitForLoad(tab.id);
      await chrome.tabs.reload(tab.id);
      await loaded;
      me = await sendToTab(tab.id, whoami, 10);
    }
    if (!me.ok) return { ok: false, error: `Profil LinkedIn connecté illisible : ${me.error}` };
    return { ok: true, cookies, user_agent: navigator.userAgent, member: me.data };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  } finally {
    if (temp) chrome.tabs.remove(temp.id).catch(() => {});
  }
}

/** Remet la session à Azerit, authentifiée par le code d'appairage de la page. */
async function connectToAzerit(origin, code, replace) {
  const cap = await captureLinkedIn();
  if (!cap.ok) return cap;
  let r;
  try {
    r = await fetch(`${origin}/api/linkedin/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, replace: Boolean(replace), cookies: cap.cookies, user_agent: cap.user_agent, member: cap.member }),
    });
  } catch {
    return { ok: false, error: `Azerit injoignable (${origin})` };
  }
  const d = await r.json().catch(() => ({}));
  if (r.ok) {
    // Compte exécuté par cette extension : son jeton reste ici (jamais remis à
    // la page), à côté de celui du popup, et le premier tick part tout de suite.
    if (typeof d.token === "string" && d.token) {
      await chrome.storage.local.set({ azeritToken: d.token });
      tick();
    }
    return { ok: true, account: d.account || null };
  }
  // FastAPI range l'erreur dans `detail` (texte, ou objet { error, code, current, got })
  const detail = typeof d.detail === "object" && d.detail ? d.detail : { error: d.detail || d.error };
  return { ok: false, status: r.status, ...detail, error: detail.error || `HTTP ${r.status}` };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  // Vrai geste demandé par le content script : seulement depuis l'onglet de travail
  // (jamais un onglet LinkedIn de la personne), cadre principal.
  if (msg.type === "real-input" && sender.id === chrome.runtime.id && sender.tab && sender.frameId === 0) {
    chrome.storage.local
      .get(WORK_TAB)
      .then(({ [WORK_TAB]: saved }) =>
        saved && saved.tabId === sender.tab.id ? realInput(sender.tab.id, msg) : { ok: false, error: "hors onglet de travail" }
      )
      .then(sendResponse, (e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }
  if ((msg.type === "whoami-cache-get" || msg.type === "whoami-cache-set") && sender.id === chrome.runtime.id && sender.tab) {
    whoamiCache(msg).then(sendResponse, () => sendResponse({ data: null }));
    return true;
  }
  // Le content script, sur le profil, demande la fenêtre visible juste avant d'ouvrir la messagerie.
  if (msg.type === "li-show-for-message" && sender.id === chrome.runtime.id && sender.tab) {
    showForMessage(sender.tab).then(
      (hide) => { pendingHide = hide; sendResponse({ ok: true }); },
      () => sendResponse({ ok: false })
    );
    return true;
  }
  if (msg.type === "reload-extension" && sender.id === chrome.runtime.id && !sender.tab) {
    // jamais au milieu d'une action : on attend sa fin
    sendResponse({ ok: true, deferred: busy });
    if (busy) reloadPending = true;
    else chrome.runtime.reload();
    return;
  }
  if (msg.type === "azerit-connect") {
    // L'origine vient de Chrome (onglet émetteur), jamais du message lui-même.
    let origin = sender.origin;
    if (!origin && sender.url) origin = new URL(sender.url).origin;
    if (!origin || !AZERIT_ORIGIN.test(origin) || typeof msg.code !== "string") {
      sendResponse({ ok: false, error: "origine non autorisée" });
      return;
    }
    connectToAzerit(origin, msg.code, msg.replace).then(sendResponse);
    return true;
  }
});
