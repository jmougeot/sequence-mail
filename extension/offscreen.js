/*
 * Document offscreen (raison CLIPBOARD) : le service worker n'a pas accès au presse-papiers.
 * Lecture et écriture par execCommand, seules possibles dans un document sans focus, avec les
 * permissions clipboardRead / clipboardWrite. Sert au collage du message (background.js,
 * pasteText) : on lit ce que la personne a copié, on écrit le message, puis on lui rend son contenu.
 */
const buf = document.getElementById("buf");
// Ce que l'on sait rendre tel quel. Autre chose (image, fichier, format d'application) :
// « non restaurable », et le background dépose le texte sans passer par le presse-papiers.
const KEPT = ["text/plain", "text/html"];

function readClipboard() {
  let got = null;
  const onPaste = (e) => {
    e.preventDefault();
    const types = [...e.clipboardData.types];
    const items = {};
    for (const t of types) if (KEPT.includes(t)) items[t] = e.clipboardData.getData(t);
    got = { types, items };
  };
  document.addEventListener("paste", onPaste, true);
  try {
    buf.value = "";
    buf.focus();
    const ok = document.execCommand("paste");
    if (!ok || !got) return { ok: false, error: "lecture du presse-papiers refusée" };
  } finally {
    document.removeEventListener("paste", onPaste, true);
  }
  const other = got.types.filter((t) => !KEPT.includes(t));
  return { ok: true, items: got.items, types: got.types, restorable: other.length === 0 };
}

function writeClipboard(items) {
  let done = false;
  const onCopy = (e) => {
    e.preventDefault();
    for (const [t, v] of Object.entries(items || {})) if (KEPT.includes(t) && typeof v === "string") e.clipboardData.setData(t, v);
    done = true;
  };
  document.addEventListener("copy", onCopy, true);
  try {
    buf.value = " ";
    buf.focus();
    buf.select();
    const ok = document.execCommand("copy");
    return ok && done ? { ok: true } : { ok: false, error: "écriture du presse-papiers refusée" };
  } finally {
    document.removeEventListener("copy", onCopy, true);
    buf.value = "";
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen" || sender.id !== chrome.runtime.id || sender.tab) return;
  try {
    if (msg.op === "read") sendResponse(readClipboard());
    else if (msg.op === "write") sendResponse(writeClipboard(msg.items));
    else sendResponse({ ok: false, error: `opération inconnue : ${msg.op}` });
  } catch (e) {
    sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});
