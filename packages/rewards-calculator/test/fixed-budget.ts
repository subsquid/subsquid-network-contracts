import Decimal from 'decimal.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClickhouseClient } from '../src/clickhouseClient';
import { config } from '../src/config';
import {
  budgetFactor,
  type FixedBudgetRule,
  fixedBudgetRule,
  isFixedBudgetActive,
} from '../src/fixedBudget';
import { Worker } from '../src/worker';
import { Workers } from '../src/workers';

const SQD = (n: number) => new Decimal(n).mul(new Decimal(10).pow(18));
const M = (n: number) => SQD(n * 1e6);
const BOND = SQD(100_000);
const YEAR = 365 * 24 * 60 * 60;
const WINDOW = 8 * 3600;

const RULE: FixedBudgetRule = {
  fromBlock: 1_000,
  budgetPerYear: M(3).mul(12),
  operatorApr: new Decimal('0.20'),
  delegatorApr: new Decimal('0.05'),
};

function perfectWorker(peerId: string, stake: Decimal) {
  const w = new Worker(peerId);
  Object.assign(w, {
    bond: BOND,
    stake,
    totalStake: stake,
    livenessCoefficient: new Decimal(1),
    dTraffic: new Decimal(1),
    dTenure: new Decimal(1),
  });
  return w;
}

/** A window of `count` bonded workers that share `delegated` unevenly. */
async function windowOf(count: number, delegated: Decimal, rule = RULE) {
  const from = '2026-11-01T00:00:00Z';
  const to = new Date(Date.parse(from) + WINDOW * 1000).toISOString();
  const workers = new Workers({ from, to } as unknown as ClickhouseClient);

  // Weights 1..count, so delegation per worker is far from uniform.
  const weightSum = (count * (count + 1)) / 2;
  for (let i = 1; i <= count; i++) {
    const stake = delegated.mul(i).div(weightSum);
    Object.assign(workers.add(`peer-${i}`), perfectWorker(`peer-${i}`, stake));
  }

  workers.selectRule(rule.fromBlock, rule);
  await workers.calculateRewards();
  return workers;
}

function totalPaid(workers: Workers) {
  return workers
    .map((w) => w.workerReward.add(w.stakerReward))
    .reduce((a, b) => a.add(b), new Decimal(0));
}

function aprs(w: Worker) {
  const perYear = new Decimal(YEAR).div(WINDOW);
  return {
    operator: w.workerReward.div(w.bond).mul(perYear).toNumber(),
    delegator: w.stakerReward.div(w.stake).mul(perYear).toNumber(),
  };
}

describe('fixed budget: activation', () => {
  it('starts at the activation block, not before', () => {
    expect(isFixedBudgetActive(RULE, 999)).to.equal(false);
    expect(isFixedBudgetActive(RULE, 1_000)).to.equal(true);
    expect(isFixedBudgetActive(RULE, 1_001)).to.equal(true);
  });

  it('is off when FIXED_BUDGET_FROM_BLOCK is unset', () => {
    const rule = fixedBudgetRule();
    expect(rule.fromBlock).to.equal(Infinity);
    expect(isFixedBudgetActive(rule, 1e12)).to.equal(false);
  });

  it('reads the default budget and targets', () => {
    const rule = fixedBudgetRule();
    expect(rule.budgetPerYear.toFixed()).to.equal(M(36).toFixed());
    expect(rule.operatorApr.toNumber()).to.equal(0.2);
    expect(rule.delegatorApr.toNumber()).to.equal(0.05);
  });

  describe('invalid config', () => {
    const saved = { ...config.fixedBudget };
    afterEach(() => Object.assign(config.fixedBudget, saved));

    it('rejects a non-numeric activation block', () => {
      config.fixedBudget.fromBlock = Number('soon');
      expect(() => fixedBudgetRule()).to.throw(/FIXED_BUDGET_FROM_BLOCK/);
    });

    it('rejects a zero target', () => {
      config.fixedBudget.delegatorApr = '0';
      expect(() => fixedBudgetRule()).to.throw(/delegatorApr/);
    });

    it('rejects a non-numeric budget', () => {
      config.fixedBudget.budgetSqdPerMonth = '3M';
      expect(() => fixedBudgetRule()).to.throw();
    });
  });
});

describe('fixed budget: budgetFactor', () => {
  it('pays the full targets while they cost less than the budget', () => {
    // Mainnet now: 0.2 * 122M + 0.05 * 78M = 28.3M a year, under 36M.
    expect(budgetFactor(RULE, M(122), M(78)).toNumber()).to.equal(1);
  });

  it('starts to scale at 320M delegated on 100M of bonds', () => {
    // 0.2 * 100M + 0.05 * 320M = 36M, exactly the yearly budget.
    expect(budgetFactor(RULE, M(100), M(320)).toNumber()).to.equal(1);
    expect(budgetFactor(RULE, M(100), M(321)).toNumber()).to.be.lessThan(1);
  });

  it('scales both targets so that the cost equals the budget', () => {
    // Custom preset: 0.2 * 150M + 0.05 * 500M = 55M a year.
    const f = budgetFactor(RULE, M(150), M(500));
    expect(f.toNumber()).to.be.closeTo(36 / 55, 1e-15);
  });

  it('is 1 for an empty network', () => {
    expect(budgetFactor(RULE, M(0), M(0)).toNumber()).to.equal(1);
  });
});

describe('fixed budget: Worker.getFixedBudgetRewards', () => {
  const rate = (apr: string) => new Decimal(apr).mul(WINDOW).div(YEAR);

  it('pays the operator on the bond only and delegators on all their stake', () => {
    const stake = SQD(3_000_000);
    const w = perfectWorker('p', stake);
    w.getFixedBudgetRewards(rate('0.2'), rate('0.05'));

    expect(w.workerReward.toFixed()).to.equal(rate('0.2').mul(BOND).toFixed());
    expect(w.stakerReward.toFixed()).to.equal(
      rate('0.05').mul(stake).toFixed(),
    );
  });

  it('does not move delegator reward to the operator', () => {
    const small = perfectWorker('a', SQD(10_000));
    const large = perfectWorker('b', SQD(3_000_000));
    small.getFixedBudgetRewards(rate('0.2'), rate('0.05'));
    large.getFixedBudgetRewards(rate('0.2'), rate('0.05'));

    expect(large.workerReward.toFixed()).to.equal(small.workerReward.toFixed());
  });

  it('applies the same quality factor to the operator and its delegators', () => {
    const w = perfectWorker('p', SQD(50_000));
    Object.assign(w, {
      livenessCoefficient: new Decimal('0.9'),
      dTraffic: new Decimal('0.8'),
      dTenure: new Decimal('0.5'),
    });
    w.getFixedBudgetRewards(rate('0.2'), rate('0.05'));

    const { operator, delegator } = aprs(w);
    expect(operator).to.be.closeTo(0.2 * 0.36, 1e-12);
    expect(delegator).to.be.closeTo(0.05 * 0.36, 1e-12);
  });

  it('pays nothing when liveness is zero', () => {
    const w = perfectWorker('p', SQD(50_000));
    w.livenessCoefficient = new Decimal(0);
    w.getFixedBudgetRewards(rate('0.2'), rate('0.05'));

    expect(w.workerReward.isZero()).to.equal(true);
    expect(w.stakerReward.isZero()).to.equal(true);
  });
});

describe('fixed budget: traffic factor', () => {
  const TOTAL_BOND = BOND.mul(1000);

  it('compares traffic with the bond only, so delegation is not a penalty', async () => {
    const plain = perfectWorker('a', SQD(0));
    const delegated = perfectWorker('b', SQD(5_000_000));
    for (const w of [plain, delegated]) {
      w.trafficWeight = new Decimal('1e-4');
      await w.calculateDTraffic(TOTAL_BOND, w.bond);
    }

    expect(delegated.dTraffic.toFixed()).to.equal(plain.dTraffic.toFixed());
  });

  it('keeps the soft-cap rule unchanged when no own supply is given', async () => {
    const w = perfectWorker('a', SQD(100_000));
    w.trafficWeight = new Decimal('1e-4');
    await w.calculateDTraffic(TOTAL_BOND);

    const expected = new Decimal('1e-4')
      .div(BOND.mul(2).div(TOTAL_BOND))
      .pow(config.dTrafficAlpha);
    expect(w.dTraffic.toFixed()).to.equal(expected.toFixed());
  });
});

describe('fixed budget: Workers.calculateRewards', () => {
  const scenarios = [
    { name: 'mainnet now', workers: 1220, delegated: M(78) },
    { name: 'target', workers: 1000, delegated: M(300) },
    { name: 'custom', workers: 1500, delegated: M(500) },
    { name: 'no delegation', workers: 50, delegated: M(0) },
  ];

  for (const s of scenarios) {
    it(`INVARIANT (${s.name}): the window never pays more than its budget`, async () => {
      const workers = await windowOf(s.workers, s.delegated);
      const windowBudget = RULE.budgetPerYear.mul(WINDOW).div(YEAR);

      expect(totalPaid(workers).lte(windowBudget.add(1))).to.equal(true);
    });
  }

  it('pays the full targets when the budget is enough', async () => {
    const workers = await windowOf(1220, M(78));

    expect(workers.budgetFactor.toNumber()).to.equal(1);
    for (const w of workers.map((w) => w)) {
      const { operator, delegator } = aprs(w);
      expect(operator).to.be.closeTo(0.2, 1e-12);
      expect(delegator).to.be.closeTo(0.05, 1e-12);
    }
  });

  it('spends exactly the budget and keeps the 4x ratio when the budget is short', async () => {
    const workers = await windowOf(1500, M(500));
    const windowBudget = RULE.budgetPerYear.mul(WINDOW).div(YEAR);

    expect(totalPaid(workers).div(windowBudget).toNumber()).to.be.closeTo(
      1,
      1e-12,
    );
    for (const w of workers.map((w) => w)) {
      const { operator, delegator } = aprs(w);
      expect(operator).to.be.closeTo((0.2 * 36) / 55, 1e-12);
      expect(operator / delegator).to.be.closeTo(4, 1e-9);
    }
  });

  it('keeps what a penalty removes in the treasury', async () => {
    const full = totalPaid(await windowOf(1500, M(500)));

    const from = '2026-11-01T00:00:00Z';
    const to = new Date(Date.parse(from) + WINDOW * 1000).toISOString();
    const workers = new Workers({ from, to } as unknown as ClickhouseClient);
    for (let i = 0; i < 1500; i++) {
      const w = workers.add(`peer-${i}`);
      Object.assign(w, perfectWorker(`peer-${i}`, M(500).div(1500)));
    }
    workers.forEach((w, i) => {
      if (i % 2) w.livenessCoefficient = new Decimal(0);
    });
    workers.selectRule(RULE.fromBlock, RULE);
    await workers.calculateRewards();

    expect(totalPaid(workers).div(full).toNumber()).to.be.closeTo(0.5, 1e-12);
  });

  it('reports the rule and the scaled operator APR', async () => {
    const workers = await windowOf(1500, M(500));

    expect(workers.rewardRule).to.equal('fixed_budget');
    expect(workers.baseApr.toNumber()).to.be.closeTo((2000 * 36) / 55, 1e-9);
  });

  it('keeps the soft-cap rule before the activation block', () => {
    const workers = new Workers({} as ClickhouseClient);
    workers.selectRule(RULE.fromBlock - 1, RULE);

    expect(workers.rewardRule).to.equal('soft_cap');
  });
});
