import "dotenv/config";

function int(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: int("PORT", 3000),
  baseUrl: process.env.BASE_URL ?? "http://localhost:3000",
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  },
  // Per-prospect link, placed in the email via {{link}}. It points to VISIT_BASE_URL (ideally a
  // subdomain like sequence.example.com serving this app), logs the visit server-side (reliable), then
  // 302-redirects to VISIT_DEST_URL (your public page). VISIT_BASE_URL must be PUBLIC.
  visit: {
    enabled: (process.env.VISIT_ENABLED ?? "true") !== "false",
    baseUrl: (process.env.VISIT_BASE_URL || process.env.BASE_URL || "http://localhost:3000").replace(/\/+$/, ""),
    destUrl: (process.env.VISIT_DEST_URL || "https://www.example.com").replace(/\/+$/, ""),
    // Bot filter: a click less than N seconds after sending is a security scanner (Safe Links…),
    // not a human. 0 disables the timing check.
    botMinDelaySeconds: int("VISIT_BOT_MIN_DELAY_SECONDS", 60),
  },
  attioApiKey: process.env.ATTIO_API_KEY ?? "",
  // Slug of a text attribute on Attio's "people" object that receives sequence progress
  attioStageAttribute: process.env.ATTIO_STAGE_ATTRIBUTE ?? "",
  // Slug of the "people" attribute used to filter imports (sync form default)
  attioImportAttribute: process.env.ATTIO_IMPORT_ATTRIBUTE ?? "",
  deliverability: {
    defaultDailyLimit: int("DEFAULT_DAILY_LIMIT", 40),
    sendWindowStart: int("SEND_WINDOW_START", 9),
    sendWindowEnd: int("SEND_WINDOW_END", 18),
    // Timezone for these hours and weekdays (default: the server's)
    sendWindowTimezone: process.env.SEND_WINDOW_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    weekdaysOnly: (process.env.WEEKDAYS_ONLY ?? "true") !== "false",
    minGapSeconds: int("MIN_GAP_SECONDS", 90),
    maxGapSeconds: int("MAX_GAP_SECONDS", 420),
    // Email warm-up: start low and ramp up weekly to the account quota. Essential on a new domain
    // (reputation to build).
    warmupStart: int("WARMUP_START", 5),
    warmupRamp: int("WARMUP_RAMP", 5),
  },
  // LinkedIn steps (invites/messages via the Chrome extension). These limits are THE anti-ban
  // safeguard: daily caps, working hours and random delays. Lowering them is safe; raising them
  // increases the risk of account restriction. See .env.example (LI_ prefix).
  linkedin: {
    invitesPerDay: int("LI_INVITES_PER_DAY", 20),
    messagesPerDay: int("LI_MESSAGES_PER_DAY", 40),
    hourStart: int("LI_HOUR_START", 9),
    hourEnd: int("LI_HOUR_END", 18),
    // Time zone of the message hours above (empty = server time zone)
    hourTimezone: process.env.LI_HOUR_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    // Invites: from HH:MM, last one before HH:MM, in SEND_WINDOW_TZ (hours above = messages)
    inviteFrom: process.env.LI_INVITE_FROM || "08:00",
    inviteUntil: process.env.LI_INVITE_UNTIL || "21:30",
    // Messages every day but Saturday (invites run every day)
    workdaysOnly: (process.env.LI_WORKDAYS_ONLY ?? "1") !== "0",
    // Each day's cap is drawn between this share and 100 % of the cap above (no flat daily volume).
    capFloorPct: int("LI_CAP_FLOOR_PCT", 60),
    // Hours move each day: start up to N min later, stop up to N min earlier.
    windowJitterMin: int("LI_WINDOW_JITTER_MIN", 75),
    // Actions go in short sessions (LI_SESSION_MIN–MAX actions, LI_MIN/MAX_GAP_SEC apart), then
    // the profile rests LI_REST_MIN–MAX minutes; inbox reads happen at a session start.
    sessionMin: int("LI_SESSION_MIN", 2),
    sessionMax: int("LI_SESSION_MAX", 5),
    minGapSec: int("LI_MIN_GAP_SEC", 120),
    maxGapSec: int("LI_MAX_GAP_SEC", 420),
    restMinMin: int("LI_REST_MIN", 60),
    restMaxMin: int("LI_REST_MAX", 150),
    pauseAfterErrorMin: int("LI_PAUSE_AFTER_ERROR_MIN", 15),
    // Retry delay when a message targets a contact not connected yet (invitation not accepted)
    messageRetryHours: int("LI_MESSAGE_RETRY_HOURS", 24),
    // …for at most N days after queuing: beyond that, invitation ignored, sequence closed.
    messageRetryMaxDays: int("LI_MESSAGE_RETRY_MAX_DAYS", 21),
    // LinkedIn security check / captcha: long pause for that account
    checkpointPauseMin: int("LI_CHECKPOINT_PAUSE_MIN", 24 * 60),
    // Inbox reading (LinkedIn reply detection): at most once every N minutes per LinkedIn profile, if
    // it has contacts to watch, and never during a rest.
    inboxEveryMin: int("LI_INBOX_EVERY_MIN", 120),
    // Encrypts the LinkedIn session and proxy of server-mode accounts. Required for that mode;
    // never change it without re-sending the sessions.
    secretKey: process.env.LI_SECRET_KEY ?? "",
    // Secret shared with the runner service (server browsers), internal network.
    runnerSecret: process.env.LI_RUNNER_SECRET ?? "",
    // Owners (e.g. "azerit:u:1") whose Chrome extension performs the sends itself: when paired from
    // Azerit, it receives its account's token and connects on its own. Other extensions only link
    // LinkedIn.
    extensionOwners: (process.env.LI_EXTENSION_OWNERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },
  // Where a Gmail connection started from Azerit returns (its settings page, e.g.
  // https://app.azerit.tech/#/settings). Empty: the dashboard's settings page.
  azeritReturnUrl: process.env.AZERIT_RETURN_URL ?? "",
  // Key of the service API (/api/svc) called by Azerit on the VPS internal network. Empty = API
  // disabled.
  serviceApiKey: process.env.SERVICE_API_KEY ?? "",
};

export function googleRedirectUri(): string {
  return `${config.baseUrl}/auth/google/callback`;
}
