import { describe, expect, it } from 'vitest';
import type { NetworkStatsEntry } from '../src/clickhouseClient';
import { historicalLiveness, livenessFactor } from '../src/clickhouseClient';
import { Worker } from '../src/worker';

const PEER = '12D3KooWMrm388Snq84RnYA9k7m2eFhYdQ4goaSAXWwXZWSBy8bu';

async function coefficientFor(stats: NetworkStatsEntry | undefined) {
  const worker = new Worker(PEER);
  await worker.calculateLiveness(stats as NetworkStatsEntry);
  return worker.livenessCoefficient;
}

const statsWith = (livenessFactor: number): NetworkStatsEntry => ({
  totalPings: 0,
  totalTimeOffline: 0,
  livenessFactor,
});

describe('Worker.calculateLiveness', () => {
  it('pays nothing below the 0.8 threshold', async () => {
    for (const lf of [0, 0.5, 0.79, 0.799999]) {
      expect(
        (await coefficientFor(statsWith(lf))).toNumber(),
        `lf=${lf}`,
      ).to.equal(0);
    }
  });

  it('ramps steeply across 0.8..0.9', async () => {
    expect((await coefficientFor(statsWith(0.8))).toNumber()).to.equal(0);
    expect((await coefficientFor(statsWith(0.85))).toNumber()).to.be.closeTo(
      0.45,
      1e-9,
    );
    expect((await coefficientFor(statsWith(0.89))).toNumber()).to.be.closeTo(
      0.81,
      1e-9,
    );
  });

  it('ramps gently across 0.9..0.95', async () => {
    expect((await coefficientFor(statsWith(0.9))).toNumber()).to.be.closeTo(
      0.9,
      1e-9,
    );
    expect((await coefficientFor(statsWith(0.94))).toNumber()).to.be.closeTo(
      0.98,
      1e-9,
    );
  });

  it('saturates at 1 from 0.95 upwards', async () => {
    for (const lf of [0.95, 0.99, 1]) {
      expect(
        (await coefficientFor(statsWith(lf))).toNumber(),
        `lf=${lf}`,
      ).to.equal(1);
    }
  });

  it('is continuous at both interior breakpoints', async () => {
    // 9x-7.2 and 2x-0.9 must agree at 0.9; 2x-0.9 must reach exactly 1 at 0.95.
    const below = (await coefficientFor(statsWith(0.9 - 1e-9))).toNumber();
    const at = (await coefficientFor(statsWith(0.9))).toNumber();
    expect(below).to.be.closeTo(at, 1e-7);
    expect((await coefficientFor(statsWith(0.95))).toNumber()).to.equal(1);
  });

  it('yields zero when the worker has no ping data at all', async () => {
    // `calculateLiveness` returns early on undefined stats, leaving the
    // coefficient at its constructor default of 0. This is fail-closed: a
    // missing ping row is indistinguishable from a genuinely offline worker,
    // and silently costs the worker its entire payout.
    expect((await coefficientFor(undefined)).toNumber()).to.equal(0);
  });
});

/**
 * Ping-series helpers. `getPings` returns each worker's timestamps already
 * bracketed by the window bounds (the SQL does `arrayConcat([from], ..., [to])`),
 * so the stubs below reproduce that shape exactly.
 */
const WINDOW_START = Math.floor(Date.parse('2026-08-28T00:00:00Z') / 1000);
const WINDOW_SECONDS = 3600;
const WINDOW_END = WINDOW_START + WINDOW_SECONDS;

function pingSeries(
  intervalSeconds: number,
  skip: (t: number) => boolean = () => false,
) {
  const pings: number[] = [];
  for (
    let t = WINDOW_START + intervalSeconds;
    t < WINDOW_END;
    t += intervalSeconds
  ) {
    if (!skip(t)) pings.push(t);
  }
  return [WINDOW_START, ...pings, WINDOW_END];
}

/**
 * A full 10s ping series covering the window, interrupted by exactly one gap of
 * the requested length. Every other interval stays at 10s so the gap under test
 * is the only thing the accounting can charge for.
 */
function seriesWithSingleGap(gapSeconds: number) {
  const gapAt = WINDOW_START + 600;
  const pings: number[] = [];
  for (let t = WINDOW_START + 10; t <= gapAt; t += 10) pings.push(t);
  for (let t = gapAt + gapSeconds; t < WINDOW_END; t += 10) pings.push(t);
  return [WINDOW_START, ...pings, WINDOW_END];
}

function clientStub(timestamps: number[]) {
  return {
    from: new Date(WINDOW_START * 1000),
    to: new Date(WINDOW_END * 1000),
    getPings: async () => ({ [PEER]: timestamps }),
  } as any;
}

describe('livenessFactor (ping gap accounting)', () => {
  it('gives a full score to a worker pinging every 10s', async () => {
    const stats = await livenessFactor(clientStub(pingSeries(10)));
    expect(stats[PEER].livenessFactor).to.equal(1);
    expect(stats[PEER].totalTimeOffline).to.equal(0);
  });

  it('tolerates gaps up to the 65s threshold', async () => {
    // 55s cadence is under the threshold, so nothing is counted as downtime,
    // even though it is 5x slower than the documented 10s ping interval.
    const stats = await livenessFactor(clientStub(pingSeries(55)));
    expect(stats[PEER].totalTimeOffline).to.equal(0);
    expect(stats[PEER].livenessFactor).to.equal(1);
  });

  it('counts the WHOLE gap as downtime, not just the excess over 65s', async () => {
    // This is the harsh part of the accounting and the reason a worker that is
    // genuinely up can still be scored as offline: one 120s gap costs 120s of
    // downtime, not the 55s by which it exceeded the threshold.
    const stats = await livenessFactor(clientStub(seriesWithSingleGap(120)));
    expect(stats[PEER].totalTimeOffline).to.equal(120);
    expect(stats[PEER].livenessFactor).to.be.closeTo(
      1 - 120 / WINDOW_SECONDS,
      1e-12,
    );
  });

  it('treats a gap of exactly 65s as online and 66s as fully offline', async () => {
    const at65 = await livenessFactor(clientStub(seriesWithSingleGap(65)));
    expect(at65[PEER].totalTimeOffline, '65s should not count').to.equal(0);

    const at66 = await livenessFactor(clientStub(seriesWithSingleGap(66)));
    expect(at66[PEER].totalTimeOffline, '66s should count in full').to.equal(
      66,
    );
  });

  it('counts silence at the start and end of the window', async () => {
    // The window bounds bracket the series, so a worker that starts pinging late
    // or stops early is charged for the surrounding silence.
    const lateStart = [
      WINDOW_START,
      WINDOW_START + 600,
      WINDOW_END - 10,
      WINDOW_END,
    ];
    const stats = await livenessFactor(clientStub(lateStart));
    expect(stats[PEER].totalTimeOffline).to.equal(600 + (WINDOW_SECONDS - 610));
  });

  it('drops a worker below the 0.8 payout cliff after enough dropped pings', async () => {
    // ~55s cadence with every other ping missing => 110s gaps. Enough of them
    // and the worker is scored under 0.8 and earns nothing, while its own
    // dashboard still reports it as up the whole time.
    let n = 0;
    const flaky = pingSeries(55, () => n++ % 2 === 1);
    const stats = await livenessFactor(clientStub(flaky));
    expect(stats[PEER].livenessFactor).to.be.lessThan(0.8);

    const worker = new Worker(PEER);
    await worker.calculateLiveness(stats[PEER]);
    expect(worker.livenessCoefficient.toNumber()).to.equal(0);
  });
});

describe('historicalLiveness (tenure input)', () => {
  it('splits pings into one liveness score per epoch boundary', async () => {
    const epochSeconds = 1800;
    const boundaries = [
      new Date(WINDOW_START * 1000),
      new Date((WINDOW_START + epochSeconds) * 1000),
      new Date((WINDOW_START + 2 * epochSeconds) * 1000),
    ];
    const pings: number[] = [];
    for (let t = WINDOW_START; t <= WINDOW_START + 2 * epochSeconds; t += 10)
      pings.push(t);

    const perEpoch = await historicalLiveness(clientStub(pings), boundaries);
    expect(perEpoch[PEER]).to.have.length(2);
    for (const lf of perEpoch[PEER]) expect(lf).to.equal(1);
  });
});
