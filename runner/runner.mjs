/**
 * Runner LinkedIn : les « navigateurs serveur » de Sequence Mail, façon lemlist.
 *
 * Pour chaque compte LinkedIn en mode serveur, un Chromium (profil persistant,
 * derrière le proxy du compte, avec la session envoyée par l'extension) fait
 * exactement ce que ferait l'extension Chrome : il demande à l'app la prochaine
 * action autorisée (/api/li/next), la joue dans la vraie interface LinkedIn, et
 * rend le verdict. Les comptes tournent en parallèle ; la cadence (quotas,
 * délais, plage horaire, pauses) reste décidée par l'app, jamais ici.
 *
 * Toute la connaissance de l'interface LinkedIn vit dans extension/content.js,
 * injecté tel quel dans la page avec un faux `chrome.runtime`.
 *
 * Garde-fous :
 *   - pas de proxy = pas de navigateur (une IP de datacenter grille le compte),
 *     sauf LI_ALLOW_NO_PROXY=1 (tests) ;
 *   - redirection vers la page de connexion → session signalée expirée, le
 *     compte s'arrête jusqu'à ce que la personne renvoie sa session ;
 *   - contrôle de sécurité → signalé, le compte s'arrête (pause longue côté app) ;
 *   - profil connecté ≠ profil du compte (content.js le relit avant chaque
 *     action) → rien n'est envoyé, l'app arrête le compte (« wrong_account ») ;
 *   - navigateurs fermés hors de la plage d'activité (économie de RAM, et un
 *     humain ne reste pas connecté toute la nuit).
 */
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const API = (process.env.SEQUENCE_URL || "http://sequence-app:3000").replace(/\/+$/, "");
const SECRET = process.env.LI_RUNNER_SECRET || "";
const PROFILES = process.env.PROFILES_DIR || "/data/profiles";
const ALLOW_NO_PROXY = process.env.LI_ALLOW_NO_PROXY === "1";
const HEADLESS = process.env.HEADLESS === "1"; // défaut : fenêtre réelle sous Xvfb (moins détectable)
const SUPERVISE_MS = 60_000;

const CONTENT_JS = await readFile(
  existsSync(new URL("./content.js", import.meta.url)) ? new URL("./content.js", import.meta.url) : new URL("../extension/content.js", import.meta.url),
  "utf8"
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const log = (acc, ...m) => console.log(`[runner] ${acc ? `#${acc.id} ${acc.name} :` : ""}`, ...m);

async function api(method, path, accountId, body) {
  const headers = { "x-li-runner": SECRET };
  if (accountId != null) headers["x-li-account-id"] = String(accountId);
  if (body) headers["content-type"] = "application/json";
  const r = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${data.error || ""}`);
  return data;
}

/** Heure locale de l'app (le fuseau de l'app fait foi pour la plage d'activité). */
function appHour(win) {
  const d = new Date(Date.now() + win.tz_offset_min * 60_000);
  return d.getUTCHours();
}
const inWindow = (win) => appHour(win) >= win.hour_start && appHour(win) < win.hour_end;

/**
 * Verdict d'une action jouée : il DOIT arriver. Perdu, l'action repasserait en
 * file à l'expiration du bail et le message repartirait. On réessaie donc
 * longtemps (~16 min) — ce compte ne reçoit rien d'autre pendant ce temps,
 * l'action ne peut pas être rejouée ailleurs — sauf refus explicite (4xx).
 */
export async function report(path, accountId, body) {
  const delays = [5, 15, 30, 60, 120, 240, 480];
  for (let i = 0; ; i++) {
    try {
      return await api("POST", path, accountId, body);
    } catch (e) {
      if (i >= delays.length || / → 4\d\d\b/.test(e.message)) throw e;
      console.warn(`[runner] #${accountId} : verdict non transmis (${e.message}) — nouvel essai dans ${delays[i]} s`);
      await sleep(delays[i] * 1000);
    }
  }
}

function parseProxy(url) {
  if (!url) return undefined;
  const u = new URL(url);
  return {
    server: `${u.protocol}//${u.hostname}:${u.port}`,
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
  };
}

function profileUrl(url) {
  try {
    const u = new URL(url);
    return `https://www.linkedin.com${u.pathname.replace(/\/+$/, "")}/`;
  } catch {
    return url;
  }
}

const RE_LOGIN = /linkedin\.com\/(login|authwall|uas\/login|signup|checkpoint\/lg\/login)/i;
const RE_CHECKPOINT = /linkedin\.com\/(checkpoint|challenge)/i;

class SessionLost extends Error {}

/**
 * Script injecté dans la page : content.js (même code que l'extension) avec un
 * faux `chrome.runtime` local, puis appel de son gestionnaire d'action. Évalué
 * par le protocole DevTools, il n'est pas soumis à la CSP de LinkedIn.
 */
export function actionScript(action) {
  return `(() => {
    if (!window.__seqLiHandler) {
      const chrome = { runtime: { onMessage: { addListener(fn) { window.__seqLiHandler = fn; } } } };
      (function () {\n${CONTENT_JS}\n})();
    }
    return new Promise((resolve) => {
      const keep = window.__seqLiHandler({ type: "li-action", action: ${JSON.stringify(action)} }, {}, resolve);
      if (keep !== true) resolve({ ok: false, error: "action non prise en charge" });
    });
  })()`;
}

/** Un compte = un navigateur, une boucle. */
class Worker {
  constructor(acc, win) {
    this.acc = acc;
    this.win = win;
    this.ctx = null;
    this.page = null;
    this.stopped = false;
    this.loop = this.run();
  }

  update(acc, win) {
    const sessionChanged = acc.session_version !== this.acc.session_version || acc.proxy !== this.acc.proxy;
    this.acc = acc;
    this.win = win;
    if (sessionChanged) this.close(); // rouvert au prochain tour avec la nouvelle session/proxy
  }

  async stop() {
    this.stopped = true;
    await this.close();
  }

  async close() {
    const ctx = this.ctx;
    this.ctx = null;
    this.page = null;
    if (ctx) await ctx.close().catch(() => {});
  }

  async ensureBrowser() {
    if (this.ctx) return;
    const proxy = parseProxy(this.acc.proxy);
    if (!proxy && !ALLOW_NO_PROXY) throw new Error("aucun proxy configuré pour ce compte — navigateur non lancé");
    const dir = `${PROFILES}/${this.acc.id}`;
    await mkdir(dir, { recursive: true });
    const s = this.acc.session;
    this.ctx = await chromium.launchPersistentContext(dir, {
      headless: HEADLESS,
      proxy,
      userAgent: s.user_agent || undefined,
      locale: "fr-FR",
      timezoneId: "Europe/Paris",
      viewport: { width: 1366, height: 820 },
      ignoreDefaultArgs: ["--enable-automation"],
      args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
    });
    // Cookies de la session : seulement quand elle a changé (sinon on écraserait
    // les cookies que LinkedIn a fait évoluer depuis dans ce profil).
    const marker = `${dir}/.session_version`;
    const known = existsSync(marker) ? (await readFile(marker, "utf8")).trim() : "";
    if (known !== String(this.acc.session_version)) {
      await this.ctx.clearCookies();
      await this.ctx.addCookies(
        s.cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || "/",
          expires: typeof c.expires === "number" ? Math.floor(c.expires) : -1,
          httpOnly: Boolean(c.httpOnly),
          secure: Boolean(c.secure),
          ...(c.sameSite ? { sameSite: c.sameSite } : {}),
        }))
      );
      await writeFile(marker, String(this.acc.session_version));
      log(this.acc, "session chargée");
    }
    this.page = this.ctx.pages()[0] || (await this.ctx.newPage());
    log(this.acc, `navigateur ouvert${proxy ? ` via ${proxy.server}` : " SANS proxy (LI_ALLOW_NO_PROXY)"}`);
  }

  /** Navigue puis vérifie que la session tient ; lève SessionLost sinon. */
  async goto(url) {
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await sleep(rand(2500, 5000)); // laisse l'interface se construire, comme un humain qui regarde
    const at = this.page.url();
    if (RE_LOGIN.test(at)) {
      await api("POST", "/api/li/runner/session-state", this.acc.id, { state: "expired", error: `redirigé vers ${at}` });
      throw new SessionLost("session LinkedIn expirée");
    }
    if (RE_CHECKPOINT.test(at)) {
      await api("POST", "/api/li/runner/session-state", this.acc.id, { state: "checkpoint", error: `contrôle de sécurité (${at})` });
      throw new SessionLost("contrôle de sécurité LinkedIn");
    }
  }

  /** Joue une action avec content.js (même code que l'extension). */
  async exec(action) {
    return await this.page.evaluate(actionScript(action));
  }

  async perform(action) {
    if (action.type === "sync_inbox") {
      await this.goto("https://www.linkedin.com/messaging/");
      const r = await this.exec({ type: "list_conversations", limit: action.limit || 40, expect_member: action.expect_member ?? null });
      const res = await api("POST", "/api/li/inbox", this.acc.id, {
        ok: r.ok,
        conversations: r.data && r.data.conversations,
        error: r.error,
        member: r.member,
        wrong_account: r.wrong_account,
      });
      if (res.wrong_account) throw new SessionLost(`mauvais profil LinkedIn connecté (${r.member && r.member.slug})`);
      log(this.acc, `messagerie lue (${r.ok ? `${res.conversations} conv., ${res.replied?.length ?? 0} réponse(s)` : r.error})`);
      return;
    }
    await this.goto(profileUrl(action.linkedin));
    const r = await this.exec(action);
    await report("/api/li/result", this.acc.id, {
      id: action.id,
      ok: r.ok,
      error: r.error,
      retry: r.retry,
      member: r.member,
      wrong_account: r.wrong_account,
      identity_unknown: r.identity_unknown,
      replied: r.replied,
      reply_text: r.reply_text,
    });
    log(this.acc, `${action.type} → ${action.linkedin} : ${r.ok ? `ok (depuis ${r.member && r.member.slug})` : `échec (${r.error})`}`);
    if (r.wrong_account) throw new SessionLost(`mauvais profil LinkedIn connecté (${r.member && r.member.slug})`);
  }

  async run() {
    await sleep(rand(0, 20_000)); // les comptes ne démarrent pas tous à la même seconde
    while (!this.stopped) {
      try {
        if (!inWindow(this.win)) {
          if (this.ctx) log(this.acc, "hors plage d'activité — navigateur fermé");
          await this.close();
          await sleep(5 * 60_000);
          continue;
        }
        if (!this.acc.proxy && !ALLOW_NO_PROXY) {
          if (!this.warnedProxy) log(this.acc, "aucun proxy configuré — en attente (Réglages → Comptes LinkedIn)");
          this.warnedProxy = true;
          await sleep(5 * 60_000);
          continue;
        }
        const next = await api("GET", "/api/li/next", this.acc.id);
        if (next.action) {
          await this.ensureBrowser();
          await this.perform(next.action);
          await sleep(rand(3000, 8000));
        } else {
          // Rien à faire maintenant : on repasse au plus tard dans la minute
          // (la lecture de la messagerie peut devenir due entre-temps).
          await sleep(Math.min(Math.max((next.wait ?? 60) * 1000, 15_000), 60_000));
        }
      } catch (e) {
        if (e instanceof SessionLost) {
          log(this.acc, `${e.message} — compte arrêté jusqu'au renvoi de la session`);
          await this.stop();
          return;
        }
        log(this.acc, "erreur :", e.message);
        await this.close();
        await sleep(60_000);
      }
    }
  }
}

// --- Supervision : un worker par compte en mode serveur ----------------------

const workers = new Map();

async function supervise() {
  let data;
  try {
    data = await api("GET", "/api/li/runner/accounts");
  } catch (e) {
    console.error("[runner] app injoignable :", e.message);
    return;
  }
  const seen = new Set();
  for (const acc of data.accounts) {
    seen.add(acc.id);
    const w = workers.get(acc.id);
    if (w && !w.stopped) w.update(acc, data.window);
    else {
      workers.set(acc.id, new Worker(acc, data.window));
      log(acc, "démarré");
    }
  }
  for (const [id, w] of workers) {
    if (!seen.has(id)) {
      await w.stop();
      workers.delete(id);
      console.log(`[runner] #${id} : plus en mode serveur (ou désactivé) — arrêté`);
    }
  }
}

async function shutdown() {
  console.log("[runner] arrêt…");
  await Promise.all([...workers.values()].map((w) => w.stop()));
  process.exit(0);
}

// Lancé directement (pas importé par un test) : boucle de supervision.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (!SECRET) {
    console.error("[runner] LI_RUNNER_SECRET manquant — arrêt.");
    process.exit(1);
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  console.log(`[runner] démarré — app ${API}, profils ${PROFILES}${HEADLESS ? ", headless" : ""}`);
  for (;;) {
    await supervise();
    await sleep(SUPERVISE_MS);
  }
}
