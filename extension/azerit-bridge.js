/*
 * Pont entre l'app Azerit (la page) et l'extension, injecté sur app.azerit.tech
 * (et localhost en développement). La page ne voit jamais les cookies LinkedIn :
 * elle envoie un code d'appairage à usage court, l'extension capture la session
 * et la remet elle-même à Azerit avec ce code (cf. background.js).
 *
 * Protocole (window.postMessage, même origine uniquement) :
 *   page → { source: "azerit-app", type: "ping" | "connect-linkedin", id, code, replace }
 *   ext  → { source: "azerit-extension", type: "ready", version }
 *          { source: "azerit-extension", type: "connect-result", id, ok, ... }
 */
(() => {
  const version = chrome.runtime.getManifest().version;
  const reply = (data) => window.postMessage({ source: "azerit-extension", ...data }, location.origin);
  reply({ type: "ready", version });
  window.addEventListener("message", async (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const m = e.data;
    if (!m || m.source !== "azerit-app") return;
    if (m.type === "ping") {
      reply({ type: "ready", version });
    } else if (m.type === "connect-linkedin" && typeof m.code === "string") {
      let r;
      try {
        r = await chrome.runtime.sendMessage({ type: "azerit-connect", code: m.code, replace: Boolean(m.replace) });
      } catch (err) {
        r = { ok: false, error: `extension indisponible (${err && err.message ? err.message : err}) — rechargez la page` };
      }
      reply({ type: "connect-result", id: m.id, ...(r || { ok: false, error: "pas de réponse de l'extension" }) });
    }
  });
})();
