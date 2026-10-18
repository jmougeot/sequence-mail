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

// OAuth credentials entered in Settings: used only when .env provides none.
const googleFromEnv = Boolean(config.google.clientId);
const storedGoogle = db.prepare("SELECT value FROM app_settings WHERE key = 'google'").get() as
  | { value: string }
  | undefined;
if (!googleFromEnv && storedGoogle) Object.assign(config.google, JSON.parse(storedGoogle.value));

export function googleCredentialsSource(): "env" | "app" | null {
  if (googleFromEnv) return "env";
  return config.google.clientId ? "app" : null;
}

export function saveGoogleCredentials(clientId: string, clientSecret: string): void {
  if (googleFromEnv) throw new Error("Google credentials are set in .env: change them there");
  db.prepare(
    "INSERT INTO app_settings (key, value) VALUES ('google', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(JSON.stringify({ clientId, clientSecret }));
  Object.assign(config.google, { clientId, clientSecret });
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
    prompt: "consent", // forces a refresh_token on every connection
    scope: SCOPES,
  });
}

// Exchange the OAuth code with a direct fetch rather than client.getToken(): googleapis' internal
// transport (gaxios) always fails on this VPS with "Premature close"; native fetch to the same
// endpoint is reliable.
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
    throw new Error(`OAuth code exchange failed (${res.status}): ${await res.text()}`);
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
  if (!email) throw new Error("Could not read the Google account's email address");

  const existing = db.prepare("SELECT id, oauth_tokens FROM accounts WHERE email = ?").get(email) as
    | { id: number; oauth_tokens: string }
    | undefined;
  if (existing) {
    // Keep the old refresh_token if Google doesn't return a new one
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
  // googleapis' default HTTP transport (gaxios) always fails on this VPS with "Premature close";
  // Node's native fetch is reliable. The OAuth client sends both token refreshes and Gmail API
  // calls through this transporter, so force it to use fetch.
  (client.transporter as unknown as { defaults: Record<string, unknown> }).defaults.fetchImplementation =
    globalThis.fetch;
  // Persist tokens auto-refreshed by googleapis
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
  // RFC 2047 for accented subjects
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
 * Converts the text body to minimal HTML: **bold**, *italic*, line breaks kept. URLs stay plain
 * text (Gmail makes them clickable).
 */
export function bodyToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>") // bold before italic
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
    inReplyTo?: string | null; // RFC822 Message-ID of the previous message
    listUnsubscribeUrl?: string | null; // one-click unsubscribe link (List-Unsubscribe)
  }
): Promise<SendResult> {
  const gmail = google.gmail({ version: "v1", auth: clientForAccount(account) });
  const rfc822MessageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@${account.email.split("@")[1]}>`;

  const from = account.from_name
    ? `${encodeHeader(account.from_name)} <${account.email}>`
    : account.email;
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  // multipart/alternative: plain text (*asterisks* stay visible) + HTML (italic rendered), as Gmail
  // does; the recipient's client picks the version.
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
  // One-click unsubscribe (RFC 8058): required by Gmail/Yahoo and a good reputation signal.
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

/** Decodes the first MIME part of the given type (depth-first search). */
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
  /**
   * Content-Type header: "multipart/report; report-type=delivery-status" = NDR/bounce (RFC 3462)
   */
  contentType: string;
  /** message/delivery-status part of an NDR (RFC 3464): Action / Status / Diagnostic-Code fields */
  deliveryStatus: string;
  /** Auto-Submitted header (RFC 3834): "auto-replied"/"auto-generated" = machine reply */
  autoSubmitted: string;
  /** Precedence header: "auto_reply"/"bulk" on some auto-replies */
  precedence: string;
  /** X-Autoreply / X-Autorespond present (non-standard out-of-office responders) */
  hasAutoReplyHeader: boolean;
}

/** A Gmail thread message, incoming or outgoing (full thread read). */
export interface ThreadMessage extends ForeignMessage {
  to: string;
  /** RFC822 Message-ID header (In-Reply-To / References of a reply) */
  messageId: string;
  /** Gmail internalDate, epoch ms */
  date: number;
  /** Sent by the account (From = account address) */
  outgoing: boolean;
}

/** All thread messages (the account's own included), in chronological order. */
export async function getThreadMessages(account: AccountRow, threadId: string): Promise<ThreadMessage[]> {
  const gmail = google.gmail({ version: "v1", auth: clientForAccount(account) });
  const { data } = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "full",
  });
  return (data.messages ?? []).map((msg) => {
    const header = (name: string) =>
      msg.payload?.headers?.find((h) => h.name?.toLowerCase() === name)?.value ?? "";
    const from = header("from");
    return {
      id: msg.id ?? "",
      from,
      to: header("to"),
      subject: header("subject"),
      messageId: header("message-id"),
      date: Number(msg.internalDate ?? 0),
      outgoing: from.toLowerCase().includes(account.email.toLowerCase()),
      text: extractPart(msg.payload as GmailPart, "text/plain") || msg.snippet || "",
      contentType: header("content-type"),
      deliveryStatus: extractPart(msg.payload as GmailPart, "message/delivery-status"),
      autoSubmitted: header("auto-submitted"),
      precedence: header("precedence"),
      hasAutoReplyHeader: Boolean(header("x-autoreply") || header("x-autorespond")),
    };
  });
}

/**
 * All thread messages not from the account (replies, bounces, auto-replies…), in chronological
 * order.
 */
export async function getForeignMessages(
  account: AccountRow,
  threadId: string
): Promise<ForeignMessage[]> {
  return (await getThreadMessages(account, threadId))
    .filter((m) => m.from && !m.outgoing)
    .map((m) => ({
      id: m.id,
      from: m.from,
      subject: m.subject,
      text: m.text,
      contentType: m.contentType,
      deliveryStatus: m.deliveryStatus,
      autoSubmitted: m.autoSubmitted,
      precedence: m.precedence,
      hasAutoReplyHeader: m.hasAutoReplyHeader,
    }));
}

/** Google access revoked or expired (refresh token rejected). */
export function isGoogleAuthError(msg: string): boolean {
  return msg.includes("invalid_grant") || msg.includes("invalid_rapt");
}

/**
 * Readable error for a Gmail call: expired access becomes a reconnect instruction rather than a
 * library trace.
 */
export function googleErrorMessage(err: unknown, accountEmail: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (isGoogleAuthError(msg)) {
    return `accès Google expiré pour ${accountEmail}, reconnectez le compte via /auth/google`;
  }
  return `Gmail (${accountEmail}) : ${msg}`;
}
