/*
 * Service worker : la boucle de fond. À intervalle régulier, il demande au
 * serveur local la prochaine action AUTORISÉE (le serveur impose quotas, plage
 * horaire et délais — l'extension ne décide jamais d'envoyer d'elle-même).
 * Quand une action est servie, il pilote un onglet LinkedIn pour l'exécuter via
 * le content script, puis renvoie le verdict au serveur.
 *
 * Sécurité : une seule action à la fois, et toute erreur remontée déclenche côté
 * serveur une longue pause. On n'insiste jamais.
 */
const DEFAULT_SERVER = "http://localhost:3000"; // serveur Sequence Mail (port du mailer)
const ALARM = "li-tick";

let busy = false; // garde-fou : jamais deux actions en parallèle

/** Adresse du serveur, réglable depuis le popup (sinon valeur par défaut). */
async function getServer() {
  const { server } = await chrome.storage.local.get("server");
  return (server || DEFAULT_SERVER).replace(/\/+$/, "");
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) tick();
});

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
  busy = true;
  const SERVER = await getServer();
  try {
    const res = await fetch(`${SERVER}/api/li/next`).then((r) => r.json());
    if (res.action) {
      await setStatus({ kind: "run", text: `${res.action.type === "invite" ? "Invitation" : "Message"} en cours…` });
      const verdict = await runAction(res.action);
      await fetch(`${SERVER}/api/li/result`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: res.action.id, ok: verdict.ok, error: verdict.error }),
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

/** Onglet LinkedIn à réutiliser (sinon on en crée un en arrière-plan). */
async function ensureTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.linkedin.com/*" });
  if (tabs.length) return tabs[0];
  return chrome.tabs.create({ url: "https://www.linkedin.com/feed/", active: false });
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

/** Normalise l'URL de profil (force https www, garde le slug /in/...). */
function profileUrl(url) {
  try {
    const u = new URL(url);
    return `https://www.linkedin.com${u.pathname.replace(/\/+$/, "")}/`;
  } catch {
    return url;
  }
}
