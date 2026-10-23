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
// Origines de l'app Azerit autorisées à demander la remise de session.
const AZERIT_ORIGIN = /^(https:\/\/app\.azerit\.tech|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;

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
    url: ["https://app.azerit.tech/*", "http://localhost/*", "http://127.0.0.1/*"],
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
    await setStatus({ kind: "run", text: "Lecture de la messagerie…" });
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
      }),
    });
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
  if ((await chrome.tabs.get(tab.id)).status !== "complete") await waitForLoad(tab.id);
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

/** Attend que l'onglet ait fini de charger l'URL demandée. */
function waitForLoad(tabId) {
  return new Promise((resolve) => {
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    // filet de sécurité : on ne reste pas bloqué si l'événement manque
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }, 25000);
  });
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
    await chrome.tabs.update(tab.id, { url: profileUrl(action.linkedin) });
    await waitForLoad(tab.id);
    await new Promise((r) => setTimeout(r, 2500 + Math.random() * 2500)); // laisse l'UI se stabiliser
    const res = await sendToTab(tab.id, { type: "li-action", action });
    if (res.ok || res.error !== "content script injoignable") return res;
    // content.js absent de la page (onglet déchargé, ou extension rechargée) :
    // rien n'a été joué, un rechargement l'y remet.
    await chrome.tabs.reload(tab.id);
    await waitForLoad(tab.id);
    await new Promise((r) => setTimeout(r, 2500 + Math.random() * 2500));
    return await sendToTab(tab.id, { type: "li-action", action }, 10);
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  } finally {
    await pendingHide();
    pendingHide = async () => {};
  }
}

/** Ouvre la messagerie et en lit la liste des conversations récentes. */
async function runInbox(action) {
  try {
    const tab = await ensureTab();
    await chrome.tabs.update(tab.id, { url: "https://www.linkedin.com/messaging/" });
    await waitForLoad(tab.id);
    await new Promise((r) => setTimeout(r, 2500 + Math.random() * 2500));
    const r = await sendToTab(tab.id, {
      type: "li-action",
      action: { type: "list_conversations", limit: action.limit || 40, expect_member: action.expect_member ?? null },
    });
    // Relations nouées depuis les invitations en attente : le serveur y voit qui a accepté
    // sans ouvrir chaque profil. Un échec ici ne gâche pas la lecture de la messagerie.
    if (r.ok && action.connections_since) {
      await chrome.tabs.update(tab.id, { url: "https://www.linkedin.com/mynetwork/invite-connect/connections/" });
      await waitForLoad(tab.id);
      await new Promise((res) => setTimeout(res, 2500 + Math.random() * 2500));
      const c = await sendToTab(tab.id, {
        type: "li-action",
        action: { type: "list_connections", since: action.connections_since, expect_member: action.expect_member ?? null },
      }).catch(() => null);
      if (c && c.ok && c.data) r.connections = c.data;
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

// --- Remise de session (popup « Confier au serveur », app Azerit) ------------

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
  try {
    const tab = await ensureTab();
    const whoami = { type: "li-action", action: { type: "whoami" } };
    let me = await sendToTab(tab.id, whoami, 3);
    if (!me.ok && me.error === "content script injoignable") {
      // Onglet LinkedIn ouvert avant l'installation (ou le rechargement) de
      // l'extension : content.js n'y est pas. Un rechargement l'y remet (pas de
      // ré-injection : content.js, partagé avec le runner, déclare des globales).
      await chrome.tabs.reload(tab.id);
      await waitForLoad(tab.id);
      me = await sendToTab(tab.id, whoami, 10);
    }
    if (!me.ok) return { ok: false, error: `Profil LinkedIn connecté illisible : ${me.error}` };
    return { ok: true, cookies, user_agent: navigator.userAgent, member: me.data };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
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
  // Le content script, sur le profil, demande la fenêtre visible juste avant d'ouvrir la messagerie.
  if (msg.type === "li-show-for-message" && sender.id === chrome.runtime.id && sender.tab) {
    showForMessage(sender.tab).then(
      (hide) => { pendingHide = hide; sendResponse({ ok: true }); },
      () => sendResponse({ ok: false })
    );
    return true;
  }
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "reload-extension" && sender.id === chrome.runtime.id && !sender.tab) {
    // jamais au milieu d'une action : on attend sa fin
    sendResponse({ ok: true, deferred: busy });
    if (busy) reloadPending = true;
    else chrome.runtime.reload();
    return;
  }
  if (msg.type === "capture-linkedin" && sender.id === chrome.runtime.id && !sender.tab) {
    captureLinkedIn().then(sendResponse); // popup de l'extension
    return true;
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
