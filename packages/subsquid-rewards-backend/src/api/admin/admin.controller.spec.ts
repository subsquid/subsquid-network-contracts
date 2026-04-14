/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Logger mock – suppress pino output in tests
// ---------------------------------------------------------------------------
jest.mock('../../common/logger', () => ({
  Logger: {
    get: () => ({
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      child: jest.fn().mockReturnThis(),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
import { AdminController } from './admin.controller';
import { DistributionStatus } from '../../rewards/distribution/distribution.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDistributionStatus(
  overrides: Partial<DistributionStatus> = {},
): DistributionStatus {
  return {
    epochId: '100-200',
    fromBlock: 100,
    toBlock: 200,
    status: 'completed',
    totalWorkers: 10,
    totalBatches: 2,
    processedBatches: 2,
    totalRewards: 1000n,
    startedAt: new Date('2025-01-01T00:00:00Z'),
    completedAt: new Date('2025-01-01T00:05:00Z'),
    ...overrides,
  };
}

/** Inject a status into the controller's private activeDistributions map. */
function injectDistribution(
  controller: AdminController,
  status: DistributionStatus,
) {
  (controller as any).activeDistributions.set(status.epochId, status);
}

function clearDistributions(controller: AdminController) {
  (controller as any).activeDistributions.clear();
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockRewardsCalculatorService() {
  return {
    calculateRewardsFormatted: jest.fn(),
    // Expose a nested configService used by getWorkerRegistrationStatus
    configService: {
      get: jest.fn().mockReturnValue('0xWorkerRegistrationAddress'),
    },
  };
}

function createMockDistributionService() {
  return {
    distributeEpochRewards: jest.fn(),
    getDistributionStatus: jest.fn(),
  };
}

function createMockContractService() {
  return {
    getBondAmount: jest.fn(),
    getActiveWorkerCount: jest.fn(),
    getL1BlockNumber: jest.fn(),
    getLastBlockRewarded: jest.fn(),
  };
}

function createMockBlockSchedulerService() {
  return {
    getStatus: jest.fn(),
    triggerManualApprovalCheck: jest.fn(),
    triggerManualDistributionCheck: jest.fn(),
    triggerManualRecoveryCheck: jest.fn(),
    forceCommit: jest.fn(),
    forceDistribution: jest.fn(),
  };
}

function createMockConfigService() {
  return {
    get: jest.fn().mockImplementation((key: string, defaultValue?: any) => {
      if (key === 'rewards.commitmentBatchSize') return defaultValue ?? 75;
      return defaultValue;
    }),
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('AdminController', () => {
  let controller: AdminController;
  let rewardsCalculatorService: ReturnType<typeof createMockRewardsCalculatorService>;
  let distributionService: ReturnType<typeof createMockDistributionService>;
  let contractService: ReturnType<typeof createMockContractService>;
  let blockSchedulerService: ReturnType<typeof createMockBlockSchedulerService>;
  let configService: ReturnType<typeof createMockConfigService>;

  beforeEach(() => {
    rewardsCalculatorService = createMockRewardsCalculatorService();
    distributionService = createMockDistributionService();
    contractService = createMockContractService();
    blockSchedulerService = createMockBlockSchedulerService();
    configService = createMockConfigService();

    controller = new AdminController(
      rewardsCalculatorService as any,
      distributionService as any,
      contractService as any,
      blockSchedulerService as any,
      configService as any,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // =========================================================================
  // 1. calculateRewards
  // =========================================================================
  describe('calculateRewards', () => {
    it('should return rewards for a block range', async () => {
      const mockResult = {
        totalRewards: '5000',
        workers: [
          { address: '0xAAA', reward: '3000' },
          { address: '0xBBB', reward: '2000' },
        ],
      };
      rewardsCalculatorService.calculateRewardsFormatted.mockResolvedValue(mockResult);

      const result = await controller.calculateRewards('100', '200');

      expect(result).toEqual({
        totalRewards: '5000',
        workers: mockResult.workers,
      });
      expect(rewardsCalculatorService.calculateRewardsFormatted).toHaveBeenCalledWith(
        expect.any(Object), // TaskContext
        100,
        200,
        true,
      );
    });

    it('should limit the number of workers returned when limit is provided', async () => {
      const mockResult = {
        totalRewards: '9000',
        workers: [
          { address: '0xAAA', reward: '3000' },
          { address: '0xBBB', reward: '3000' },
          { address: '0xCCC', reward: '3000' },
        ],
      };
      rewardsCalculatorService.calculateRewardsFormatted.mockResolvedValue(mockResult);

      const result = await controller.calculateRewards('100', '200', '2');

      expect(result).toEqual({
        totalRewards: '9000',
        workers: [
          { address: '0xAAA', reward: '3000' },
          { address: '0xBBB', reward: '3000' },
        ],
      });
    });

    it('should return error on failure', async () => {
      rewardsCalculatorService.calculateRewardsFormatted.mockRejectedValue(
        new Error('Calculation failed'),
      );

      const result = await controller.calculateRewards('100', '200');

      expect(result).toEqual({
        success: false,
        error: 'Calculation failed',
      });
    });
  });

  // =========================================================================
  // 2. startDistribution
  // =========================================================================
  describe('startDistribution', () => {
    it('should complete a distribution successfully', async () => {
      const finalStatus = makeDistributionStatus({ status: 'completed' });
      distributionService.distributeEpochRewards.mockResolvedValue(finalStatus);

      const result = await controller.startDistribution({
        fromBlock: 100,
        toBlock: 200,
      });

      expect(result).toEqual({
        success: true,
        message: 'Distribution completed successfully',
        epochId: '100-200',
        status: expect.objectContaining({
          epochId: '100-200',
          status: 'completed',
          totalRewards: '1000',
        }),
      });
      expect(distributionService.distributeEpochRewards).toHaveBeenCalledWith(
        100,
        200,
        75, // default batch size from configService
      );
    });

    it('should use custom batchSize when provided', async () => {
      const finalStatus = makeDistributionStatus();
      distributionService.distributeEpochRewards.mockResolvedValue(finalStatus);

      await controller.startDistribution({
        fromBlock: 100,
        toBlock: 200,
        batchSize: 50,
      });

      expect(distributionService.distributeEpochRewards).toHaveBeenCalledWith(
        100,
        200,
        50,
      );
    });

    it('should return error for invalid block range (fromBlock >= toBlock)', async () => {
      const result = await controller.startDistribution({
        fromBlock: 200,
        toBlock: 100,
      });

      expect(result).toEqual({
        success: false,
        error: 'Invalid block range: fromBlock must be less than toBlock',
      });
      expect(distributionService.distributeEpochRewards).not.toHaveBeenCalled();
    });

    it('should return error for equal block range', async () => {
      const result = await controller.startDistribution({
        fromBlock: 100,
        toBlock: 100,
      });

      expect(result).toEqual({
        success: false,
        error: 'Invalid block range: fromBlock must be less than toBlock',
      });
    });

    it('should reject when distribution is already running for the same epoch', async () => {
      const runningStatus = makeDistributionStatus({
        status: 'distributing',
        completedAt: undefined,
      });
      injectDistribution(controller, runningStatus);

      const result = await controller.startDistribution({
        fromBlock: 100,
        toBlock: 200,
      });

      expect(result).toEqual({
        success: false,
        error: 'Distribution already running for this epoch',
        status: expect.objectContaining({
          epochId: '100-200',
          status: 'distributing',
        }),
      });
    });

    it('should allow restart when previous distribution completed', async () => {
      const completedStatus = makeDistributionStatus({ status: 'completed' });
      injectDistribution(controller, completedStatus);

      const newFinalStatus = makeDistributionStatus({ status: 'completed', totalRewards: 2000n });
      distributionService.distributeEpochRewards.mockResolvedValue(newFinalStatus);

      const result = await controller.startDistribution({
        fromBlock: 100,
        toBlock: 200,
      });

      expect(result.success).toBe(true);
    });

    it('should allow restart when previous distribution failed', async () => {
      const failedStatus = makeDistributionStatus({ status: 'failed' });
      injectDistribution(controller, failedStatus);

      const newFinalStatus = makeDistributionStatus({ status: 'completed' });
      distributionService.distributeEpochRewards.mockResolvedValue(newFinalStatus);

      const result = await controller.startDistribution({
        fromBlock: 100,
        toBlock: 200,
      });

      expect(result.success).toBe(true);
    });

    it('should handle distribution service failure', async () => {
      distributionService.distributeEpochRewards.mockRejectedValue(
        new Error('Transaction reverted'),
      );

      const result = await controller.startDistribution({
        fromBlock: 100,
        toBlock: 200,
      });

      // The inner error is wrapped in HttpException, then caught by outer catch
      expect(result).toEqual({
        success: false,
        error: 'Distribution failed: Transaction reverted',
      });

      // Verify error status is stored
      const stored = (controller as any).activeDistributions.get('100-200');
      expect(stored.status).toBe('failed');
      expect(stored.error).toBe('Transaction reverted');
      expect(stored.completedAt).toBeDefined();
    });
  });

  // =========================================================================
  // 3. getDistributionStatus
  // =========================================================================
  describe('getDistributionStatus', () => {
    it('should return status for an existing distribution', async () => {
      const status = makeDistributionStatus();
      injectDistribution(controller, status);

      const result = await controller.getDistributionStatus('100-200');

      expect(result).toEqual({
        success: true,
        status: expect.objectContaining({
          epochId: '100-200',
          status: 'completed',
          totalRewards: '1000',
        }),
      });
    });

    it('should return not found for a missing distribution', async () => {
      const result = await controller.getDistributionStatus('999-1000');

      expect(result).toEqual({
        success: false,
        error: 'Distribution not found',
      });
    });
  });

  // =========================================================================
  // 4. getAllDistributions
  // =========================================================================
  describe('getAllDistributions', () => {
    it('should return all distributions', async () => {
      const status1 = makeDistributionStatus({
        epochId: '100-200',
        startedAt: new Date('2025-01-01T00:00:00Z'),
      });
      const status2 = makeDistributionStatus({
        epochId: '200-300',
        fromBlock: 200,
        toBlock: 300,
        startedAt: new Date('2025-01-02T00:00:00Z'),
      });
      injectDistribution(controller, status1);
      injectDistribution(controller, status2);

      const result = await controller.getAllDistributions();

      expect(result.success).toBe(true);
      expect(result.total).toBe(2);
      expect(result.returned).toBe(2);
      // Should be sorted by startedAt descending
      expect((result as any).distributions[0].epochId).toBe('200-300');
      expect((result as any).distributions[1].epochId).toBe('100-200');
    });

    it('should filter by status', async () => {
      const completed = makeDistributionStatus({
        epochId: '100-200',
        status: 'completed',
      });
      const failed = makeDistributionStatus({
        epochId: '200-300',
        fromBlock: 200,
        toBlock: 300,
        status: 'failed',
      });
      injectDistribution(controller, completed);
      injectDistribution(controller, failed);

      const result = await controller.getAllDistributions(undefined, 'completed');

      expect(result.success).toBe(true);
      expect(result.total).toBe(1);
      expect(result.returned).toBe(1);
      expect((result as any).distributions[0].status).toBe('completed');
    });

    it('should respect limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        const from = i * 100;
        const to = from + 100;
        injectDistribution(
          controller,
          makeDistributionStatus({
            epochId: `${from}-${to}`,
            fromBlock: from,
            toBlock: to,
            startedAt: new Date(2025, 0, i + 1),
          }),
        );
      }

      const result = await controller.getAllDistributions('2');

      expect(result.success).toBe(true);
      expect(result.returned).toBe(2);
      expect(result.total).toBe(5);
    });

    it('should return empty list when no distributions exist', async () => {
      const result = await controller.getAllDistributions();

      expect(result).toEqual({
        success: true,
        distributions: [],
        total: 0,
        returned: 0,
      });
    });
  });

  // =========================================================================
  // 5. getContractStatus
  // =========================================================================
  describe('getContractStatus', () => {
    it('should return contract status for an epoch', async () => {
      const mockStatus = { committed: true, distributed: false };
      distributionService.getDistributionStatus.mockResolvedValue(mockStatus);

      const result = await controller.getContractStatus('100', '200');

      expect(result).toEqual({
        success: true,
        contractStatus: mockStatus,
        epoch: '100-200',
      });
      expect(distributionService.getDistributionStatus).toHaveBeenCalledWith(100, 200);
    });

    it('should return error on failure', async () => {
      distributionService.getDistributionStatus.mockRejectedValue(
        new Error('Contract call failed'),
      );

      const result = await controller.getContractStatus('100', '200');

      expect(result).toEqual({
        success: false,
        error: 'Contract call failed',
      });
    });
  });

  // =========================================================================
  // 6. getWorkerRegistrationStatus
  // =========================================================================
  describe('getWorkerRegistrationStatus', () => {
    it('should return worker registration details', async () => {
      const bondAmount = BigInt(100) * BigInt(1e18); // 100 SQD
      contractService.getBondAmount.mockResolvedValue(bondAmount);
      contractService.getActiveWorkerCount.mockResolvedValue(50n);

      const result = await controller.getWorkerRegistrationStatus();

      expect(result).toEqual({
        success: true,
        bondAmount: bondAmount.toString(),
        bondAmountSQD: 100,
        activeWorkerCount: '50',
        contractAddress: '0xWorkerRegistrationAddress',
      });
    });

    it('should return error on failure', async () => {
      contractService.getBondAmount.mockRejectedValue(
        new Error('RPC call failed'),
      );

      const result = await controller.getWorkerRegistrationStatus();

      expect(result).toEqual({
        success: false,
        error: 'RPC call failed',
      });
    });
  });

  // =========================================================================
  // 7. health
  // =========================================================================
  describe('health', () => {
    it('should return healthy status with empty distributions', async () => {
      const result = await controller.health();

      expect(result).toEqual({
        status: 'healthy',
        timestamp: expect.any(String),
        activeDistributions: 0,
        distributionStats: {
          calculating: 0,
          generating_tree: 0,
          committing: 0,
          distributing: 0,
          completed: 0,
          failed: 0,
        },
      });
    });

    it('should count distributions by status', async () => {
      const statuses: DistributionStatus['status'][] = [
        'calculating',
        'generating_tree',
        'committing',
        'distributing',
        'completed',
        'failed',
      ];

      statuses.forEach((s, i) => {
        injectDistribution(
          controller,
          makeDistributionStatus({
            epochId: `${i * 100}-${(i + 1) * 100}`,
            fromBlock: i * 100,
            toBlock: (i + 1) * 100,
            status: s,
          }),
        );
      });

      const result = await controller.health();

      expect(result.activeDistributions).toBe(6);
      expect(result.distributionStats).toEqual({
        calculating: 1,
        generating_tree: 1,
        committing: 1,
        distributing: 1,
        completed: 1,
        failed: 1,
      });
    });

    it('should count multiple distributions with the same status', async () => {
      injectDistribution(
        controller,
        makeDistributionStatus({ epochId: '100-200', status: 'completed' }),
      );
      injectDistribution(
        controller,
        makeDistributionStatus({
          epochId: '200-300',
          fromBlock: 200,
          toBlock: 300,
          status: 'completed',
        }),
      );
      injectDistribution(
        controller,
        makeDistributionStatus({
          epochId: '300-400',
          fromBlock: 300,
          toBlock: 400,
          status: 'failed',
        }),
      );

      const result = await controller.health();

      expect(result.distributionStats.completed).toBe(2);
      expect(result.distributionStats.failed).toBe(1);
      expect(result.activeDistributions).toBe(3);
    });
  });

  // =========================================================================
  // 8. cleanup
  // =========================================================================
  describe('cleanup', () => {
    it('should clean up old completed/failed distributions', async () => {
      const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48 hours ago
      const recentDate = new Date(Date.now() - 1 * 60 * 60 * 1000); // 1 hour ago

      injectDistribution(
        controller,
        makeDistributionStatus({
          epochId: '100-200',
          status: 'completed',
          completedAt: oldDate,
        }),
      );
      injectDistribution(
        controller,
        makeDistributionStatus({
          epochId: '200-300',
          fromBlock: 200,
          toBlock: 300,
          status: 'failed',
          completedAt: oldDate,
        }),
      );
      injectDistribution(
        controller,
        makeDistributionStatus({
          epochId: '300-400',
          fromBlock: 300,
          toBlock: 400,
          status: 'completed',
          completedAt: recentDate,
        }),
      );

      const result = await controller.cleanup({ maxAgeHours: 24 });

      expect(result).toEqual({
        success: true,
        message: 'Cleaned up 2 old distributions',
        remaining: 1,
        cutoffAge: '24 hours',
      });
      expect((controller as any).activeDistributions.has('100-200')).toBe(false);
      expect((controller as any).activeDistributions.has('200-300')).toBe(false);
      expect((controller as any).activeDistributions.has('300-400')).toBe(true);
    });

    it('should keep active distributions even if old', async () => {
      const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000);

      injectDistribution(
        controller,
        makeDistributionStatus({
          epochId: '100-200',
          status: 'distributing',
          completedAt: undefined,
        }),
      );
      injectDistribution(
        controller,
        makeDistributionStatus({
          epochId: '200-300',
          fromBlock: 200,
          toBlock: 300,
          status: 'calculating',
          completedAt: undefined,
        }),
      );

      const result = await controller.cleanup({ maxAgeHours: 1 });

      expect(result.success).toBe(true);
      expect((result as any).message).toBe('Cleaned up 0 old distributions');
      expect((result as any).remaining).toBe(2);
    });

    it('should default to 24 hours max age', async () => {
      const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25 hours ago

      injectDistribution(
        controller,
        makeDistributionStatus({
          epochId: '100-200',
          status: 'completed',
          completedAt: oldDate,
        }),
      );

      const result = await controller.cleanup({});

      expect(result.success).toBe(true);
      expect((result as any).cutoffAge).toBe('24 hours');
      expect((result as any).message).toBe('Cleaned up 1 old distributions');
    });

    it('should not clean distributions without completedAt', async () => {
      injectDistribution(
        controller,
        makeDistributionStatus({
          epochId: '100-200',
          status: 'completed',
          completedAt: undefined,
        }),
      );

      const result = await controller.cleanup({ maxAgeHours: 0 });

      expect(result.success).toBe(true);
      expect((result as any).message).toBe('Cleaned up 0 old distributions');
      expect((result as any).remaining).toBe(1);
    });

    // --- RWD-M-005: scheduled cleanup ----------------------------------------
    describe('scheduledCleanup (RWD-M-005)', () => {
      it('should evict terminal distributions older than 24h without needing an operator action', async () => {
        // 48h-old terminal distributions
        const oldCompletedAt = new Date(Date.now() - 48 * 60 * 60 * 1000);
        injectDistribution(
          controller,
          makeDistributionStatus({
            epochId: '100-200',
            status: 'completed',
            completedAt: oldCompletedAt,
          }),
        );
        injectDistribution(
          controller,
          makeDistributionStatus({
            epochId: '200-300',
            fromBlock: 200,
            toBlock: 300,
            status: 'failed',
            completedAt: oldCompletedAt,
          }),
        );
        // A fresh, in-flight one must survive
        injectDistribution(
          controller,
          makeDistributionStatus({
            epochId: '300-400',
            fromBlock: 300,
            toBlock: 400,
            status: 'calculating',
          }),
        );

        await controller.scheduledCleanup();

        expect(
          (controller as any).activeDistributions.has('100-200'),
        ).toBe(false);
        expect(
          (controller as any).activeDistributions.has('200-300'),
        ).toBe(false);
        expect(
          (controller as any).activeDistributions.has('300-400'),
        ).toBe(true);
      });

      it('should be safe to run against an empty map', async () => {
        clearDistributions(controller);
        await expect(controller.scheduledCleanup()).resolves.toBeUndefined();
      });
    });
  });

  // =========================================================================
  // 9. getSystemStatus
  // =========================================================================
  describe('getSystemStatus', () => {
    it('should return system status overview', async () => {
      injectDistribution(
        controller,
        makeDistributionStatus({ epochId: '100-200', status: 'completed' }),
      );
      injectDistribution(
        controller,
        makeDistributionStatus({
          epochId: '200-300',
          fromBlock: 200,
          toBlock: 300,
          status: 'calculating',
        }),
      );
      injectDistribution(
        controller,
        makeDistributionStatus({
          epochId: '300-400',
          fromBlock: 300,
          toBlock: 400,
          status: 'failed',
        }),
      );

      const result = await controller.getSystemStatus();

      expect(result).toEqual({
        success: true,
        status: 'operational',
        distributions: {
          active: 1,
          completed: 1,
          failed: 1,
          total: 3,
        },
        uptime: expect.any(Number),
        timestamp: expect.any(String),
      });
    });

    it('should return empty counts with no distributions', async () => {
      const result = await controller.getSystemStatus();

      expect(result).toEqual({
        success: true,
        status: 'operational',
        distributions: {
          active: 0,
          completed: 0,
          failed: 0,
          total: 0,
        },
        uptime: expect.any(Number),
        timestamp: expect.any(String),
      });
    });

    it('should count all active-type statuses correctly', async () => {
      const activeStatuses: DistributionStatus['status'][] = [
        'calculating',
        'generating_tree',
        'committing',
        'distributing',
      ];

      activeStatuses.forEach((s, i) => {
        injectDistribution(
          controller,
          makeDistributionStatus({
            epochId: `${i}-${i + 1}`,
            fromBlock: i,
            toBlock: i + 1,
            status: s,
          }),
        );
      });

      const result = await controller.getSystemStatus();

      expect((result as any).distributions.active).toBe(4);
    });
  });

  // =========================================================================
  // 10. getSchedulerStatus
  // =========================================================================
  describe('getSchedulerStatus', () => {
    it('should return scheduler status and network info', async () => {
      const schedulerStatus = {
        enabled: true,
        isApprovalProcessing: false,
        isDistributionProcessing: false,
      };
      blockSchedulerService.getStatus.mockReturnValue(schedulerStatus);
      contractService.getL1BlockNumber.mockResolvedValue(1000);
      contractService.getLastBlockRewarded.mockResolvedValue(900);

      const result = await controller.getSchedulerStatus();

      expect(result).toEqual({
        success: true,
        scheduler: schedulerStatus,
        network: {
          currentBlock: 1000,
          lastRewardedBlock: 900,
          blocksSinceLastReward: 100,
        },
      });
    });

    it('should return error on failure', async () => {
      blockSchedulerService.getStatus.mockImplementation(() => {
        throw new Error('Scheduler unavailable');
      });

      const result = await controller.getSchedulerStatus();

      expect(result).toEqual({
        success: false,
        error: 'Scheduler unavailable',
      });
    });

    it('should return error when contract call fails', async () => {
      blockSchedulerService.getStatus.mockReturnValue({ enabled: true });
      contractService.getL1BlockNumber.mockRejectedValue(
        new Error('RPC timeout'),
      );

      const result = await controller.getSchedulerStatus();

      expect(result).toEqual({
        success: false,
        error: 'RPC timeout',
      });
    });
  });

  // =========================================================================
  // 11. triggerApprovalCheck
  // =========================================================================
  describe('triggerApprovalCheck', () => {
    it('should return success when approval is triggered', async () => {
      blockSchedulerService.triggerManualApprovalCheck.mockResolvedValue(true);

      const result = await controller.triggerApprovalCheck();

      expect(result).toEqual({
        success: true,
        triggered: true,
        message: 'Approval check completed successfully',
      });
    });

    it('should return no-op message when no approval needed', async () => {
      blockSchedulerService.triggerManualApprovalCheck.mockResolvedValue(false);

      const result = await controller.triggerApprovalCheck();

      expect(result).toEqual({
        success: true,
        triggered: false,
        message: 'Approval check completed - no approval needed',
      });
    });

    it('should return error on failure', async () => {
      blockSchedulerService.triggerManualApprovalCheck.mockRejectedValue(
        new Error('Approval check error'),
      );

      const result = await controller.triggerApprovalCheck();

      expect(result).toEqual({
        success: false,
        error: 'Approval check error',
      });
    });
  });

  // =========================================================================
  // 11b. triggerDistributionCheck
  // =========================================================================
  describe('triggerDistributionCheck', () => {
    it('should return success when distribution is triggered', async () => {
      blockSchedulerService.triggerManualDistributionCheck.mockResolvedValue(true);

      const result = await controller.triggerDistributionCheck();

      expect(result).toEqual({
        success: true,
        triggered: true,
        message: 'Distribution check completed successfully',
      });
    });

    it('should return no-op message when no distribution needed', async () => {
      blockSchedulerService.triggerManualDistributionCheck.mockResolvedValue(false);

      const result = await controller.triggerDistributionCheck();

      expect(result).toEqual({
        success: true,
        triggered: false,
        message: 'Distribution check completed - no distribution needed',
      });
    });

    it('should return error on failure', async () => {
      blockSchedulerService.triggerManualDistributionCheck.mockRejectedValue(
        new Error('Distribution trigger error'),
      );

      const result = await controller.triggerDistributionCheck();

      expect(result).toEqual({
        success: false,
        error: 'Distribution trigger error',
      });
    });
  });

  // =========================================================================
  // 11c. triggerRecoveryCheck
  // =========================================================================
  describe('triggerRecoveryCheck', () => {
    it('should return success when recovery is triggered', async () => {
      blockSchedulerService.triggerManualRecoveryCheck.mockResolvedValue(true);

      const result = await controller.triggerRecoveryCheck();

      expect(result).toEqual({
        success: true,
        triggered: true,
        message: 'Recovery check completed successfully',
      });
    });

    it('should return no-op message when no stuck commitments found', async () => {
      blockSchedulerService.triggerManualRecoveryCheck.mockResolvedValue(false);

      const result = await controller.triggerRecoveryCheck();

      expect(result).toEqual({
        success: true,
        triggered: false,
        message: 'Recovery check completed - no stuck commitments found',
      });
    });

    it('should return error on failure', async () => {
      blockSchedulerService.triggerManualRecoveryCheck.mockRejectedValue(
        new Error('Recovery trigger error'),
      );

      const result = await controller.triggerRecoveryCheck();

      expect(result).toEqual({
        success: false,
        error: 'Recovery trigger error',
      });
    });
  });

  // =========================================================================
  // 12. forceCommit
  // =========================================================================
  describe('forceCommit', () => {
    it('should return success when commit succeeds', async () => {
      blockSchedulerService.forceCommit.mockResolvedValue(true);

      const result = await controller.forceCommit({
        fromBlock: 100,
        toBlock: 200,
      });

      expect(result).toEqual({
        success: true,
        message: 'Commit completed for 100-200',
      });
      expect(blockSchedulerService.forceCommit).toHaveBeenCalledWith(100, 200);
    });

    it('should return failure when commit returns false', async () => {
      blockSchedulerService.forceCommit.mockResolvedValue(false);

      const result = await controller.forceCommit({
        fromBlock: 100,
        toBlock: 200,
      });

      expect(result).toEqual({
        success: false,
        message: 'Commit failed',
      });
    });

    it('should return error on exception', async () => {
      blockSchedulerService.forceCommit.mockRejectedValue(
        new Error('Force commit error'),
      );

      const result = await controller.forceCommit({
        fromBlock: 100,
        toBlock: 200,
      });

      expect(result).toEqual({
        success: false,
        error: 'Force commit error',
      });
    });
  });

  // =========================================================================
  // 12b. forceDistribution
  // =========================================================================
  describe('forceDistribution', () => {
    it('should return success when distribution succeeds', async () => {
      blockSchedulerService.forceDistribution.mockResolvedValue(true);

      const result = await controller.forceDistribution({
        fromBlock: 100,
        toBlock: 200,
      });

      expect(result).toEqual({
        success: true,
        message: 'Distribution completed for 100-200',
      });
      expect(blockSchedulerService.forceDistribution).toHaveBeenCalledWith(100, 200);
    });

    it('should return failure when distribution returns false', async () => {
      blockSchedulerService.forceDistribution.mockResolvedValue(false);

      const result = await controller.forceDistribution({
        fromBlock: 100,
        toBlock: 200,
      });

      expect(result).toEqual({
        success: false,
        message: 'Distribution failed',
      });
    });

    it('should return error on exception', async () => {
      blockSchedulerService.forceDistribution.mockRejectedValue(
        new Error('Force distribution error'),
      );

      const result = await controller.forceDistribution({
        fromBlock: 100,
        toBlock: 200,
      });

      expect(result).toEqual({
        success: false,
        error: 'Force distribution error',
      });
    });
  });

  // =========================================================================
  // 13. getAPRMetrics
  // =========================================================================
  describe('getAPRMetrics', () => {
    it('should return APR metrics successfully', async () => {
      contractService.getActiveWorkerCount.mockResolvedValue(100n);
      contractService.getBondAmount.mockResolvedValue(BigInt(100) * BigInt(1e18));

      const result = await controller.getAPRMetrics();

      expect(result.success).toBe(true);
      expect((result as any).networkMetrics).toBeDefined();
      expect((result as any).networkMetrics.activeWorkers).toBe(100);
      expect((result as any).stakeMetrics).toBeDefined();
      expect((result as any).aprCalculation).toBeDefined();
      expect((result as any).aprCalculation.baseAPR).toBeDefined();
      expect((result as any).aprCalculation.discountFactor).toBeDefined();
      expect((result as any).aprCalculation.finalAPR).toBeDefined();
      expect((result as any).aprRanges).toBeDefined();
      expect((result as any).calculations).toBeDefined();
    });

    it('should return error on failure', async () => {
      contractService.getActiveWorkerCount.mockRejectedValue(
        new Error('Network error'),
      );

      const result = await controller.getAPRMetrics();

      expect(result).toEqual({
        success: false,
        error: 'Network error',
      });
    });

    it('should compute correct metrics for known inputs', async () => {
      // 10 workers, bond = 1000 SQD each
      contractService.getActiveWorkerCount.mockResolvedValue(10n);
      contractService.getBondAmount.mockResolvedValue(BigInt(1000) * BigInt(1e18));

      const result = await controller.getAPRMetrics();

      expect(result.success).toBe(true);
      const nm = (result as any).networkMetrics;
      expect(nm.activeWorkers).toBe(10);
      // actualCapacity = 10 * 1 * 0.9 = 9 TB
      expect(nm.actualCapacity).toBe('9.00 TB');
      // targetCapacity = 10 * 1 * 1.2 = 12 TB
      expect(nm.targetCapacity).toBe('12.00 TB');
    });
  });

  // =========================================================================
  // 14. calculateBaseAPR edge cases
  // =========================================================================
  describe('calculateBaseAPR (private)', () => {
    let calculateBaseAPR: (utilizationRate: number) => number;

    beforeEach(() => {
      calculateBaseAPR = (controller as any).calculateBaseAPR.bind(controller);
    });

    it('should return BASE_APR (0.2) for optimal utilization (0.1 < u <= 0.2)', () => {
      expect(calculateBaseAPR(0.15)).toBeCloseTo(0.2);
      expect(calculateBaseAPR(0.2)).toBeCloseTo(0.2);
    });

    it('should return reduced APR for very low utilization (u = 0)', () => {
      // BASE_APR * (1 - (0.1 - 0) * 2) = 0.2 * (1 - 0.2) = 0.2 * 0.8 = 0.16
      expect(calculateBaseAPR(0)).toBeCloseTo(0.16);
    });

    it('should return MIN_APR floor for extremely negative utilization', () => {
      // For u = -10: 0.2 * (1 - (0.1 - (-10)) * 2) = large negative, clamped to 0.05
      expect(calculateBaseAPR(-10)).toBeCloseTo(0.05);
    });

    it('should return exactly 0.2 at u = 0.1 boundary', () => {
      // 0.2 * (1 - (0.1 - 0.1) * 2) = 0.2 * 1 = 0.2
      expect(calculateBaseAPR(0.1)).toBeCloseTo(0.2);
    });

    it('should scale up APR for high utilization (u > 0.2)', () => {
      // u = 0.4: scalingFactor = min(3.5, 1 + (0.4-0.2)*5) = min(3.5, 2) = 2
      // result = min(0.7, 0.2 * 2) = min(0.7, 0.4) = 0.4
      expect(calculateBaseAPR(0.4)).toBeCloseTo(0.4);
    });

    it('should cap at MAX_APR (0.7) for very high utilization', () => {
      // u = 0.9: scalingFactor = min(3.5, 1 + (0.9-0.2)*5) = min(3.5, 4.5) = 3.5
      // result = min(0.7, 0.2 * 3.5) = min(0.7, 0.7) = 0.7
      expect(calculateBaseAPR(0.9)).toBeCloseTo(0.7);
    });

    it('should return 0.7 at the exact scaling factor cap', () => {
      // u = 0.7: scalingFactor = min(3.5, 1 + (0.7-0.2)*5) = min(3.5, 3.5) = 3.5
      // result = 0.2 * 3.5 = 0.7
      expect(calculateBaseAPR(0.7)).toBeCloseTo(0.7);
    });

    it('should increase monotonically in the scaling region', () => {
      const apr03 = calculateBaseAPR(0.3);
      const apr04 = calculateBaseAPR(0.4);
      const apr05 = calculateBaseAPR(0.5);
      expect(apr04).toBeGreaterThan(apr03);
      expect(apr05).toBeGreaterThan(apr04);
    });
  });

  // =========================================================================
  // 15. calculateStakeDiscountFactor edge cases
  // =========================================================================
  describe('calculateStakeDiscountFactor (private)', () => {
    let calculateStakeDiscountFactor: (stakeFactor: number) => number;

    beforeEach(() => {
      calculateStakeDiscountFactor = (
        controller as any
      ).calculateStakeDiscountFactor.bind(controller);
    });

    it('should return 1.0 when stake factor is below optimal (0.25)', () => {
      expect(calculateStakeDiscountFactor(0)).toBe(1.0);
      expect(calculateStakeDiscountFactor(0.1)).toBe(1.0);
      expect(calculateStakeDiscountFactor(0.24)).toBe(1.0);
    });

    it('should return 1.0 at exactly the optimal stake factor', () => {
      expect(calculateStakeDiscountFactor(0.25)).toBe(1.0);
    });

    it('should return discount for stake factor above optimal', () => {
      // stakeFactor = 0.5: excessStake = 0.25, maxExcess = 0.75, discountRate = 0.9
      // result = max(0.1, 1.0 - (0.25/0.75) * 0.9) = max(0.1, 1.0 - 0.3) = 0.7
      expect(calculateStakeDiscountFactor(0.5)).toBeCloseTo(0.7);
    });

    it('should return near minimum for very high stake factor', () => {
      // stakeFactor = 1.0: excessStake = 0.75
      // result = max(0.1, 1.0 - (0.75/0.75) * 0.9) = max(0.1, 0.1) = 0.1
      expect(calculateStakeDiscountFactor(1.0)).toBeCloseTo(0.1);
    });

    it('should clamp at minimum 0.1 for extremely high stake factor', () => {
      // stakeFactor = 2.0: excessStake = 1.75
      // result = max(0.1, 1.0 - (1.75/0.75) * 0.9) = max(0.1, negative) = 0.1
      expect(calculateStakeDiscountFactor(2.0)).toBeCloseTo(0.1);
    });

    it('should decrease monotonically above optimal', () => {
      const d03 = calculateStakeDiscountFactor(0.3);
      const d05 = calculateStakeDiscountFactor(0.5);
      const d08 = calculateStakeDiscountFactor(0.8);
      expect(d05).toBeLessThan(d03);
      expect(d08).toBeLessThan(d05);
    });
  });

  // =========================================================================
  // formatStatus (private helper)
  // =========================================================================
  describe('formatStatus (private)', () => {
    it('should convert totalRewards bigint to string', () => {
      const status = makeDistributionStatus({ totalRewards: 123456789n });
      const formatted = (controller as any).formatStatus(status);

      expect(formatted.totalRewards).toBe('123456789');
    });

    it('should compute duration for completed distributions', () => {
      const start = new Date('2025-01-01T00:00:00Z');
      const end = new Date('2025-01-01T00:05:00Z'); // 5 minutes = 300000ms
      const status = makeDistributionStatus({
        startedAt: start,
        completedAt: end,
      });

      const formatted = (controller as any).formatStatus(status);

      expect(formatted.duration).toBe(300000);
    });

    it('should compute duration from now for in-progress distributions', () => {
      const start = new Date(Date.now() - 10000); // 10 seconds ago
      const status = makeDistributionStatus({
        startedAt: start,
        completedAt: undefined,
      });

      const formatted = (controller as any).formatStatus(status);

      // Duration should be approximately 10000ms (allow some slack for test execution)
      expect(formatted.duration).toBeGreaterThanOrEqual(9900);
      expect(formatted.duration).toBeLessThan(12000);
    });
  });
});
