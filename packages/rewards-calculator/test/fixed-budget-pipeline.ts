import Decimal from 'decimal.js';
import { describe, expect, it, vi } from 'vitest';
import type { ClickhouseClient } from '../src/clickhouseClient';
import type { FixedBudgetRule } from '../src/fixedBudget';
import { Workers } from '../src/workers';

const SQD = (n: number) => 10n ** 18n * BigInt(n);
const BOND = new Decimal(SQD(100_000).toString());

// Two workers: the soft cap clips the second one's 2M delegation to 20K.
const CAPPED = [SQD(10_000), SQD(20_000)];
const DELEGATED = [SQD(10_000), SQD(2_000_000)];

vi.mock('../src/chain', async (importOriginal) => {
  const ok = (result: bigint) => ({ status: 'success', result });
  return {
    ...(await importOriginal<typeof import('../src/chain')>()),
    getStakes: vi.fn(async () => [CAPPED.map(ok), DELEGATED.map(ok)]),
  };
});

const RULE: FixedBudgetRule = {
  fromBlock: 1_000,
  budgetPerYear: new Decimal(SQD(36_000_000).toString()),
  operatorApr: new Decimal('0.20'),
  delegatorApr: new Decimal('0.05'),
};

async function twoWorkers(windowStartBlock: number) {
  const workers = new Workers({} as ClickhouseClient);
  // Normally set by fetchCurrentBond(); the soft-cap supply reads it.
  Object.assign(workers, { bond: BOND });
  workers.add('a');
  workers.add('b');
  workers.forEach((w) => {
    w.bond = BOND;
    w.trafficWeight = new Decimal('0.1');
  });
  // Every rule is set by the window start block before any chain read.
  workers.selectRule(windowStartBlock, RULE);
  await workers.getStakes();
  return workers;
}

describe('fixed budget: stake and traffic inputs', () => {
  it('pays delegators on the full delegation, not the capped stake', async () => {
    const workers = await twoWorkers(RULE.fromBlock);
    const stakes = workers.map((w) => w.stake.toFixed());

    expect(stakes).to.deep.equal(DELEGATED.map(String));
  });

  it('keeps the capped stake under the soft-cap rule', async () => {
    const workers = await twoWorkers(RULE.fromBlock - 1);
    const stakes = workers.map((w) => w.stake.toFixed());

    expect(stakes).to.deep.equal(CAPPED.map(String));
  });

  it('gives equal traffic factors to equal traffic, whatever the delegation', async () => {
    const workers = await twoWorkers(RULE.fromBlock);
    workers.getDTrraffic();

    const [a, b] = workers.map((w) => w.dTraffic.toFixed());
    expect(b).to.equal(a);
  });

  it('lowers the traffic factor of the large delegation under the soft-cap rule', async () => {
    const workers = await twoWorkers(RULE.fromBlock - 1);
    workers.getDTrraffic();

    const [a, b] = workers.map((w) => w.dTraffic);
    expect(b.lt(a)).to.equal(true);
  });
});

describe('fixed budget: epochStats', () => {
  it('selects the rule from the window start block before it reads stakes', async () => {
    const chain = await import('../src/chain');
    const { ClickhouseClient } = await import('../src/clickhouseClient');
    const { epochStats } = await import('../src/reward');

    vi.spyOn(chain, 'getBlockTimestamp').mockResolvedValue(new Date(0));
    vi.spyOn(ClickhouseClient.prototype, 'getActiveWorkers').mockImplementation(
      async function (this: ClickhouseClient) {
        const workers = new Workers(this);
        workers.add('a');
        return workers;
      },
    );

    const calls: string[] = [];
    const steps = [
      'selectRule',
      'getNextDistributionStartBlockNumber',
      'clearUnknownWorkers',
      'getStakes',
      'getT',
      'fetchCurrentBond',
      'getDTrraffic',
      'getLiveness',
      'getDTenure',
      'calculateRewards',
      'logStats',
    ] as const;
    const selectRule = vi.fn();
    for (const step of steps) {
      vi.spyOn(Workers.prototype, step).mockImplementation(((
        ...args: unknown[]
      ) => {
        calls.push(step);
        if (step === 'selectRule') selectRule(...args);
      }) as never);
    }

    await epochStats(1_234, 5_678);

    expect(selectRule).toHaveBeenCalledWith(1_234);
    expect(calls.indexOf('selectRule')).to.be.lessThan(
      calls.indexOf('getStakes'),
    );
    vi.restoreAllMocks();
  });
});
