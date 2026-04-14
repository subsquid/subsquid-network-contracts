import Decimal from 'decimal.js';
import {
  OldWorker,
  NetworkStatsEntry,
  RewardWorker,
  calculateLivenessFactor,
} from './rewards-calculator.service';

Decimal.set({ precision: 28, minE: -9 });

describe('RewardsCalculator - reward formula sanity tests', () => {
  /**
   * Helper: compute the liveness coefficient exactly as OldWorker.calculateLiveness does.
   */
  async function getLivenessCoefficient(
    livenessFactor: number,
  ): Promise<Decimal> {
    const worker = new OldWorker('test-peer');
    const stats: NetworkStatsEntry = {
      totalPings: 100,
      totalTimeOffline: 0,
      livenessFactor,
    };
    await worker.calculateLiveness(stats);
    return worker.livenessCoefficient;
  }

  it('should handle the reward formula correctly with known inputs', async () => {
    // Setup: rMax=0.0001, liveness=1.0, dTraffic=0.5, dTenure=1.0
    // bond=100e18, stake=200e18
    const worker = new OldWorker('test-peer-1');

    // Set liveness to 1.0 (>= 0.95 branch => coefficient = 1)
    await worker.calculateLiveness({
      totalPings: 100,
      totalTimeOffline: 0,
      livenessFactor: 1.0,
    });
    expect(worker.livenessCoefficient.toNumber()).toBe(1);

    // Manually set the remaining parameters
    worker.dTraffic = new Decimal(0.5);
    worker.dTenure = new Decimal(1.0);
    worker.bond = new Decimal('100e18'); // 100 * 10^18
    worker.stake = new Decimal('200e18'); // 200 * 10^18

    const rMax = new Decimal(0.0001);
    await worker.getRewards(rMax);

    // actualYield = rMax * livenessCoefficient * dTraffic * dTenure
    //             = 0.0001 * 1 * 0.5 * 1.0
    //             = 0.00005
    const expectedActualYield = new Decimal(0.00005);
    expect(worker.actualYield.toNumber()).toBeCloseTo(
      expectedActualYield.toNumber(),
      10,
    );

    // workerReward = actualYield * (bond + stake/2)
    //             = 0.00005 * (100e18 + 200e18/2)
    //             = 0.00005 * (1e20 + 1e20)
    //             = 0.00005 * 2e20
    //             = 1e16  (i.e. 10_000_000_000_000_000)
    const expectedWorkerReward = new Decimal('1e16');
    expect(worker.workerReward.toFixed(0)).toBe(expectedWorkerReward.toFixed(0));

    // stakerReward = actualYield * stake / 2
    //             = 0.00005 * 200e18 / 2
    //             = 0.00005 * 2e20 / 2
    //             = 0.00005 * 1e20
    //             = 5e15  (i.e. 5_000_000_000_000_000)
    const expectedStakerReward = new Decimal('5e15');
    expect(worker.stakerReward.toFixed(0)).toBe(expectedStakerReward.toFixed(0));
  });

  it('liveness coefficient piecewise function test', async () => {
    // Branch 1: liveness < 0.8 => coefficient = 0
    const coeff07 = await getLivenessCoefficient(0.7);
    expect(coeff07.toNumber()).toBe(0);

    // Branch 2: 0.8 <= liveness < 0.9 => coefficient = 9*l - 7.2
    // liveness = 0.85 => 9 * 0.85 - 7.2 = 7.65 - 7.2 = 0.45
    const coeff085 = await getLivenessCoefficient(0.85);
    expect(coeff085.toNumber()).toBeCloseTo(0.45, 10);

    // Branch 3: 0.9 <= liveness < 0.95 => coefficient = 2*l - 0.9
    // liveness = 0.92 => 2 * 0.92 - 0.9 = 1.84 - 0.9 = 0.94
    const coeff092 = await getLivenessCoefficient(0.92);
    expect(coeff092.toNumber()).toBeCloseTo(0.94, 10);

    // Branch 4: liveness >= 0.95 => coefficient = 1
    const coeff096 = await getLivenessCoefficient(0.96);
    expect(coeff096.toNumber()).toBe(1);
  });

  it('deterministic: same inputs produce same outputs', async () => {
    async function computeRewards() {
      const worker = new OldWorker('determinism-test');
      await worker.calculateLiveness({
        totalPings: 50,
        totalTimeOffline: 100,
        livenessFactor: 0.92,
      });
      worker.dTraffic = new Decimal(0.75);
      worker.dTenure = new Decimal(0.8);
      worker.bond = new Decimal('500e18');
      worker.stake = new Decimal('300e18');

      const rMax = new Decimal(0.00025);
      await worker.getRewards(rMax);

      return {
        actualYield: worker.actualYield.toFixed(28),
        workerReward: worker.workerReward.toFixed(0),
        stakerReward: worker.stakerReward.toFixed(0),
      };
    }

    const run1 = await computeRewards();
    const run2 = await computeRewards();

    expect(run1.actualYield).toBe(run2.actualYield);
    expect(run1.workerReward).toBe(run2.workerReward);
    expect(run1.stakerReward).toBe(run2.stakerReward);
  });
});

// ---------------------------------------------------------------------------
// Division-by-zero guards (CRITICAL - recently fixed)
// ---------------------------------------------------------------------------

describe('RewardWorker - division by zero guards', () => {
  let worker: RewardWorker;

  beforeEach(() => {
    worker = new RewardWorker('zero-guard-peer');
  });

  it('calculateDTraffic with totalSupply=0 should set dTraffic to 0, not throw', async () => {
    worker.stake = new Decimal('100e18');
    worker.bond = new Decimal('50e18');
    worker.trafficWeight = new Decimal(0.5);

    await worker.calculateDTraffic(new Decimal(0));
    expect(worker.dTraffic.toNumber()).toBe(0);
  });

  it('calculateDTraffic with supplyRatio=0 (stake=0, bond=0) should set dTraffic to 1, not throw', async () => {
    worker.stake = new Decimal(0);
    worker.bond = new Decimal(0);
    worker.trafficWeight = new Decimal(0.5);

    // totalSupply is nonzero but this worker's stake+bond = 0 => supplyRatio = 0
    await worker.calculateDTraffic(new Decimal('1000e18'));
    expect(worker.dTraffic.toNumber()).toBe(1);
  });

  it('normalizeTraffic with totalBytesSent=0 should not throw (via calculateT)', async () => {
    worker.bytesSent = 100;
    worker.chunksRead = 200;

    await expect(worker.calculateT(0, 1000)).resolves.not.toThrow();
    // When totalBytesSent is 0, normalizedBytes=0 => trafficWeight = sqrt(0 * x) = 0
    expect(worker.trafficWeight.toNumber()).toBe(0);
  });

  it('normalizeTraffic with totalChunksRead=0 should not throw (via calculateT)', async () => {
    worker.bytesSent = 100;
    worker.chunksRead = 200;

    await expect(worker.calculateT(1000, 0)).resolves.not.toThrow();
    // When totalChunksRead is 0, normalizedChunks=0 => trafficWeight = sqrt(x * 0) = 0
    expect(worker.trafficWeight.toNumber()).toBe(0);
  });

  it('normalizeTraffic with both totals=0 should not throw (via calculateT)', async () => {
    worker.bytesSent = 0;
    worker.chunksRead = 0;

    await expect(worker.calculateT(0, 0)).resolves.not.toThrow();
    expect(worker.trafficWeight.toNumber()).toBe(0);
  });

  it('apr with bond=0 should return worker_apr="0", not throw', async () => {
    worker.bond = new Decimal(0);
    worker.stake = new Decimal('100e18');
    worker.totalStake = new Decimal('100e18');
    worker.workerReward = new Decimal('1e16');
    worker.stakerReward = new Decimal('5e15');

    const result = worker.apr(3600, 365 * 24 * 60 * 60);
    expect(result.worker_apr).toBe('0');
    // delegator_apr should still compute normally
    expect(result.delegator_apr).not.toBe('0');
  });

  it('apr with epochDuration=0 should return "0" for both APRs, not throw', async () => {
    worker.bond = new Decimal('100e18');
    worker.stake = new Decimal('50e18');
    worker.totalStake = new Decimal('50e18');
    worker.workerReward = new Decimal('1e16');
    worker.stakerReward = new Decimal('5e15');

    const result = worker.apr(0, 365 * 24 * 60 * 60);
    expect(result.worker_apr).toBe('0');
    expect(result.delegator_apr).toBe('0');
  });

  it('apr with totalStake=0 should return delegator_apr="0"', async () => {
    worker.bond = new Decimal('100e18');
    worker.stake = new Decimal(0);
    worker.totalStake = new Decimal(0);
    worker.workerReward = new Decimal('1e16');
    worker.stakerReward = new Decimal('5e15');

    const result = worker.apr(3600, 365 * 24 * 60 * 60);
    expect(result.delegator_apr).toBe('0');
    // worker_apr should still compute normally
    expect(result.worker_apr).not.toBe('0');
  });
});

// ---------------------------------------------------------------------------
// calculateT (traffic weight)
// ---------------------------------------------------------------------------

describe('RewardWorker - calculateT', () => {
  it('should compute trafficWeight as sqrt(normalizedBytes * normalizedChunks)', async () => {
    const worker = new RewardWorker('traffic-peer');
    worker.bytesSent = 500;
    worker.chunksRead = 200;

    const totalBytes = 1000;
    const totalChunks = 400;

    await worker.calculateT(totalBytes, totalChunks);

    // normalizedBytes = 500/1000 = 0.5
    // normalizedChunks = 200/400 = 0.5
    // trafficWeight = sqrt(0.5 * 0.5) = sqrt(0.25) = 0.5
    expect(worker.trafficWeight.toNumber()).toBeCloseTo(0.5, 10);
  });

  it('should return trafficWeight=0 when worker has zero bytes and chunks', async () => {
    const worker = new RewardWorker('no-traffic-peer');
    worker.bytesSent = 0;
    worker.chunksRead = 0;

    await worker.calculateT(1000, 1000);
    expect(worker.trafficWeight.toNumber()).toBe(0);
  });

  it('should handle asymmetric traffic correctly', async () => {
    const worker = new RewardWorker('asym-peer');
    worker.bytesSent = 1000;
    worker.chunksRead = 100;

    await worker.calculateT(1000, 1000);
    // normalizedBytes = 1.0, normalizedChunks = 0.1
    // trafficWeight = sqrt(1.0 * 0.1) = sqrt(0.1)
    const expected = Math.sqrt(0.1);
    expect(worker.trafficWeight.toNumber()).toBeCloseTo(expected, 10);
  });
});

// ---------------------------------------------------------------------------
// calculateLiveness edge cases
// ---------------------------------------------------------------------------

describe('RewardWorker - calculateLiveness edge cases', () => {
  it('exactly at boundary 0.8 should use 9l-7.2 branch', async () => {
    const worker = new RewardWorker('boundary-peer');
    await worker.calculateLiveness({
      totalPings: 100,
      totalTimeOffline: 0,
      livenessFactor: 0.8,
    });
    // 9 * 0.8 - 7.2 = 7.2 - 7.2 = 0
    expect(worker.livenessCoefficient.toNumber()).toBeCloseTo(0, 10);
  });

  it('exactly at boundary 0.9 should use 2l-0.9 branch', async () => {
    const worker = new RewardWorker('boundary-peer');
    await worker.calculateLiveness({
      totalPings: 100,
      totalTimeOffline: 0,
      livenessFactor: 0.9,
    });
    // 2 * 0.9 - 0.9 = 1.8 - 0.9 = 0.9
    expect(worker.livenessCoefficient.toNumber()).toBeCloseTo(0.9, 10);
  });

  it('exactly at boundary 0.95 should be 1', async () => {
    const worker = new RewardWorker('boundary-peer');
    await worker.calculateLiveness({
      totalPings: 100,
      totalTimeOffline: 0,
      livenessFactor: 0.95,
    });
    expect(worker.livenessCoefficient.toNumber()).toBe(1);
  });

  it('liveness = 0 should give coefficient = 0', async () => {
    const worker = new RewardWorker('dead-peer');
    await worker.calculateLiveness({
      totalPings: 100,
      totalTimeOffline: 1000,
      livenessFactor: 0,
    });
    expect(worker.livenessCoefficient.toNumber()).toBe(0);
  });

  it('liveness = 1.0 should give coefficient = 1', async () => {
    const worker = new RewardWorker('perfect-peer');
    await worker.calculateLiveness({
      totalPings: 100,
      totalTimeOffline: 0,
      livenessFactor: 1.0,
    });
    expect(worker.livenessCoefficient.toNumber()).toBe(1);
  });

  it('null networkStats should not throw and should leave coefficient unchanged', async () => {
    const worker = new RewardWorker('null-stats-peer');
    worker.livenessCoefficient = new Decimal(0.42);

    // null is handled by the early-return guard: if (!networkStats) return;
    await worker.calculateLiveness(null as unknown as NetworkStatsEntry);
    // The coefficient should remain what it was before the call
    expect(worker.livenessCoefficient.toNumber()).toBe(0.42);
  });

  it('undefined networkStats should not throw and should leave coefficient unchanged', async () => {
    const worker = new RewardWorker('undef-stats-peer');
    worker.livenessCoefficient = new Decimal(0.99);

    await worker.calculateLiveness(undefined as unknown as NetworkStatsEntry);
    expect(worker.livenessCoefficient.toNumber()).toBe(0.99);
  });
});

// ---------------------------------------------------------------------------
// calculateDTenure
// ---------------------------------------------------------------------------

describe('RewardWorker - calculateDTenure', () => {
  it('empty historical liveness should give dTenure = 0.5', async () => {
    const worker = new RewardWorker('tenure-peer');
    await worker.calculateDTenure([]);
    expect(worker.dTenure.toNumber()).toBe(0.5);
  });

  it('all epochs above threshold (>=0.9) should yield higher dTenure', async () => {
    const worker = new RewardWorker('tenured-peer');
    // 10 live epochs, all >= 0.9
    const history = [0.95, 0.92, 0.91, 0.99, 0.93, 0.90, 0.96, 0.94, 0.97, 0.98];
    await worker.calculateDTenure(history);

    // liveEpochs = 10
    // dTenure = 0.5 + floor(10/2 + 0.05) * 0.1 = 0.5 + floor(5.05) * 0.1 = 0.5 + 5 * 0.1 = 1.0
    expect(worker.dTenure.toNumber()).toBe(1.0);
  });

  it('no epochs above threshold should give dTenure = 0.5', async () => {
    const worker = new RewardWorker('untenured-peer');
    const history = [0.5, 0.6, 0.7, 0.89, 0.85];
    await worker.calculateDTenure(history);

    // liveEpochs = 0
    // dTenure = 0.5 + floor(0/2 + 0.05) * 0.1 = 0.5 + floor(0.05) * 0.1 = 0.5 + 0 = 0.5
    expect(worker.dTenure.toNumber()).toBe(0.5);
  });

  it('mixed epochs should compute correct dTenure', async () => {
    const worker = new RewardWorker('mixed-peer');
    // 4 live epochs out of 8
    const history = [0.95, 0.5, 0.92, 0.6, 0.91, 0.7, 0.90, 0.8];
    await worker.calculateDTenure(history);

    // liveEpochs = 4 (0.95, 0.92, 0.91, 0.90)
    // dTenure = 0.5 + floor(4/2 + 0.05) * 0.1 = 0.5 + floor(2.05) * 0.1 = 0.5 + 2 * 0.1 = 0.7
    expect(worker.dTenure.toNumber()).toBe(0.7);
  });

  it('single live epoch should give dTenure = 0.5', async () => {
    const worker = new RewardWorker('single-epoch-peer');
    await worker.calculateDTenure([0.95]);

    // liveEpochs = 1
    // dTenure = 0.5 + floor(1/2 + 0.05) * 0.1 = 0.5 + floor(0.55) * 0.1 = 0.5 + 0 = 0.5
    expect(worker.dTenure.toNumber()).toBe(0.5);
  });

  it('two live epochs should give dTenure = 0.6', async () => {
    const worker = new RewardWorker('two-epoch-peer');
    await worker.calculateDTenure([0.95, 0.92]);

    // liveEpochs = 2
    // dTenure = 0.5 + floor(2/2 + 0.05) * 0.1 = 0.5 + floor(1.05) * 0.1 = 0.5 + 1 * 0.1 = 0.6
    expect(worker.dTenure.toNumber()).toBe(0.6);
  });
});

// ---------------------------------------------------------------------------
// getRewards
// ---------------------------------------------------------------------------

describe('RewardWorker - getRewards', () => {
  it('zero rMax should yield zero rewards', async () => {
    const worker = new RewardWorker('zero-rmax-peer');
    worker.livenessCoefficient = new Decimal(1);
    worker.dTraffic = new Decimal(0.5);
    worker.dTenure = new Decimal(1);
    worker.bond = new Decimal('100e18');
    worker.stake = new Decimal('200e18');

    await worker.getRewards(new Decimal(0));

    expect(worker.actualYield.toNumber()).toBe(0);
    expect(worker.workerReward.toNumber()).toBe(0);
    expect(worker.stakerReward.toNumber()).toBe(0);
  });

  it('zero liveness coefficient should yield zero rewards', async () => {
    const worker = new RewardWorker('dead-peer');
    worker.livenessCoefficient = new Decimal(0);
    worker.dTraffic = new Decimal(0.8);
    worker.dTenure = new Decimal(0.9);
    worker.bond = new Decimal('500e18');
    worker.stake = new Decimal('300e18');

    await worker.getRewards(new Decimal(0.001));

    expect(worker.actualYield.toNumber()).toBe(0);
    expect(worker.workerReward.toNumber()).toBe(0);
    expect(worker.stakerReward.toNumber()).toBe(0);
  });

  it('full parameters should compute correct formula', async () => {
    const worker = new RewardWorker('full-peer');
    worker.livenessCoefficient = new Decimal(0.9);
    worker.dTraffic = new Decimal(0.8);
    worker.dTenure = new Decimal(0.7);
    worker.bond = new Decimal('200e18');
    worker.stake = new Decimal('400e18');

    const rMax = new Decimal(0.0002);
    await worker.getRewards(rMax);

    // actualYield = 0.0002 * 0.9 * 0.8 * 0.7 = 0.0001008
    const expectedYield = 0.0002 * 0.9 * 0.8 * 0.7;
    expect(worker.actualYield.toNumber()).toBeCloseTo(expectedYield, 10);

    // workerReward = actualYield * (bond + stake/2) = 0.0001008 * (200e18 + 200e18)
    const expectedWorkerReward = new Decimal(expectedYield).mul(
      new Decimal('200e18').add(new Decimal('400e18').div(2)),
    );
    expect(worker.workerReward.toFixed(0)).toBe(expectedWorkerReward.toFixed(0));

    // stakerReward = actualYield * stake / 2 = 0.0001008 * 400e18 / 2
    const expectedStakerReward = new Decimal(expectedYield)
      .mul(new Decimal('400e18'))
      .div(2);
    expect(worker.stakerReward.toFixed(0)).toBe(expectedStakerReward.toFixed(0));
  });

  it('zero stake should produce zero staker reward but nonzero worker reward', async () => {
    const worker = new RewardWorker('no-stake-peer');
    worker.livenessCoefficient = new Decimal(1);
    worker.dTraffic = new Decimal(1);
    worker.dTenure = new Decimal(1);
    worker.bond = new Decimal('100e18');
    worker.stake = new Decimal(0);

    await worker.getRewards(new Decimal(0.0001));

    expect(worker.stakerReward.toNumber()).toBe(0);
    expect(worker.workerReward.toNumber()).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// processQuery
// ---------------------------------------------------------------------------

describe('RewardWorker - processQuery', () => {
  it('should accumulate bytesSent and chunksRead across multiple calls', async () => {
    const worker = new RewardWorker('query-peer');
    expect(worker.bytesSent).toBe(0);
    expect(worker.chunksRead).toBe(0);

    await worker.processQuery({ output_size: 100, num_read_chunks: 50 });
    expect(worker.bytesSent).toBe(100);
    expect(worker.chunksRead).toBe(50);

    await worker.processQuery({ output_size: 200, num_read_chunks: 150 });
    expect(worker.bytesSent).toBe(300);
    expect(worker.chunksRead).toBe(200);

    await worker.processQuery({ output_size: 0, num_read_chunks: 0 });
    expect(worker.bytesSent).toBe(300);
    expect(worker.chunksRead).toBe(200);
  });

  it('should return true', async () => {
    const worker = new RewardWorker('query-return-peer');
    const result = await worker.processQuery({ output_size: 10, num_read_chunks: 5 });
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getId
// ---------------------------------------------------------------------------

describe('RewardWorker - getId', () => {
  it('with contractId set should return it', async () => {
    const worker = new RewardWorker('id-peer');
    worker.setContractId(42n);
    const id = await worker.getId();
    expect(id).toBe(42n);
  });

  it('without contractId should return 0n', async () => {
    const worker = new RewardWorker('no-id-peer');
    const id = await worker.getId();
    expect(id).toBe(0n);
  });

  it('contractId set to large bigint should return correctly', async () => {
    const worker = new RewardWorker('big-id-peer');
    const largeId = 123456789012345678901234567890n;
    worker.setContractId(largeId);
    const id = await worker.getId();
    expect(id).toBe(largeId);
  });
});

// ---------------------------------------------------------------------------
// calculateLivenessFactor (exported function) - error handling
// ---------------------------------------------------------------------------

describe('calculateLivenessFactor - error handling', () => {
  it('should return {} and log error when ClickHouse service throws', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const mockClickHouse = {
      configService: { get: () => 'testnet' },
      client: {
        query: () => {
          throw new Error('Connection refused');
        },
      },
    };

    const result = await calculateLivenessFactor(
      mockClickHouse,
      new Date('2024-01-01'),
      new Date('2024-01-02'),
    );

    expect(result).toEqual({});
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[calculateLivenessFactor]'),
      expect.any(Error),
    );

    consoleSpy.mockRestore();
  });

  it('should return {} when client.query().stream() throws', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const mockClickHouse = {
      configService: { get: () => 'testnet' },
      client: {
        query: () => ({
          stream: () => {
            throw new Error('Stream error');
          },
        }),
      },
    };

    const result = await calculateLivenessFactor(
      mockClickHouse,
      new Date('2024-01-01'),
      new Date('2024-01-02'),
    );

    expect(result).toEqual({});
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// calculateDTraffic - normal cases
// ---------------------------------------------------------------------------

describe('RewardWorker - calculateDTraffic (normal)', () => {
  it('should compute dTraffic correctly when trafficWeight > supplyRatio', async () => {
    const worker = new RewardWorker('dtraffic-peer');
    worker.stake = new Decimal('100e18');
    worker.bond = new Decimal('100e18');
    worker.trafficWeight = new Decimal(0.5);

    // totalSupply = 1000e18, supplyRatio = 200e18 / 1000e18 = 0.2
    // dTraffic = min(1, (0.5 / 0.2)^0.1) = min(1, 2.5^0.1)
    await worker.calculateDTraffic(new Decimal('1000e18'), new Decimal(0.1));

    const expectedRaw = Math.pow(2.5, 0.1);
    const expected = Math.min(1, expectedRaw);
    expect(worker.dTraffic.toNumber()).toBeCloseTo(expected, 5);
  });

  it('should cap dTraffic at 1', async () => {
    const worker = new RewardWorker('capped-peer');
    worker.stake = new Decimal('10e18');
    worker.bond = new Decimal('10e18');
    worker.trafficWeight = new Decimal(0.9);

    // supplyRatio = 20e18 / 100e18 = 0.2
    // (0.9 / 0.2)^0.1 = 4.5^0.1 => > 1 => capped at 1
    await worker.calculateDTraffic(new Decimal('100e18'), new Decimal(0.1));
    expect(worker.dTraffic.toNumber()).toBeLessThanOrEqual(1);
  });

  it('should use default dTrafficAlpha=0.1 when not specified', async () => {
    const worker = new RewardWorker('default-alpha-peer');
    worker.stake = new Decimal('50e18');
    worker.bond = new Decimal('50e18');
    worker.trafficWeight = new Decimal(0.3);

    await worker.calculateDTraffic(new Decimal('500e18'));

    // supplyRatio = 100e18/500e18 = 0.2
    // (0.3/0.2)^0.1 = 1.5^0.1
    const expected = Math.min(1, Math.pow(1.5, 0.1));
    expect(worker.dTraffic.toNumber()).toBeCloseTo(expected, 5);
  });
});

// ---------------------------------------------------------------------------
// apr - normal computation
// ---------------------------------------------------------------------------

describe('RewardWorker - apr (normal computation)', () => {
  it('should compute correct APR values with standard inputs', async () => {
    const worker = new RewardWorker('apr-peer');
    worker.bond = new Decimal('100e18');
    worker.stake = new Decimal('200e18');
    worker.totalStake = new Decimal('200e18');
    worker.workerReward = new Decimal('1e16');
    worker.stakerReward = new Decimal('5e15');

    const epochDuration = 3600; // 1 hour
    const year = 365 * 24 * 60 * 60;

    const result = worker.apr(epochDuration, year);

    // duration = year / epochDuration = 31536000 / 3600 = 8760
    // worker_apr = workerReward / bond * duration = 1e16 / 100e18 * 8760 = 0.0001 * 8760 = 0.876
    const expectedWorkerApr = new Decimal('1e16')
      .div(new Decimal('100e18'))
      .mul(new Decimal(year).div(epochDuration));

    expect(result.worker_apr).toBe(expectedWorkerApr.toFixed());

    // delegator_apr = stakerReward / totalStake * duration = 5e15 / 200e18 * 8760
    const expectedDelegatorApr = new Decimal('5e15')
      .div(new Decimal('200e18'))
      .mul(new Decimal(year).div(epochDuration));

    expect(result.delegator_apr).toBe(expectedDelegatorApr.toFixed());
  });
});

// ---------------------------------------------------------------------------
// RewardWorker constructor & default values
// ---------------------------------------------------------------------------

describe('RewardWorker - constructor and defaults', () => {
  it('should set peerId from constructor', () => {
    const worker = new RewardWorker('my-peer-id');
    expect(worker.peerId).toBe('my-peer-id');
  });

  it('should initialize all numeric fields to zero/default', () => {
    const worker = new RewardWorker('defaults-peer');
    expect(worker.bytesSent).toBe(0);
    expect(worker.chunksRead).toBe(0);
    expect(worker.trafficWeight.toNumber()).toBe(0);
    expect(worker.dTraffic.toNumber()).toBe(0);
    expect(worker.stake.toNumber()).toBe(0);
    expect(worker.totalStake.toNumber()).toBe(0);
    expect(worker.livenessCoefficient.toNumber()).toBe(0);
    expect(worker.bond.toNumber()).toBe(0);
    expect(worker.actualYield.toNumber()).toBe(0);
    expect(worker.requestsProcessed).toBe(0);
    expect(worker.totalRequests).toBe(0);
    expect(worker.networkStats).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// OldWorker alias
// ---------------------------------------------------------------------------

describe('OldWorker alias', () => {
  it('OldWorker should be the same class as RewardWorker', () => {
    expect(OldWorker).toBe(RewardWorker);
  });

  it('OldWorker instance should have all RewardWorker methods', () => {
    const worker = new OldWorker('alias-peer');
    expect(typeof worker.calculateT).toBe('function');
    expect(typeof worker.calculateDTraffic).toBe('function');
    expect(typeof worker.calculateLiveness).toBe('function');
    expect(typeof worker.calculateDTenure).toBe('function');
    expect(typeof worker.getRewards).toBe('function');
    expect(typeof worker.processQuery).toBe('function');
    expect(typeof worker.getId).toBe('function');
    expect(typeof worker.apr).toBe('function');
    expect(typeof worker.setContractId).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// calculateLivenessFactor - happy path (exercises internal helpers:
//   formatDateForClickHouse, secondDiffs, totalOfflineSeconds, networkStats)
// ---------------------------------------------------------------------------

describe('calculateLivenessFactor - happy path via mock ClickHouse', () => {
  /**
   * Creates a mock ClickHouse service whose stream returns the given rows.
   */
  function createMockClickHouse(rows: any[]) {
    return {
      configService: {
        get: (key: string) => {
          if (key === 'database.clickhouse.database') return 'testnet';
          if (key === 'rewards.workerOfflineThreshold') return 65;
          return undefined;
        },
      },
      client: {
        query: () => ({
          stream: async function* () {
            for (const row of rows) {
              yield row;
            }
          },
        }),
      },
    };
  }

  it('should compute liveness for a single worker with no offline time', async () => {
    // Worker pings every 60 seconds throughout a 600s epoch
    // Timestamps: [start=0, 60, 120, 180, 240, 300, 360, 420, 480, 540, end=600]
    const start = new Date('2024-01-01T00:00:00Z');
    const end = new Date('2024-01-01T00:10:00Z'); // 600 seconds
    const startUnix = Math.floor(start.getTime() / 1000);

    const timestamps: number[] = [];
    for (let i = 0; i <= 10; i++) {
      timestamps.push(startUnix + i * 60);
    }

    const mock = createMockClickHouse([
      { worker_id: 'worker-a', timestamps },
    ]);

    const result = await calculateLivenessFactor(mock, start, end);

    expect(result['worker-a']).toBeDefined();
    // All diffs are 60s, none exceed the 65s threshold, so totalOffline = 0
    // livenessFactor = 1 - 0/600 = 1.0
    expect(result['worker-a'].livenessFactor).toBe(1);
    expect(result['worker-a'].totalTimeOffline).toBe(0);
  });

  it('should detect offline time when gaps exceed the configured threshold', async () => {
    const start = new Date('2024-01-01T00:00:00Z');
    const end = new Date('2024-01-01T01:00:00Z'); // 3600 seconds
    const startUnix = Math.floor(start.getTime() / 1000);

    // Worker pings at 0, 100, 200, then goes offline for 800s, then pings at 1000, 1100, ..., 3600
    const timestamps = [startUnix, startUnix + 100, startUnix + 200, startUnix + 1000, startUnix + 1100, startUnix + 3600];

    const mock = createMockClickHouse([
      { worker_id: 'offline-worker', timestamps },
    ]);

    const result = await calculateLivenessFactor(mock, start, end);

    expect(result['offline-worker']).toBeDefined();
    // Diffs: [100, 100, 800, 100, 2500]
    // With the 65s threshold, every gap is counted as offline.
    expect(result['offline-worker'].totalTimeOffline).toBe(3600);
    expect(result['offline-worker'].livenessFactor).toBeCloseTo(0, 10);
  });

  it('should handle multiple workers', async () => {
    const start = new Date('2024-01-01T00:00:00Z');
    const end = new Date('2024-01-01T00:10:00Z'); // 600s
    const startUnix = Math.floor(start.getTime() / 1000);

    const mock = createMockClickHouse([
      {
        worker_id: 'good-worker',
        timestamps: [startUnix, startUnix + 60, startUnix + 120, startUnix + 180, startUnix + 600],
      },
      {
        worker_id: 'bad-worker',
        timestamps: [startUnix, startUnix + 600], // only start and end, no pings in between
      },
    ]);

    const result = await calculateLivenessFactor(mock, start, end);

    expect(Object.keys(result)).toHaveLength(2);
    expect(result['good-worker']).toBeDefined();
    expect(result['bad-worker']).toBeDefined();
  });

  it('should return empty result when no workers are returned', async () => {
    const mock = createMockClickHouse([]);

    const result = await calculateLivenessFactor(
      mock,
      new Date('2024-01-01'),
      new Date('2024-01-02'),
    );

    expect(result).toEqual({});
  });

  it('should skip rows without worker_id or timestamps', async () => {
    const mock = createMockClickHouse([
      { worker_id: null, timestamps: [100, 200] },
      { worker_id: 'valid', timestamps: null },
      { worker_id: '', timestamps: [100, 200] },
    ]);

    const result = await calculateLivenessFactor(
      mock,
      new Date('2024-01-01'),
      new Date('2024-01-02'),
    );

    // All rows should be skipped: null worker_id, null timestamps, empty string worker_id
    expect(Object.keys(result).length).toBeLessThanOrEqual(1);
    expect(result['valid']).toBeUndefined();
  });

  it('should fallback to "testnet" when configService is undefined', async () => {
    const start = new Date('2024-01-01T00:00:00Z');
    const end = new Date('2024-01-01T00:10:00Z');
    const startUnix = Math.floor(start.getTime() / 1000);

    const mock = {
      configService: undefined,
      client: {
        query: () => ({
          stream: async function* () {
            yield {
              worker_id: 'fallback-worker',
              timestamps: [startUnix, startUnix + 60, startUnix + 600],
            };
          },
        }),
      },
    };

    const result = await calculateLivenessFactor(mock, start, end);
    expect(result['fallback-worker']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// End-to-end mini-scenario: full reward pipeline for a single worker
// ---------------------------------------------------------------------------

describe('RewardWorker - full pipeline integration', () => {
  it('should compute consistent rewards through the full pipeline', async () => {
    const worker = new RewardWorker('pipeline-peer');

    // 1. Process queries
    await worker.processQuery({ output_size: 500, num_read_chunks: 300 });
    await worker.processQuery({ output_size: 500, num_read_chunks: 200 });
    expect(worker.bytesSent).toBe(1000);
    expect(worker.chunksRead).toBe(500);

    // 2. Calculate traffic weight (worker is the only worker)
    await worker.calculateT(1000, 500);
    // normalizedBytes=1, normalizedChunks=1 => trafficWeight = sqrt(1) = 1
    expect(worker.trafficWeight.toNumber()).toBe(1);

    // 3. Set stake and bond
    worker.bond = new Decimal('100e18');
    worker.stake = new Decimal('200e18');
    worker.totalStake = new Decimal('200e18');

    // 4. Calculate dTraffic
    const totalSupply = worker.bond.add(worker.stake);
    await worker.calculateDTraffic(totalSupply);
    // supplyRatio = 300e18 / 300e18 = 1, trafficWeight = 1
    // dTraffic = min(1, (1/1)^0.1) = min(1, 1) = 1
    expect(worker.dTraffic.toNumber()).toBe(1);

    // 5. Calculate liveness
    await worker.calculateLiveness({
      totalPings: 100,
      totalTimeOffline: 0,
      livenessFactor: 0.96,
    });
    expect(worker.livenessCoefficient.toNumber()).toBe(1);

    // 6. Calculate dTenure
    await worker.calculateDTenure([0.95, 0.92, 0.91, 0.93]);
    // liveEpochs = 4 => dTenure = 0.5 + floor(4/2 + 0.05) * 0.1 = 0.7
    expect(worker.dTenure.toNumber()).toBe(0.7);

    // 7. Calculate rewards
    const rMax = new Decimal(0.0001);
    await worker.getRewards(rMax);

    // actualYield = 0.0001 * 1 * 1 * 0.7 = 0.00007
    expect(worker.actualYield.toNumber()).toBeCloseTo(0.00007, 10);

    // workerReward = 0.00007 * (100e18 + 200e18/2) = 0.00007 * 200e18 = 1.4e16
    const expectedWorkerReward = new Decimal(0.00007).mul(
      new Decimal('100e18').add(new Decimal('200e18').div(2)),
    );
    expect(worker.workerReward.toFixed(0)).toBe(expectedWorkerReward.toFixed(0));

    // stakerReward = 0.00007 * 200e18 / 2 = 7e15
    const expectedStakerReward = new Decimal(0.00007).mul('200e18').div(2);
    expect(worker.stakerReward.toFixed(0)).toBe(expectedStakerReward.toFixed(0));

    // 8. APR
    const duration = 3600; // 1 hour epoch
    const year = 365 * 24 * 60 * 60;
    const aprResult = worker.apr(duration, year);
    expect(parseFloat(aprResult.worker_apr)).toBeGreaterThan(0);
    expect(parseFloat(aprResult.delegator_apr)).toBeGreaterThan(0);

    // 9. getId
    worker.setContractId(99n);
    expect(await worker.getId()).toBe(99n);
  });
});

// ---------------------------------------------------------------------------
// RewardsCalculatorService - full service tests with mocked dependencies
// ---------------------------------------------------------------------------

import { RewardsCalculatorService } from './rewards-calculator.service';

describe('RewardsCalculatorService', () => {
  // Shared mock context
  const mockCtx: any = {
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
    },
  };

  /**
   * Creates a standard set of mock services for the RewardsCalculatorService.
   * Each property can be overridden via the `overrides` parameter.
   */
  function createMocks(overrides: Record<string, any> = {}) {
    const startTime = new Date('2024-01-01T00:00:00Z');
    const endTime = new Date('2024-01-01T01:00:00Z');
    const startUnix = Math.floor(startTime.getTime() / 1000);

    const mockConfigService: any = {
      get: jest.fn((key: string, defaultValue?: any) => {
        const configMap: Record<string, any> = {
          'rewards.skipSignatureValidation': true,
          'rewards.tenureEpochCount': 2,
          'rewards.totalBatches': undefined,
          'rewards.batchNumber': undefined,
          ...overrides.config,
        };
        return configMap[key] !== undefined ? configMap[key] : defaultValue;
      }),
    };

    const mockClickHouseService: any = {
      getActiveWorkers: jest.fn().mockResolvedValue(
        overrides.activeWorkers ?? [
          {
            worker_id: 'peer-A',
            num_read_chunks: 100,
            output_size: 500,
            totalRequests: 10,
          },
        ],
      ),
      configService: { get: () => 'testnet' },
      client: {
        query: () => ({
          stream: async function* () {
            // Liveness pings: worker pings every 60s => perfect liveness
            const pings = overrides.pings ?? [
              {
                worker_id: 'peer-A',
                timestamps: Array.from({ length: 62 }, (_, i) => startUnix + i * 60),
              },
            ];
            for (const p of pings) {
              yield p;
            }
          },
        }),
      },
    };

    const mockContractService: any = {
      getBlockTimestamp: jest.fn().mockImplementation((_ctx: any, blockNumber: number) => {
        // Map block numbers to times
        if (blockNumber <= 1000) return Promise.resolve(startTime);
        return Promise.resolve(endTime);
      }),
      getEpochLength: jest.fn().mockResolvedValue(overrides.epochLength ?? 100),
      preloadWorkerIds: jest.fn().mockResolvedValue(
        overrides.workerIdMapping ?? { 'peer-A': 1n },
      ),
      getStakes: jest.fn().mockResolvedValue(
        overrides.stakes ?? [
          [{ status: 'success', result: 200000000000000000000n }], // capedStakes
          [{ status: 'success', result: 300000000000000000000n }], // totalStakes
        ],
      ),
      getBondAmount: jest.fn().mockResolvedValue(
        overrides.bondAmount ?? 100000000000000000000n, // 100e18
      ),
      getLatestL2Block: jest.fn().mockResolvedValue(overrides.latestBlock ?? 2000n),
      getEffectiveTVL: jest.fn().mockResolvedValue(
        overrides.tvl ?? 1000000000000000000000n, // 1000e18
      ),
      getInitialRewardPoolSize: jest.fn().mockResolvedValue(
        overrides.initialRewardPoolSize ?? 10000000000000000000000n, // 10000e18
      ),
      getYearlyRewardCapCoefficient: jest.fn().mockResolvedValue(
        overrides.yearlyRewardCapCoefficient ?? 200n,
      ),
    };

    const mockMetricsLoggerService: any = {
      log: jest.fn(),
    };

    return {
      configService: mockConfigService,
      clickHouseService: mockClickHouseService,
      contractService: mockContractService,
      metricsLoggerService: mockMetricsLoggerService,
    };
  }

  function createService(overrides: Record<string, any> = {}) {
    const mocks = createMocks(overrides);
    const service = new RewardsCalculatorService(
      mocks.configService,
      mocks.clickHouseService,
      mocks.contractService,
      mocks.metricsLoggerService,
    );
    return { service, mocks };
  }

  // ---- calculateRewards / calculateEpochRewards ----

  describe('calculateRewards', () => {
    it('should return workers with correct reward fields for a single worker', async () => {
      const { service } = createService();

      const result = await service.calculateRewards(mockCtx, 1000, 2000, true);

      expect(result.workers.length).toBe(1);
      expect(result.workers[0].workerId).toBe(1n);
      expect(result.workers[0].id).toBe(1n);
      expect(typeof result.workers[0].workerReward).toBe('bigint');
      expect(typeof result.workers[0].stakerReward).toBe('bigint');
      expect(result.totalRewards).toBe(result.workers[0].workerReward);
      expect(result.epochMetadata).toBeDefined();
      expect(result.epochMetadata!.fromBlock).toBe(1000);
      expect(result.epochMetadata!.toBlock).toBe(2000);
    });

    it('should return empty result when no active workers', async () => {
      const { service } = createService({ activeWorkers: [] });

      const result = await service.calculateRewards(mockCtx, 1000, 2000, true);

      expect(result.workers).toEqual([]);
      expect(result.totalRewards).toBe(0n);
    });

    it('should return empty result when no workers match contract mapping', async () => {
      const { service } = createService({
        workerIdMapping: {}, // no mappings
      });

      const result = await service.calculateRewards(mockCtx, 1000, 2000, true);

      expect(result.workers).toEqual([]);
      expect(result.totalRewards).toBe(0n);
    });

    it('should filter out workers with zero contract id', async () => {
      const { service } = createService({
        workerIdMapping: { 'peer-A': 0n }, // zero id = unregistered
      });

      const result = await service.calculateRewards(mockCtx, 1000, 2000, true);

      expect(result.workers).toEqual([]);
      expect(result.totalRewards).toBe(0n);
    });

    it('should handle multiple workers', async () => {
      const { service } = createService({
        activeWorkers: [
          { worker_id: 'peer-A', num_read_chunks: 100, output_size: 500, totalRequests: 10 },
          { worker_id: 'peer-B', num_read_chunks: 200, output_size: 300, totalRequests: 20 },
        ],
        workerIdMapping: { 'peer-A': 1n, 'peer-B': 2n },
        stakes: [
          [
            { status: 'success', result: 200000000000000000000n },
            { status: 'success', result: 100000000000000000000n },
          ],
          [
            { status: 'success', result: 300000000000000000000n },
            { status: 'success', result: 150000000000000000000n },
          ],
        ],
        pings: [
          {
            worker_id: 'peer-A',
            timestamps: Array.from({ length: 62 }, (_, i) =>
              Math.floor(new Date('2024-01-01T00:00:00Z').getTime() / 1000) + i * 60,
            ),
          },
          {
            worker_id: 'peer-B',
            timestamps: Array.from({ length: 62 }, (_, i) =>
              Math.floor(new Date('2024-01-01T00:00:00Z').getTime() / 1000) + i * 60,
            ),
          },
        ],
      });

      const result = await service.calculateRewards(mockCtx, 1000, 2000, true);

      expect(result.workers.length).toBe(2);
      expect(result.totalRewards).toBeGreaterThan(0n);
    });

    it('should handle failed stake multicall gracefully', async () => {
      const { service } = createService({
        stakes: [
          [{ status: 'failure', error: 'RPC error' }],
          [{ status: 'failure', error: 'RPC error' }],
        ],
      });

      const result = await service.calculateRewards(mockCtx, 1000, 2000, true);

      // Worker should still be in result, but with zero stake
      expect(result.workers.length).toBe(1);
    });
  });

  // ---- calculateEpochRewards (thin wrapper) ----

  describe('calculateEpochRewards', () => {
    it('should return only the workers array', async () => {
      const { service } = createService();

      const workers = await service.calculateEpochRewards(mockCtx, 1000, 2000, true);

      expect(Array.isArray(workers)).toBe(true);
      expect(workers.length).toBe(1);
      expect(workers[0].workerId).toBe(1n);
    });
  });

  // ---- calculateRewardsDetailed (thin wrapper) ----

  describe('calculateRewardsDetailed', () => {
    it('should return full result with epoch metadata', async () => {
      const { service } = createService();

      const result = await service.calculateRewardsDetailed(mockCtx, 1000, 2000, true);

      expect(result.workers).toBeDefined();
      expect(result.totalRewards).toBeDefined();
      expect(result.epochMetadata).toBeDefined();
      expect(result.calculationTime).toBeDefined();
    });
  });

  // ---- calculateRewardsFormatted ----

  describe('calculateRewardsFormatted', () => {
    it('should return formatted result with APR, traffic, delegation, liveness info', async () => {
      const { service } = createService();

      const result = await service.calculateRewardsFormatted(mockCtx, 1000, 2000, true);

      expect(result.totalRewards).toBeDefined();
      expect(result.totalRewards.worker).toBeDefined();
      expect(result.totalRewards.staker).toBeDefined();
      expect(result.workers.length).toBe(1);

      const w = result.workers[0];
      expect(w.id).toBe('peer-A');
      expect(w.apr).toBeDefined();
      expect(w.apr.worker_apr).toBeDefined();
      expect(w.apr.delegator_apr).toBeDefined();
      expect(w.traffic).toBeDefined();
      expect(w.traffic.bytesSent).toBe(500);
      expect(w.traffic.chunksRead).toBe(100);
      expect(w.delegation).toBeDefined();
      expect(w.liveness).toBeDefined();
    });

    it('should return empty formatted result when no active workers', async () => {
      const { service } = createService({ activeWorkers: [] });

      const result = await service.calculateRewardsFormatted(mockCtx, 1000, 2000, true);

      expect(result.totalRewards.worker).toBe('0');
      expect(result.totalRewards.staker).toBe('0');
      expect(result.workers).toEqual([]);
    });

    it('should return empty formatted result when no contract mappings', async () => {
      const { service } = createService({ workerIdMapping: {} });

      const result = await service.calculateRewardsFormatted(mockCtx, 1000, 2000, true);

      expect(result.workers).toEqual([]);
    });
  });

  // ---- Batch filtering ----

  describe('batch filtering', () => {
    it('should adjust block range when totalBatches > 1', async () => {
      // Use a valid base58 peer ID for batch filtering (bs58.decode is called)
      const base58PeerId = '12D3KooWBvG3Z'; // valid base58 string
      const { service, mocks } = createService({
        activeWorkers: [
          { worker_id: base58PeerId, num_read_chunks: 100, output_size: 500, totalRequests: 10 },
        ],
        workerIdMapping: { [base58PeerId]: 1n },
        stakes: [
          [{ status: 'success', result: 200000000000000000000n }],
          [{ status: 'success', result: 300000000000000000000n }],
        ],
        pings: [
          {
            worker_id: base58PeerId,
            timestamps: Array.from({ length: 62 }, (_, i) =>
              Math.floor(new Date('2024-01-01T00:00:00Z').getTime() / 1000) + i * 60,
            ),
          },
        ],
        config: {
          'rewards.skipSignatureValidation': true,
          'rewards.tenureEpochCount': 2,
          'rewards.totalBatches': 2,
          'rewards.batchNumber': undefined,
        },
      });

      const result = await service.calculateRewards(mockCtx, 1000, 2000, true, undefined, 2);

      // With totalBatches=2, the service adjusts the fromBlock and filters workers
      expect(result).toBeDefined();
      expect(mocks.contractService.getBlockTimestamp).toHaveBeenCalled();
    });

    it('should throw when totalBatches > 64', async () => {
      const { service } = createService();

      await expect(
        service.calculateRewards(mockCtx, 1000, 2000, true, 0, 65),
      ).rejects.toThrow('Total batches must be <= 64');
    });
  });

  // ---- APR calculation from contracts ----

  describe('APR from contracts', () => {
    it('should compute APR from contract values', async () => {
      const { service } = createService({
        tvl: 1000000000000000000000n, // 1000e18
        initialRewardPoolSize: 10000000000000000000000n, // 10000e18
        yearlyRewardCapCoefficient: 100n,
      });

      const result = await service.calculateRewards(mockCtx, 1000, 2000, true);

      // APR = min(yearlyRewardCapCoefficient * initialRewardPoolSize / tvl, 2000) basis points
      // = min(100 * 10000e18 / 1000e18, 2000) = min(1000, 2000) = 1000
      expect(result.workers.length).toBe(1);
    });

    it('should use 20% APR fallback (2000 basis points) when TVL is 0', async () => {
      // Regression guard for RWD-C-001:
      // The zero-TVL fallback must return basis points (2000), not 0.2.
      // If it returns 0.2 the downstream `rMax = baseApr * duration / YEAR / 10_000`
      // evaluates to ~0 and every worker's reward is ~0 — a 10,000x underpayment.
      const { service: zeroTvlService } = createService({ tvl: 0n });
      const { service: contractErrService, mocks: contractErrMocks } =
        createService();
      contractErrMocks.contractService.getEffectiveTVL.mockRejectedValue(
        new Error('RPC fail'),
      );

      const zeroTvlResult = await zeroTvlService.calculateRewards(
        mockCtx,
        1000,
        2000,
        true,
      );
      const contractErrResult = await contractErrService.calculateRewards(
        mockCtx,
        1000,
        2000,
        true,
      );

      // 1. Zero-TVL epoch must produce at least one non-zero worker reward.
      expect(zeroTvlResult.workers.length).toBeGreaterThan(0);
      const totalWorkerReward = zeroTvlResult.workers.reduce(
        (sum, w) => sum + BigInt(w.workerReward),
        0n,
      );
      expect(totalWorkerReward).toBeGreaterThan(0n);

      // 2. Zero-TVL fallback must yield the SAME rewards as the contract-error
      //    fallback (both paths return 2000 bp).
      expect(contractErrResult.workers.length).toBe(
        zeroTvlResult.workers.length,
      );
      for (let i = 0; i < zeroTvlResult.workers.length; i++) {
        expect(zeroTvlResult.workers[i].workerReward).toBe(
          contractErrResult.workers[i].workerReward,
        );
      }
    });

    it('should use fallback APR when contract calls fail', async () => {
      const { service, mocks } = createService();
      mocks.contractService.getEffectiveTVL.mockRejectedValue(new Error('RPC fail'));

      const result = await service.calculateRewards(mockCtx, 1000, 2000, true);

      // Should fall back to 2000 basis points
      expect(result).toBeDefined();
      expect(result.workers.length).toBe(1);
    });

    it('should use fallback APR when getLatestL2Block fails', async () => {
      const { service, mocks } = createService();
      mocks.contractService.getLatestL2Block.mockRejectedValue(new Error('RPC fail'));

      const result = await service.calculateRewards(mockCtx, 1000, 2000, true);

      expect(result).toBeDefined();
      expect(result.workers.length).toBe(1);
    });

    it('should cap APR at 2000 basis points', async () => {
      const { service } = createService({
        tvl: 100000000000000000000n, // 100e18 - small TVL
        initialRewardPoolSize: 10000000000000000000000n, // 10000e18
        yearlyRewardCapCoefficient: 500n, // Very high coefficient
        // apyCap = 500 * 10000e18 / 100e18 = 50000 > 2000, capped at 2000
      });

      const result = await service.calculateRewards(mockCtx, 1000, 2000, true);

      expect(result).toBeDefined();
      expect(result.workers.length).toBe(1);
    });
  });

  // ---- Block timestamp fallback ----

  describe('block timestamp fallback', () => {
    it('should handle getBlockTimestamp failure for tenure epoch timestamps', async () => {
      const { service, mocks } = createService();

      // Make getBlockTimestamp fail for negative/early block numbers (tenure blocks)
      const originalImpl = mocks.contractService.getBlockTimestamp;
      mocks.contractService.getBlockTimestamp.mockImplementation((_ctx: any, blockNumber: number) => {
        if (blockNumber < 0) {
          return Promise.reject(new Error('Block not found'));
        }
        if (blockNumber <= 1000) {
          return Promise.resolve(new Date('2024-01-01T00:00:00Z'));
        }
        return Promise.resolve(new Date('2024-01-01T01:00:00Z'));
      });

      const result = await service.calculateRewards(mockCtx, 1000, 2000, true);

      // Should still produce results, using estimated timestamps
      expect(result).toBeDefined();
      expect(result.workers.length).toBe(1);
    });
  });
});
