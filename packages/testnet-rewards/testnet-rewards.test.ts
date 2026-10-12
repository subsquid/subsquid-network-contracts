import { describe, expect, test } from "bun:test";
import { twap } from "./testnet-rewards";

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
