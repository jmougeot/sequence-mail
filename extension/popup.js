/* Popup : montre l'état (dernier tick de fond + quotas du serveur) et permet
 * d'activer/mettre en pause l'extension. La pause stoppe toute action locale. */
const DEFAULT_SERVER = "https://sequence.example.com"; // prod partagée Sequence Mail (réglable ci-dessous — ex. http://localhost:3000 en local)

async function getServer() {
  const { server } = await chrome.storage.local.get("server");
  return (server || DEFAULT_SERVER).replace(/\/+$/, "");
}

// En-têtes d'auth : mot de passe de la prod + jeton du compte LinkedIn.
async function authHeaders() {
  const { authUser, authPass, liToken } = await chrome.storage.local.get(["authUser", "authPass", "liToken"]);
  const h = {};
  if (authPass) h.Authorization = "Basic " + btoa(`${authUser || "admin"}:${authPass}`);
  // Jeton du compte LinkedIn de ce navigateur (Réglages de l'app) : quotas et
  // contacts propres à ce compte. Sans jeton, le serveur sert le compte principal.
  if (liToken) h["X-LI-Account"] = liToken;
  return h;
}

// Même règle que background.js : sans mot de passe d'accès, ni jeton, ni autre serveur,
// ce navigateur n'exécute rien (utilisateur d'Azerit) — vue « Azerit » seule,
// réglages d'exécutant derrière « Advanced settings ».
let showAdvanced = false;
async function isExecutor() {
  const { server, authPass, liToken } = await chrome.storage.local.get(["server", "authPass", "liToken"]);
  const custom = Boolean(server) && server.replace(/\/+$/, "") !== DEFAULT_SERVER;
  return Boolean(authPass) || Boolean(liToken) || custom;
}

async function refresh() {
  const operator = showAdvanced || (await isExecutor());
  document.getElementById("bridge").hidden = operator;
  document.getElementById("operator").hidden = !operator;
  if (!operator) return; // rien à interroger

  const SERVER = await getServer();
  const { enabled, lastStatus } = await chrome.storage.local.get(["enabled", "lastStatus"]);
  if (document.activeElement !== document.getElementById("server")) {
    document.getElementById("server").value = SERVER;
  }
  const on = enabled !== false;
  document.getElementById("toggle").textContent = on ? "Mettre en pause" : "Activer";

  const s = lastStatus || { kind: on ? "idle" : "off", text: on ? "En attente du prochain tick…" : "En pause" };
  document.getElementById("dot").className = "dot " + (on ? s.kind : "off");
  document.getElementById("statusText").textContent = on ? s.text : "En pause";

  // Pré-remplit les champs d'identifiants (sans écraser ce que l'utilisateur tape)
  const { authUser, authPass } = await chrome.storage.local.get(["authUser", "authPass"]);
  if (document.activeElement !== document.getElementById("authUser")) {
    document.getElementById("authUser").value = authUser || "";
  }
  if (document.activeElement !== document.getElementById("authPass")) {
    document.getElementById("authPass").value = authPass || "";
  }

  const { liToken } = await chrome.storage.local.get("liToken");
  if (document.activeElement !== document.getElementById("liToken")) {
    document.getElementById("liToken").value = liToken || "";
  }

  // Quotas du jour de ce compte, lus côté serveur
  try {
    const r = await fetch(`${SERVER}/api/li/status`, { headers: await authHeaders() });
    const st = await r.json().catch(() => ({}));
    if (!r.ok) {
      document.getElementById("stat").innerHTML = "";
      document.getElementById("sub").textContent =
        st.error || `Accès refusé (${r.status}) — mot de passe d'accès manquant ou incorrect.`;
      return;
    }
    document.getElementById("account").textContent = st.name ? `Compte : ${st.name}` : "";
    document.getElementById("stat").innerHTML =
      `<div><b>${st.today.invite.sent}/${st.today.invite.cap}</b>invitations</div>` +
      `<div><b>${st.today.message.sent}/${st.today.message.cap}</b>messages</div>` +
      `<div><b>${st.queue.pending}</b>en file</div>`;
    document.getElementById("sub").textContent = st.within_window
      ? `${st.queue.sent} envoyée(s) · ${st.queue.failed} échec(s)`
      : "Hors plage horaire d'envoi — reprise automatique.";
  } catch {
    document.getElementById("stat").innerHTML = "";
    document.getElementById("sub").textContent = `App Sequence Mail injoignable (${SERVER}).`;
  }
}

document.getElementById("showAdvanced").addEventListener("click", () => {
  showAdvanced = true;
  refresh();
});

document.getElementById("toggle").addEventListener("click", async () => {
  const { enabled } = await chrome.storage.local.get("enabled");
  const next = enabled === false; // on inverse
  await chrome.storage.local.set({ enabled: next });
  // informe aussi le serveur (cohérence de l'état affiché dans l'app)
  fetch(`${await getServer()}/api/li/toggle`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ enabled: next }),
  }).catch(() => {});
  refresh();
});

// Enregistre les identifiants d'accès (prod protégée par mot de passe)
document.getElementById("saveAuth").addEventListener("click", async () => {
  await chrome.storage.local.set({
    authUser: document.getElementById("authUser").value.trim() || "admin",
    authPass: document.getElementById("authPass").value,
  });
  refresh();
});

// Confie le compte au serveur : envoie la session LinkedIn de ce navigateur
// (cookies linkedin.com + user-agent) et le profil connecté. Le compte passe en
// mode serveur ; cette extension n'exécute plus rien pour lui.
document.getElementById("handover").addEventListener("click", async () => {
  const msg = document.getElementById("handoverMsg");
  const { liToken } = await chrome.storage.local.get("liToken");
  if (!liToken) {
    msg.textContent = "Renseignez d'abord le jeton du compte LinkedIn ci-dessous.";
    return;
  }
  msg.textContent = "Lecture de la session LinkedIn…";
  const cap = await chrome.runtime.sendMessage({ type: "capture-linkedin" });
  if (!cap || !cap.ok) {
    msg.textContent = (cap && cap.error) || "Session LinkedIn illisible.";
    return;
  }
  try {
    const r = await fetch(`${await getServer()}/api/li/session`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify({ cookies: cap.cookies, user_agent: cap.user_agent, member: cap.member }),
    });
    const d = await r.json().catch(() => ({}));
    msg.textContent = r.ok
      ? `✓ Session de ${cap.member.name || cap.member.slug} transmise : le serveur pilote désormais « ${d.account && d.account.name} ».`
      : `Échec : ${d.error || r.status}`;
  } catch {
    msg.textContent = "Serveur injoignable.";
  }
  refresh();
});

// Enregistre le jeton du compte LinkedIn (Réglages de l'app → Comptes LinkedIn)
document.getElementById("saveToken").addEventListener("click", async () => {
  await chrome.storage.local.set({ liToken: document.getElementById("liToken").value.trim() });
  refresh();
});

// Enregistre l'adresse du serveur (utile si l'app tourne sur un autre port)
document.getElementById("saveServer").addEventListener("click", async () => {
  const v = document.getElementById("server").value.trim();
  await chrome.storage.local.set({ server: v || DEFAULT_SERVER });
  refresh();
});

refresh();
setInterval(refresh, 3000);
