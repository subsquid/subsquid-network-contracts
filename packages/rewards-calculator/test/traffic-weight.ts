import { expect } from "chai";
import Decimal from "decimal.js";
import { Worker } from "../src/worker";

/**
 * Traffic weight is the geometric mean of a worker's two normalized traffic
 * shares:
 *
 *     t = sqrt( (bytes/totalBytes) * (chunks/totalChunks) )
 *
 * Both shares are ~1e-5 for a typical worker on a ~2000-worker network, so the
 * INTERMEDIATE PRODUCT sits around 1e-9..1e-10 even though the geometric mean
 * itself is a perfectly healthy ~1e-5.
 *
 * That intermediate value is the whole reason these tests exist. `Decimal`'s
 * `minE` option is an underflow clamp: any result whose exponent falls below it
 * is flushed to exactly zero. With `minE: -9` the product underflowed before
 * `sqrt` could bring it back into range, so `trafficWeight` became 0, `dTraffic`
 * became 0^0.1 = 0, and the worker's entire reward was zeroed — regardless of
 * having perfect uptime and real, served traffic.
 *
 * The figures below are the real production values that exposed it: worker 115
 * (12D3KooWMrm3...y8bu) over its 2026-08-28 00:35–08:37 UTC accounting window,
 * which paid out exactly 0 wei on-chain.
 */

// Observed on mainnet for the window that wrongly paid zero.
const ZEROED_WINDOW = {
  bytesSent: 545_663_720,
  chunksRead: 227,
  totalBytesSent: 2.392e13,
  totalChunksRead: 1.865e7,
};

// The same worker one window earlier, which paid ~10.3 SQD normally.
const PAID_WINDOW = {
  bytesSent: 1_835_394_394,
  chunksRead: 1220,
  totalBytesSent: 3.082e13,
  totalChunksRead: 1.994e7,
};

async function trafficWeightFor(w: typeof ZEROED_WINDOW) {
  const worker = new Worker("12D3KooWMrm388Snq84RnYA9k7m2eFhYdQ4goaSAXWwXZWSBy8bu");
  worker.bytesSent = w.bytesSent;
  worker.chunksRead = w.chunksRead;
  await worker.calculateT(w.totalBytesSent, w.totalChunksRead);
  return worker.trafficWeight;
}

describe("Worker.calculateT (traffic weight)", () => {
  it("REGRESSION: a low-traffic worker still gets a non-zero traffic weight", async () => {
    // Before the minE fix this was exactly 0 and cost the worker a full payout.
    const t = await trafficWeightFor(ZEROED_WINDOW);
    expect(t.isZero(), "traffic weight underflowed to zero").to.equal(false);
    expect(t.toNumber()).to.be.closeTo(1.666e-5, 1e-7);
  });

  it("REGRESSION: the intermediate product survives even though it is ~1e-10", async () => {
    // Guards the specific mechanism, not just the symptom: the product of the
    // two shares must not be flushed to zero before sqrt runs.
    const nb = new Decimal(ZEROED_WINDOW.bytesSent).div(ZEROED_WINDOW.totalBytesSent);
    const nc = new Decimal(ZEROED_WINDOW.chunksRead).div(ZEROED_WINDOW.totalChunksRead);
    const product = nb.mul(nc);
    expect(product.toNumber()).to.be.lessThan(1e-9); // genuinely below the old clamp
    expect(product.isZero(), "intermediate product underflowed").to.equal(false);
  });

  it("is the geometric mean of the two normalized shares", async () => {
    const t = await trafficWeightFor(PAID_WINDOW);
    const expected = Math.sqrt(
      (PAID_WINDOW.bytesSent / PAID_WINDOW.totalBytesSent) *
        (PAID_WINDOW.chunksRead / PAID_WINDOW.totalChunksRead),
    );
    expect(t.toNumber()).to.be.closeTo(expected, expected * 1e-6);
  });

  it("ranks a busier worker above a quieter one", async () => {
    const quiet = await trafficWeightFor(ZEROED_WINDOW);
    const busy = await trafficWeightFor(PAID_WINDOW);
    expect(busy.gt(quiet)).to.equal(true);
  });

  it("is zero only when the worker genuinely served nothing", async () => {
    const worker = new Worker("12D3KooWnothing");
    worker.bytesSent = 0;
    worker.chunksRead = 0;
    await worker.calculateT(1e13, 1e7);
    expect(worker.trafficWeight.isZero()).to.equal(true);
  });

  it("is zero when a worker served bytes but read no chunks", async () => {
    // Documents the geometric-mean semantics: either factor at zero zeroes it.
    const worker = new Worker("12D3KooWnochunks");
    worker.bytesSent = 1_000_000;
    worker.chunksRead = 0;
    await worker.calculateT(1e13, 1e7);
    expect(worker.trafficWeight.isZero()).to.equal(true);
  });

  it("scales far below the old clamp without collapsing", async () => {
    // A worker 100x smaller than the one that triggered the bug: the product is
    // ~1e-14, which any underflow clamp above that would silently zero.
    const worker = new Worker("12D3KooWtiny");
    worker.bytesSent = 5_456_637;
    worker.chunksRead = 2;
    await worker.calculateT(2.392e13, 1.865e7);
    expect(worker.trafficWeight.isZero()).to.equal(false);
    expect(worker.trafficWeight.toNumber()).to.be.greaterThan(0);
  });
});

describe("Decimal global configuration", () => {
  it("has no underflow clamp that could zero a traffic product", () => {
    // src/worker.ts configures Decimal globally at import time. `minE` must stay
    // at (or near) the library default; anything around -9 reintroduces the bug
    // for every worker below ~1/31,600 of network traffic.
    expect(new Decimal("1e-12").isZero(), "1e-12 was flushed to zero").to.equal(false);
    expect(new Decimal("1e-30").isZero(), "1e-30 was flushed to zero").to.equal(false);
  });
});
