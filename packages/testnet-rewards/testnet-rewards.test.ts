import { describe, expect, test } from "bun:test";
import { normalize, parseDecimal, previousQuarter, quarterBounds, twap } from "./testnet-rewards";

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
