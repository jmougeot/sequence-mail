/**
 * LinkedIn cadence, pure (no database): delays between actions, session sizes, rests, and the
 * hours each LinkedIn profile may act. outreach.ts applies them; li-cadence.test.ts checks them.
 *
 * Draws: a uniform draw between two bounds leaves a sharp floor and a flat band, the signature of
 * a script. Delays, session sizes and rests come from a shifted log-normal instead: mostly short
 * values, sometimes long ones, with a floor at half the configured minimum. Its mean is
 * calibrated on the old uniform draw — equal for session sizes and rests, 5 % lower for the delay
 * between actions — so the sending rate never drops.
 *
 * Hours: each profile gets its own daily draw (salt = its LinkedIn slug), so two accounts no
 * longer open and close at the same minute.
 */
import { createHash } from "node:crypto";
import { config } from "../config.js";

const L = config.linkedin;
const DAY_MS = 24 * 60 * 60 * 1000;

export type LiActionType = "invite" | "message";
export type Rng = () => number;

// --- Draws -------------------------------------------------------------------

/** Standard normal CDF (Abramowitz-Stegun 7.1.26, error < 1.5e-7). */
function phi(x: number): number {
  const t = 1 / (1 + (0.3275911 * Math.abs(x)) / Math.SQRT2);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** Mean of a log-normal (mu, sigma) truncated to (0, c]. */
function truncatedMean(mu: number, sigma: number, c: number): number {
  const k = (Math.log(c) - mu) / sigma;
  return Math.exp(mu + (sigma * sigma) / 2) * (phi(k - sigma) / phi(k));
}

const muCache = new Map<string, number>();
/** mu such that the log-normal (mu, sigma) truncated to (0, c] has mean m (0 < m < c). */
function calibrate(m: number, sigma: number, c: number): number {
  const key = `${m}:${sigma}:${c}`;
  const hit = muCache.get(key);
  if (hit != null) return hit;
  let lo = Math.log(m) - 3 * sigma * sigma - 10;
  let hi = Math.log(c) + 10 * sigma;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (truncatedMean(mid, sigma, c) < m) lo = mid;
    else hi = mid;
  }
  const mu = (lo + hi) / 2;
  muCache.set(key, mu);
  return mu;
}

/**
 * Value in [lo, hi] with mean `mean`: lo + a log-normal of spread `sigma`, truncated at hi - lo
 * (redrawn above it, so no pile-up at the cap). Mostly near the median, sometimes far above.
 */
export function tailDraw(lo: number, mean: number, hi: number, sigma: number, rng: Rng = Math.random): number {
  if (!(mean > lo && hi > mean && sigma > 0)) return Math.min(Math.max(mean, lo), Math.max(lo, hi));
  const c = hi - lo;
  const mu = calibrate(mean - lo, sigma, c);
  for (let i = 0; i < 100; i++) {
    const u = 1 - rng();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
    const y = Math.exp(mu + sigma * z);
    if (y <= c) return lo + y;
  }
  return mean;
}

/** Spread of each draw: delays vary most, rests a little less, session sizes least. */
const GAP_SIGMA = 0.9;
const REST_SIGMA = 0.6;
const SESSION_SIGMA = 0.45;
/** Mean delay between two actions, as a share of the old uniform draw's mean. */
const GAP_MEAN_SHARE = 0.95;

/**
 * Delay in seconds between two actions of a session, from bounds `minSec`–`maxSec` (the old
 * uniform draw): floor at half of minSec, mean 5 % below (minSec + maxSec) / 2, at most 4 × maxSec.
 */
export function gapSec(minSec = L.minGapSec, maxSec = L.maxGapSec, rng: Rng = Math.random): number {
  const a = Math.max(0, Math.min(minSec, maxSec));
  const b = Math.max(minSec, maxSec);
  return tailDraw(a / 2, (GAP_MEAN_SHARE * (a + b)) / 2, 4 * b, GAP_SIGMA, rng);
}

/** Rest in minutes after a session, from LI_REST_MIN–MAX: floor at half the minimum, same mean, at most 3 × the maximum. */
export function restMin(minMin = L.restMinMin, maxMin = L.restMaxMin, rng: Rng = Math.random): number {
  const a = Math.max(0, Math.min(minMin, maxMin));
  const b = Math.max(minMin, maxMin);
  return tailDraw(a / 2, (a + b) / 2, 3 * b, REST_SIGMA, rng);
}

/**
 * Actions in a session, from LI_SESSION_MIN–MAX: at least half the minimum (1 at least), same mean
 * as the old uniform integer draw, at most twice the maximum. Rounded up or down at random in
 * proportion, which keeps the mean exact.
 */
export function sessionSize(minN = L.sessionMin, maxN = L.sessionMax, rng: Rng = Math.random): number {
  const a = Math.max(1, Math.min(minN, maxN));
  const b = Math.max(a, minN, maxN);
  const x = tailDraw(Math.max(1, Math.round(a / 2)), (a + b) / 2, 2 * b, SESSION_SIGMA, rng);
  const n = Math.floor(x);
  return Math.max(1, n + (rng() < x - n ? 1 : 0));
}

// --- Calendar day in LI_HOUR_TZ ----------------------------------------------

// Calendar day and clock in LI_HOUR_TZ: daily caps reset at its midnight and inbox reads follow
// its hours (the container itself runs in UTC).
const dayZone = new Intl.DateTimeFormat("en-US", {
  timeZone: L.hourTimezone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
});
export function zoneParts(ts: number): Record<string, number> {
  const p: Record<string, number> = {};
  for (const part of dayZone.formatToParts(ts)) if (part.type !== "literal") p[part.type] = Number(part.value);
  return p;
}
/** Offset of LI_HOUR_TZ from UTC at `ts`, in minutes (Paris: 60 or 120). */
export function zoneOffsetMin(ts: number): number {
  const p = zoneParts(ts);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000) / 60_000);
}
/** Midnight of `ts`'s day in LI_HOUR_TZ. */
export function startOfLocalDay(ts: number): number {
  const p = zoneParts(ts);
  const midnight = Date.UTC(p.year, p.month - 1, p.day); // local midnight read as UTC
  const guess = midnight - zoneOffsetMin(ts) * 60_000;
  return midnight - zoneOffsetMin(guess) * 60_000; // offset at midnight itself (DST change days)
}

/** Draw in [0, 1) fixed for a calendar day (LI_HOUR_TZ) and a salt: the same all day, new each day. */
export function dayDraw(ts: number, salt: string): number {
  const p = zoneParts(ts);
  return createHash("sha256").update(`${p.year}-${p.month}-${p.day}:${salt}`).digest().readUInt32BE(0) / 2 ** 32;
}

/** Today's cap: between LI_CAP_FLOOR_PCT and 100 % of `cap`, drawn each day (`salt` names the profile and the type). */
export function todayCap(cap: number, ts: number, salt: string): number {
  if (cap <= 0) return 0;
  const floor = Math.min(100, Math.max(0, L.capFloorPct)) / 100;
  return Math.max(1, Math.round(cap * (floor + (1 - floor) * dayDraw(ts, salt))));
}

// --- Hours, per LinkedIn profile ----------------------------------------------

/** What identifies a LinkedIn profile in the daily draws. */
export interface ProfileRef {
  id: number;
  member_slug: string | null;
}

/** Salt of a profile's daily draws: its LinkedIn slug (shared by its accounts), else the account. */
export function profileKey(a: ProfileRef): string {
  return a.member_slug ?? `account-${a.id}`;
}

/** [from, until) in minutes of the day, moved each day and for each profile: starts later, ends earlier (LI_WINDOW_JITTER_MIN). */
function jittered(ts: number, from: number, until: number, salt: string, key: string): [number, number] {
  const j = Math.max(0, Math.min(L.windowJitterMin, (until - from) / 4));
  return [from + dayDraw(ts, `${key}:${salt}:from`) * j, until - dayDraw(ts, `${key}:${salt}:until`) * j];
}

// Messages: LI_HOUR_START to LI_HOUR_END in LI_HOUR_TZ.
const messageZone = new Intl.DateTimeFormat("en-US", {
  timeZone: L.hourTimezone, hourCycle: "h23", weekday: "short", hour: "numeric", minute: "numeric",
});

/** Today's message hours of a profile, in minutes of the day (LI_HOUR_TZ). */
export function messageWindow(ts: number, a: ProfileRef): [number, number] {
  return jittered(ts, L.hourStart * 60, L.hourEnd * 60, "message", profileKey(a));
}

function withinWindow(ts: number, a: ProfileRef): boolean {
  const p: Record<string, string> = {};
  for (const part of messageZone.formatToParts(ts)) p[part.type] = part.value;
  if (L.workdaysOnly && p.weekday === "Sat") return false;
  const min = Number(p.hour) * 60 + Number(p.minute);
  const [from, until] = messageWindow(ts, a);
  return min >= from && min < until;
}

// Invites: from L.inviteFrom until L.inviteUntil in the email window's time zone, weekends included
// (both windows shrink by a different random amount each day).
const inviteZone = new Intl.DateTimeFormat("en-US", {
  timeZone: config.deliverability.sendWindowTimezone, hourCycle: "h23", hour: "numeric", minute: "numeric",
});
const hhmm = (s: string) => (([h, m]) => h * 60 + (m || 0))(s.split(":").map(Number));
const INVITE_FROM_MIN = hhmm(L.inviteFrom);
const INVITE_UNTIL_MIN = hhmm(L.inviteUntil);

/** Today's invite hours of a profile, in minutes of the day (SEND_WINDOW_TZ). */
export function inviteWindow(ts: number, a: ProfileRef): [number, number] {
  return jittered(ts, INVITE_FROM_MIN, INVITE_UNTIL_MIN, "invite", profileKey(a));
}

function withinInviteWindow(ts: number, a: ProfileRef): boolean {
  const p: Record<string, string> = {};
  for (const part of inviteZone.formatToParts(ts)) p[part.type] = part.value;
  const min = Number(p.hour) * 60 + Number(p.minute);
  const [from, until] = inviteWindow(ts, a);
  return min >= from && min < until;
}

/** First quarter hour after `ts` where `open` holds, within 8 days. */
function nextOpening(ts: number, open: (t: number) => boolean): number {
  // Every UTC offset in use is a multiple of 15 min: the configured hours fall on a quarter hour.
  const step = 15 * 60_000;
  for (let t = Math.ceil((ts + 1) / step) * step; t < ts + 8 * DAY_MS; t += step) {
    if (open(t)) return t;
  }
  return ts + DAY_MS;
}

/** Action types the profile's hours allow at `ts`: messages in LI_HOUR_*, invites in LI_INVITE_FROM–LI_INVITE_UNTIL. */
export function openTypes(ts: number, a: ProfileRef): LiActionType[] {
  return (["invite", "message"] as LiActionType[]).filter((t) => (t === "invite" ? withinInviteWindow(ts, a) : withinWindow(ts, a)));
}

/** Next instant the profile's hours for `type` open. */
export function nextOpen(type: LiActionType, ts: number, a: ProfileRef): number {
  return nextOpening(ts, (t) => (type === "invite" ? withinInviteWindow(t, a) : withinWindow(t, a)));
}
