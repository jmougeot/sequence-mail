import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { config } from "../config.js";
import { gapSec, inviteWindow, messageWindow, nextOpen, openTypes, restMin, sessionSize, tailDraw } from "./li-cadence.js";

const L = config.linkedin;
const N = 100_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Seeded generator (mulberry32): the same draws on every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

const draws = (f: (rng: () => number) => number, seed = 1) => {
  const rng = seeded(seed);
  return Array.from({ length: N }, () => f(rng));
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// Production settings (9 Nov. 2026) and the defaults of config.ts.
const SETTINGS = [
  { gap: [30, 120], session: [6, 12], rest: [15, 45] },
  { gap: [L.minGapSec, L.maxGapSec], session: [L.sessionMin, L.sessionMax], rest: [L.restMinMin, L.restMaxMin] },
];

describe("delay between two actions", () => {
  for (const { gap: [lo, hi] } of SETTINGS) {
    it(`${lo}-${hi} s: mean not above the old uniform draw's, floor below the old one`, () => {
      const xs = draws((rng) => gapSec(lo, hi, rng));
      assert.ok(mean(xs) <= (lo + hi) / 2, `mean ${mean(xs)} > ${(lo + hi) / 2}`);
      assert.ok(xs.some((x) => x < lo), `no delay under the old floor ${lo} s`);
      assert.ok(Math.min(...xs) >= lo / 2, "delay under half the minimum");
      assert.ok(Math.max(...xs) <= 4 * hi, "delay over 4 × the maximum");
      // Long tail: some delays beyond the old maximum, median under the mean.
      assert.ok(xs.some((x) => x > hi), "no delay beyond the old maximum");
      assert.ok(median(xs) < mean(xs));
    });
  }
  it("draws without a seed keep the mean too", () => {
    const xs = Array.from({ length: N }, () => gapSec(30, 120));
    assert.ok(mean(xs) <= 75);
  });
});

describe("session size and rest", () => {
  for (const { session: [a, b], rest: [r1, r2] } of SETTINGS) {
    it(`sessions of ${a}-${b} actions: same mean, wider spread, whole numbers ≥ 1`, () => {
      const xs = draws((rng) => sessionSize(a, b, rng), 2);
      assert.ok(Math.abs(mean(xs) - (a + b) / 2) < 0.05, `mean ${mean(xs)}`);
      assert.ok(xs.every((x) => Number.isInteger(x) && x >= 1 && x <= 2 * b));
      if (a > 1) assert.ok(xs.some((x) => x < a));
      assert.ok(xs.some((x) => x > b));
    });
    it(`rests of ${r1}-${r2} min: same mean, shorter and longer ones`, () => {
      const xs = draws((rng) => restMin(r1, r2, rng), 3);
      assert.ok(Math.abs(mean(xs) - (r1 + r2) / 2) < 0.01 * (r1 + r2), `mean ${mean(xs)}`);
      assert.ok(xs.some((x) => x < r1) && xs.some((x) => x > r2));
      assert.ok(xs.every((x) => x >= r1 / 2 && x <= 3 * r2));
    });
  }
  it("tailDraw hits the requested mean, within its bounds", () => {
    const xs = draws((rng) => tailDraw(10, 40, 200, 0.9, rng), 4);
    assert.ok(Math.abs(mean(xs) - 40) < 0.5, `mean ${mean(xs)}`);
    assert.ok(xs.every((x) => x >= 10 && x <= 200));
  });
  it("degenerate bounds give a fixed value", () => {
    assert.equal(sessionSize(1, 1), 1);
    assert.equal(gapSec(0, 0), 0);
  });
});

describe("hours per LinkedIn profile", () => {
  const jacques = { id: 5, member_slug: "jacques" };
  const lumine = { id: 6, member_slug: "lumine" };
  const day0 = Date.UTC(2026, 10, 9, 11, 0); // midday in Europe: one calendar day everywhere near
  const days = Array.from({ length: 60 }, (_, k) => day0 + k * DAY_MS);
  const jitter = (from: number, until: number) => Math.min(L.windowJitterMin, (until - from) / 4);

  it("two accounts get different hours on the same day", () => {
    let gaps = 0;
    for (const ts of days) {
      for (const w of [messageWindow, inviteWindow]) {
        const [a, b] = [w(ts, jacques), w(ts, lumine)];
        assert.notDeepEqual(a, b);
        gaps += Math.abs(a[0] - b[0]);
      }
    }
    // Uniform openings over [0, jitter]: about jitter / 3 apart on average.
    assert.ok(gaps / (2 * days.length) > 10, `openings only ${gaps / (2 * days.length)} min apart`);
  });

  it("same account, same day: same hours, whatever the time of the call", () => {
    for (const ts of days) {
      for (const a of [jacques, { id: 7, member_slug: null }]) {
        assert.deepEqual(messageWindow(ts, a), messageWindow(ts + 9 * 3600_000, { ...a }));
        assert.deepEqual(inviteWindow(ts - 3 * 3600_000, a), inviteWindow(ts + 6 * 3600_000, a));
      }
    }
  });

  it("an account without slug and one with a slug differ; accounts of one profile share hours", () => {
    const ts = day0;
    assert.notDeepEqual(messageWindow(ts, { id: 5, member_slug: null }), messageWindow(ts, { id: 6, member_slug: null }));
    assert.deepEqual(messageWindow(ts, { id: 5, member_slug: "jacques" }), messageWindow(ts, { id: 9, member_slug: "jacques" }));
  });

  it("hours stay within the configured bounds", () => {
    const msg: [number, number] = [L.hourStart * 60, L.hourEnd * 60];
    const hm = (s: string) => s.split(":").map(Number).reduce((h, m) => h * 60 + m, 0) as number;
    const inv: [number, number] = [hm(L.inviteFrom), hm(L.inviteUntil)];
    for (const ts of days) {
      for (const a of [jacques, lumine]) {
        for (const [[from, until], [f0, u0]] of [
          [messageWindow(ts, a), msg],
          [inviteWindow(ts, a), inv],
        ] as Array<[[number, number], [number, number]]>) {
          const j = jitter(f0, u0);
          assert.ok(from >= f0 && from <= f0 + j && until <= u0 && until >= u0 - j, `${from}-${until} outside ${f0}-${u0}`);
        }
      }
    }
  });

  it("nextOpen lands where openTypes allows the type", () => {
    for (const a of [jacques, lumine]) {
      for (const t of ["invite", "message"] as const) {
        const at = nextOpen(t, day0, a);
        assert.ok(at > day0 && at < day0 + 8 * DAY_MS);
        assert.ok(openTypes(at, a).includes(t));
      }
    }
  });
});
