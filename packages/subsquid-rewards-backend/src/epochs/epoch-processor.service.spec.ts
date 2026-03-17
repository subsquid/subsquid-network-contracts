import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EpochProcessorService } from './epoch-processor.service';
import { StatelessCoordinatorService } from './stateless-coordinator.service';
import { BlockSchedulerService } from './block-scheduler.service';
import { ContractService } from '../blockchain/contract.service';
import { RewardsCalculatorService } from '../rewards/calculation/rewards-calculator.service';
import { DistributionService } from '../rewards/distribution/distribution.service';
import { DistributionRecoveryService } from '../rewards/distribution/distribution-recovery.service';
import { CommitmentKeyService } from '../common';

// Suppress pino logger output during tests
jest.mock('../common/logger', () => ({
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

describe('EpochProcessor crash resilience', () => {
  let epochProcessor: EpochProcessorService;
  let blockScheduler: BlockSchedulerService;
  let mockContractService: any;
  let mockStatelessCoordinator: any;
  let mockDistributionService: any;
  let mockRecoveryService: any;
  let mockRewardsCalculator: any;
  let mockCommitmentKeyService: any;
  let mockConfigService: any;

  beforeEach(async () => {
    mockContractService = {
      getLastBlockRewarded: jest.fn().mockResolvedValue(0),
      getL1BlockNumber: jest.fn().mockResolvedValue(1000),
      getEpochLength: jest.fn().mockResolvedValue(100),
      getDistributionStatus: jest.fn().mockResolvedValue({
        nextFromBlock: 100,
        nextToBlock: 200,
        isReadyForDistribution: true,
        hasExistingCommitment: false,
      }),
      getCommitmentInfo: jest.fn().mockResolvedValue(null),
      getRequiredApprovals: jest.fn().mockResolvedValue(2),
      isNextDistributionReady: jest.fn().mockResolvedValue({
        blocksUntilReady: 0,
        needsConfirmation: false,
        nextFromBlock: 100,
        nextToBlock: 200,
      }),
      canCommit: jest.fn().mockResolvedValue(true),
      approveCommitment: jest.fn().mockResolvedValue(true),
      getCommitmentsNeedingApproval: jest.fn().mockResolvedValue([]),
      hasApprovedCommitment: jest.fn().mockResolvedValue(false),
      getPendingCommitments: jest.fn().mockResolvedValue([]),
      getRecentDistributionEvents: jest.fn().mockResolvedValue([]),
      getLastCommitmentKey: jest.fn().mockResolvedValue(
        '0x0000000000000000000000000000000000000000000000000000000000000000',
      ),
      getBondAmount: jest.fn().mockResolvedValue(0n),
      getActiveWorkerCount: jest.fn().mockResolvedValue(0n),
    };

    mockStatelessCoordinator = {
      isCurrentCommitter: jest.fn().mockResolvedValue({
        isCommitter: true,
        currentWindow: 1,
        blocksLeft: 50,
        reason: 'eligible committer',
      }),
      checkCommitEligibility: jest.fn().mockResolvedValue({
        eligible: true,
        blocksLeft: 50,
        windowInfo: {
          currentWindow: 1,
          windowStart: 0,
          windowEnd: 130,
          nextWindowStart: 131,
        },
      }),
      checkForPendingApprovals: jest.fn().mockResolvedValue({
        hasApprovals: false,
        pendingCommitments: [],
      }),
      shouldSkipRecovery: jest.fn().mockResolvedValue(true),
      shouldStartDistribution: jest.fn().mockResolvedValue(true),
      isAnotherBotDistributing: jest.fn().mockResolvedValue({ isActive: false }),
      shouldActivateRecovery: jest.fn().mockResolvedValue({ shouldActivate: false }),
    };

    mockDistributionService = {
      distributeEpochRewards: jest.fn().mockResolvedValue({
        status: 'completed',
        totalWorkers: 10,
        totalBatches: 2,
        totalRewards: 1000000000000000000n,
      }),
      getApprovedEpochsForDistribution: jest.fn().mockResolvedValue([]),
      generateMerkleTreeOnly: jest.fn().mockResolvedValue({
        root: '0xabc',
        totalBatches: 2,
      }),
      commitRootOnly: jest.fn().mockResolvedValue({ success: true }),
      distributeApprovedEpoch: jest.fn().mockResolvedValue(true),
      uploadEpochDataToS3: jest.fn().mockResolvedValue('https://s3.example.com/epoch-data'),
      distributionBatchSize: 75,
    };

    mockRecoveryService = {
      checkPendingDistributions: jest.fn().mockResolvedValue({
        lastCommitment: null,
        pendingRanges: [],
      }),
    };

    mockRewardsCalculator = {
      calculateRewardsDetailed: jest.fn().mockResolvedValue({
        workers: [{ address: '0x1', reward: 100n }],
      }),
    };

    mockCommitmentKeyService = {
      generateKey: jest.fn().mockReturnValue('0xcommitmentkey'),
    };

    mockConfigService = {
      get: jest.fn((key: string, defaultValue?: any) => {
        const config: Record<string, any> = {
          'rewards.enableAutoDistribution': true,
          'rewards.enableStartupRecoveryCheck': false,
          'rewards.roundRobinWindow': 130,
          'rewards.commitSafetyBuffer': 3,
          'rewards.distributionBlockInterval': 520,
          'rewards.useMerkleTree': true,
          'blockchain.distributor.privateKey': '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        };
        return config[key] !== undefined ? config[key] : defaultValue;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EpochProcessorService,
        BlockSchedulerService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: ContractService, useValue: mockContractService },
        { provide: StatelessCoordinatorService, useValue: mockStatelessCoordinator },
        { provide: DistributionService, useValue: mockDistributionService },
        { provide: DistributionRecoveryService, useValue: mockRecoveryService },
        { provide: RewardsCalculatorService, useValue: mockRewardsCalculator },
        { provide: CommitmentKeyService, useValue: mockCommitmentKeyService },
      ],
    }).compile();

    epochProcessor = module.get<EpochProcessorService>(EpochProcessorService);
    blockScheduler = module.get<BlockSchedulerService>(BlockSchedulerService);
  });

  describe('BlockScheduler crash resilience', () => {
    it('should survive and not rethrow when checkApprovalInterval encounters an error', async () => {
      mockStatelessCoordinator.checkForPendingApprovals.mockRejectedValue(
        new Error('RPC timeout'),
      );

      // Should not throw
      await expect(
        blockScheduler.checkApprovalInterval(),
      ).resolves.not.toThrow();

      // isApprovalProcessing should be reset to false
      const status = blockScheduler.getStatus();
      expect(status.isApprovalProcessing).toBe(false);
    });

    it('should survive and not rethrow when checkDistributionInterval encounters an error', async () => {
      mockContractService.isNextDistributionReady.mockRejectedValue(
        new Error('Network error'),
      );

      await expect(
        blockScheduler.checkDistributionInterval(),
      ).resolves.not.toThrow();

      const status = blockScheduler.getStatus();
      expect(status.isDistributionProcessing).toBe(false);
    });

    it('should survive and not rethrow when checkRecoveryInterval encounters an error', async () => {
      mockStatelessCoordinator.shouldSkipRecovery.mockRejectedValue(
        new Error('Contract call failed'),
      );

      await expect(
        blockScheduler.checkRecoveryInterval(),
      ).resolves.not.toThrow();

      const status = blockScheduler.getStatus();
      expect(status.isDistributionProcessing).toBe(false);
    });

    it('should not overlap approval — returns immediately if already processing', async () => {
      // Manually set isApprovalProcessing to true
      (blockScheduler as any).isApprovalProcessing = true;

      await blockScheduler.checkApprovalInterval();

      // Should not have called any downstream service
      expect(
        mockStatelessCoordinator.checkForPendingApprovals,
      ).not.toHaveBeenCalled();
    });

    it('should not overlap distribution — returns immediately if already processing', async () => {
      (blockScheduler as any).isDistributionProcessing = true;

      await blockScheduler.checkDistributionInterval();

      expect(
        mockContractService.isNextDistributionReady,
      ).not.toHaveBeenCalled();
    });

    it('should not overlap recovery — returns immediately if distribution is processing', async () => {
      (blockScheduler as any).isDistributionProcessing = true;

      await blockScheduler.checkRecoveryInterval();

      expect(
        mockStatelessCoordinator.shouldSkipRecovery,
      ).not.toHaveBeenCalled();
    });

    it('should reset isApprovalProcessing flag even when error occurs', async () => {
      mockStatelessCoordinator.checkForPendingApprovals.mockRejectedValue(
        new Error('Unexpected failure'),
      );

      await blockScheduler.checkApprovalInterval();

      expect(blockScheduler.getStatus().isApprovalProcessing).toBe(false);
    });

    it('should reset isDistributionProcessing flag even when error occurs in distribution', async () => {
      mockContractService.isNextDistributionReady.mockRejectedValue(
        new Error('RPC provider down'),
      );

      await blockScheduler.checkDistributionInterval();

      expect(blockScheduler.getStatus().isDistributionProcessing).toBe(false);
    });

    it('should reset isDistributionProcessing flag even when error occurs in recovery', async () => {
      mockStatelessCoordinator.shouldSkipRecovery.mockRejectedValue(
        new Error('Timeout'),
      );

      await blockScheduler.checkRecoveryInterval();

      expect(blockScheduler.getStatus().isDistributionProcessing).toBe(false);
    });

    it('should skip all processing when auto distribution is disabled', async () => {
      (blockScheduler as any).enableAutoDistribution = false;

      await blockScheduler.checkApprovalInterval();
      await blockScheduler.checkDistributionInterval();
      await blockScheduler.checkRecoveryInterval();

      expect(
        mockStatelessCoordinator.checkForPendingApprovals,
      ).not.toHaveBeenCalled();
      expect(
        mockContractService.isNextDistributionReady,
      ).not.toHaveBeenCalled();
      expect(
        mockStatelessCoordinator.shouldSkipRecovery,
      ).not.toHaveBeenCalled();
    });
  });

  describe('EpochProcessor error handling', () => {
    it('should return false and not throw when processDistribution encounters an error', async () => {
      mockStatelessCoordinator.isCurrentCommitter.mockRejectedValue(
        new Error('Contract error'),
      );

      const result = await epochProcessor.processDistribution();

      expect(result).toBe(false);
    });

    it('should not throw when processApproval encounters an RPC error', async () => {
      mockContractService.getDistributionStatus.mockRejectedValue(
        new Error('RPC error'),
      );

      // getEpochRange catches the error and returns [0,0], so processApproval
      // sees fromBlock >= toBlock and returns true (no blocks to process).
      // The key assertion: it does NOT throw.
      await expect(epochProcessor.processApproval()).resolves.not.toThrow();
    });

    it('should not throw when processEpoch encounters a network failure', async () => {
      mockContractService.getDistributionStatus.mockRejectedValue(
        new Error('Network failure'),
      );

      // Same as above: getEpochRange catches internally, returns [0,0].
      await expect(epochProcessor.processEpoch()).resolves.not.toThrow();
    });

    it('should handle checkCommitmentStatus errors gracefully', async () => {
      mockContractService.getDistributionStatus.mockRejectedValue(
        new Error('Timeout'),
      );

      const status = await epochProcessor.checkCommitmentStatus();

      expect(status.exists).toBe(false);
      expect(status.currentApprovals).toBe(0);
      expect(status.requiredApprovals).toBe(0);
    });

    it('should handle processExistingApprovals errors gracefully', async () => {
      mockStatelessCoordinator.checkForPendingApprovals.mockRejectedValue(
        new Error('RPC timeout'),
      );

      const result = await epochProcessor.processExistingApprovals();

      expect(result).toBe(false);
    });

    it('should skip distribution when not the current committer', async () => {
      mockStatelessCoordinator.isCurrentCommitter.mockResolvedValue({
        isCommitter: false,
        currentWindow: 1,
        blocksLeft: 50,
        reason: 'not current committer',
      });

      const result = await epochProcessor.processDistribution();

      expect(result).toBe(true);
      expect(
        mockDistributionService.getApprovedEpochsForDistribution,
      ).not.toHaveBeenCalled();
    });
  });
});

describe('BlockScheduler trigger/force methods', () => {
  let epochProcessor: EpochProcessorService;
  let blockScheduler: BlockSchedulerService;
  let mockContractService: any;
  let mockStatelessCoordinator: any;
  let mockDistributionService: any;
  let mockRecoveryService: any;
  let mockRewardsCalculator: any;
  let mockCommitmentKeyService: any;
  let mockConfigService: any;

  beforeEach(async () => {
    mockContractService = {
      getLastBlockRewarded: jest.fn().mockResolvedValue(0),
      getL1BlockNumber: jest.fn().mockResolvedValue(1000),
      getEpochLength: jest.fn().mockResolvedValue(100),
      getDistributionStatus: jest.fn().mockResolvedValue({
        nextFromBlock: 100,
        nextToBlock: 200,
        isReadyForDistribution: true,
        hasExistingCommitment: false,
      }),
      getCommitmentInfo: jest.fn().mockResolvedValue(null),
      getRequiredApprovals: jest.fn().mockResolvedValue(2),
      isNextDistributionReady: jest.fn().mockResolvedValue({
        blocksUntilReady: 0,
        needsConfirmation: false,
        nextFromBlock: 100,
        nextToBlock: 200,
      }),
      canCommit: jest.fn().mockResolvedValue(true),
      approveCommitment: jest.fn().mockResolvedValue(true),
      getCommitmentsNeedingApproval: jest.fn().mockResolvedValue([]),
      hasApprovedCommitment: jest.fn().mockResolvedValue(false),
      getPendingCommitments: jest.fn().mockResolvedValue([]),
      getRecentDistributionEvents: jest.fn().mockResolvedValue([]),
      getLastCommitmentKey: jest.fn().mockResolvedValue(
        '0x0000000000000000000000000000000000000000000000000000000000000000',
      ),
      getBondAmount: jest.fn().mockResolvedValue(0n),
      getActiveWorkerCount: jest.fn().mockResolvedValue(0n),
    };

    mockStatelessCoordinator = {
      isCurrentCommitter: jest.fn().mockResolvedValue({
        isCommitter: true,
        currentWindow: 1,
        blocksLeft: 50,
        reason: 'eligible committer',
      }),
      checkCommitEligibility: jest.fn().mockResolvedValue({
        eligible: true,
        blocksLeft: 50,
        windowInfo: {
          currentWindow: 1,
          windowStart: 0,
          windowEnd: 130,
          nextWindowStart: 131,
        },
      }),
      checkForPendingApprovals: jest.fn().mockResolvedValue({
        hasApprovals: false,
        pendingCommitments: [],
      }),
      shouldSkipRecovery: jest.fn().mockResolvedValue(true),
      shouldStartDistribution: jest.fn().mockResolvedValue(true),
      isAnotherBotDistributing: jest.fn().mockResolvedValue({ isActive: false }),
      shouldActivateRecovery: jest.fn().mockResolvedValue({ shouldActivate: false }),
    };

    mockDistributionService = {
      distributeEpochRewards: jest.fn().mockResolvedValue({
        status: 'completed',
        totalWorkers: 10,
        totalBatches: 2,
        totalRewards: 1000000000000000000n,
      }),
      getApprovedEpochsForDistribution: jest.fn().mockResolvedValue([]),
      generateMerkleTreeOnly: jest.fn().mockResolvedValue({
        root: '0xabc',
        totalBatches: 2,
      }),
      commitRootOnly: jest.fn().mockResolvedValue({ success: true }),
      distributeApprovedEpoch: jest.fn().mockResolvedValue(true),
      uploadEpochDataToS3: jest.fn().mockResolvedValue('https://s3.example.com/epoch-data'),
      distributionBatchSize: 75,
    };

    mockRecoveryService = {
      checkPendingDistributions: jest.fn().mockResolvedValue({
        lastCommitment: null,
        pendingRanges: [],
      }),
    };

    mockRewardsCalculator = {
      calculateRewardsDetailed: jest.fn().mockResolvedValue({
        workers: [{ address: '0x1', reward: 100n }],
      }),
    };

    mockCommitmentKeyService = {
      generateKey: jest.fn().mockReturnValue('0xcommitmentkey'),
    };

    mockConfigService = {
      get: jest.fn((key: string, defaultValue?: any) => {
        const config: Record<string, any> = {
          'rewards.enableAutoDistribution': true,
          'rewards.enableStartupRecoveryCheck': false,
          'rewards.roundRobinWindow': 130,
          'rewards.commitSafetyBuffer': 3,
          'rewards.distributionBlockInterval': 520,
          'rewards.useMerkleTree': true,
          'blockchain.distributor.privateKey': '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        };
        return config[key] !== undefined ? config[key] : defaultValue;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EpochProcessorService,
        BlockSchedulerService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: ContractService, useValue: mockContractService },
        { provide: StatelessCoordinatorService, useValue: mockStatelessCoordinator },
        { provide: DistributionService, useValue: mockDistributionService },
        { provide: DistributionRecoveryService, useValue: mockRecoveryService },
        { provide: RewardsCalculatorService, useValue: mockRewardsCalculator },
        { provide: CommitmentKeyService, useValue: mockCommitmentKeyService },
      ],
    }).compile();

    epochProcessor = module.get<EpochProcessorService>(EpochProcessorService);
    blockScheduler = module.get<BlockSchedulerService>(BlockSchedulerService);
  });

  describe('triggerManualApprovalCheck', () => {
    it('should return true on successful approval check', async () => {
      const result = await blockScheduler.triggerManualApprovalCheck();
      expect(result).toBe(true);
    });

    it('should return true even when checkApprovalInterval internally catches errors', async () => {
      // checkApprovalInterval catches its own errors, so triggerManualApprovalCheck
      // should always return true unless there is an unexpected synchronous throw
      mockStatelessCoordinator.checkForPendingApprovals.mockRejectedValue(
        new Error('RPC timeout'),
      );

      const result = await blockScheduler.triggerManualApprovalCheck();
      // The inner method catches the error, so the outer wrapper sees no throw
      expect(result).toBe(true);
    });
  });

  describe('triggerManualDistributionCheck', () => {
    it('should return true on successful distribution check', async () => {
      const result = await blockScheduler.triggerManualDistributionCheck();
      expect(result).toBe(true);
    });

    it('should return true even when checkDistributionInterval internally catches errors', async () => {
      mockContractService.isNextDistributionReady.mockRejectedValue(
        new Error('Network failure'),
      );

      const result = await blockScheduler.triggerManualDistributionCheck();
      expect(result).toBe(true);
    });
  });

  describe('triggerManualRecoveryCheck', () => {
    it('should return true on successful recovery check', async () => {
      const result = await blockScheduler.triggerManualRecoveryCheck();
      expect(result).toBe(true);
    });

    it('should return true even when checkRecoveryInterval internally catches errors', async () => {
      mockStatelessCoordinator.shouldSkipRecovery.mockRejectedValue(
        new Error('Contract call failed'),
      );

      const result = await blockScheduler.triggerManualRecoveryCheck();
      expect(result).toBe(true);
    });
  });

  describe('forceCommit', () => {
    it('should return true when processApproval succeeds', async () => {
      const result = await blockScheduler.forceCommit(100, 200);
      expect(result).toBe(true);
    });

    it('should return false and log when processApproval throws', async () => {
      mockContractService.getDistributionStatus.mockRejectedValue(
        new Error('Unexpected error in processApproval'),
      );

      // getEpochRange catches internally and returns [0,0], so processApproval
      // returns true (no blocks). Let us force an error that propagates:
      jest.spyOn(epochProcessor, 'processApproval').mockRejectedValue(
        new Error('Force commit RPC error'),
      );

      const result = await blockScheduler.forceCommit(100, 200);
      expect(result).toBe(false);
    });
  });

  describe('forceDistribution', () => {
    it('should return true when processDistribution succeeds', async () => {
      const result = await blockScheduler.forceDistribution(100, 200);
      expect(result).toBe(true);
    });

    it('should return false and log when processDistribution throws', async () => {
      jest.spyOn(epochProcessor, 'processDistribution').mockRejectedValue(
        new Error('Force distribution RPC error'),
      );

      const result = await blockScheduler.forceDistribution(100, 200);
      expect(result).toBe(false);
    });
  });

  describe('getStatus', () => {
    it('should return correct enabled and processing flags at initialization', () => {
      const status = blockScheduler.getStatus();
      expect(status.enabled).toBe(true);
      expect(status.isApprovalProcessing).toBe(false);
      expect(status.isDistributionProcessing).toBe(false);
    });

    it('should reflect updated processing state', () => {
      (blockScheduler as any).isApprovalProcessing = true;
      (blockScheduler as any).isDistributionProcessing = true;

      const status = blockScheduler.getStatus();
      expect(status.isApprovalProcessing).toBe(true);
      expect(status.isDistributionProcessing).toBe(true);
    });
  });
});

describe('EpochProcessor onModuleInit', () => {
  let mockContractService: any;
  let mockStatelessCoordinator: any;
  let mockDistributionService: any;
  let mockRecoveryService: any;
  let mockRewardsCalculator: any;
  let mockCommitmentKeyService: any;

  const zeroKey =
    '0x0000000000000000000000000000000000000000000000000000000000000000';
  const nonZeroKey =
    '0xabc0000000000000000000000000000000000000000000000000000000000001';

  function createMocks() {
    mockContractService = {
      getLastBlockRewarded: jest.fn().mockResolvedValue(500),
      getL1BlockNumber: jest.fn().mockResolvedValue(1000),
      getEpochLength: jest.fn().mockResolvedValue(100),
      getDistributionStatus: jest.fn().mockResolvedValue({
        nextFromBlock: 100,
        nextToBlock: 200,
        isReadyForDistribution: true,
        hasExistingCommitment: false,
      }),
      getCommitmentInfo: jest.fn().mockResolvedValue(null),
      getRequiredApprovals: jest.fn().mockResolvedValue(2),
      isNextDistributionReady: jest.fn().mockResolvedValue({
        blocksUntilReady: 0,
        needsConfirmation: false,
        nextFromBlock: 100,
        nextToBlock: 200,
      }),
      canCommit: jest.fn().mockResolvedValue(true),
      approveCommitment: jest.fn().mockResolvedValue(true),
      getCommitmentsNeedingApproval: jest.fn().mockResolvedValue([]),
      hasApprovedCommitment: jest.fn().mockResolvedValue(false),
      getPendingCommitments: jest.fn().mockResolvedValue([]),
      getRecentDistributionEvents: jest.fn().mockResolvedValue([]),
      getLastCommitmentKey: jest.fn().mockResolvedValue(zeroKey),
      getBondAmount: jest.fn().mockResolvedValue(0n),
      getActiveWorkerCount: jest.fn().mockResolvedValue(0n),
    };

    mockStatelessCoordinator = {
      isCurrentCommitter: jest.fn().mockResolvedValue({
        isCommitter: true,
        currentWindow: 1,
        blocksLeft: 50,
        reason: 'eligible committer',
      }),
      checkCommitEligibility: jest.fn().mockResolvedValue({
        eligible: true,
        blocksLeft: 50,
        windowInfo: {
          currentWindow: 1,
          windowStart: 0,
          windowEnd: 130,
          nextWindowStart: 131,
        },
      }),
      checkForPendingApprovals: jest.fn().mockResolvedValue({
        hasApprovals: false,
        pendingCommitments: [],
      }),
      shouldSkipRecovery: jest.fn().mockResolvedValue(true),
      shouldStartDistribution: jest.fn().mockResolvedValue(true),
      isAnotherBotDistributing: jest.fn().mockResolvedValue({ isActive: false }),
      shouldActivateRecovery: jest.fn().mockResolvedValue({ shouldActivate: false }),
    };

    mockDistributionService = {
      distributeEpochRewards: jest.fn().mockResolvedValue({
        status: 'completed',
        totalWorkers: 10,
        totalBatches: 2,
        totalRewards: 1000000000000000000n,
      }),
      getApprovedEpochsForDistribution: jest.fn().mockResolvedValue([]),
      generateMerkleTreeOnly: jest.fn().mockResolvedValue({
        root: '0xabc',
        totalBatches: 2,
      }),
      commitRootOnly: jest.fn().mockResolvedValue({ success: true }),
      distributeApprovedEpoch: jest.fn().mockResolvedValue(true),
      uploadEpochDataToS3: jest.fn().mockResolvedValue('https://s3.example.com/epoch-data'),
      distributionBatchSize: 75,
    };

    mockRecoveryService = {
      checkPendingDistributions: jest.fn().mockResolvedValue({
        lastCommitment: null,
        pendingRanges: [],
      }),
    };

    mockRewardsCalculator = {
      calculateRewardsDetailed: jest.fn().mockResolvedValue({
        workers: [{ address: '0x1', reward: 100n }],
      }),
    };

    mockCommitmentKeyService = {
      generateKey: jest.fn().mockReturnValue('0xcommitmentkey'),
    };
  }

  async function buildService(enableRecoveryCheck: boolean) {
    const mockConfigService = {
      get: jest.fn((key: string, defaultValue?: any) => {
        const config: Record<string, any> = {
          'rewards.enableAutoDistribution': true,
          'rewards.enableStartupRecoveryCheck': enableRecoveryCheck,
          'rewards.roundRobinWindow': 130,
          'rewards.commitSafetyBuffer': 3,
          'rewards.distributionBlockInterval': 520,
          'rewards.useMerkleTree': true,
          'blockchain.distributor.privateKey':
            '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        };
        return config[key] !== undefined ? config[key] : defaultValue;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EpochProcessorService,
        BlockSchedulerService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: ContractService, useValue: mockContractService },
        { provide: StatelessCoordinatorService, useValue: mockStatelessCoordinator },
        { provide: DistributionService, useValue: mockDistributionService },
        { provide: DistributionRecoveryService, useValue: mockRecoveryService },
        { provide: RewardsCalculatorService, useValue: mockRewardsCalculator },
        { provide: CommitmentKeyService, useValue: mockCommitmentKeyService },
      ],
    }).compile();

    return module.get<EpochProcessorService>(EpochProcessorService);
  }

  beforeEach(() => {
    createMocks();
  });

  it('should skip when enableRecoveryCheck is false', async () => {
    const service = await buildService(false);

    await service.onModuleInit();

    expect(mockContractService.getLastBlockRewarded).not.toHaveBeenCalled();
  });

  it('should handle lastBlockRewarded = 0 (no previous distributions)', async () => {
    mockContractService.getLastBlockRewarded.mockResolvedValue(0);

    const service = await buildService(true);
    await service.onModuleInit();

    expect(mockContractService.getLastBlockRewarded).toHaveBeenCalled();
    // Should return early - no call to getLastCommitmentKey
    expect(mockContractService.getLastCommitmentKey).not.toHaveBeenCalled();
  });

  it('should handle ContractFunctionExecutionError in getLastBlockRewarded', async () => {
    const error = new Error('ContractFunctionExecutionError: lastBlockRewarded reverted');
    mockContractService.getLastBlockRewarded.mockRejectedValue(error);

    const service = await buildService(true);

    // Should not throw
    await expect(service.onModuleInit()).resolves.not.toThrow();

    // Should not proceed to getLastCommitmentKey
    expect(mockContractService.getLastCommitmentKey).not.toHaveBeenCalled();
  });

  it('should handle lastCommitmentKey !== zeroKey with active commitment (status 1)', async () => {
    mockContractService.getLastBlockRewarded.mockResolvedValue(500);
    mockContractService.getLastCommitmentKey.mockResolvedValue(nonZeroKey);
    mockRecoveryService.checkPendingDistributions.mockResolvedValue({
      lastCommitment: {
        fromBlock: 400,
        toBlock: 500,
        status: 1,
        processedBatches: 1,
        totalBatches: 3,
      },
      pendingRanges: [],
    });

    const service = await buildService(true);
    await service.onModuleInit();

    expect(mockRecoveryService.checkPendingDistributions).toHaveBeenCalled();
  });

  it('should handle lastCommitmentKey !== zeroKey with completed commitment (status 2)', async () => {
    mockContractService.getLastBlockRewarded.mockResolvedValue(500);
    mockContractService.getLastCommitmentKey.mockResolvedValue(nonZeroKey);
    mockRecoveryService.checkPendingDistributions.mockResolvedValue({
      lastCommitment: {
        fromBlock: 400,
        toBlock: 500,
        status: 2,
        processedBatches: 3,
        totalBatches: 3,
      },
      pendingRanges: [],
    });

    const service = await buildService(true);
    await service.onModuleInit();

    expect(mockRecoveryService.checkPendingDistributions).toHaveBeenCalled();
  });

  it('should handle lastCommitmentKey fetch error (uses zero key)', async () => {
    mockContractService.getLastBlockRewarded.mockResolvedValue(500);
    mockContractService.getLastCommitmentKey.mockRejectedValue(
      new Error('RPC error'),
    );
    mockRecoveryService.checkPendingDistributions.mockResolvedValue({
      lastCommitment: null,
      pendingRanges: [],
    });

    const service = await buildService(true);
    await service.onModuleInit();

    // Should still continue - the catch block sets lastCommitmentKey to zeroKey
    // and skips the commitment status check block since lastCommitmentKey === zeroKey
    expect(mockContractService.getL1BlockNumber).toHaveBeenCalled();
  });

  it('should log warning when missed epochs detected', async () => {
    mockContractService.getLastBlockRewarded.mockResolvedValue(500);
    mockContractService.getLastCommitmentKey.mockResolvedValue(zeroKey);
    mockContractService.getL1BlockNumber.mockResolvedValue(2000);
    mockContractService.getEpochLength.mockResolvedValue(100);
    mockRecoveryService.checkPendingDistributions.mockResolvedValue({
      lastCommitment: null,
      pendingRanges: [],
    });

    const service = await buildService(true);
    await service.onModuleInit();

    // blocksSinceLastReward = 2000 - 500 = 1500, epochLength = 100
    // 1500 > 100, so missedEpochs = 15
    expect(mockContractService.getL1BlockNumber).toHaveBeenCalled();
    expect(mockContractService.getEpochLength).toHaveBeenCalled();
  });

  it('should log info when blocks since last reward < epochLength', async () => {
    mockContractService.getLastBlockRewarded.mockResolvedValue(950);
    mockContractService.getLastCommitmentKey.mockResolvedValue(zeroKey);
    mockContractService.getL1BlockNumber.mockResolvedValue(1000);
    mockContractService.getEpochLength.mockResolvedValue(100);
    mockRecoveryService.checkPendingDistributions.mockResolvedValue({
      lastCommitment: null,
      pendingRanges: [],
    });

    const service = await buildService(true);
    await service.onModuleInit();

    // blocksSinceLastReward = 1000 - 950 = 50, epochLength = 100
    // 50 <= 100, so logs info
    expect(mockContractService.getL1BlockNumber).toHaveBeenCalled();
  });

  it('should handle pendingRanges found', async () => {
    mockContractService.getLastBlockRewarded.mockResolvedValue(500);
    mockContractService.getLastCommitmentKey.mockResolvedValue(zeroKey);
    mockRecoveryService.checkPendingDistributions.mockResolvedValue({
      lastCommitment: null,
      pendingRanges: [{ fromBlock: 300, toBlock: 400 }],
    });

    const service = await buildService(true);
    await service.onModuleInit();

    expect(mockRecoveryService.checkPendingDistributions).toHaveBeenCalled();
  });

  it('should catch top-level error gracefully', async () => {
    mockContractService.getLastBlockRewarded.mockResolvedValue(500);
    mockContractService.getLastCommitmentKey.mockResolvedValue(zeroKey);
    // Make checkPendingDistributions succeed for the first call (inside the
    // lastCommitmentKey !== zeroKey block - but we use zeroKey so it's skipped),
    // then fail on the outer call to trigger the top-level catch
    mockRecoveryService.checkPendingDistributions.mockRejectedValue(
      new Error('Unexpected failure'),
    );

    const service = await buildService(true);

    // Should not throw - caught by outer try/catch
    await expect(service.onModuleInit()).resolves.not.toThrow();
  });

  it('should rethrow non-ContractFunctionExecutionError from getLastBlockRewarded (caught by outer catch)', async () => {
    // Error that does NOT match any of the known contract error patterns
    const error = new Error('Some completely unrelated RPC error');
    mockContractService.getLastBlockRewarded.mockRejectedValue(error);

    const service = await buildService(true);

    // The inner catch rethrows, the outer catch at line 127-128 catches it
    await expect(service.onModuleInit()).resolves.not.toThrow();

    // Should not proceed to getLastCommitmentKey since the error was rethrown
    expect(mockContractService.getLastCommitmentKey).not.toHaveBeenCalled();
  });

  it('should handle checkPendingDistributions error inside lastCommitmentKey block', async () => {
    mockContractService.getLastBlockRewarded.mockResolvedValue(500);
    mockContractService.getLastCommitmentKey.mockResolvedValue(nonZeroKey);
    // First call (inside lastCommitmentKey !== zeroKey block) throws
    // Second call (the outer one) should succeed
    mockRecoveryService.checkPendingDistributions
      .mockRejectedValueOnce(new Error('RPC timeout'))
      .mockResolvedValueOnce({
        lastCommitment: null,
        pendingRanges: [],
      });

    const service = await buildService(true);
    await service.onModuleInit();

    // Should still continue past the error - the catch at line 94-96 logs debug and continues
    expect(mockContractService.getL1BlockNumber).toHaveBeenCalled();
  });
});

describe('EpochProcessor processEpochWithMerkleTree', () => {
  let epochProcessor: EpochProcessorService;
  let mockContractService: any;
  let mockStatelessCoordinator: any;
  let mockDistributionService: any;
  let mockRecoveryService: any;
  let mockRewardsCalculator: any;
  let mockCommitmentKeyService: any;
  let mockConfigService: any;

  beforeEach(async () => {
    mockContractService = {
      getLastBlockRewarded: jest.fn().mockResolvedValue(0),
      getL1BlockNumber: jest.fn().mockResolvedValue(1000),
      getEpochLength: jest.fn().mockResolvedValue(100),
      getDistributionStatus: jest.fn().mockResolvedValue({
        nextFromBlock: 100,
        nextToBlock: 200,
        isReadyForDistribution: true,
        hasExistingCommitment: false,
      }),
      getCommitmentInfo: jest.fn().mockResolvedValue(null),
      getRequiredApprovals: jest.fn().mockResolvedValue(2),
      isNextDistributionReady: jest.fn().mockResolvedValue({
        blocksUntilReady: 0,
        needsConfirmation: false,
        nextFromBlock: 100,
        nextToBlock: 200,
      }),
      canCommit: jest.fn().mockResolvedValue(true),
      approveCommitment: jest.fn().mockResolvedValue(true),
      getCommitmentsNeedingApproval: jest.fn().mockResolvedValue([]),
      hasApprovedCommitment: jest.fn().mockResolvedValue(false),
      getPendingCommitments: jest.fn().mockResolvedValue([]),
      getRecentDistributionEvents: jest.fn().mockResolvedValue([]),
      getLastCommitmentKey: jest.fn().mockResolvedValue(
        '0x0000000000000000000000000000000000000000000000000000000000000000',
      ),
      getBondAmount: jest.fn().mockResolvedValue(0n),
      getActiveWorkerCount: jest.fn().mockResolvedValue(0n),
    };

    mockStatelessCoordinator = {
      isCurrentCommitter: jest.fn().mockResolvedValue({
        isCommitter: true,
        currentWindow: 1,
        blocksLeft: 50,
        reason: 'eligible committer',
      }),
      checkCommitEligibility: jest.fn().mockResolvedValue({
        eligible: true,
        blocksLeft: 50,
        windowInfo: {
          currentWindow: 1,
          windowStart: 0,
          windowEnd: 130,
          nextWindowStart: 131,
        },
      }),
      checkForPendingApprovals: jest.fn().mockResolvedValue({
        hasApprovals: false,
        pendingCommitments: [],
      }),
      shouldSkipRecovery: jest.fn().mockResolvedValue(true),
      shouldStartDistribution: jest.fn().mockResolvedValue(true),
      isAnotherBotDistributing: jest.fn().mockResolvedValue({ isActive: false }),
      shouldActivateRecovery: jest.fn().mockResolvedValue({ shouldActivate: false }),
    };

    mockDistributionService = {
      distributeEpochRewards: jest.fn().mockResolvedValue({
        status: 'completed',
        totalWorkers: 10,
        totalBatches: 2,
        totalRewards: 1000000000000000000n,
      }),
      getApprovedEpochsForDistribution: jest.fn().mockResolvedValue([]),
      generateMerkleTreeOnly: jest.fn().mockResolvedValue({
        root: '0xabc',
        totalBatches: 2,
      }),
      commitRootOnly: jest.fn().mockResolvedValue({ success: true }),
      distributeApprovedEpoch: jest.fn().mockResolvedValue(true),
      uploadEpochDataToS3: jest.fn().mockResolvedValue('https://s3.example.com/epoch-data'),
      distributionBatchSize: 75,
    };

    mockRecoveryService = {
      checkPendingDistributions: jest.fn().mockResolvedValue({
        lastCommitment: null,
        pendingRanges: [],
      }),
    };

    mockRewardsCalculator = {
      calculateRewardsDetailed: jest.fn().mockResolvedValue({
        workers: [{ address: '0x1', reward: 100n }],
      }),
    };

    mockCommitmentKeyService = {
      generateKey: jest.fn().mockReturnValue('0xcommitmentkey'),
    };

    mockConfigService = {
      get: jest.fn((key: string, defaultValue?: any) => {
        const config: Record<string, any> = {
          'rewards.enableAutoDistribution': true,
          'rewards.enableStartupRecoveryCheck': false,
          'rewards.roundRobinWindow': 130,
          'rewards.commitSafetyBuffer': 3,
          'rewards.distributionBlockInterval': 520,
          'rewards.useMerkleTree': true,
          'blockchain.distributor.privateKey':
            '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        };
        return config[key] !== undefined ? config[key] : defaultValue;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EpochProcessorService,
        BlockSchedulerService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: ContractService, useValue: mockContractService },
        { provide: StatelessCoordinatorService, useValue: mockStatelessCoordinator },
        { provide: DistributionService, useValue: mockDistributionService },
        { provide: DistributionRecoveryService, useValue: mockRecoveryService },
        { provide: RewardsCalculatorService, useValue: mockRewardsCalculator },
        { provide: CommitmentKeyService, useValue: mockCommitmentKeyService },
      ],
    }).compile();

    epochProcessor = module.get<EpochProcessorService>(EpochProcessorService);
  });

  it('should return true when distribution completes successfully', async () => {
    // processEpoch calls getEpochRange then processEpochWithMerkleTree
    const result = await epochProcessor.processEpoch();

    expect(result).toBe(true);
    expect(mockDistributionService.distributeEpochRewards).toHaveBeenCalledWith(
      100,
      200,
      75,
    );
  });

  it('should return false when distribution fails (status !== completed)', async () => {
    mockDistributionService.distributeEpochRewards.mockResolvedValue({
      status: 'failed',
      error: 'Batch processing error',
      totalWorkers: 0,
      totalBatches: 0,
      totalRewards: 0n,
    });

    const result = await epochProcessor.processEpoch();

    expect(result).toBe(false);
  });

  it('should return false when distributeEpochRewards throws', async () => {
    mockDistributionService.distributeEpochRewards.mockRejectedValue(
      new Error('RPC failure'),
    );

    const result = await epochProcessor.processEpoch();

    expect(result).toBe(false);
  });
});

describe('EpochProcessor processApprovalWithMerkleTree - full flow', () => {
  let epochProcessor: EpochProcessorService;
  let mockContractService: any;
  let mockStatelessCoordinator: any;
  let mockDistributionService: any;
  let mockRecoveryService: any;
  let mockRewardsCalculator: any;
  let mockCommitmentKeyService: any;
  let mockConfigService: any;

  beforeEach(async () => {
    mockContractService = {
      getLastBlockRewarded: jest.fn().mockResolvedValue(0),
      getL1BlockNumber: jest.fn().mockResolvedValue(1000),
      getEpochLength: jest.fn().mockResolvedValue(100),
      getDistributionStatus: jest.fn().mockResolvedValue({
        nextFromBlock: 100,
        nextToBlock: 200,
        isReadyForDistribution: true,
        hasExistingCommitment: false,
      }),
      getCommitmentInfo: jest.fn().mockResolvedValue(null),
      getRequiredApprovals: jest.fn().mockResolvedValue(2),
      isNextDistributionReady: jest.fn().mockResolvedValue({
        blocksUntilReady: 0,
        needsConfirmation: false,
        nextFromBlock: 100,
        nextToBlock: 200,
      }),
      canCommit: jest.fn().mockResolvedValue(true),
      approveCommitment: jest.fn().mockResolvedValue(true),
      getCommitmentsNeedingApproval: jest.fn().mockResolvedValue([]),
      hasApprovedCommitment: jest.fn().mockResolvedValue(false),
      getPendingCommitments: jest.fn().mockResolvedValue([]),
      getRecentDistributionEvents: jest.fn().mockResolvedValue([]),
      getLastCommitmentKey: jest.fn().mockResolvedValue(
        '0x0000000000000000000000000000000000000000000000000000000000000000',
      ),
      getBondAmount: jest.fn().mockResolvedValue(0n),
      getActiveWorkerCount: jest.fn().mockResolvedValue(0n),
    };

    mockStatelessCoordinator = {
      isCurrentCommitter: jest.fn().mockResolvedValue({
        isCommitter: true,
        currentWindow: 1,
        blocksLeft: 50,
        reason: 'eligible committer',
      }),
      checkCommitEligibility: jest.fn().mockResolvedValue({
        eligible: true,
        blocksLeft: 50,
        windowInfo: {
          currentWindow: 1,
          windowStart: 0,
          windowEnd: 130,
          nextWindowStart: 131,
        },
      }),
      checkForPendingApprovals: jest.fn().mockResolvedValue({
        hasApprovals: false,
        pendingCommitments: [],
      }),
      shouldSkipRecovery: jest.fn().mockResolvedValue(true),
      shouldStartDistribution: jest.fn().mockResolvedValue(true),
      isAnotherBotDistributing: jest.fn().mockResolvedValue({ isActive: false }),
      shouldActivateRecovery: jest.fn().mockResolvedValue({ shouldActivate: false }),
    };

    mockDistributionService = {
      distributeEpochRewards: jest.fn().mockResolvedValue({
        status: 'completed',
        totalWorkers: 10,
        totalBatches: 2,
        totalRewards: 1000000000000000000n,
      }),
      getApprovedEpochsForDistribution: jest.fn().mockResolvedValue([]),
      generateMerkleTreeOnly: jest.fn().mockResolvedValue({
        root: '0xabc',
        totalBatches: 2,
      }),
      commitRootOnly: jest.fn().mockResolvedValue({ success: true }),
      distributeApprovedEpoch: jest.fn().mockResolvedValue(true),
      uploadEpochDataToS3: jest.fn().mockResolvedValue('https://s3.example.com/epoch-data'),
      distributionBatchSize: 75,
    };

    mockRecoveryService = {
      checkPendingDistributions: jest.fn().mockResolvedValue({
        lastCommitment: null,
        pendingRanges: [],
      }),
    };

    mockRewardsCalculator = {
      calculateRewardsDetailed: jest.fn().mockResolvedValue({
        workers: [{ address: '0x1', reward: 100n }],
      }),
    };

    mockCommitmentKeyService = {
      generateKey: jest.fn().mockReturnValue('0xcommitmentkey'),
    };

    mockConfigService = {
      get: jest.fn((key: string, defaultValue?: any) => {
        const config: Record<string, any> = {
          'rewards.enableAutoDistribution': true,
          'rewards.enableStartupRecoveryCheck': false,
          'rewards.roundRobinWindow': 130,
          'rewards.commitSafetyBuffer': 3,
          'rewards.distributionBlockInterval': 520,
          'rewards.useMerkleTree': true,
          'blockchain.distributor.privateKey':
            '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        };
        return config[key] !== undefined ? config[key] : defaultValue;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EpochProcessorService,
        BlockSchedulerService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: ContractService, useValue: mockContractService },
        { provide: StatelessCoordinatorService, useValue: mockStatelessCoordinator },
        { provide: DistributionService, useValue: mockDistributionService },
        { provide: DistributionRecoveryService, useValue: mockRecoveryService },
        { provide: RewardsCalculatorService, useValue: mockRewardsCalculator },
        { provide: CommitmentKeyService, useValue: mockCommitmentKeyService },
      ],
    }).compile();

    epochProcessor = module.get<EpochProcessorService>(EpochProcessorService);
  });

  it('should handle existing commitment where current bot is committer (returns true)', async () => {
    mockContractService.getCommitmentInfo.mockResolvedValue({
      status: 1,
      approvalCount: 1n,
    });
    mockStatelessCoordinator.isCurrentCommitter.mockResolvedValue({
      isCommitter: true,
      currentWindow: 1,
      blocksLeft: 50,
      reason: 'eligible committer',
    });

    const result = await epochProcessor.processNewCommitment();

    expect(result).toBe(true);
    // Should not proceed to calculate rewards since commitment already exists
    expect(mockRewardsCalculator.calculateRewardsDetailed).not.toHaveBeenCalled();
  });

  it('should handle existing commitment needing approval (non-committer, status 1, approvalCount 0)', async () => {
    mockContractService.getCommitmentInfo.mockResolvedValue({
      status: 1,
      approvalCount: 0n,
    });
    mockStatelessCoordinator.isCurrentCommitter.mockResolvedValue({
      isCommitter: false,
      currentWindow: 1,
      blocksLeft: 50,
      reason: 'not current committer',
    });

    const result = await epochProcessor.processNewCommitment();

    expect(result).toBe(true);
    expect(mockContractService.approveCommitment).toHaveBeenCalledWith(100, 200);
  });

  it('should handle checkCommitEligibility returning not eligible', async () => {
    // No existing commitment
    mockContractService.getCommitmentInfo.mockResolvedValue(null);
    mockStatelessCoordinator.isCurrentCommitter.mockResolvedValue({
      isCommitter: true,
      currentWindow: 1,
      blocksLeft: 50,
      reason: 'eligible committer',
    });
    mockStatelessCoordinator.checkCommitEligibility.mockResolvedValue({
      eligible: false,
      reason: 'Too late in window',
      blocksLeft: 0,
    });

    const result = await epochProcessor.processNewCommitment();

    expect(result).toBe(true);
    expect(mockRewardsCalculator.calculateRewardsDetailed).not.toHaveBeenCalled();
  });

  it('should handle no workers found (returns true)', async () => {
    mockContractService.getCommitmentInfo.mockResolvedValue(null);
    mockStatelessCoordinator.isCurrentCommitter.mockResolvedValue({
      isCommitter: true,
      currentWindow: 1,
      blocksLeft: 50,
      reason: 'eligible committer',
    });
    mockStatelessCoordinator.checkCommitEligibility.mockResolvedValue({
      eligible: true,
      blocksLeft: 50,
    });
    mockRewardsCalculator.calculateRewardsDetailed.mockResolvedValue({
      workers: [],
    });

    const result = await epochProcessor.processNewCommitment();

    expect(result).toBe(true);
    expect(mockDistributionService.generateMerkleTreeOnly).not.toHaveBeenCalled();
  });

  it('should execute full commit flow: calculateRewardsDetailed -> generateMerkleTreeOnly -> commitRootOnly -> uploadEpochDataToS3', async () => {
    mockContractService.getCommitmentInfo.mockResolvedValue(null);
    mockStatelessCoordinator.isCurrentCommitter.mockResolvedValue({
      isCommitter: true,
      currentWindow: 1,
      blocksLeft: 50,
      reason: 'eligible committer',
    });
    mockStatelessCoordinator.checkCommitEligibility.mockResolvedValue({
      eligible: true,
      blocksLeft: 50,
    });

    const workers = [{ address: '0x1', reward: 100n }];
    mockRewardsCalculator.calculateRewardsDetailed.mockResolvedValue({ workers });
    mockDistributionService.generateMerkleTreeOnly.mockResolvedValue({
      root: '0xmerkleroot',
      totalBatches: 3,
    });
    mockDistributionService.commitRootOnly.mockResolvedValue({ success: true });
    mockDistributionService.uploadEpochDataToS3.mockResolvedValue(
      'https://s3.example.com/data',
    );

    const result = await epochProcessor.processNewCommitment();

    expect(result).toBe(true);
    expect(mockRewardsCalculator.calculateRewardsDetailed).toHaveBeenCalledWith(
      expect.anything(),
      100,
      200,
      true,
    );
    expect(mockDistributionService.generateMerkleTreeOnly).toHaveBeenCalledWith(
      workers,
      75,
    );
    expect(mockDistributionService.commitRootOnly).toHaveBeenCalledWith(
      100,
      200,
      '0xmerkleroot',
      3,
      '',
      workers,
      { root: '0xmerkleroot', totalBatches: 3 },
      75,
    );
    expect(mockDistributionService.uploadEpochDataToS3).toHaveBeenCalledWith(
      100,
      200,
      '0xmerkleroot',
      3,
      workers,
      { root: '0xmerkleroot', totalBatches: 3 },
      75,
    );
  });

  it('should handle commitRootOnly failure', async () => {
    mockContractService.getCommitmentInfo.mockResolvedValue(null);
    mockStatelessCoordinator.isCurrentCommitter.mockResolvedValue({
      isCommitter: true,
      currentWindow: 1,
      blocksLeft: 50,
      reason: 'eligible committer',
    });
    mockStatelessCoordinator.checkCommitEligibility.mockResolvedValue({
      eligible: true,
      blocksLeft: 50,
    });
    mockRewardsCalculator.calculateRewardsDetailed.mockResolvedValue({
      workers: [{ address: '0x1', reward: 100n }],
    });
    mockDistributionService.generateMerkleTreeOnly.mockResolvedValue({
      root: '0xabc',
      totalBatches: 2,
    });
    mockDistributionService.commitRootOnly.mockResolvedValue({ success: false });

    const result = await epochProcessor.processNewCommitment();

    expect(result).toBe(false);
    expect(mockDistributionService.uploadEpochDataToS3).not.toHaveBeenCalled();
  });

  it('should handle S3 upload failure (still returns true since commit succeeded)', async () => {
    mockContractService.getCommitmentInfo.mockResolvedValue(null);
    mockStatelessCoordinator.isCurrentCommitter.mockResolvedValue({
      isCommitter: true,
      currentWindow: 1,
      blocksLeft: 50,
      reason: 'eligible committer',
    });
    mockStatelessCoordinator.checkCommitEligibility.mockResolvedValue({
      eligible: true,
      blocksLeft: 50,
    });
    mockRewardsCalculator.calculateRewardsDetailed.mockResolvedValue({
      workers: [{ address: '0x1', reward: 100n }],
    });
    mockDistributionService.generateMerkleTreeOnly.mockResolvedValue({
      root: '0xabc',
      totalBatches: 2,
    });
    mockDistributionService.commitRootOnly.mockResolvedValue({ success: true });
    mockDistributionService.uploadEpochDataToS3.mockRejectedValue(
      new Error('S3 upload failed'),
    );

    const result = await epochProcessor.processNewCommitment();

    // Should still return true - S3 failure is caught and logged but doesn't fail the commit
    expect(result).toBe(true);
  });

  it('should return true when non-committer and no existing commitment', async () => {
    mockContractService.getCommitmentInfo.mockResolvedValue(null);
    mockStatelessCoordinator.isCurrentCommitter.mockResolvedValue({
      isCommitter: false,
      currentWindow: 1,
      blocksLeft: 50,
      reason: 'not current committer',
    });

    const result = await epochProcessor.processNewCommitment();

    expect(result).toBe(true);
    expect(mockStatelessCoordinator.checkCommitEligibility).not.toHaveBeenCalled();
  });

  it('should return true for non-committer with existing commitment status 2 (completed)', async () => {
    // Existing commitment with status 2 (completed), non-committer
    // Should fall through the status checks and hit `return true` at line 415
    mockContractService.getCommitmentInfo.mockResolvedValue({
      status: 2,
      approvalCount: 2n,
    });
    mockStatelessCoordinator.isCurrentCommitter.mockResolvedValue({
      isCommitter: false,
      currentWindow: 1,
      blocksLeft: 50,
      reason: 'not current committer',
    });

    const result = await epochProcessor.processNewCommitment();

    expect(result).toBe(true);
    expect(mockContractService.approveCommitment).not.toHaveBeenCalled();
    expect(mockRewardsCalculator.calculateRewardsDetailed).not.toHaveBeenCalled();
  });

  it('should return true for non-committer with existing commitment status 1 but approvalCount > 0', async () => {
    // Existing commitment with status 1 but approvalCount !== 0n
    // Should NOT call approveCommitment and should return true at line 415
    mockContractService.getCommitmentInfo.mockResolvedValue({
      status: 1,
      approvalCount: 1n,
    });
    mockStatelessCoordinator.isCurrentCommitter.mockResolvedValue({
      isCommitter: false,
      currentWindow: 1,
      blocksLeft: 50,
      reason: 'not current committer',
    });

    const result = await epochProcessor.processNewCommitment();

    expect(result).toBe(true);
    expect(mockContractService.approveCommitment).not.toHaveBeenCalled();
  });

  it('should return false when processApprovalWithMerkleTree throws', async () => {
    mockContractService.getDistributionStatus.mockResolvedValue({
      nextFromBlock: 100,
      nextToBlock: 200,
      isReadyForDistribution: true,
      hasExistingCommitment: false,
    });
    // Force an error inside processApprovalWithMerkleTree by making generateKey throw
    mockCommitmentKeyService.generateKey.mockImplementation(() => {
      throw new Error('Unexpected key error');
    });

    const result = await epochProcessor.processApproval();

    expect(result).toBe(false);
  });
});

describe('EpochProcessor processApprovedEpochs', () => {
  let epochProcessor: EpochProcessorService;
  let mockContractService: any;
  let mockStatelessCoordinator: any;
  let mockDistributionService: any;
  let mockRecoveryService: any;
  let mockRewardsCalculator: any;
  let mockCommitmentKeyService: any;
  let mockConfigService: any;

  beforeEach(async () => {
    mockContractService = {
      getLastBlockRewarded: jest.fn().mockResolvedValue(0),
      getL1BlockNumber: jest.fn().mockResolvedValue(1000),
      getEpochLength: jest.fn().mockResolvedValue(100),
      getDistributionStatus: jest.fn().mockResolvedValue({
        nextFromBlock: 100,
        nextToBlock: 200,
        isReadyForDistribution: true,
        hasExistingCommitment: false,
      }),
      getCommitmentInfo: jest.fn().mockResolvedValue(null),
      getRequiredApprovals: jest.fn().mockResolvedValue(2),
      isNextDistributionReady: jest.fn().mockResolvedValue({
        blocksUntilReady: 0,
        needsConfirmation: false,
        nextFromBlock: 100,
        nextToBlock: 200,
      }),
      canCommit: jest.fn().mockResolvedValue(true),
      approveCommitment: jest.fn().mockResolvedValue(true),
      getCommitmentsNeedingApproval: jest.fn().mockResolvedValue([]),
      hasApprovedCommitment: jest.fn().mockResolvedValue(false),
      getPendingCommitments: jest.fn().mockResolvedValue([]),
      getRecentDistributionEvents: jest.fn().mockResolvedValue([]),
      getLastCommitmentKey: jest.fn().mockResolvedValue(
        '0x0000000000000000000000000000000000000000000000000000000000000000',
      ),
      getBondAmount: jest.fn().mockResolvedValue(0n),
      getActiveWorkerCount: jest.fn().mockResolvedValue(0n),
    };

    mockStatelessCoordinator = {
      isCurrentCommitter: jest.fn().mockResolvedValue({
        isCommitter: true,
        currentWindow: 1,
        blocksLeft: 50,
        reason: 'eligible committer',
      }),
      checkCommitEligibility: jest.fn().mockResolvedValue({
        eligible: true,
        blocksLeft: 50,
        windowInfo: {
          currentWindow: 1,
          windowStart: 0,
          windowEnd: 130,
          nextWindowStart: 131,
        },
      }),
      checkForPendingApprovals: jest.fn().mockResolvedValue({
        hasApprovals: false,
        pendingCommitments: [],
      }),
      shouldSkipRecovery: jest.fn().mockResolvedValue(true),
      shouldStartDistribution: jest.fn().mockResolvedValue(true),
      isAnotherBotDistributing: jest.fn().mockResolvedValue({ isActive: false }),
      shouldActivateRecovery: jest.fn().mockResolvedValue({ shouldActivate: false }),
    };

    mockDistributionService = {
      distributeEpochRewards: jest.fn().mockResolvedValue({
        status: 'completed',
        totalWorkers: 10,
        totalBatches: 2,
        totalRewards: 1000000000000000000n,
      }),
      getApprovedEpochsForDistribution: jest.fn().mockResolvedValue([]),
      generateMerkleTreeOnly: jest.fn().mockResolvedValue({
        root: '0xabc',
        totalBatches: 2,
      }),
      commitRootOnly: jest.fn().mockResolvedValue({ success: true }),
      distributeApprovedEpoch: jest.fn().mockResolvedValue(true),
      uploadEpochDataToS3: jest.fn().mockResolvedValue('https://s3.example.com/epoch-data'),
      distributionBatchSize: 75,
    };

    mockRecoveryService = {
      checkPendingDistributions: jest.fn().mockResolvedValue({
        lastCommitment: null,
        pendingRanges: [],
      }),
    };

    mockRewardsCalculator = {
      calculateRewardsDetailed: jest.fn().mockResolvedValue({
        workers: [{ address: '0x1', reward: 100n }],
      }),
    };

    mockCommitmentKeyService = {
      generateKey: jest.fn().mockReturnValue('0xcommitmentkey'),
    };

    mockConfigService = {
      get: jest.fn((key: string, defaultValue?: any) => {
        const config: Record<string, any> = {
          'rewards.enableAutoDistribution': true,
          'rewards.enableStartupRecoveryCheck': false,
          'rewards.roundRobinWindow': 130,
          'rewards.commitSafetyBuffer': 3,
          'rewards.distributionBlockInterval': 520,
          'rewards.useMerkleTree': true,
          'blockchain.distributor.privateKey':
            '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        };
        return config[key] !== undefined ? config[key] : defaultValue;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EpochProcessorService,
        BlockSchedulerService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: ContractService, useValue: mockContractService },
        { provide: StatelessCoordinatorService, useValue: mockStatelessCoordinator },
        { provide: DistributionService, useValue: mockDistributionService },
        { provide: DistributionRecoveryService, useValue: mockRecoveryService },
        { provide: RewardsCalculatorService, useValue: mockRewardsCalculator },
        { provide: CommitmentKeyService, useValue: mockCommitmentKeyService },
      ],
    }).compile();

    epochProcessor = module.get<EpochProcessorService>(EpochProcessorService);
  });

  it('should handle shouldStartDistribution returning false (skips epoch)', async () => {
    mockDistributionService.getApprovedEpochsForDistribution.mockResolvedValue([
      { fromBlock: 100, toBlock: 200, merkleRoot: '0xroot1' },
    ]);
    mockStatelessCoordinator.shouldStartDistribution.mockResolvedValue(false);

    const result = await epochProcessor.processDistribution();

    expect(result).toBe(true);
    expect(mockDistributionService.distributeApprovedEpoch).not.toHaveBeenCalled();
  });

  it('should distribute approved epoch successfully', async () => {
    mockDistributionService.getApprovedEpochsForDistribution.mockResolvedValue([
      { fromBlock: 100, toBlock: 200, merkleRoot: '0xroot1' },
    ]);
    mockStatelessCoordinator.shouldStartDistribution.mockResolvedValue(true);
    mockDistributionService.distributeApprovedEpoch.mockResolvedValue(true);

    const result = await epochProcessor.processDistribution();

    expect(result).toBe(true);
    expect(mockDistributionService.distributeApprovedEpoch).toHaveBeenCalledWith(
      100,
      200,
      '0xroot1',
    );
  });

  it('should return false when distributeApprovedEpoch fails', async () => {
    mockDistributionService.getApprovedEpochsForDistribution.mockResolvedValue([
      { fromBlock: 100, toBlock: 200, merkleRoot: '0xroot1' },
    ]);
    mockStatelessCoordinator.shouldStartDistribution.mockResolvedValue(true);
    mockDistributionService.distributeApprovedEpoch.mockResolvedValue(false);

    const result = await epochProcessor.processDistribution();

    expect(result).toBe(false);
  });

  it('should stop distributing when no longer current committer mid-loop', async () => {
    mockDistributionService.getApprovedEpochsForDistribution.mockResolvedValue([
      { fromBlock: 100, toBlock: 200, merkleRoot: '0xroot1' },
      { fromBlock: 200, toBlock: 300, merkleRoot: '0xroot2' },
    ]);

    // First call: is committer (checked in processDistribution itself)
    // Second call: is committer (first epoch in loop)
    // Third call: no longer committer (second epoch in loop - should break)
    mockStatelessCoordinator.isCurrentCommitter
      .mockResolvedValueOnce({ isCommitter: true, currentWindow: 1, blocksLeft: 50, reason: 'ok' })
      .mockResolvedValueOnce({ isCommitter: true, currentWindow: 1, blocksLeft: 50, reason: 'ok' })
      .mockResolvedValueOnce({ isCommitter: false, currentWindow: 2, blocksLeft: 0, reason: 'window changed' });

    mockStatelessCoordinator.shouldStartDistribution.mockResolvedValue(true);
    mockDistributionService.distributeApprovedEpoch.mockResolvedValue(true);

    const result = await epochProcessor.processDistribution();

    // First epoch distributed, second skipped (break)
    expect(mockDistributionService.distributeApprovedEpoch).toHaveBeenCalledTimes(1);
    expect(result).toBe(true);
  });

  it('should return false when processApprovedEpochs throws', async () => {
    mockDistributionService.getApprovedEpochsForDistribution.mockRejectedValue(
      new Error('DB connection error'),
    );

    const result = await epochProcessor.processDistribution();

    expect(result).toBe(false);
  });
});

describe('BlockScheduler distribution flow', () => {
  let epochProcessor: EpochProcessorService;
  let blockScheduler: BlockSchedulerService;
  let mockContractService: any;
  let mockStatelessCoordinator: any;
  let mockDistributionService: any;
  let mockRecoveryService: any;
  let mockRewardsCalculator: any;
  let mockCommitmentKeyService: any;
  let mockConfigService: any;

  beforeEach(async () => {
    mockContractService = {
      getLastBlockRewarded: jest.fn().mockResolvedValue(0),
      getL1BlockNumber: jest.fn().mockResolvedValue(1000),
      getEpochLength: jest.fn().mockResolvedValue(100),
      getDistributionStatus: jest.fn().mockResolvedValue({
        nextFromBlock: 100,
        nextToBlock: 200,
        isReadyForDistribution: true,
        hasExistingCommitment: false,
      }),
      getCommitmentInfo: jest.fn().mockResolvedValue(null),
      getRequiredApprovals: jest.fn().mockResolvedValue(2),
      isNextDistributionReady: jest.fn().mockResolvedValue({
        blocksUntilReady: 0,
        needsConfirmation: false,
        nextFromBlock: 100,
        nextToBlock: 200,
      }),
      canCommit: jest.fn().mockResolvedValue(true),
      approveCommitment: jest.fn().mockResolvedValue(true),
      getCommitmentsNeedingApproval: jest.fn().mockResolvedValue([]),
      hasApprovedCommitment: jest.fn().mockResolvedValue(false),
      getPendingCommitments: jest.fn().mockResolvedValue([]),
      getRecentDistributionEvents: jest.fn().mockResolvedValue([]),
      getLastCommitmentKey: jest.fn().mockResolvedValue(
        '0x0000000000000000000000000000000000000000000000000000000000000000',
      ),
      getBondAmount: jest.fn().mockResolvedValue(0n),
      getActiveWorkerCount: jest.fn().mockResolvedValue(0n),
    };

    mockStatelessCoordinator = {
      isCurrentCommitter: jest.fn().mockResolvedValue({
        isCommitter: true,
        currentWindow: 1,
        blocksLeft: 50,
        reason: 'eligible committer',
      }),
      checkCommitEligibility: jest.fn().mockResolvedValue({
        eligible: true,
        blocksLeft: 50,
        windowInfo: {
          currentWindow: 1,
          windowStart: 0,
          windowEnd: 130,
          nextWindowStart: 131,
        },
      }),
      checkForPendingApprovals: jest.fn().mockResolvedValue({
        hasApprovals: false,
        pendingCommitments: [],
      }),
      shouldSkipRecovery: jest.fn().mockResolvedValue(true),
      shouldStartDistribution: jest.fn().mockResolvedValue(true),
      isAnotherBotDistributing: jest.fn().mockResolvedValue({ isActive: false }),
      shouldActivateRecovery: jest.fn().mockResolvedValue({ shouldActivate: false }),
    };

    mockDistributionService = {
      distributeEpochRewards: jest.fn().mockResolvedValue({
        status: 'completed',
        totalWorkers: 10,
        totalBatches: 2,
        totalRewards: 1000000000000000000n,
      }),
      getApprovedEpochsForDistribution: jest.fn().mockResolvedValue([]),
      generateMerkleTreeOnly: jest.fn().mockResolvedValue({
        root: '0xabc',
        totalBatches: 2,
      }),
      commitRootOnly: jest.fn().mockResolvedValue({ success: true }),
      distributeApprovedEpoch: jest.fn().mockResolvedValue(true),
      uploadEpochDataToS3: jest.fn().mockResolvedValue('https://s3.example.com/epoch-data'),
      distributionBatchSize: 75,
    };

    mockRecoveryService = {
      checkPendingDistributions: jest.fn().mockResolvedValue({
        lastCommitment: null,
        pendingRanges: [],
      }),
    };

    mockRewardsCalculator = {
      calculateRewardsDetailed: jest.fn().mockResolvedValue({
        workers: [{ address: '0x1', reward: 100n }],
      }),
    };

    mockCommitmentKeyService = {
      generateKey: jest.fn().mockReturnValue('0xcommitmentkey'),
    };

    mockConfigService = {
      get: jest.fn((key: string, defaultValue?: any) => {
        const config: Record<string, any> = {
          'rewards.enableAutoDistribution': true,
          'rewards.enableStartupRecoveryCheck': false,
          'rewards.roundRobinWindow': 130,
          'rewards.commitSafetyBuffer': 3,
          'rewards.distributionBlockInterval': 520,
          'rewards.useMerkleTree': true,
          'blockchain.distributor.privateKey': '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        };
        return config[key] !== undefined ? config[key] : defaultValue;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EpochProcessorService,
        BlockSchedulerService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: ContractService, useValue: mockContractService },
        { provide: StatelessCoordinatorService, useValue: mockStatelessCoordinator },
        { provide: DistributionService, useValue: mockDistributionService },
        { provide: DistributionRecoveryService, useValue: mockRecoveryService },
        { provide: RewardsCalculatorService, useValue: mockRewardsCalculator },
        { provide: CommitmentKeyService, useValue: mockCommitmentKeyService },
      ],
    }).compile();

    epochProcessor = module.get<EpochProcessorService>(EpochProcessorService);
    blockScheduler = module.get<BlockSchedulerService>(BlockSchedulerService);
  });

  it('should skip distribution when blocksUntilReady > 0', async () => {
    mockContractService.isNextDistributionReady.mockResolvedValue({
      blocksUntilReady: 50,
      needsConfirmation: false,
      nextFromBlock: 100,
      nextToBlock: 200,
    });

    await blockScheduler.checkDistributionInterval();

    expect(mockStatelessCoordinator.isCurrentCommitter).not.toHaveBeenCalled();
    expect(blockScheduler.getStatus().isDistributionProcessing).toBe(false);
  });

  it('should skip distribution when needsConfirmation is true', async () => {
    mockContractService.isNextDistributionReady.mockResolvedValue({
      blocksUntilReady: 0,
      needsConfirmation: true,
      confirmationBlocksNeeded: 42,
      nextFromBlock: 100,
      nextToBlock: 200,
    });

    await blockScheduler.checkDistributionInterval();

    expect(mockStatelessCoordinator.isCurrentCommitter).not.toHaveBeenCalled();
    expect(blockScheduler.getStatus().isDistributionProcessing).toBe(false);
  });

  it('should skip distribution when not the current committer', async () => {
    mockStatelessCoordinator.isCurrentCommitter.mockResolvedValue({
      isCommitter: false,
      currentWindow: 2,
      blocksLeft: 30,
      reason: 'not in window',
    });

    await blockScheduler.checkDistributionInterval();

    // Should not call checkCommitmentStatus or processNewCommitment
    jest.spyOn(epochProcessor, 'checkCommitmentStatus');
    jest.spyOn(epochProcessor, 'processNewCommitment');

    expect(blockScheduler.getStatus().isDistributionProcessing).toBe(false);
  });

  it('should create a new commitment when none exists', async () => {
    const processNewCommitmentSpy = jest
      .spyOn(epochProcessor, 'processNewCommitment')
      .mockResolvedValue(true);
    jest.spyOn(epochProcessor, 'checkCommitmentStatus').mockResolvedValue({
      exists: false,
      currentApprovals: 0,
      requiredApprovals: 2,
      fromBlock: 100,
      toBlock: 200,
    });

    await blockScheduler.checkDistributionInterval();

    expect(processNewCommitmentSpy).toHaveBeenCalled();
  });

  it('should start distribution when enough approvals exist', async () => {
    const processDistributionSpy = jest
      .spyOn(epochProcessor, 'processDistribution')
      .mockResolvedValue(true);
    jest.spyOn(epochProcessor, 'checkCommitmentStatus').mockResolvedValue({
      exists: true,
      currentApprovals: 3,
      requiredApprovals: 2,
      fromBlock: 100,
      toBlock: 200,
      status: 1,
    });

    await blockScheduler.checkDistributionInterval();

    expect(processDistributionSpy).toHaveBeenCalled();
  });

  it('should wait when not enough approvals exist', async () => {
    const processDistributionSpy = jest.spyOn(epochProcessor, 'processDistribution');
    const processNewCommitmentSpy = jest.spyOn(epochProcessor, 'processNewCommitment');
    jest.spyOn(epochProcessor, 'checkCommitmentStatus').mockResolvedValue({
      exists: true,
      currentApprovals: 1,
      requiredApprovals: 3,
      fromBlock: 100,
      toBlock: 200,
      status: 1,
    });

    await blockScheduler.checkDistributionInterval();

    expect(processDistributionSpy).not.toHaveBeenCalled();
    expect(processNewCommitmentSpy).not.toHaveBeenCalled();
  });
});

describe('BlockScheduler recovery flow', () => {
  let epochProcessor: EpochProcessorService;
  let blockScheduler: BlockSchedulerService;
  let mockContractService: any;
  let mockStatelessCoordinator: any;
  let mockDistributionService: any;
  let mockRecoveryService: any;
  let mockRewardsCalculator: any;
  let mockCommitmentKeyService: any;
  let mockConfigService: any;

  beforeEach(async () => {
    mockContractService = {
      getLastBlockRewarded: jest.fn().mockResolvedValue(0),
      getL1BlockNumber: jest.fn().mockResolvedValue(1000),
      getEpochLength: jest.fn().mockResolvedValue(100),
      getDistributionStatus: jest.fn().mockResolvedValue({
        nextFromBlock: 100,
        nextToBlock: 200,
        isReadyForDistribution: true,
        hasExistingCommitment: false,
      }),
      getCommitmentInfo: jest.fn().mockResolvedValue(null),
      getRequiredApprovals: jest.fn().mockResolvedValue(2),
      isNextDistributionReady: jest.fn().mockResolvedValue({
        blocksUntilReady: 0,
        needsConfirmation: false,
        nextFromBlock: 100,
        nextToBlock: 200,
      }),
      canCommit: jest.fn().mockResolvedValue(true),
      approveCommitment: jest.fn().mockResolvedValue(true),
      getCommitmentsNeedingApproval: jest.fn().mockResolvedValue([]),
      hasApprovedCommitment: jest.fn().mockResolvedValue(false),
      getPendingCommitments: jest.fn().mockResolvedValue([]),
      getRecentDistributionEvents: jest.fn().mockResolvedValue([]),
      getLastCommitmentKey: jest.fn().mockResolvedValue(
        '0x0000000000000000000000000000000000000000000000000000000000000000',
      ),
      getBondAmount: jest.fn().mockResolvedValue(0n),
      getActiveWorkerCount: jest.fn().mockResolvedValue(0n),
    };

    mockStatelessCoordinator = {
      isCurrentCommitter: jest.fn().mockResolvedValue({
        isCommitter: true,
        currentWindow: 1,
        blocksLeft: 50,
        reason: 'eligible committer',
      }),
      checkCommitEligibility: jest.fn().mockResolvedValue({
        eligible: true,
        blocksLeft: 50,
        windowInfo: {
          currentWindow: 1,
          windowStart: 0,
          windowEnd: 130,
          nextWindowStart: 131,
        },
      }),
      checkForPendingApprovals: jest.fn().mockResolvedValue({
        hasApprovals: false,
        pendingCommitments: [],
      }),
      shouldSkipRecovery: jest.fn().mockResolvedValue(true),
      shouldStartDistribution: jest.fn().mockResolvedValue(true),
      isAnotherBotDistributing: jest.fn().mockResolvedValue({ isActive: false }),
      shouldActivateRecovery: jest.fn().mockResolvedValue({ shouldActivate: false }),
    };

    mockDistributionService = {
      distributeEpochRewards: jest.fn().mockResolvedValue({
        status: 'completed',
        totalWorkers: 10,
        totalBatches: 2,
        totalRewards: 1000000000000000000n,
      }),
      getApprovedEpochsForDistribution: jest.fn().mockResolvedValue([]),
      generateMerkleTreeOnly: jest.fn().mockResolvedValue({
        root: '0xabc',
        totalBatches: 2,
      }),
      commitRootOnly: jest.fn().mockResolvedValue({ success: true }),
      distributeApprovedEpoch: jest.fn().mockResolvedValue(true),
      uploadEpochDataToS3: jest.fn().mockResolvedValue('https://s3.example.com/epoch-data'),
      distributionBatchSize: 75,
    };

    mockRecoveryService = {
      checkPendingDistributions: jest.fn().mockResolvedValue({
        lastCommitment: null,
        pendingRanges: [],
      }),
    };

    mockRewardsCalculator = {
      calculateRewardsDetailed: jest.fn().mockResolvedValue({
        workers: [{ address: '0x1', reward: 100n }],
      }),
    };

    mockCommitmentKeyService = {
      generateKey: jest.fn().mockReturnValue('0xcommitmentkey'),
    };

    mockConfigService = {
      get: jest.fn((key: string, defaultValue?: any) => {
        const config: Record<string, any> = {
          'rewards.enableAutoDistribution': true,
          'rewards.enableStartupRecoveryCheck': false,
          'rewards.roundRobinWindow': 130,
          'rewards.commitSafetyBuffer': 3,
          'rewards.distributionBlockInterval': 520,
          'rewards.useMerkleTree': true,
          'blockchain.distributor.privateKey': '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        };
        return config[key] !== undefined ? config[key] : defaultValue;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EpochProcessorService,
        BlockSchedulerService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: ContractService, useValue: mockContractService },
        { provide: StatelessCoordinatorService, useValue: mockStatelessCoordinator },
        { provide: DistributionService, useValue: mockDistributionService },
        { provide: DistributionRecoveryService, useValue: mockRecoveryService },
        { provide: RewardsCalculatorService, useValue: mockRewardsCalculator },
        { provide: CommitmentKeyService, useValue: mockCommitmentKeyService },
      ],
    }).compile();

    epochProcessor = module.get<EpochProcessorService>(EpochProcessorService);
    blockScheduler = module.get<BlockSchedulerService>(BlockSchedulerService);
  });

  it('should skip recovery when shouldSkipRecovery returns true', async () => {
    mockStatelessCoordinator.shouldSkipRecovery.mockResolvedValue(true);

    const processDistributionSpy = jest.spyOn(epochProcessor, 'processDistribution');

    await blockScheduler.checkRecoveryInterval();

    expect(mockStatelessCoordinator.shouldSkipRecovery).toHaveBeenCalled();
    expect(processDistributionSpy).not.toHaveBeenCalled();
    expect(blockScheduler.getStatus().isDistributionProcessing).toBe(false);
  });

  it('should proceed with recovery when shouldSkipRecovery returns false', async () => {
    mockStatelessCoordinator.shouldSkipRecovery.mockResolvedValue(false);

    const processDistributionSpy = jest
      .spyOn(epochProcessor, 'processDistribution')
      .mockResolvedValue(true);

    await blockScheduler.checkRecoveryInterval();

    expect(mockStatelessCoordinator.shouldSkipRecovery).toHaveBeenCalled();
    expect(processDistributionSpy).toHaveBeenCalled();
    expect(blockScheduler.getStatus().isDistributionProcessing).toBe(false);
  });
});

describe('EpochProcessor additional coverage', () => {
  let epochProcessor: EpochProcessorService;
  let mockContractService: any;
  let mockStatelessCoordinator: any;
  let mockDistributionService: any;
  let mockRecoveryService: any;
  let mockRewardsCalculator: any;
  let mockCommitmentKeyService: any;
  let mockConfigService: any;

  beforeEach(async () => {
    mockContractService = {
      getLastBlockRewarded: jest.fn().mockResolvedValue(0),
      getL1BlockNumber: jest.fn().mockResolvedValue(1000),
      getEpochLength: jest.fn().mockResolvedValue(100),
      getDistributionStatus: jest.fn().mockResolvedValue({
        nextFromBlock: 100,
        nextToBlock: 200,
        isReadyForDistribution: true,
        hasExistingCommitment: false,
      }),
      getCommitmentInfo: jest.fn().mockResolvedValue(null),
      getRequiredApprovals: jest.fn().mockResolvedValue(2),
      isNextDistributionReady: jest.fn().mockResolvedValue({
        blocksUntilReady: 0,
        needsConfirmation: false,
        nextFromBlock: 100,
        nextToBlock: 200,
      }),
      canCommit: jest.fn().mockResolvedValue(true),
      approveCommitment: jest.fn().mockResolvedValue(true),
      getCommitmentsNeedingApproval: jest.fn().mockResolvedValue([]),
      hasApprovedCommitment: jest.fn().mockResolvedValue(false),
      getPendingCommitments: jest.fn().mockResolvedValue([]),
      getRecentDistributionEvents: jest.fn().mockResolvedValue([]),
      getLastCommitmentKey: jest.fn().mockResolvedValue(
        '0x0000000000000000000000000000000000000000000000000000000000000000',
      ),
      getBondAmount: jest.fn().mockResolvedValue(0n),
      getActiveWorkerCount: jest.fn().mockResolvedValue(0n),
    };

    mockStatelessCoordinator = {
      isCurrentCommitter: jest.fn().mockResolvedValue({
        isCommitter: true,
        currentWindow: 1,
        blocksLeft: 50,
        reason: 'eligible committer',
      }),
      checkCommitEligibility: jest.fn().mockResolvedValue({
        eligible: true,
        blocksLeft: 50,
        windowInfo: {
          currentWindow: 1,
          windowStart: 0,
          windowEnd: 130,
          nextWindowStart: 131,
        },
      }),
      checkForPendingApprovals: jest.fn().mockResolvedValue({
        hasApprovals: false,
        pendingCommitments: [],
      }),
      shouldSkipRecovery: jest.fn().mockResolvedValue(true),
      shouldStartDistribution: jest.fn().mockResolvedValue(true),
      isAnotherBotDistributing: jest.fn().mockResolvedValue({ isActive: false }),
      shouldActivateRecovery: jest.fn().mockResolvedValue({ shouldActivate: false }),
    };

    mockDistributionService = {
      distributeEpochRewards: jest.fn().mockResolvedValue({
        status: 'completed',
        totalWorkers: 10,
        totalBatches: 2,
        totalRewards: 1000000000000000000n,
      }),
      getApprovedEpochsForDistribution: jest.fn().mockResolvedValue([]),
      generateMerkleTreeOnly: jest.fn().mockResolvedValue({
        root: '0xabc',
        totalBatches: 2,
      }),
      commitRootOnly: jest.fn().mockResolvedValue({ success: true }),
      distributeApprovedEpoch: jest.fn().mockResolvedValue(true),
      uploadEpochDataToS3: jest.fn().mockResolvedValue('https://s3.example.com/epoch-data'),
      distributionBatchSize: 75,
    };

    mockRecoveryService = {
      checkPendingDistributions: jest.fn().mockResolvedValue({
        lastCommitment: null,
        pendingRanges: [],
      }),
    };

    mockRewardsCalculator = {
      calculateRewardsDetailed: jest.fn().mockResolvedValue({
        workers: [{ address: '0x1', reward: 100n }],
      }),
    };

    mockCommitmentKeyService = {
      generateKey: jest.fn().mockReturnValue('0xcommitmentkey'),
    };

    mockConfigService = {
      get: jest.fn((key: string, defaultValue?: any) => {
        const config: Record<string, any> = {
          'rewards.enableAutoDistribution': true,
          'rewards.enableStartupRecoveryCheck': false,
          'rewards.roundRobinWindow': 130,
          'rewards.commitSafetyBuffer': 3,
          'rewards.distributionBlockInterval': 520,
          'rewards.useMerkleTree': true,
          'blockchain.distributor.privateKey': '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        };
        return config[key] !== undefined ? config[key] : defaultValue;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EpochProcessorService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: ContractService, useValue: mockContractService },
        { provide: StatelessCoordinatorService, useValue: mockStatelessCoordinator },
        { provide: DistributionService, useValue: mockDistributionService },
        { provide: DistributionRecoveryService, useValue: mockRecoveryService },
        { provide: RewardsCalculatorService, useValue: mockRewardsCalculator },
        { provide: CommitmentKeyService, useValue: mockCommitmentKeyService },
      ],
    }).compile();

    epochProcessor = module.get<EpochProcessorService>(EpochProcessorService);
  });

  describe('processNewCommitment', () => {
    it('should return true when fromBlock >= toBlock (no blocks to process)', async () => {
      mockContractService.getDistributionStatus.mockResolvedValue({
        nextFromBlock: 200,
        nextToBlock: 200,
        isReadyForDistribution: false,
        hasExistingCommitment: false,
      });

      const result = await epochProcessor.processNewCommitment();
      expect(result).toBe(true);
    });

    it('should return false when an error is thrown during commitment', async () => {
      mockContractService.getDistributionStatus.mockResolvedValue({
        nextFromBlock: 100,
        nextToBlock: 200,
        isReadyForDistribution: true,
        hasExistingCommitment: false,
      });

      // Simulate a commitment already exists check that throws
      mockContractService.getCommitmentInfo.mockRejectedValue(
        new Error('RPC error'),
      );
      // After the catch in processApprovalWithMerkleTree, it proceeds to
      // create a new commitment. Force commitRootOnly to fail:
      mockDistributionService.commitRootOnly.mockResolvedValue({ success: false });

      const result = await epochProcessor.processNewCommitment();
      expect(result).toBe(false);
    });

    it('should call processApprovalWithMerkleTree for valid block range', async () => {
      mockContractService.getDistributionStatus.mockResolvedValue({
        nextFromBlock: 100,
        nextToBlock: 200,
        isReadyForDistribution: true,
        hasExistingCommitment: false,
      });
      // No existing commitment, is current committer, eligible
      mockContractService.getCommitmentInfo.mockResolvedValue(null);

      const result = await epochProcessor.processNewCommitment();

      expect(result).toBe(true);
      expect(mockRewardsCalculator.calculateRewardsDetailed).toHaveBeenCalled();
      expect(mockDistributionService.generateMerkleTreeOnly).toHaveBeenCalled();
      expect(mockDistributionService.commitRootOnly).toHaveBeenCalled();
    });
  });

  describe('processExistingApprovals', () => {
    it('should return true and approve pending commitments', async () => {
      mockStatelessCoordinator.checkForPendingApprovals.mockResolvedValue({
        hasApprovals: true,
        pendingCommitments: [
          { fromBlock: 100, toBlock: 200 },
          { fromBlock: 200, toBlock: 300 },
        ],
      });

      const result = await epochProcessor.processExistingApprovals();

      expect(result).toBe(true);
      expect(mockContractService.approveCommitment).toHaveBeenCalledTimes(2);
      expect(mockContractService.approveCommitment).toHaveBeenCalledWith(100, 200);
      expect(mockContractService.approveCommitment).toHaveBeenCalledWith(200, 300);
    });

    it('should return true when no approvals are needed', async () => {
      mockStatelessCoordinator.checkForPendingApprovals.mockResolvedValue({
        hasApprovals: false,
        pendingCommitments: [],
      });

      const result = await epochProcessor.processExistingApprovals();

      expect(result).toBe(true);
      expect(mockContractService.approveCommitment).not.toHaveBeenCalled();
    });

    it('should return false when one approval fails', async () => {
      mockStatelessCoordinator.checkForPendingApprovals.mockResolvedValue({
        hasApprovals: true,
        pendingCommitments: [
          { fromBlock: 100, toBlock: 200 },
          { fromBlock: 200, toBlock: 300 },
        ],
      });
      mockContractService.approveCommitment
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      const result = await epochProcessor.processExistingApprovals();

      expect(result).toBe(false);
    });

    it('should return false when an approval throws', async () => {
      mockStatelessCoordinator.checkForPendingApprovals.mockResolvedValue({
        hasApprovals: true,
        pendingCommitments: [{ fromBlock: 100, toBlock: 200 }],
      });
      mockContractService.approveCommitment.mockRejectedValue(
        new Error('Transaction reverted'),
      );

      const result = await epochProcessor.processExistingApprovals();

      expect(result).toBe(false);
    });
  });

  describe('checkCommitmentStatus', () => {
    it('should return commitment info when commitment exists', async () => {
      mockContractService.getCommitmentInfo.mockResolvedValue({
        status: 1,
        approvalCount: 3n,
      });
      mockContractService.getRequiredApprovals.mockResolvedValue(2);

      const status = await epochProcessor.checkCommitmentStatus();

      expect(status.exists).toBe(true);
      expect(status.currentApprovals).toBe(3);
      expect(status.requiredApprovals).toBe(2);
      expect(status.fromBlock).toBe(100);
      expect(status.toBlock).toBe(200);
      expect(status.status).toBe(1);
    });

    it('should return exists=false when no commitment info is returned', async () => {
      mockContractService.getCommitmentInfo.mockResolvedValue(null);
      mockContractService.getRequiredApprovals.mockResolvedValue(2);

      const status = await epochProcessor.checkCommitmentStatus();

      expect(status.exists).toBe(false);
      expect(status.requiredApprovals).toBe(2);
    });

    it('should return exists=false when commitment status is 0', async () => {
      mockContractService.getCommitmentInfo.mockResolvedValue({
        status: 0,
        approvalCount: 0n,
      });
      mockContractService.getRequiredApprovals.mockResolvedValue(2);

      const status = await epochProcessor.checkCommitmentStatus();

      expect(status.exists).toBe(false);
      expect(status.requiredApprovals).toBe(2);
    });

    it('should return empty status when fromBlock >= toBlock', async () => {
      mockContractService.getDistributionStatus.mockResolvedValue({
        nextFromBlock: 200,
        nextToBlock: 200,
        isReadyForDistribution: false,
        hasExistingCommitment: false,
      });

      const status = await epochProcessor.checkCommitmentStatus();

      expect(status.exists).toBe(false);
      expect(status.currentApprovals).toBe(0);
      expect(status.requiredApprovals).toBe(0);
    });
  });

  describe('processDistribution', () => {
    it('should process approved epochs when current committer', async () => {
      mockDistributionService.getApprovedEpochsForDistribution.mockResolvedValue([
        { fromBlock: 100, toBlock: 200, merkleRoot: '0xabc' },
      ]);

      const result = await epochProcessor.processDistribution();

      expect(result).toBe(true);
      expect(mockDistributionService.distributeApprovedEpoch).toHaveBeenCalledWith(
        100,
        200,
        '0xabc',
      );
    });

    it('should return true with no approved epochs to distribute', async () => {
      mockDistributionService.getApprovedEpochsForDistribution.mockResolvedValue([]);

      const result = await epochProcessor.processDistribution();

      expect(result).toBe(true);
    });

    it('should stop distributing when no longer current committer mid-loop', async () => {
      mockDistributionService.getApprovedEpochsForDistribution.mockResolvedValue([
        { fromBlock: 100, toBlock: 200, merkleRoot: '0xabc' },
        { fromBlock: 200, toBlock: 300, merkleRoot: '0xdef' },
      ]);
      // First call in processDistribution itself returns true,
      // then in the loop: first re-check returns true, second returns false
      mockStatelessCoordinator.isCurrentCommitter
        .mockResolvedValueOnce({ isCommitter: true, currentWindow: 1, blocksLeft: 50, reason: 'ok' })
        .mockResolvedValueOnce({ isCommitter: true, currentWindow: 1, blocksLeft: 50, reason: 'ok' })
        .mockResolvedValueOnce({ isCommitter: false, currentWindow: 2, blocksLeft: 0, reason: 'window changed' });

      const result = await epochProcessor.processDistribution();

      // First epoch should be distributed, second should be skipped
      expect(mockDistributionService.distributeApprovedEpoch).toHaveBeenCalledTimes(1);
      expect(result).toBe(true);
    });

    it('should skip epoch when shouldStartDistribution returns false', async () => {
      mockDistributionService.getApprovedEpochsForDistribution.mockResolvedValue([
        { fromBlock: 100, toBlock: 200, merkleRoot: '0xabc' },
      ]);
      mockStatelessCoordinator.shouldStartDistribution.mockResolvedValue(false);

      const result = await epochProcessor.processDistribution();

      expect(mockDistributionService.distributeApprovedEpoch).not.toHaveBeenCalled();
      expect(result).toBe(true);
    });
  });
});

describe('EpochProcessor onModuleInit coverage', () => {
  const zeroKey = '0x0000000000000000000000000000000000000000000000000000000000000000';

  function createMocks() {
    return {
      cs: {
        getLastBlockRewarded: jest.fn().mockResolvedValue(500),
        getL1BlockNumber: jest.fn().mockResolvedValue(1000),
        getEpochLength: jest.fn().mockResolvedValue(100),
        getLastCommitmentKey: jest.fn().mockResolvedValue(zeroKey),
      },
      rs: {
        checkPendingDistributions: jest.fn().mockResolvedValue({ lastCommitment: null, pendingRanges: [] }),
      },
    };
  }

  function svc(m: any, recovery: boolean) {
    const cfg = { get: jest.fn((k: string, d?: any) => k === 'rewards.enableStartupRecoveryCheck' ? recovery : d) };
    return new EpochProcessorService(cfg as any, {} as any, m.cs as any, {} as any, m.rs as any, {} as any, {} as any);
  }

  it('skips when disabled', async () => {
    const m = createMocks();
    await svc(m, false).onModuleInit();
    expect(m.cs.getLastBlockRewarded).not.toHaveBeenCalled();
  });

  it('handles lastBlockRewarded = 0', async () => {
    const m = createMocks();
    m.cs.getLastBlockRewarded.mockResolvedValue(0);
    await svc(m, true).onModuleInit();
    expect(m.cs.getLastCommitmentKey).not.toHaveBeenCalled();
  });

  it('handles ContractFunctionExecutionError', async () => {
    const m = createMocks();
    m.cs.getLastBlockRewarded.mockRejectedValue(new Error('ContractFunctionExecutionError: lastBlockRewarded'));
    await svc(m, true).onModuleInit();
  });

  it('handles non-contract error at top level', async () => {
    const m = createMocks();
    m.cs.getLastBlockRewarded.mockRejectedValue(new Error('Network timeout'));
    await svc(m, true).onModuleInit();
  });

  it('checks commitment with non-zero key - status 1', async () => {
    const m = createMocks();
    m.cs.getLastCommitmentKey.mockResolvedValue('0xabc');
    m.rs.checkPendingDistributions.mockResolvedValue({
      lastCommitment: { fromBlock: 400, toBlock: 500, status: 1, processedBatches: 1, totalBatches: 3 },
      pendingRanges: [],
    });
    await svc(m, true).onModuleInit();
    expect(m.rs.checkPendingDistributions).toHaveBeenCalled();
  });

  it('checks commitment with non-zero key - status 2', async () => {
    const m = createMocks();
    m.cs.getLastCommitmentKey.mockResolvedValue('0xabc');
    m.rs.checkPendingDistributions.mockResolvedValue({
      lastCommitment: { fromBlock: 400, toBlock: 500, status: 2, processedBatches: 3, totalBatches: 3 },
      pendingRanges: [],
    });
    await svc(m, true).onModuleInit();
  });

  it('handles getLastCommitmentKey error', async () => {
    const m = createMocks();
    m.cs.getLastCommitmentKey.mockRejectedValue(new Error('RPC'));
    await svc(m, true).onModuleInit();
  });

  it('warns about missed epochs', async () => {
    const m = createMocks();
    m.cs.getL1BlockNumber.mockResolvedValue(1500);
    await svc(m, true).onModuleInit();
    expect(m.cs.getEpochLength).toHaveBeenCalled();
  });

  it('logs info when blocks < epoch length', async () => {
    const m = createMocks();
    m.cs.getLastBlockRewarded.mockResolvedValue(950);
    await svc(m, true).onModuleInit();
  });

  it('handles pending ranges', async () => {
    const m = createMocks();
    m.rs.checkPendingDistributions.mockResolvedValue({
      lastCommitment: null, pendingRanges: [{ fromBlock: 500, toBlock: 600 }],
    });
    await svc(m, true).onModuleInit();
  });

  it('handles inner commitment check error', async () => {
    const m = createMocks();
    m.cs.getLastCommitmentKey.mockResolvedValue('0xabc');
    m.rs.checkPendingDistributions
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce({ lastCommitment: null, pendingRanges: [] });
    await svc(m, true).onModuleInit();
  });

  it('catches top-level error', async () => {
    const m = createMocks();
    m.cs.getL1BlockNumber.mockRejectedValue(new Error('down'));
    await svc(m, true).onModuleInit();
  });
});

describe('EpochProcessor processEpoch (processEpochWithMerkleTree) direct', () => {
  function make(csMock: any, dsMock: any) {
    const cfg = { get: jest.fn((k: string, d?: any) => k === 'rewards.enableStartupRecoveryCheck' ? false : d) };
    return new EpochProcessorService(cfg as any, {} as any, csMock as any, dsMock as any, {} as any, {} as any, {} as any);
  }

  it('returns true on completed distribution', async () => {
    const cs = { getDistributionStatus: jest.fn().mockResolvedValue({ nextFromBlock: 100, nextToBlock: 200 }) };
    const ds = { distributeEpochRewards: jest.fn().mockResolvedValue({ status: 'completed', totalWorkers: 10, totalBatches: 2, totalRewards: 1000n }), distributionBatchSize: 75 };
    expect(await make(cs, ds).processEpoch()).toBe(true);
    expect(ds.distributeEpochRewards).toHaveBeenCalledWith(100, 200, 75);
  });

  it('returns false on failed distribution', async () => {
    const cs = { getDistributionStatus: jest.fn().mockResolvedValue({ nextFromBlock: 100, nextToBlock: 200 }) };
    const ds = { distributeEpochRewards: jest.fn().mockResolvedValue({ status: 'failed', error: 'err' }), distributionBatchSize: 75 };
    expect(await make(cs, ds).processEpoch()).toBe(false);
  });

  it('returns false when throws', async () => {
    const cs = { getDistributionStatus: jest.fn().mockResolvedValue({ nextFromBlock: 100, nextToBlock: 200 }) };
    const ds = { distributeEpochRewards: jest.fn().mockRejectedValue(new Error('RPC')), distributionBatchSize: 75 };
    expect(await make(cs, ds).processEpoch()).toBe(false);
  });

  it('returns true when no blocks', async () => {
    const cs = { getDistributionStatus: jest.fn().mockResolvedValue({ nextFromBlock: 200, nextToBlock: 200 }) };
    const ds = { distributeEpochRewards: jest.fn(), distributionBatchSize: 75 };
    expect(await make(cs, ds).processEpoch()).toBe(true);
    expect(ds.distributeEpochRewards).not.toHaveBeenCalled();
  });
});

describe('EpochProcessor processApproval full flow direct', () => {
  function base() {
    return {
      cs: {
        getDistributionStatus: jest.fn().mockResolvedValue({ nextFromBlock: 100, nextToBlock: 200 }),
        getCommitmentInfo: jest.fn().mockResolvedValue(null),
        getRequiredApprovals: jest.fn().mockResolvedValue(2),
        approveCommitment: jest.fn().mockResolvedValue(true),
      },
      sc: {
        isCurrentCommitter: jest.fn().mockResolvedValue({ isCommitter: true }),
        checkCommitEligibility: jest.fn().mockResolvedValue({ eligible: true, blocksLeft: 50 }),
      },
      ds: {
        generateMerkleTreeOnly: jest.fn().mockResolvedValue({ root: '0xabc', totalBatches: 2 }),
        commitRootOnly: jest.fn().mockResolvedValue({ success: true }),
        uploadEpochDataToS3: jest.fn().mockResolvedValue('s3://data'),
        distributionBatchSize: 75,
      },
      rc: { calculateRewardsDetailed: jest.fn().mockResolvedValue({ workers: [{ address: '0x1', reward: 100n }] }) },
      ck: { generateKey: jest.fn().mockReturnValue('0xkey') },
    };
  }

  function make(m: any) {
    const cfg = { get: jest.fn((k: string, d?: any) => k === 'rewards.enableStartupRecoveryCheck' ? false : d) };
    return new EpochProcessorService(cfg as any, m.rc as any, m.cs as any, m.ds as any, {} as any, m.sc as any, m.ck as any);
  }

  it('existing commitment + committer → true', async () => {
    const m = base(); m.cs.getCommitmentInfo.mockResolvedValue({ status: 1, approvalCount: 1n });
    expect(await make(m).processApproval()).toBe(true);
    expect(m.rc.calculateRewardsDetailed).not.toHaveBeenCalled();
  });

  it('existing commitment + non-committer → approves', async () => {
    const m = base();
    m.cs.getCommitmentInfo.mockResolvedValue({ status: 1, approvalCount: 0n });
    m.sc.isCurrentCommitter.mockResolvedValue({ isCommitter: false });
    expect(await make(m).processApproval()).toBe(true);
    expect(m.cs.approveCommitment).toHaveBeenCalledWith(100, 200);
  });

  it('not eligible → skips', async () => {
    const m = base(); m.sc.checkCommitEligibility.mockResolvedValue({ eligible: false });
    expect(await make(m).processApproval()).toBe(true);
  });

  it('no workers → true', async () => {
    const m = base(); m.rc.calculateRewardsDetailed.mockResolvedValue({ workers: [] });
    expect(await make(m).processApproval()).toBe(true);
  });

  it('full commit flow', async () => {
    const m = base();
    expect(await make(m).processApproval()).toBe(true);
    expect(m.ds.commitRootOnly).toHaveBeenCalled();
    expect(m.ds.uploadEpochDataToS3).toHaveBeenCalled();
  });

  it('commitRootOnly failure → false', async () => {
    const m = base(); m.ds.commitRootOnly.mockResolvedValue({ success: false });
    expect(await make(m).processApproval()).toBe(false);
  });

  it('S3 failure → still true', async () => {
    const m = base(); m.ds.uploadEpochDataToS3.mockRejectedValue(new Error('S3'));
    expect(await make(m).processApproval()).toBe(true);
  });

  it('non-committer + no commitment → true', async () => {
    const m = base(); m.sc.isCurrentCommitter.mockResolvedValue({ isCommitter: false });
    expect(await make(m).processApproval()).toBe(true);
  });

  it('getCommitmentInfo error → proceeds', async () => {
    const m = base(); m.cs.getCommitmentInfo.mockRejectedValue(new Error('RPC'));
    expect(await make(m).processApproval()).toBe(true);
  });

  it('getDistributionStatus failure → true (getEpochRange returns [0,0], no blocks to process)', async () => {
    const m = base(); m.cs.getDistributionStatus.mockRejectedValue(new Error('down'));
    // getEpochRange catches internally and returns [0,0], so fromBlock >= toBlock → true
    expect(await make(m).processApproval()).toBe(true);
  });

  it('should pass distributionBatchSize consistently to generateMerkleTreeOnly, commitRootOnly, and uploadEpochDataToS3', async () => {
    const m = base();
    expect(await make(m).processApproval()).toBe(true);
    // All calls should use the same batch size (75, from the mock's distributionBatchSize)
    expect(m.ds.generateMerkleTreeOnly).toHaveBeenCalledWith(
      expect.any(Array),
      75,
    );
    expect(m.ds.commitRootOnly).toHaveBeenCalledWith(
      100, 200,
      '0xabc', // merkle root from mock
      2,       // totalBatches from mock
      '',
      expect.any(Array),
      expect.any(Object),
      75,      // batchSize must match
    );
    expect(m.ds.uploadEpochDataToS3).toHaveBeenCalledWith(
      100, 200,
      '0xabc',
      2,
      expect.any(Array),
      expect.any(Object),
      75,      // batchSize must match
    );
  });
});
