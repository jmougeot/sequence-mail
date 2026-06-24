/*
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

async function clickHuman(el) {
  el.scrollIntoView({ block: "center" });
  await sleep(rand(300, 700));
  el.click();
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
    // contenteditable : insertText est ce que LinkedIn écoute (sinon le bouton Envoyer reste inactif)
    el.textContent = "";
    document.execCommand("insertText", false, text);
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
  }
  await sleep(rand(400, 900));
}

// --- Libellés (FR + EN). À COMPLÉTER si LinkedIn change. ----------------------
const RE_CONNECT = /^(se connecter|connect|invitez|invite)\b/i;
const RE_MORE = /^(plus|more actions|more)\b/i;
const RE_MESSAGE = /(?:^|\b)(message|messagerie)\b/i;
const RE_ADD_NOTE = /(ajouter une note|add a note)/i;
const RE_SEND_NOTE = /(envoyer l.invitation|envoyer$|^envoyer\b|send invitation|^send$)/i;
const RE_SEND_NO_NOTE = /(envoyer sans note|send without)/i;
const RE_SEND_MSG = /(^envoyer$|^send$)/i;

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

/** Envoie un message (le profil doit être une relation pour que ce soit délivré). */
async function doMessage(text) {
  if (!text || !text.trim()) return { ok: false, error: "message vide" };
  const msgBtn = await waitFor(() => findClickable(RE_MESSAGE), 6000);
  if (!msgBtn) return { ok: false, error: "bouton « Message » introuvable" };
  await clickHuman(msgBtn);
  await human();

  const editor = await waitFor(
    () => document.querySelector('.msg-form__contenteditable [contenteditable="true"], div[role="textbox"][contenteditable="true"]'),
    6000
  );
  if (!editor) return { ok: false, error: "zone de saisie du message introuvable" };
  await typeInto(editor, text.trim());

  const send = await waitFor(
    () => document.querySelector('button.msg-form__send-button:not([disabled])') || findClickable(RE_SEND_MSG),
    5000
  );
  if (!send) return { ok: false, error: "bouton d'envoi du message introuvable" };
  await clickHuman(send);
  await human();
  return { ok: true };
}

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
        const r = action.type === "message" ? await doMessage(action.body) : await doInvite(action.body);
        sendResponse(r);
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true; // réponse asynchrone
  }
});
