import { describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  cdnCheckoutProblem,
  normalize,
  parseDecimal,
  previousQuarter,
  quarterBounds,
  resolvePeriod,
  twap,
  windowRelation,
} from "./testnet-rewards";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Hourly samples at 0h..24h inclusive.
const hourly = (price: (h: number) => number): [number, number][] =>
  Array.from({ length: 25 }, (_, h) => [h * HOUR, price(h)]);

describe("twap", () => {
  test("constant price", () => {
    expect(twap(hourly(() => 0.022), 0, DAY)).toBeCloseTo(0.022, 12);
  });

  test("linear ramp averages to the midpoint, boundary samples included", () => {
    // 0.021 -> 0.023 over the day: the exact TWAP is 0.022.
    expect(twap(hourly((h) => 0.021 + (0.002 * h) / 24), 0, DAY)).toBeCloseTo(0.022, 12);
  });

  test("step in the last hour counts for its full share of the window", () => {
    // 0.02 for 23h, then 0.02 -> 0.068 over the last hour: area adds 0.024 per hour = 0.001 per day.
    const points = hourly((h) => (h < 24 ? 0.02 : 0.068));
    expect(twap(points, 0, DAY)).toBeCloseTo(0.021, 12);
  });

  test("interpolates at boundaries that fall between samples", () => {
    const points = hourly((h) => h);
    expect(twap(points, 0.5 * HOUR, 1.5 * HOUR)).toBeCloseTo(1, 12);
  });

  test("holds the edge price beyond the samples", () => {
    expect(twap([[HOUR, 2]], 0, DAY)).toBeCloseTo(2, 12);
  });

  test("ignores samples outside the window", () => {
    const points: [number, number][] = [[-DAY, 100], [0, 1], [DAY, 1], [2 * DAY, 100]];
    expect(twap(points, 0, DAY)).toBeCloseTo(1, 12);
  });
});

describe("normalize", () => {
  const WEI = 10n ** 18n;
  const params = [parseDecimal("25", "workers"), parseDecimal("225", "usd"), parseDecimal("0.035716", "price")] as const;

  test("splits 25 x $225 / price pro rata, floored to wei", () => {
    const out = normalize([["0xa", 1n], ["0xb", 3n]], ...params);
    // 5625 / 0.035716 SQD in total: a gets a quarter, b three quarters, each floored.
    const budget = (5625n * 1_000_000n * WEI) / 35716n;
    expect(out).toEqual([["0xa", (5625n * 1_000_000n * WEI) / (35716n * 4n)], ["0xb", (3n * 5625n * 1_000_000n * WEI) / (35716n * 4n)]]);
    const total = out.reduce((acc, [, a]) => acc + a, 0n);
    expect(total <= budget).toBe(true);
    expect(budget - total < 2n).toBe(true);
  });

  test("is exact for amounts far beyond float precision", () => {
    const big = 30158180895972897309266n;
    const [[, amount]] = normalize([["0xa", big]], parseDecimal("1", "w"), parseDecimal("1", "u"), parseDecimal("0.5", "p"));
    expect(amount).toBe(2n * WEI);
  });
});

describe("quarters", () => {
  test("quarterBounds ends on the first day of the next quarter", () => {
    expect(quarterBounds("2026-Q3")).toEqual({ from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-10-01T00:00:00Z") });
    expect(quarterBounds("2026-Q4")).toEqual({ from: new Date("2026-10-01T00:00:00Z"), to: new Date("2027-01-01T00:00:00Z") });
  });

  test("previousQuarter rolls Q1 back to the previous year", () => {
    expect(previousQuarter("2026-Q3")).toBe("2026-Q2");
    expect(previousQuarter("2027-Q1")).toBe("2026-Q4");
    expect(previousQuarter("2026-04-01_2026-06-30")).toBeNull();
  });
});

describe("periods", () => {
  test("--from with --quarter moves the data window but not the label or the price window", () => {
    const p = resolvePeriod({ quarter: "2026-Q3", from: "2026-06-30" });
    expect(p.label).toBe("2026-Q3");
    expect([p.from, p.to]).toEqual([new Date("2026-06-30T00:00:00Z"), new Date("2026-10-01T00:00:00Z")]);
    expect([p.priceFrom, p.priceTo]).toEqual([new Date("2026-07-01T00:00:00Z"), new Date("2026-10-01T00:00:00Z")]);
  });

  test("windowRelation flags gaps and overlaps", () => {
    const jul1 = new Date("2026-07-01T00:00:00Z");
    expect(windowRelation("2026-07-01", jul1)).toBe("contiguous");
    expect(windowRelation("2026-06-30", jul1)).toBe("gap");
    expect(windowRelation("2026-07-02", jul1)).toBe("overlap");
  });
});

test("cdnCheckoutProblem", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cdn-check-"));
  const git = (dir: string, ...args: string[]) =>
    expect(Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args]).exitCode).toBe(0);
  const commit = (dir: string, file: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), file);
    git(dir, "add", ".");
    git(dir, "commit", "-qm", file);
  };
  const [origin, clone] = [path.join(root, "origin"), path.join(root, "clone")];
  try {
    fs.mkdirSync(origin);
    git(origin, "init", "-q", "-b", "main");
    commit(origin, "src/points/testnet-rewards/current.json");
    git(root, "clone", "-q", origin, clone);
    expect(cdnCheckoutProblem(clone)).toBeNull();
    expect(cdnCheckoutProblem(root)).toContain("not a git checkout");

    git(clone, "switch", "-qc", "feature");
    expect(cdnCheckoutProblem(clone)).toContain('on branch "feature", not main');
    git(clone, "switch", "-q", "main");

    commit(origin, "other.txt");
    expect(cdnCheckoutProblem(clone)).toContain("1 commit(s) behind origin/main");
    git(clone, "pull", "-q", "--ff-only");

    git(clone, "rm", "-rq", "src");
    git(clone, "commit", "-qm", "rm");
    expect(cdnCheckoutProblem(clone)).toContain("no src/points/testnet-rewards/");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
