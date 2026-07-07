import { google } from "googleapis";
import type { Credentials, OAuth2Client } from "google-auth-library";
import { config, googleRedirectUri } from "../config.js";
import { db } from "../db.js";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

export interface AccountRow {
  id: number;
  email: string;
  oauth_tokens: string;
  daily_limit: number;
  sent_today: number;
  sent_today_date: string | null;
  last_sent_at: number | null;
  next_allowed_at: number | null;
  active: number;
  warmup: number;
  warmup_started_at: number | null;
  created_at: number;
  from_name: string | null;
  signature: string | null;
}

function newOAuthClient(): OAuth2Client {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    googleRedirectUri()
  );
}

export function authUrl(): string {
  return newOAuthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // force un refresh_token à chaque connexion
    scope: SCOPES,
  });
}

// Échange du code OAuth via fetch direct plutôt que client.getToken() : le transport
// interne de googleapis (gaxios) échoue de façon systématique sur ce VPS avec
// « Premature close ». fetch natif vers le même endpoint est fiable.
async function exchangeCodeForTokens(code: string): Promise<Credentials> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: googleRedirectUri(),
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    throw new Error(`Échange du code OAuth échoué (${res.status}) : ${await res.text()}`);
  }
  const t = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    scope?: string;
    token_type?: string;
    id_token?: string;
    expires_in?: number;
  };
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    scope: t.scope,
    token_type: t.token_type,
    id_token: t.id_token,
    expiry_date: t.expires_in ? Date.now() + t.expires_in * 1000 : undefined,
  };
}

async function fetchUserEmail(accessToken: string): Promise<string | undefined> {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return undefined;
  const data = (await res.json()) as { email?: string };
  return data.email;
}

export async function handleOAuthCallback(code: string): Promise<string> {
  const client = newOAuthClient();
  const tokens = await exchangeCodeForTokens(code);
  client.setCredentials(tokens);
  const email = await fetchUserEmail(tokens.access_token!);
  if (!email) throw new Error("Impossible de récupérer l'adresse email du compte Google");

  const existing = db.prepare("SELECT id, oauth_tokens FROM accounts WHERE email = ?").get(email) as
    | { id: number; oauth_tokens: string }
    | undefined;
  if (existing) {
    // Conserve l'ancien refresh_token si Google n'en renvoie pas de nouveau
    const old = JSON.parse(existing.oauth_tokens) as Credentials;
    const merged = { ...old, ...tokens, refresh_token: tokens.refresh_token ?? old.refresh_token };
    db.prepare("UPDATE accounts SET oauth_tokens = ?, active = 1 WHERE id = ?").run(
      JSON.stringify(merged),
      existing.id
    );
  } else {
    db.prepare("INSERT INTO accounts (email, oauth_tokens, daily_limit) VALUES (?, ?, ?)").run(
      email,
      JSON.stringify(tokens),
      config.deliverability.defaultDailyLimit
    );
  }
  return email;
}

export function clientForAccount(account: AccountRow): OAuth2Client {
  const client = newOAuthClient();
  client.setCredentials(JSON.parse(account.oauth_tokens) as Credentials);
  // Le transport HTTP par défaut de googleapis (gaxios) échoue systématiquement
  // sur ce VPS avec « Premature close » ; le fetch natif de Node est fiable. Le
  // client OAuth fait passer par ce transporter aussi bien le rafraîchissement de
  // token que les appels API Gmail : on le force donc à utiliser fetch.
  (client.transporter as unknown as { defaults: Record<string, unknown> }).defaults.fetchImplementation =
    globalThis.fetch;
  // Persiste les tokens rafraîchis automatiquement par googleapis
  client.on("tokens", (tokens) => {
    const current = JSON.parse(
      (db.prepare("SELECT oauth_tokens FROM accounts WHERE id = ?").get(account.id) as AccountRow)
        .oauth_tokens
    ) as Credentials;
    const merged = { ...current, ...tokens, refresh_token: tokens.refresh_token ?? current.refresh_token };
    db.prepare("UPDATE accounts SET oauth_tokens = ? WHERE id = ?").run(
      JSON.stringify(merged),
      account.id
    );
  });
  return client;
}

function encodeHeader(value: string): string {
  // RFC 2047 pour les sujets accentués
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export interface SendResult {
  gmailMessageId: string;
  threadId: string;
  rfc822MessageId: string;
}

/**
 * Convertit le corps texte en HTML minimal : **texte** gras, *texte* italique,
 * sauts de ligne préservés. Les URLs restent en clair (Gmail les rend cliquables
 * à l'affichage).
 */
export function bodyToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>") // gras avant italique
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/\r?\n/g, "<br>\n");
  return `<div dir="ltr">${escaped}</div>`;
}

export async function sendEmail(
  account: AccountRow,
  opts: {
    to: string;
    subject: string;
    body: string;
    threadId?: string | null;
    inReplyTo?: string | null; // Message-ID RFC822 du message précédent
    listUnsubscribeUrl?: string | null; // lien de désinscription un-clic (List-Unsubscribe)
  }
): Promise<SendResult> {
  const gmail = google.gmail({ version: "v1", auth: clientForAccount(account) });
  const rfc822MessageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@${account.email.split("@")[1]}>`;

  const from = account.from_name
    ? `${encodeHeader(account.from_name)} <${account.email}>`
    : account.email;
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  // multipart/alternative : texte brut (les *étoiles* restent visibles) + HTML (italique rendu),
  // comme le ferait Gmail — le client du destinataire choisit la version.
  const boundary = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const headers = [
    `From: ${from}`,
    `To: ${opts.to}`,
    `Subject: ${encodeHeader(opts.subject)}`,
    `Message-ID: ${rfc822MessageId}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  if (opts.inReplyTo) {
    headers.push(`In-Reply-To: ${opts.inReplyTo}`, `References: ${opts.inReplyTo}`);
  }
  // Désinscription un-clic (RFC 8058) : exigée par Gmail/Yahoo et bon signal de réputation.
  if (opts.listUnsubscribeUrl) {
    headers.push(
      `List-Unsubscribe: <${opts.listUnsubscribeUrl}>`,
      "List-Unsubscribe-Post: List-Unsubscribe=One-Click"
    );
  }
  const mime =
    headers.join("\r\n") +
    "\r\n\r\n" +
    `--${boundary}\r\n` +
    'Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
    b64(opts.body) +
    `\r\n--${boundary}\r\n` +
    'Content-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
    b64(bodyToHtml(opts.body)) +
    `\r\n--${boundary}--`;
  const raw = Buffer.from(mime, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const { data } = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw, threadId: opts.threadId ?? undefined },
  });
  return {
    gmailMessageId: data.id ?? "",
    threadId: data.threadId ?? "",
    rfc822MessageId,
  };
}

interface GmailPart {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: GmailPart[] | null;
}

/** Décode la première partie MIME du type demandé (recherche en profondeur). */
function extractPart(part: GmailPart | undefined | null, mimeType: string): string {
  if (!part) return "";
  if (part.mimeType === mimeType && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf8");
  }
  for (const p of part.parts ?? []) {
    const text = extractPart(p, mimeType);
    if (text) return text;
  }
  return "";
}

export interface ForeignMessage {
  id: string;
  from: string;
  subject: string;
  text: string;
  /** En-tête Content-Type : "multipart/report; report-type=delivery-status" = NDR/bounce (RFC 3462) */
  contentType: string;
  /** Partie message/delivery-status d'un NDR (RFC 3464) : champs Action / Status / Diagnostic-Code */
  deliveryStatus: string;
  /** En-tête Auto-Submitted (RFC 3834) : "auto-replied"/"auto-generated" = réponse machine */
  autoSubmitted: string;
  /** En-tête Precedence : "auto_reply"/"bulk" sur certaines réponses automatiques */
  precedence: string;
  /** X-Autoreply / X-Autorespond présents (répondeurs d'absence non standards) */
  hasAutoReplyHeader: boolean;
}

/**
 * Retourne tous les messages du fil ne venant pas du compte (réponses, bounces,
 * réponses automatiques…), dans l'ordre chronologique.
 */
export async function getForeignMessages(
  account: AccountRow,
  threadId: string
): Promise<ForeignMessage[]> {
  const gmail = google.gmail({ version: "v1", auth: clientForAccount(account) });
  const { data } = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "full",
  });
  const result: ForeignMessage[] = [];
  for (const msg of data.messages ?? []) {
    const header = (name: string) =>
      msg.payload?.headers?.find((h) => h.name?.toLowerCase() === name)?.value ?? "";
    const from = header("from");
    if (from && !from.toLowerCase().includes(account.email.toLowerCase())) {
      result.push({
        id: msg.id ?? "",
        from,
        subject: header("subject"),
        text: extractPart(msg.payload as GmailPart, "text/plain") || msg.snippet || "",
        contentType: header("content-type"),
        deliveryStatus: extractPart(msg.payload as GmailPart, "message/delivery-status"),
        autoSubmitted: header("auto-submitted"),
        precedence: header("precedence"),
        hasAutoReplyHeader: Boolean(header("x-autoreply") || header("x-autorespond")),
      });
    }
  }
  return result;
}
