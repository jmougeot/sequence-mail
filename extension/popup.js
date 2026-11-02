/* Popup : montre l'état (dernier tick de fond + quotas du serveur) et permet
 * d'activer/mettre en pause l'extension. La pause stoppe toute action locale. */
const DEFAULT_SERVER = "https://sequence.example.com"; // prod partagée Sequence Mail (réglable ci-dessous — ex. http://localhost:3000 en local)

async function getServer() {
  const { server } = await chrome.storage.local.get("server");
  return (server || DEFAULT_SERVER).replace(/\/+$/, "");
}

// En-têtes d'auth : mot de passe de la prod + jeton du compte LinkedIn.
async function authHeaders() {
  const { authUser, authPass, liToken, azeritToken } = await chrome.storage.local.get([
    "authUser",
    "authPass",
    "liToken",
    "azeritToken",
  ]);
  const h = {};
  if (authPass) h.Authorization = "Basic " + btoa(`${authUser || "admin"}:${authPass}`);
  // Jeton du compte LinkedIn de ce navigateur (Réglages de l'app), sinon celui
  // reçu d'Azerit : quotas et contacts de ce compte. Sans jeton, le serveur sert le compte principal.
  const token = liToken || azeritToken;
  if (token) h["X-LI-Account"] = token;
  return h;
}

// Même règle que background.js : sans mot de passe d'accès, ni jeton, ni autre serveur,
// ce navigateur n'exécute rien (utilisateur d'Azerit) — vue « Azerit » seule,
// réglages d'exécutant derrière « Advanced settings ».
let showAdvanced = false;
async function isExecutor() {
  const { server, authPass, liToken, azeritToken } = await chrome.storage.local.get(["server", "authPass", "liToken", "azeritToken"]);
  const custom = Boolean(server) && server.replace(/\/+$/, "") !== DEFAULT_SERVER;
  return Boolean(authPass) || Boolean(liToken) || Boolean(azeritToken) || custom;
}

// --- Actions en échec : à faire à la main sur LinkedIn ---

const FAILED_LABEL = { invite: "Invitation non envoyée", message: "Message non envoyé" };
let shownTodo = ""; // la liste n'est redessinée que si elle change (refresh toutes les 3 s)

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Dit au serveur que l'action a été faite : le contact passe à la suite de la séquence.
async function markDone(id) {
  const r = await fetch(`${await getServer()}/api/li/result`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ id, done_by_hand: true }),
  });
  if (!r.ok) throw new Error(String(r.status));
}

// Deux clics : le premier arme le bouton quelques secondes, le second envoie.
function doneButton(id) {
  const label = "Fait à la main";
  const btn = el("button", "done", label);
  let armed = null;
  btn.addEventListener("click", async () => {
    if (!armed) {
      btn.textContent = "Confirmer ?";
      btn.classList.add("armed");
      armed = setTimeout(() => {
        armed = null;
        btn.textContent = label;
        btn.classList.remove("armed");
      }, 4000);
      return;
    }
    clearTimeout(armed);
    armed = null;
    btn.classList.remove("armed");
    btn.disabled = true;
    btn.textContent = "…";
    try {
      await markDone(id);
      refresh();
    } catch {
      btn.disabled = false;
      btn.textContent = "Échec — réessayer";
    }
  });
  return btn;
}

function copyButton(text) {
  const label = "Copier";
  const btn = el("button", "", label);
  btn.addEventListener("click", async () => {
    await navigator.clipboard.writeText(text);
    btn.textContent = "Copié ✓";
    setTimeout(() => (btn.textContent = label), 1500);
  });
  return btn;
}

function todoItem(a) {
  const item = el("li", "item");
  const head = el("div", "item-head");
  head.append(el("b", "", a.name), el("span", "tag", FAILED_LABEL[a.type] || "Action non envoyée"));
  item.append(head);
  item.append(el("div", "why", a.campaign));
  if (a.error) {
    const why = el("div", "why", a.error);
    why.title = a.error;
    item.append(why);
  }
  const acts = el("div", "acts");
  const link = el("a", "btn", "Ouvrir LinkedIn");
  link.href = a.url;
  link.target = "_blank";
  link.rel = "noreferrer";
  acts.append(link);
  if (a.body) acts.append(copyButton(a.body));
  acts.append(doneButton(a.id));
  item.append(acts);
  return item;
}

function renderTodo(list) {
  const key = JSON.stringify(list);
  if (key === shownTodo) return;
  shownTodo = key;
  document.getElementById("todo").hidden = !list.length;
  document.getElementById("todoCount").textContent = `(${list.length})`;
  document.getElementById("todoList").replaceChildren(...list.map(todoItem));
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
    document.getElementById("sub").textContent = `${st.queue.sent} envoyée(s) aujourd'hui`;
    renderTodo(st.to_do_by_hand || []);
  } catch {
    document.getElementById("stat").innerHTML = "";
    document.getElementById("sub").textContent = `App Sequence Mail injoignable (${SERVER}).`;
  }
}

document.getElementById("showAdvanced").addEventListener("click", () => {
  showAdvanced = true;
  refresh();
});

document.getElementById("reload").addEventListener("click", async () => {
  const r = await chrome.runtime.sendMessage({ type: "reload-extension" }).catch(() => null);
  if (r && r.deferred) document.getElementById("statusText").textContent = "Rechargement à la fin de l'action en cours…";
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
