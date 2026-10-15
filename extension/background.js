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

/** Adresse du serveur, réglable depuis le popup (sinon valeur par défaut). */
async function getServer() {
  const { server } = await chrome.storage.local.get("server");
  return (server || DEFAULT_SERVER).replace(/\/+$/, "");
}

/**
 * En-têtes d'authentification : mot de passe de la prod (Caddy basic_auth) et
 * jeton du compte LinkedIn. Réglés depuis le popup.
 */
async function authHeaders() {
  const { authUser, authPass, liToken } = await chrome.storage.local.get(["authUser", "authPass", "liToken"]);
  const h = {};
  if (authPass) h.Authorization = "Basic " + btoa(`${authUser || "admin"}:${authPass}`);
  // Jeton du compte LinkedIn de ce navigateur (Réglages de l'app) : quotas et
  // contacts propres à ce compte. Sans jeton, le serveur sert le compte principal.
  if (liToken) h["X-LI-Account"] = liToken;
  return h;
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
  const { server, authPass, liToken } = await chrome.storage.local.get(["server", "authPass", "liToken"]);
  const custom = Boolean(server) && server.replace(/\/+$/, "") !== DEFAULT_SERVER;
  return Boolean(authPass) || Boolean(liToken) || custom;
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
    const auth = await authHeaders();
    const r = await fetch(`${SERVER}/api/li/next`, { headers: auth });
    if (r.status === 401) {
      const { error } = await r.json().catch(() => ({}));
      await setStatus({ kind: "err", text: error || "Accès refusé (401) — renseignez le mot de passe d'accès dans le popup." });
      return; // le finally remet busy = false
    }
    const res = await r.json();
    if (res.error) {
      await setStatus({ kind: "err", text: res.error });
      return;
    }
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
        }),
      });
      await setStatus(r.ok ? { kind: "ok", text: "Messagerie lue" } : { kind: "err", text: `Messagerie : ${r.error || "illisible"}` });
    } else if (res.action) {
      await setStatus({ kind: "run", text: `${res.action.type === "invite" ? "Invitation" : "Message"} en cours…` });
      const verdict = await runAction(res.action);
      await postVerdict(`${SERVER}/api/li/result`, auth, {
        id: res.action.id,
        ok: verdict.ok,
        error: verdict.error,
        retry: verdict.retry,
        member: verdict.member,
        wrong_account: verdict.wrong_account,
        identity_unknown: verdict.identity_unknown,
        replied: verdict.replied,
        reply_text: verdict.reply_text,
      });
      await setStatus(
        verdict.ok
          ? { kind: "ok", text: "Dernière action : réussie" }
          : { kind: "err", text: `Échec : ${verdict.error || "inconnu"}` }
      );
    } else if (res.wait != null) {
      await setStatus({ kind: "wait", text: `${res.reason} — reprise dans ~${Math.ceil(res.wait / 60)} min` });
    } else {
      await setStatus({ kind: "idle", text: res.reason || "File vide" });
    }
  } catch (e) {
    await setStatus({ kind: "err", text: `Serveur injoignable (${SERVER}). Lancez l'app Sequence Mail.` });
  } finally {
    busy = false;
  }
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

/** Onglet LinkedIn à réutiliser (sinon on en crée un en arrière-plan, chargé). */
async function ensureTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.linkedin.com/*" });
  if (tabs.length) return tabs[0];
  const tab = await chrome.tabs.create({ url: "https://www.linkedin.com/feed/", active: false });
  await waitForLoad(tab.id);
  return tab;
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
async function runAction(action) {
  try {
    const tab = await ensureTab();
    await chrome.tabs.update(tab.id, { url: profileUrl(action.linkedin) });
    await waitForLoad(tab.id);
    await new Promise((r) => setTimeout(r, 2500 + Math.random() * 2500)); // laisse l'UI se stabiliser
    return await sendToTab(tab.id, { type: "li-action", action });
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

/** Ouvre la messagerie et en lit la liste des conversations récentes. */
async function runInbox(action) {
  try {
    const tab = await ensureTab();
    await chrome.tabs.update(tab.id, { url: "https://www.linkedin.com/messaging/" });
    await waitForLoad(tab.id);
    await new Promise((r) => setTimeout(r, 2500 + Math.random() * 2500));
    return await sendToTab(tab.id, {
      type: "li-action",
      action: { type: "list_conversations", limit: action.limit || 40, expect_member: action.expect_member ?? null },
    });
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
    // la page) et le premier tick part tout de suite.
    if (typeof d.token === "string" && d.token) {
      await chrome.storage.local.set({ liToken: d.token });
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
