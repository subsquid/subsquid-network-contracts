import { expect } from "chai";
import Decimal from "decimal.js";
import { Worker } from "../src/worker";

const PEER = "12D3KooWMrm388Snq84RnYA9k7m2eFhYdQ4goaSAXWwXZWSBy8bu";
const SQD = (n: number) => new Decimal(n).mul(new Decimal(10).pow(18));
const BOND = SQD(100_000); // the mainnet worker bond

function workerWith(fields: Partial<Record<"trafficWeight" | "stake" | "bond" | "totalStake" | "dTraffic" | "livenessCoefficient" | "dTenure", Decimal>>) {
  const w = new Worker(PEER);
  Object.assign(w, fields);
  return w;
}

describe("Worker.calculateDTenure", () => {
  const tenure = async (livenessPerEpoch: number[]) => {
    const w = new Worker(PEER);
    await w.calculateDTenure(livenessPerEpoch);
    return w.dTenure.toNumber();
  };

  it("floors at 0.5 for a worker with no qualifying history", async () => {
    expect(await tenure([])).to.equal(0.5);
    expect(await tenure([0.1, 0.5, 0.89])).to.equal(0.5);
  });

  it("steps up 0.1 for every two epochs at or above 0.9 liveness", async () => {
    expect(await tenure([1])).to.equal(0.5);
    expect(await tenure([1, 1])).to.be.closeTo(0.6, 1e-12);
    expect(await tenure([1, 1, 1])).to.be.closeTo(0.6, 1e-12);
    expect(await tenure([1, 1, 1, 1])).to.be.closeTo(0.7, 1e-12);
  });

  it("counts exactly 0.9 as a live epoch", async () => {
    expect(await tenure([0.9, 0.9])).to.be.closeTo(0.6, 1e-12);
    expect(await tenure([0.8999, 0.8999])).to.equal(0.5);
  });

  it("saturates at 1.0 over the full tenure window", async () => {
    expect(await tenure(new Array(10).fill(1))).to.be.closeTo(1, 1e-12);
    expect(await tenure(new Array(11).fill(1))).to.be.closeTo(1, 1e-12);
  });

  it("INVARIANT: never zero, so tenure alone cannot void a payout", async () => {
    for (const history of [[], [0], new Array(10).fill(0)]) {
      expect(await tenure(history)).to.be.greaterThan(0);
    }
  });
});

describe("Worker.calculateDTraffic", () => {
  // A typical mainnet shape: ~1900 workers each bonded at 100k SQD.
  const TOTAL_SUPPLY = BOND.mul(1900);

  const dTraffic = async (trafficWeight: Decimal, stake = new Decimal(0)) => {
    const w = workerWith({ trafficWeight, stake, bond: BOND });
    await w.calculateDTraffic(TOTAL_SUPPLY);
    return w.dTraffic;
  };

  it("is zero only when traffic weight is zero", async () => {
    expect((await dTraffic(new Decimal(0))).isZero()).to.equal(true);
    expect((await dTraffic(new Decimal("1e-5"))).isZero()).to.equal(false);
  });

  it("caps at 1 for a worker carrying more traffic than its stake share", async () => {
    expect((await dTraffic(new Decimal("0.5"))).toNumber()).to.equal(1);
  });

  it("increases monotonically with traffic", async () => {
    const a = await dTraffic(new Decimal("1e-5"));
    const b = await dTraffic(new Decimal("5e-5"));
    const c = await dTraffic(new Decimal("2e-4"));
    expect(b.gt(a)).to.equal(true);
    expect(c.gt(b)).to.equal(true);
  });

  it("compresses hard: 10x the traffic is only ~1.26x the multiplier", async () => {
    // alpha = 0.1, so 10^0.1 ~= 1.2589. This is why dTraffic can never itself
    // become small enough to underflow, and why the reward spread across
    // workers is narrow.
    const a = await dTraffic(new Decimal("1e-5"));
    const b = await dTraffic(new Decimal("1e-4"));
    expect(b.div(a).toNumber()).to.be.closeTo(Math.pow(10, 0.1), 1e-6);
  });

  it("stays well clear of zero even for an implausibly tiny traffic weight", async () => {
    const d = await dTraffic(new Decimal("1e-12"));
    expect(d.isZero()).to.equal(false);
    expect(d.toNumber()).to.be.greaterThan(0.05);
  });
});

describe("Worker.getRewards", () => {
  const rMax = new Decimal("1.8e-4"); // ~20% APR over an 8h accounting window

  const rewardsFor = async (over: Parameters<typeof workerWith>[0]) => {
    const w = workerWith({
      livenessCoefficient: new Decimal(1),
      dTraffic: new Decimal(1),
      dTenure: new Decimal(1),
      bond: BOND,
      stake: new Decimal(0),
      ...over,
    });
    await w.getRewards(rMax);
    return w;
  };

  it("applies yield to bond plus half the delegated stake", async () => {
    const stake = SQD(50_000);
    const w = await rewardsFor({ stake });
    const expected = rMax.mul(BOND.add(stake.div(2)));
    expect(w.workerReward.toFixed()).to.equal(expected.toFixed());
  });

  it("gives delegators half the yield on their stake", async () => {
    const stake = SQD(50_000);
    const w = await rewardsFor({ stake });
    expect(w.stakerReward.toFixed()).to.equal(rMax.mul(stake).div(2).toFixed());
  });

  it("pays no staker reward when nothing is delegated", async () => {
    const w = await rewardsFor({ stake: new Decimal(0) });
    expect(w.stakerReward.isZero()).to.equal(true);
    expect(w.workerReward.isZero()).to.equal(false);
  });

  it("zeroes the payout when liveness is zero", async () => {
    const w = await rewardsFor({ livenessCoefficient: new Decimal(0) });
    expect(w.workerReward.isZero()).to.equal(true);
  });

  it("zeroes the payout when traffic is zero", async () => {
    // The multiplicative structure means any single zeroed factor voids the
    // whole reward — which is what made the traffic-weight underflow so costly.
    const w = await rewardsFor({ dTraffic: new Decimal(0) });
    expect(w.workerReward.isZero()).to.equal(true);
  });

  it("REGRESSION: a low-traffic worker with perfect uptime is still paid", async () => {
    const w = workerWith({ bond: BOND, stake: new Decimal(0), livenessCoefficient: new Decimal(1) });
    w.bytesSent = 545_663_720;
    w.chunksRead = 227;
    await w.calculateT(2.392e13, 1.865e7);
    await w.calculateDTraffic(BOND.mul(1900));
    await w.calculateDTenure(new Array(10).fill(1));
    await w.getRewards(rMax);
    expect(w.workerReward.isZero(), "perfect-uptime worker was paid nothing").to.equal(false);
  });
});

describe("Worker.stakeWeight and Worker.apr", () => {
  it("returns zero stake weight when the network has no stake", () => {
    const w = workerWith({ stake: new Decimal(0) });
    expect(w.stakeWeight(new Decimal(0)).toNumber()).to.equal(0);
  });

  it("returns the worker's share of total stake", () => {
    const w = workerWith({ stake: SQD(25_000) });
    expect(w.stakeWeight(SQD(100_000)).toNumber()).to.equal(0.25);
  });

  it("reports zero delegator APR rather than dividing by zero", async () => {
    const w = workerWith({
      bond: BOND,
      stake: new Decimal(0),
      totalStake: new Decimal(0),
      livenessCoefficient: new Decimal(1),
      dTraffic: new Decimal(1),
      dTenure: new Decimal(1),
    });
    await w.getRewards(new Decimal("1.8e-4"));
    const { delegator_apr, worker_apr } = w.apr(8 * 3600, 365 * 24 * 3600);
    expect(delegator_apr).to.equal("0");
    expect(Number(worker_apr)).to.be.greaterThan(0);
  });
});
