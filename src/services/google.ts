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

export async function handleOAuthCallback(code: string): Promise<string> {
  const client = newOAuthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: "v2", auth: client });
  const { data } = await oauth2.userinfo.get();
  const email = data.email;
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

/** Convertit le corps texte en HTML minimal : *texte* devient italique, sauts de ligne préservés. */
export function bodyToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
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

function extractPlainText(part: GmailPart | undefined | null): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf8");
  }
  for (const p of part.parts ?? []) {
    const text = extractPlainText(p);
    if (text) return text;
  }
  return "";
}

export interface ForeignMessage {
  id: string;
  from: string;
  subject: string;
  text: string;
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
        text: extractPlainText(msg.payload as GmailPart) || msg.snippet || "",
        autoSubmitted: header("auto-submitted"),
        precedence: header("precedence"),
        hasAutoReplyHeader: Boolean(header("x-autoreply") || header("x-autorespond")),
      });
    }
  }
  return result;
}
