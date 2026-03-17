import { StatelessCoordinatorService } from './stateless-coordinator.service';

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

// Known Hardhat/Anvil test private key — deterministic address
const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
// The address derived from the above key (viem privateKeyToAccount)
// 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
const EXPECTED_BOT_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

function createMocks() {
  const mockContractService = {
    getL1BlockNumber: jest.fn(),
    canCommit: jest.fn(),
    getCommitmentsNeedingApproval: jest.fn(),
    hasApprovedCommitment: jest.fn(),
    getPendingCommitments: jest.fn(),
    getRecentDistributionEvents: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn((key: string, defaultValue?: any) => {
      const config: Record<string, any> = {
        'rewards.roundRobinWindow': 130,
        'blockchain.distributor.privateKey': TEST_PRIVATE_KEY,
      };
      return config[key] !== undefined ? config[key] : defaultValue;
    }),
  };

  return { mockContractService, mockConfigService };
}

describe('StatelessCoordinatorService', () => {
  let service: StatelessCoordinatorService;
  let mockContractService: ReturnType<typeof createMocks>['mockContractService'];
  let mockConfigService: ReturnType<typeof createMocks>['mockConfigService'];

  beforeEach(() => {
    const mocks = createMocks();
    mockContractService = mocks.mockContractService;
    mockConfigService = mocks.mockConfigService;

    service = new StatelessCoordinatorService(
      mockContractService as any,
      mockConfigService as any,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // isCurrentCommitter()
  // ──────────────────────────────────────────────────────────────────────────
  describe('isCurrentCommitter()', () => {
    it('should return isCommitter=true when bot is the eligible committer', async () => {
      mockContractService.getL1BlockNumber.mockResolvedValue(500);
      mockContractService.canCommit.mockResolvedValue(true);

      const result = await service.isCurrentCommitter();

      expect(result.isCommitter).toBe(true);
      expect(result.reason).toBe('eligible committer');
      expect(mockContractService.canCommit).toHaveBeenCalledWith(
        EXPECTED_BOT_ADDRESS,
      );
    });

    it('should return isCommitter=false when bot is NOT the eligible committer', async () => {
      mockContractService.getL1BlockNumber.mockResolvedValue(500);
      mockContractService.canCommit.mockResolvedValue(false);

      const result = await service.isCurrentCommitter();

      expect(result.isCommitter).toBe(false);
      expect(result.reason).toBe('not current committer');
    });

    it('should calculate currentWindow correctly as floor(block / windowSize)', async () => {
      // block=500, window=130 => currentWindow = floor(500/130) = 3
      mockContractService.getL1BlockNumber.mockResolvedValue(500);
      mockContractService.canCommit.mockResolvedValue(true);

      const result = await service.isCurrentCommitter();

      expect(result.currentWindow).toBe(Math.floor(500 / 130));
      expect(result.currentWindow).toBe(3);
    });

    it('should calculate blocksLeft correctly as windowEnd - currentBlock', async () => {
      // block=500, window=130
      // currentWindow = 3, windowEnd = (3+1)*130 - 1 = 519
      // blocksLeft = 519 - 500 = 19
      mockContractService.getL1BlockNumber.mockResolvedValue(500);
      mockContractService.canCommit.mockResolvedValue(true);

      const result = await service.isCurrentCommitter();

      expect(result.blocksLeft).toBe(19);
    });

    it('should handle block exactly at window boundary', async () => {
      // block=130, window=130 => currentWindow = 1, windowEnd = 259, blocksLeft = 129
      mockContractService.getL1BlockNumber.mockResolvedValue(130);
      mockContractService.canCommit.mockResolvedValue(true);

      const result = await service.isCurrentCommitter();

      expect(result.currentWindow).toBe(1);
      expect(result.blocksLeft).toBe(129);
    });

    it('should handle block=0 (genesis)', async () => {
      // block=0, window=130 => currentWindow = 0, windowEnd = 129, blocksLeft = 129
      mockContractService.getL1BlockNumber.mockResolvedValue(0);
      mockContractService.canCommit.mockResolvedValue(true);

      const result = await service.isCurrentCommitter();

      expect(result.currentWindow).toBe(0);
      expect(result.blocksLeft).toBe(129);
    });

    it('should return error fallback when getL1BlockNumber fails', async () => {
      mockContractService.getL1BlockNumber.mockRejectedValue(
        new Error('RPC timeout'),
      );

      const result = await service.isCurrentCommitter();

      expect(result.isCommitter).toBe(false);
      expect(result.currentWindow).toBe(0);
      expect(result.blocksLeft).toBe(0);
      expect(result.reason).toBe('error checking committer status');
    });

    it('should return error fallback when canCommit fails', async () => {
      mockContractService.getL1BlockNumber.mockResolvedValue(500);
      mockContractService.canCommit.mockRejectedValue(
        new Error('Contract reverted'),
      );

      const result = await service.isCurrentCommitter();

      expect(result.isCommitter).toBe(false);
      expect(result.reason).toBe('error checking committer status');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // checkCommitEligibility()
  // ──────────────────────────────────────────────────────────────────────────
  describe('checkCommitEligibility()', () => {
    it('should return eligible=true when bot is the current committer', async () => {
      mockContractService.getL1BlockNumber.mockResolvedValue(500);
      mockContractService.canCommit.mockResolvedValue(true);

      const result = await service.checkCommitEligibility();

      expect(result.eligible).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('should return eligible=false when bot is not the current committer', async () => {
      mockContractService.getL1BlockNumber.mockResolvedValue(500);
      mockContractService.canCommit.mockResolvedValue(false);

      const result = await service.checkCommitEligibility();

      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('not the current committer for this window');
    });

    it('should calculate windowInfo fields correctly', async () => {
      // block=500, window=130
      // currentWindow=3, windowStart=390, windowEnd=519, nextWindowStart=520
      mockContractService.getL1BlockNumber.mockResolvedValue(500);
      mockContractService.canCommit.mockResolvedValue(true);

      const result = await service.checkCommitEligibility();

      expect(result.windowInfo.currentWindow).toBe(3);
      expect(result.windowInfo.windowStart).toBe(390);
      expect(result.windowInfo.windowEnd).toBe(519);
      expect(result.windowInfo.nextWindowStart).toBe(520);
      expect(result.blocksLeft).toBe(19);
    });

    it('should return error fallback when contract call fails', async () => {
      mockContractService.getL1BlockNumber.mockRejectedValue(
        new Error('Network error'),
      );

      const result = await service.checkCommitEligibility();

      expect(result.eligible).toBe(false);
      expect(result.blocksLeft).toBe(0);
      expect(result.windowInfo).toEqual({
        currentWindow: 0,
        windowStart: 0,
        windowEnd: 0,
        nextWindowStart: 0,
      });
      expect(result.reason).toBe('error checking eligibility');
    });

    it('should use the configured roundRobinWindow value', async () => {
      // Override to use a different window size
      mockConfigService.get.mockImplementation(
        (key: string, defaultValue?: any) => {
          const config: Record<string, any> = {
            'rewards.roundRobinWindow': 200,
            'blockchain.distributor.privateKey': TEST_PRIVATE_KEY,
          };
          return config[key] !== undefined ? config[key] : defaultValue;
        },
      );
      // block=500, window=200 => currentWindow=2, windowStart=400, windowEnd=599
      mockContractService.getL1BlockNumber.mockResolvedValue(500);
      mockContractService.canCommit.mockResolvedValue(true);

      const result = await service.checkCommitEligibility();

      expect(result.windowInfo.currentWindow).toBe(2);
      expect(result.windowInfo.windowStart).toBe(400);
      expect(result.windowInfo.windowEnd).toBe(599);
      expect(result.windowInfo.nextWindowStart).toBe(600);
      expect(result.blocksLeft).toBe(99);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // checkForPendingApprovals()
  // ──────────────────────────────────────────────────────────────────────────
  describe('checkForPendingApprovals()', () => {
    it('should return hasApprovals=false when no pending commitments exist', async () => {
      mockContractService.getCommitmentsNeedingApproval.mockResolvedValue([]);

      const result = await service.checkForPendingApprovals();

      expect(result.hasApprovals).toBe(false);
      expect(result.pendingCommitments).toEqual([]);
    });

    it('should return hasApprovals=true when bot has not approved pending commitments', async () => {
      mockContractService.getCommitmentsNeedingApproval.mockResolvedValue([
        { fromBlock: 100, toBlock: 200, merkleRoot: '0xabc' },
      ]);
      mockContractService.hasApprovedCommitment.mockResolvedValue(false);

      const result = await service.checkForPendingApprovals();

      expect(result.hasApprovals).toBe(true);
      expect(result.pendingCommitments).toEqual([
        { fromBlock: 100, toBlock: 200 },
      ]);
    });

    it('should return hasApprovals=false when bot has already approved all pending commitments', async () => {
      mockContractService.getCommitmentsNeedingApproval.mockResolvedValue([
        { fromBlock: 100, toBlock: 200, merkleRoot: '0xabc' },
      ]);
      mockContractService.hasApprovedCommitment.mockResolvedValue(true);

      const result = await service.checkForPendingApprovals();

      expect(result.hasApprovals).toBe(false);
      expect(result.pendingCommitments).toEqual([]);
    });

    it('should include commitment when hasApprovedCommitment throws (safe fallback)', async () => {
      mockContractService.getCommitmentsNeedingApproval.mockResolvedValue([
        { fromBlock: 100, toBlock: 200, merkleRoot: '0xabc' },
      ]);
      mockContractService.hasApprovedCommitment.mockRejectedValue(
        new Error('RPC error'),
      );

      const result = await service.checkForPendingApprovals();

      // Safe fallback: includes commitment when we cannot verify approval status
      expect(result.hasApprovals).toBe(true);
      expect(result.pendingCommitments).toEqual([
        { fromBlock: 100, toBlock: 200 },
      ]);
    });

    it('should return empty when getCommitmentsNeedingApproval fails', async () => {
      mockContractService.getCommitmentsNeedingApproval.mockRejectedValue(
        new Error('Contract error'),
      );

      const result = await service.checkForPendingApprovals();

      expect(result.hasApprovals).toBe(false);
      expect(result.pendingCommitments).toEqual([]);
    });

    it('should handle multiple commitments where some are approved and some are not', async () => {
      mockContractService.getCommitmentsNeedingApproval.mockResolvedValue([
        { fromBlock: 100, toBlock: 200, merkleRoot: '0xabc' },
        { fromBlock: 200, toBlock: 300, merkleRoot: '0xdef' },
        { fromBlock: 300, toBlock: 400, merkleRoot: '0x123' },
      ]);
      mockContractService.hasApprovedCommitment
        .mockResolvedValueOnce(true)   // first commitment: already approved
        .mockResolvedValueOnce(false)  // second commitment: not approved
        .mockResolvedValueOnce(false); // third commitment: not approved

      const result = await service.checkForPendingApprovals();

      expect(result.hasApprovals).toBe(true);
      expect(result.pendingCommitments).toEqual([
        { fromBlock: 200, toBlock: 300 },
        { fromBlock: 300, toBlock: 400 },
      ]);
    });

    it('should pass the bot address to hasApprovedCommitment', async () => {
      mockContractService.getCommitmentsNeedingApproval.mockResolvedValue([
        { fromBlock: 100, toBlock: 200, merkleRoot: '0xabc' },
      ]);
      mockContractService.hasApprovedCommitment.mockResolvedValue(false);

      await service.checkForPendingApprovals();

      expect(mockContractService.hasApprovedCommitment).toHaveBeenCalledWith(
        100,
        200,
        EXPECTED_BOT_ADDRESS,
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // shouldActivateRecovery()
  // ──────────────────────────────────────────────────────────────────────────
  describe('shouldActivateRecovery()', () => {
    it('should return shouldActivate=false when no pending commitments exist', async () => {
      mockContractService.getPendingCommitments.mockResolvedValue([]);

      const result = await service.shouldActivateRecovery();

      expect(result.shouldActivate).toBe(false);
    });

    it('should return shouldActivate=false when pending commitments are not old enough', async () => {
      mockContractService.getPendingCommitments.mockResolvedValue([
        { fromBlock: 900, toBlock: 950 },
      ]);
      // Current block = 1000, toBlock = 950 => blocksSince = 50 < 100 threshold
      mockContractService.getL1BlockNumber.mockResolvedValue(1000);

      const result = await service.shouldActivateRecovery();

      expect(result.shouldActivate).toBe(false);
      expect(result.stuckCommitments).toEqual([]);
    });

    it('should return shouldActivate=true when commitments are older than RECOVERY_BLOCK_THRESHOLD', async () => {
      mockContractService.getPendingCommitments.mockResolvedValue([
        { fromBlock: 800, toBlock: 850 },
      ]);
      // Current block = 1000, toBlock = 850 => blocksSince = 150 >= 100 threshold
      mockContractService.getL1BlockNumber.mockResolvedValue(1000);

      const result = await service.shouldActivateRecovery();

      expect(result.shouldActivate).toBe(true);
      expect(result.stuckCommitments).toEqual([
        { fromBlock: 800, toBlock: 850 },
      ]);
      expect(result.blocksSinceCommitment).toBe(150);
      expect(result.lastCommitmentBlock).toBe(850);
      expect(result.currentBlock).toBe(1000);
    });

    it('should return shouldActivate=true when blocksSince equals exactly RECOVERY_BLOCK_THRESHOLD', async () => {
      mockContractService.getPendingCommitments.mockResolvedValue([
        { fromBlock: 800, toBlock: 900 },
      ]);
      // blocksSince = 1000 - 900 = 100 (exactly the threshold)
      mockContractService.getL1BlockNumber.mockResolvedValue(1000);

      const result = await service.shouldActivateRecovery();

      expect(result.shouldActivate).toBe(true);
      expect(result.stuckCommitments).toHaveLength(1);
    });

    it('should track the oldest stuck commitment correctly with multiple commitments', async () => {
      mockContractService.getPendingCommitments.mockResolvedValue([
        { fromBlock: 700, toBlock: 750 },  // blocksSince = 250 (oldest)
        { fromBlock: 800, toBlock: 880 },  // blocksSince = 120
        { fromBlock: 900, toBlock: 950 },  // blocksSince = 50, not stuck
      ]);
      mockContractService.getL1BlockNumber.mockResolvedValue(1000);

      const result = await service.shouldActivateRecovery();

      expect(result.shouldActivate).toBe(true);
      expect(result.stuckCommitments).toHaveLength(2);
      expect(result.blocksSinceCommitment).toBe(250); // max blocks since
      expect(result.lastCommitmentBlock).toBe(750);   // oldest commitment block
    });

    it('should return shouldActivate=false when contract call fails', async () => {
      mockContractService.getPendingCommitments.mockRejectedValue(
        new Error('Contract error'),
      );

      const result = await service.shouldActivateRecovery();

      expect(result.shouldActivate).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // isAnotherBotDistributing()
  // ──────────────────────────────────────────────────────────────────────────
  describe('isAnotherBotDistributing()', () => {
    it('should return isActive=false when no recent events exist', async () => {
      mockContractService.getRecentDistributionEvents.mockResolvedValue([]);

      const result = await service.isAnotherBotDistributing(100, 200);

      expect(result.isActive).toBe(false);
      expect(mockContractService.getRecentDistributionEvents).toHaveBeenCalledWith(50);
    });

    it('should return isActive=false when events exist for different blocks', async () => {
      mockContractService.getRecentDistributionEvents.mockResolvedValue([
        { fromBlock: 300, toBlock: 400, blockTimestamp: Math.floor(Date.now() / 1000) },
      ]);

      const result = await service.isAnotherBotDistributing(100, 200);

      expect(result.isActive).toBe(false);
    });

    it('should return isActive=true when matching events exist within timeout', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      mockContractService.getRecentDistributionEvents.mockResolvedValue([
        { fromBlock: 100, toBlock: 200, blockTimestamp: nowSeconds - 60 }, // 60s ago (< 300s)
      ]);

      const result = await service.isAnotherBotDistributing(100, 200);

      expect(result.isActive).toBe(true);
    });

    it('should return isActive=false when matching events are older than ACTIVITY_TIMEOUT', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      mockContractService.getRecentDistributionEvents.mockResolvedValue([
        { fromBlock: 100, toBlock: 200, blockTimestamp: nowSeconds - 600 }, // 600s ago (> 300s)
      ]);

      const result = await service.isAnotherBotDistributing(100, 200);

      expect(result.isActive).toBe(false);
    });

    it('should use the most recent event timestamp when multiple matching events exist', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      mockContractService.getRecentDistributionEvents.mockResolvedValue([
        { fromBlock: 100, toBlock: 200, blockTimestamp: nowSeconds - 600 }, // old
        { fromBlock: 100, toBlock: 200, blockTimestamp: nowSeconds - 30 },  // recent
        { fromBlock: 100, toBlock: 200, blockTimestamp: nowSeconds - 400 }, // old
      ]);

      const result = await service.isAnotherBotDistributing(100, 200);

      // Should use the most recent event (30s ago < 300s timeout)
      expect(result.isActive).toBe(true);
    });

    it('should return isActive=false when contract call fails', async () => {
      mockContractService.getRecentDistributionEvents.mockRejectedValue(
        new Error('Network failure'),
      );

      const result = await service.isAnotherBotDistributing(100, 200);

      expect(result.isActive).toBe(false);
    });

    it('should correctly filter events by both fromBlock and toBlock', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      mockContractService.getRecentDistributionEvents.mockResolvedValue([
        { fromBlock: 100, toBlock: 300, blockTimestamp: nowSeconds - 10 }, // wrong toBlock
        { fromBlock: 50, toBlock: 200, blockTimestamp: nowSeconds - 10 },  // wrong fromBlock
        { fromBlock: 100, toBlock: 200, blockTimestamp: nowSeconds - 10 }, // exact match
      ]);

      const result = await service.isAnotherBotDistributing(100, 200);

      expect(result.isActive).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // shouldStartDistribution()
  // ──────────────────────────────────────────────────────────────────────────
  describe('shouldStartDistribution()', () => {
    it('should return true when no other bot is distributing', async () => {
      mockContractService.getRecentDistributionEvents.mockResolvedValue([]);

      const result = await service.shouldStartDistribution(100, 200);

      expect(result).toBe(true);
    });

    it('should return false when another bot is actively distributing', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      mockContractService.getRecentDistributionEvents.mockResolvedValue([
        { fromBlock: 100, toBlock: 200, blockTimestamp: nowSeconds - 30 },
      ]);

      const result = await service.shouldStartDistribution(100, 200);

      expect(result).toBe(false);
    });

    it('should return true when events exist but are expired (older than timeout)', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      mockContractService.getRecentDistributionEvents.mockResolvedValue([
        { fromBlock: 100, toBlock: 200, blockTimestamp: nowSeconds - 600 },
      ]);

      const result = await service.shouldStartDistribution(100, 200);

      expect(result).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // shouldSkipRecovery()
  // ──────────────────────────────────────────────────────────────────────────
  describe('shouldSkipRecovery()', () => {
    it('should return true (skip) when there are no stuck commitments', async () => {
      mockContractService.getPendingCommitments.mockResolvedValue([]);

      const result = await service.shouldSkipRecovery();

      expect(result).toBe(true);
    });

    it('should return true (skip) when stuck commitments exist but another bot is handling them', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      mockContractService.getPendingCommitments.mockResolvedValue([
        { fromBlock: 800, toBlock: 850 },
      ]);
      mockContractService.getL1BlockNumber.mockResolvedValue(1000);
      mockContractService.getRecentDistributionEvents.mockResolvedValue([
        { fromBlock: 800, toBlock: 850, blockTimestamp: nowSeconds - 30 },
      ]);

      const result = await service.shouldSkipRecovery();

      expect(result).toBe(true);
    });

    it('should return false (proceed) when stuck commitments exist and no other bot is handling them', async () => {
      mockContractService.getPendingCommitments.mockResolvedValue([
        { fromBlock: 800, toBlock: 850 },
      ]);
      mockContractService.getL1BlockNumber.mockResolvedValue(1000);
      mockContractService.getRecentDistributionEvents.mockResolvedValue([]);

      const result = await service.shouldSkipRecovery();

      expect(result).toBe(false);
    });

    it('should return true (skip recovery) when shouldActivateRecovery catches an internal error', async () => {
      // When getPendingCommitments throws, shouldActivateRecovery catches it
      // and returns { shouldActivate: false }. shouldSkipRecovery then sees
      // no stuck commitments and returns true (skip recovery).
      mockContractService.getPendingCommitments.mockRejectedValue(
        new Error('Contract error'),
      );

      const result = await service.shouldSkipRecovery();

      expect(result).toBe(true);
    });

    it('should return false (allow recovery) when shouldSkipRecovery own try/catch catches an error', async () => {
      // Force shouldActivateRecovery to throw past its own catch block
      // by spying on the method and making it reject
      jest.spyOn(service, 'shouldActivateRecovery').mockRejectedValue(
        new Error('Unexpected failure'),
      );

      const result = await service.shouldSkipRecovery();

      // shouldSkipRecovery's own catch returns false (allow recovery as safety)
      expect(result).toBe(false);
    });

    it('should check each stuck commitment individually for active distribution', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      mockContractService.getPendingCommitments.mockResolvedValue([
        { fromBlock: 700, toBlock: 750 }, // stuck
        { fromBlock: 800, toBlock: 850 }, // stuck
      ]);
      mockContractService.getL1BlockNumber.mockResolvedValue(1000);
      // First check: no bot handling 700-750; Second check: bot handling 800-850
      mockContractService.getRecentDistributionEvents
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { fromBlock: 800, toBlock: 850, blockTimestamp: nowSeconds - 30 },
        ]);

      // Even though first stuck commitment has no handler, we return true
      // because shouldSkipRecovery iterates and returns true on first active hit
      // Actually re-reading the code: it returns true on the FIRST active one
      // so it would check 700-750 first (not active), then 800-850 (active) => true
      // Wait, let me re-check. Actually the getRecentDistributionEvents is called
      // with ACTIVITY_WINDOW_BLOCKS (50), so the mock order matters based on call order.
      // First call for 700-750: returns [], second call for 800-850: returns event.
      const result = await service.shouldSkipRecovery();

      // Should skip because at least one stuck commitment has another bot active
      expect(result).toBe(true);
      expect(mockContractService.getRecentDistributionEvents).toHaveBeenCalledTimes(2);
    });

    it('should return false when stuck commitments exist and distribution events are expired', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      mockContractService.getPendingCommitments.mockResolvedValue([
        { fromBlock: 800, toBlock: 850 },
      ]);
      mockContractService.getL1BlockNumber.mockResolvedValue(1000);
      mockContractService.getRecentDistributionEvents.mockResolvedValue([
        { fromBlock: 800, toBlock: 850, blockTimestamp: nowSeconds - 600 }, // expired
      ]);

      const result = await service.shouldSkipRecovery();

      expect(result).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // getBotAddress() (tested indirectly)
  // ──────────────────────────────────────────────────────────────────────────
  describe('getBotAddress() (indirect)', () => {
    it('should throw Error when private key is missing', async () => {
      mockConfigService.get.mockImplementation(
        (key: string, defaultValue?: any) => {
          const config: Record<string, any> = {
            'rewards.roundRobinWindow': 130,
            // No private key configured
          };
          return config[key] !== undefined ? config[key] : defaultValue;
        },
      );

      mockContractService.getL1BlockNumber.mockResolvedValue(500);

      // isCurrentCommitter calls getBotAddress, which should throw
      // and be caught by the try/catch in isCurrentCommitter
      const result = await service.isCurrentCommitter();

      expect(result.isCommitter).toBe(false);
      expect(result.reason).toBe('error checking committer status');
    });

    it('should derive the correct address from the configured private key', async () => {
      mockContractService.getL1BlockNumber.mockResolvedValue(500);
      mockContractService.canCommit.mockResolvedValue(true);

      await service.isCurrentCommitter();

      expect(mockContractService.canCommit).toHaveBeenCalledWith(
        EXPECTED_BOT_ADDRESS,
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Edge cases and integration between methods
  // ──────────────────────────────────────────────────────────────────────────
  describe('edge cases', () => {
    it('checkCommitEligibility should call getL1BlockNumber twice (own + isCurrentCommitter)', async () => {
      mockContractService.getL1BlockNumber.mockResolvedValue(500);
      mockContractService.canCommit.mockResolvedValue(true);

      await service.checkCommitEligibility();

      // Once from checkCommitEligibility itself, once from isCurrentCommitter
      expect(mockContractService.getL1BlockNumber).toHaveBeenCalledTimes(2);
    });

    it('shouldStartDistribution should delegate to isAnotherBotDistributing and invert result', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      mockContractService.getRecentDistributionEvents.mockResolvedValue([
        { fromBlock: 100, toBlock: 200, blockTimestamp: nowSeconds - 10 },
      ]);

      const distributing = await service.isAnotherBotDistributing(100, 200);
      expect(distributing.isActive).toBe(true);

      // Reset mock call count but keep same behavior
      mockContractService.getRecentDistributionEvents.mockResolvedValue([
        { fromBlock: 100, toBlock: 200, blockTimestamp: nowSeconds - 10 },
      ]);

      const shouldStart = await service.shouldStartDistribution(100, 200);
      expect(shouldStart).toBe(false);
    });

    it('shouldActivateRecovery should not call getL1BlockNumber when there are no pending commitments', async () => {
      mockContractService.getPendingCommitments.mockResolvedValue([]);

      await service.shouldActivateRecovery();

      expect(mockContractService.getL1BlockNumber).not.toHaveBeenCalled();
    });

    it('checkForPendingApprovals should not call hasApprovedCommitment when no pending commitments', async () => {
      mockContractService.getCommitmentsNeedingApproval.mockResolvedValue([]);

      await service.checkForPendingApprovals();

      expect(mockContractService.hasApprovedCommitment).not.toHaveBeenCalled();
    });
  });
});
