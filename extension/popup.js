/* Popup : montre l'état (dernier tick de fond + quotas du serveur) et permet
 * d'activer/mettre en pause l'extension. La pause stoppe toute action locale. */
const DEFAULT_SERVER = "https://sequence.example.com"; // prod partagée Sequence Mail (réglable ci-dessous — ex. http://localhost:3000 en local)

async function getServer() {
  const { server } = await chrome.storage.local.get("server");
  return (server || DEFAULT_SERVER).replace(/\/+$/, "");
}

// En-tête d'auth pour la prod protégée par mot de passe (vide en local).
async function authHeaders() {
  const { authUser, authPass } = await chrome.storage.local.get(["authUser", "authPass"]);
  if (!authPass) return {};
  return { Authorization: "Basic " + btoa(`${authUser || "admin"}:${authPass}`) };
}

async function refresh() {
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

  // Quotas du jour, lus côté serveur
  try {
    const r = await fetch(`${SERVER}/api/li/status`, { headers: await authHeaders() });
    if (r.status === 401) {
      document.getElementById("stat").innerHTML = "";
      document.getElementById("sub").textContent = "Accès refusé (401) — mot de passe d'accès manquant ou incorrect.";
      return;
    }
    const st = await r.json();
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

// Enregistre l'adresse du serveur (utile si l'app tourne sur un autre port)
document.getElementById("saveServer").addEventListener("click", async () => {
  const v = document.getElementById("server").value.trim();
  await chrome.storage.local.set({ server: v || DEFAULT_SERVER });
  refresh();
});

refresh();
setInterval(refresh, 3000);
