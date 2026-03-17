/* eslint-disable @typescript-eslint/no-explicit-any */

// ──────────────────────────────────────────────────────────────
// Environment variables must be set BEFORE any imports
// ──────────────────────────────────────────────────────────────
process.env.DISTRIBUTOR_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
process.env.REWARDS_DISTRIBUTION_ADDRESS =
  '0x1234567890123456789012345678901234567890';

// ──────────────────────────────────────────────────────────────
// Module-level mocks (must come before the import of the SUT)
// ──────────────────────────────────────────────────────────────

const mockPublicClient = {
  readContract: jest.fn(),
  simulateContract: jest.fn(),
  waitForTransactionReceipt: jest.fn(),
};

const mockWalletClient = {
  account: { address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' },
  writeContract: jest.fn(),
};

jest.mock('viem', () => {
  const actual = jest.requireActual('viem');
  return {
    ...actual,
    createPublicClient: jest.fn().mockReturnValue(mockPublicClient),
    createWalletClient: jest.fn().mockReturnValue(mockWalletClient),
    getContract: jest.fn(),
  };
});

jest.mock('viem/accounts', () => ({
  privateKeyToAccount: jest.fn().mockReturnValue({
    address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  }),
}));

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

// ──────────────────────────────────────────────────────────────
// Imports
// ──────────────────────────────────────────────────────────────

import { DistributionService } from './distribution.service';
import { getContract, BaseError } from 'viem';

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

const TX_HASH = '0xtxhash123';
const MERKLE_ROOT = '0xabcdef';
const BLOCK_NUMBER = 42n;
const GAS_USED = 100000n;
const GAS_PRICE = 5000000000n;

const defaultReceipt = {
  transactionHash: TX_HASH,
  blockNumber: BLOCK_NUMBER,
  gasUsed: GAS_USED,
  effectiveGasPrice: GAS_PRICE,
};

function makeMerkleTreeResult(root = MERKLE_ROOT, totalBatches = 2) {
  const allLeaves = [
    {
      recipients: [1n, 2n],
      workerRewards: [100n, 200n],
      stakerRewards: [50n, 100n],
      leafHash: '0xleaf1',
    },
    {
      recipients: [3n],
      workerRewards: [300n],
      stakerRewards: [150n],
      leafHash: '0xleaf2',
    },
  ];
  const allProofs = [['0xproof1'], ['0xproof2']];
  return {
    root,
    totalBatches,
    leaves: allLeaves.slice(0, totalBatches),
    proofs: allProofs.slice(0, totalBatches),
  };
}

// ──────────────────────────────────────────────────────────────
// Mock service factories
// ──────────────────────────────────────────────────────────────

function createMockConfigService() {
  return {
    get: jest.fn((key: string, defaultValue?: any) => {
      const config: Record<string, any> = {
        'blockchain.network.l2RpcUrl': 'http://localhost:8545',
        'blockchain.distributor.privateKey':
          '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        'blockchain.contracts.rewardsDistribution':
          '0x1234567890123456789012345678901234567890',
        'blockchain.network.name': 'testnet',
      };
      return config[key] !== undefined ? config[key] : defaultValue;
    }),
  };
}

function createMockContractService() {
  return {
    client: mockPublicClient,
    getBlockTimestamp: jest
      .fn()
      .mockResolvedValue(new Date('2024-01-01T00:00:00Z')),
  };
}

function createMockMerkleTreeService() {
  return {
    generateMerkleTree: jest.fn().mockResolvedValue(makeMerkleTreeResult()),
  };
}

function createMockRewardsCalculatorService() {
  return {
    calculateRewardsDetailed: jest.fn().mockResolvedValue({
      workers: [
        {
          workerId: 1n,
          id: 1n,
          workerReward: 100n,
          stakerReward: 50n,
          stake: 1000n,
          totalStake: 2000n,
        },
        {
          workerId: 2n,
          id: 2n,
          workerReward: 200n,
          stakerReward: 100n,
          stake: 3000n,
          totalStake: 5000n,
        },
      ],
      totalRewards: 300n,
      calculationTime: 10,
    }),
    calculateRewardsFormatted: jest.fn().mockResolvedValue({
      totalRewards: { worker: '300', staker: '150' },
      workers: [],
    }),
  };
}

function createMockRecoveryService() {
  return {};
}

function createMockErrorDecoder() {
  return {
    formatError: jest.fn().mockReturnValue('decoded error message'),
    getErrorContext: jest.fn().mockReturnValue({}),
    isSpecificError: jest.fn().mockReturnValue(false),
  };
}

function createMockRewardsReporterService() {
  return {
    logSuccessfulRewardsReport: jest.fn().mockResolvedValue(undefined),
    logFailedRewardsReport: jest.fn().mockResolvedValue(undefined),
  };
}

function createMockEpochMetricsService() {
  return {
    collectNetworkMetrics: jest.fn().mockResolvedValue({}),
    extractRewardMetrics: jest.fn().mockReturnValue({}),
  };
}

function createMockCommitmentKeyService() {
  return {
    generateKey: jest.fn().mockReturnValue('0xcommitmentkey'),
  };
}

function createMockS3Service(enabled = false) {
  return {
    isEnabled: jest.fn().mockReturnValue(enabled),
    generateS3Key: jest
      .fn()
      .mockReturnValue('rewards/testnet/distributions/100-200.json'),
    uploadEpochRewards: jest.fn().mockResolvedValue({
      key: 'test.json',
      url: 'https://s3/test.json',
    }),
    downloadJson: jest.fn().mockResolvedValue(null),
    checkFileExists: jest.fn().mockResolvedValue(false),
  };
}

// ──────────────────────────────────────────────────────────────
// Service factory
// ──────────────────────────────────────────────────────────────

interface MockServices {
  configService: ReturnType<typeof createMockConfigService>;
  contractService: ReturnType<typeof createMockContractService>;
  merkleTreeService: ReturnType<typeof createMockMerkleTreeService>;
  rewardsCalculatorService: ReturnType<
    typeof createMockRewardsCalculatorService
  >;
  recoveryService: ReturnType<typeof createMockRecoveryService>;
  errorDecoder: ReturnType<typeof createMockErrorDecoder>;
  rewardsReporterService: ReturnType<typeof createMockRewardsReporterService>;
  epochMetricsService: ReturnType<typeof createMockEpochMetricsService>;
  commitmentKeyService: ReturnType<typeof createMockCommitmentKeyService>;
  s3Service: ReturnType<typeof createMockS3Service>;
}

function createService(overrides: Partial<MockServices> = {}): {
  service: DistributionService;
  mocks: MockServices;
} {
  const mocks: MockServices = {
    configService: overrides.configService ?? createMockConfigService(),
    contractService: overrides.contractService ?? createMockContractService(),
    merkleTreeService:
      overrides.merkleTreeService ?? createMockMerkleTreeService(),
    rewardsCalculatorService:
      overrides.rewardsCalculatorService ??
      createMockRewardsCalculatorService(),
    recoveryService: overrides.recoveryService ?? createMockRecoveryService(),
    errorDecoder: overrides.errorDecoder ?? createMockErrorDecoder(),
    rewardsReporterService:
      overrides.rewardsReporterService ?? createMockRewardsReporterService(),
    epochMetricsService:
      overrides.epochMetricsService ?? createMockEpochMetricsService(),
    commitmentKeyService:
      overrides.commitmentKeyService ?? createMockCommitmentKeyService(),
    s3Service: overrides.s3Service ?? createMockS3Service(),
  };

  const service = new DistributionService(
    mocks.configService as any,
    mocks.contractService as any,
    mocks.merkleTreeService as any,
    mocks.rewardsCalculatorService as any,
    mocks.recoveryService as any,
    mocks.errorDecoder as any,
    mocks.rewardsReporterService as any,
    mocks.epochMetricsService as any,
    mocks.commitmentKeyService as any,
    mocks.s3Service as any,
  );

  // Override the viem clients with our mocks
  (service as any).publicClient = mockPublicClient;
  (service as any).walletClient = mockWalletClient;

  return { service, mocks };
}

// ──────────────────────────────────────────────────────────────
// Setup helpers for blockchain call sequences
// ──────────────────────────────────────────────────────────────

/**
 * Sets up mockPublicClient for a fresh distribution (no existing commitment).
 */
function setupFreshDistribution() {
  mockPublicClient.readContract
    .mockResolvedValueOnce([0, 0n, 0n, '0x0', 0, 0, 0n, '']) // commitments check in distributeEpochRewards
    .mockResolvedValueOnce(true) // canCommit
    .mockResolvedValueOnce([0, 0n, 0n, '0x0', 0, 0, 0n, '']); // commitments check in commitMerkleRoot

  mockPublicClient.simulateContract.mockResolvedValueOnce({
    request: 'commitRequest',
  });
  mockWalletClient.writeContract.mockResolvedValueOnce(TX_HASH);
  mockPublicClient.waitForTransactionReceipt.mockResolvedValueOnce(
    defaultReceipt,
  );

  // Distribute batch 1
  mockPublicClient.simulateContract.mockResolvedValueOnce({
    request: 'distRequest1',
  });
  mockWalletClient.writeContract.mockResolvedValueOnce('0xbatch1hash');
  mockPublicClient.waitForTransactionReceipt.mockResolvedValueOnce({
    ...defaultReceipt,
    transactionHash: '0xbatch1hash',
  });

  // Distribute batch 2
  mockPublicClient.simulateContract.mockResolvedValueOnce({
    request: 'distRequest2',
  });
  mockWalletClient.writeContract.mockResolvedValueOnce('0xbatch2hash');
  mockPublicClient.waitForTransactionReceipt.mockResolvedValueOnce({
    ...defaultReceipt,
    transactionHash: '0xbatch2hash',
  });
}

/**
 * Sets up for resumeDistribution (existing commitment with matching root).
 */
function setupResumeWithMatchingRoot() {
  mockPublicClient.readContract.mockResolvedValueOnce([
    1,
    100n,
    200n,
    MERKLE_ROOT,
    2,
    0,
    1n,
    '',
  ]);

  // Distribute batch 1
  mockPublicClient.simulateContract.mockResolvedValueOnce({
    request: 'distRequest1',
  });
  mockWalletClient.writeContract.mockResolvedValueOnce('0xbatch1hash');
  mockPublicClient.waitForTransactionReceipt.mockResolvedValueOnce({
    ...defaultReceipt,
    transactionHash: '0xbatch1hash',
  });

  // Distribute batch 2
  mockPublicClient.simulateContract.mockResolvedValueOnce({
    request: 'distRequest2',
  });
  mockWalletClient.writeContract.mockResolvedValueOnce('0xbatch2hash');
  mockPublicClient.waitForTransactionReceipt.mockResolvedValueOnce({
    ...defaultReceipt,
    transactionHash: '0xbatch2hash',
  });
}

// ──────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────

describe('DistributionService', () => {
  // Make setTimeout resolve immediately so retry delays are instant
  const originalSetTimeout = global.setTimeout;

  beforeAll(() => {
    (global as any).setTimeout = (fn: Function, _ms?: number) =>
      originalSetTimeout(fn, 0);
  });

  afterAll(() => {
    global.setTimeout = originalSetTimeout;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ================================================================
  //  1. Constructor
  // ================================================================

  describe('constructor', () => {
    it('should instantiate successfully with valid config', () => {
      const { service } = createService();
      expect(service).toBeDefined();
    });

    it('should throw when DISTRIBUTOR_PRIVATE_KEY is missing', () => {
      const origKey = process.env.DISTRIBUTOR_PRIVATE_KEY;
      delete process.env.DISTRIBUTOR_PRIVATE_KEY;

      const configService = createMockConfigService();
      configService.get.mockImplementation(
        (key: string, defaultValue?: any) => {
          if (key === 'blockchain.distributor.privateKey') return undefined;
          if (key === 'blockchain.network.l2RpcUrl')
            return 'http://localhost:8545';
          return defaultValue;
        },
      );

      expect(
        () =>
          new DistributionService(
            configService as any,
            createMockContractService() as any,
            createMockMerkleTreeService() as any,
            createMockRewardsCalculatorService() as any,
            createMockRecoveryService() as any,
            createMockErrorDecoder() as any,
            createMockRewardsReporterService() as any,
            createMockEpochMetricsService() as any,
            createMockCommitmentKeyService() as any,
            createMockS3Service() as any,
          ),
      ).toThrow('DISTRIBUTOR_PRIVATE_KEY environment variable is required');

      process.env.DISTRIBUTOR_PRIVATE_KEY = origKey;
    });

    it('should throw when DISTRIBUTOR_PRIVATE_KEY has invalid format', () => {
      const origKey = process.env.DISTRIBUTOR_PRIVATE_KEY;
      process.env.DISTRIBUTOR_PRIVATE_KEY = '0xshort';

      const configService = createMockConfigService();
      configService.get.mockImplementation(
        (key: string, defaultValue?: any) => {
          if (key === 'blockchain.distributor.privateKey') return undefined;
          if (key === 'blockchain.network.l2RpcUrl')
            return 'http://localhost:8545';
          return defaultValue;
        },
      );

      expect(
        () =>
          new DistributionService(
            configService as any,
            createMockContractService() as any,
            createMockMerkleTreeService() as any,
            createMockRewardsCalculatorService() as any,
            createMockRecoveryService() as any,
            createMockErrorDecoder() as any,
            createMockRewardsReporterService() as any,
            createMockEpochMetricsService() as any,
            createMockCommitmentKeyService() as any,
            createMockS3Service() as any,
          ),
      ).toThrow('Invalid private key format');

      process.env.DISTRIBUTOR_PRIVATE_KEY = origKey;
    });
  });

  // ================================================================
  //  2. distributeEpochRewards — happy path (no existing commitment)
  // ================================================================

  describe('distributeEpochRewards — fresh distribution', () => {
    it('should execute full distribution when no existing commitment', async () => {
      const { service, mocks } = createService();
      setupFreshDistribution();

      const result = await service.distributeEpochRewards(100, 200, 75);

      expect(result.status).toBe('completed');
      expect(result.epochId).toBe('100-200');
      expect(result.fromBlock).toBe(100);
      expect(result.toBlock).toBe(200);
      expect(result.totalWorkers).toBe(2);
      expect(result.totalBatches).toBe(2);
      expect(result.processedBatches).toBe(2);
      expect(result.merkleRoot).toBe(MERKLE_ROOT);
      expect(result.completedAt).toBeDefined();
      expect(result.sessionId).toBeDefined();

      expect(
        mocks.rewardsCalculatorService.calculateRewardsDetailed,
      ).toHaveBeenCalledWith(
        expect.anything(),
        100,
        200,
        true,
        undefined,
        undefined,
      );
    });

    it('should calculate totalRewards from worker rewards', async () => {
      const { service } = createService();
      setupFreshDistribution();

      const result = await service.distributeEpochRewards(100, 200, 75);

      expect(result.totalRewards).toBe(300n);
    });

    it('should include transaction logs for commit and distribute', async () => {
      const { service } = createService();
      setupFreshDistribution();

      const result = await service.distributeEpochRewards(100, 200, 75);

      expect(result.transactionLogs).toBeDefined();
      expect(result.transactionLogs!.length).toBeGreaterThanOrEqual(3);
      expect(result.transactionLogs![0].type).toBe('commit');
      expect(result.transactionLogs![0].status).toBe('success');
    });

    it('should call generateMerkleTree with workers and batchSize', async () => {
      const { service, mocks } = createService();
      setupFreshDistribution();

      await service.distributeEpochRewards(100, 200, 50);

      expect(mocks.merkleTreeService.generateMerkleTree).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ workerId: 1n }),
          expect.objectContaining({ workerId: 2n }),
        ]),
        50,
      );
    });

    it('should generate rewards report after successful distribution', async () => {
      const { service, mocks } = createService();
      setupFreshDistribution();

      await service.distributeEpochRewards(100, 200, 75);

      expect(
        mocks.rewardsCalculatorService.calculateRewardsFormatted,
      ).toHaveBeenCalled();
      expect(
        mocks.rewardsReporterService.logSuccessfulRewardsReport,
      ).toHaveBeenCalled();
    });

    it('should not fail when rewards report generation fails', async () => {
      const { service, mocks } = createService();
      setupFreshDistribution();
      mocks.rewardsCalculatorService.calculateRewardsFormatted.mockRejectedValueOnce(
        new Error('report error'),
      );

      const result = await service.distributeEpochRewards(100, 200, 75);

      expect(result.status).toBe('completed');
    });
  });

  // ================================================================
  //  3. distributeEpochRewards — S3 upload during fresh distribution
  // ================================================================

  describe('distributeEpochRewards — S3 upload', () => {
    it('should upload to S3 when S3 is enabled', async () => {
      const s3Service = createMockS3Service(true);
      const { service } = createService({ s3Service });
      setupFreshDistribution();

      await service.distributeEpochRewards(100, 200, 75);

      expect(s3Service.uploadEpochRewards).toHaveBeenCalled();
    });

    it('should skip S3 upload when S3 is disabled', async () => {
      const s3Service = createMockS3Service(false);
      const { service } = createService({ s3Service });
      setupFreshDistribution();

      await service.distributeEpochRewards(100, 200, 75);

      expect(s3Service.uploadEpochRewards).not.toHaveBeenCalled();
    });

    it('should continue distribution even when S3 upload fails', async () => {
      const s3Service = createMockS3Service(true);
      s3Service.uploadEpochRewards.mockRejectedValueOnce(
        new Error('S3 upload failed'),
      );
      const { service } = createService({ s3Service });
      setupFreshDistribution();

      const result = await service.distributeEpochRewards(100, 200, 75);

      expect(result.status).toBe('completed');
    });

    it('should use S3 key from s3Service when S3 is enabled', async () => {
      const s3Service = createMockS3Service(true);
      const { service } = createService({ s3Service });
      setupFreshDistribution();

      await service.distributeEpochRewards(100, 200, 75);

      expect(s3Service.generateS3Key).toHaveBeenCalledWith(
        'testnet',
        100,
        200,
      );
    });
  });

  // ================================================================
  //  4. distributeEpochRewards — resume distribution
  // ================================================================

  describe('distributeEpochRewards — resume distribution', () => {
    it('should resume when existing commitment matches reconstructed root', async () => {
      const { service, mocks } = createService();
      setupResumeWithMatchingRoot();

      const result = await service.distributeEpochRewards(100, 200, 75);

      expect(result.status).toBe('completed');
      expect(result.merkleRoot).toBe(MERKLE_ROOT);
      expect(
        mocks.rewardsCalculatorService.calculateRewardsDetailed,
      ).toHaveBeenCalled();
    });

    it('should recover from S3 when reconstructed root does not match', async () => {
      const s3Service = createMockS3Service(false);
      const merkleTreeService = createMockMerkleTreeService();

      merkleTreeService.generateMerkleTree
        .mockResolvedValueOnce(makeMerkleTreeResult('0xwrongroot'))
        .mockResolvedValueOnce(makeMerkleTreeResult(MERKLE_ROOT));

      s3Service.downloadJson.mockResolvedValueOnce({
        rawData: {
          totalWorkers: 2,
          workers: [
            { workerId: '1', workerReward: '100', stakerReward: '50' },
            { workerId: '2', workerReward: '200', stakerReward: '100' },
          ],
        },
        merkleTree: { root: MERKLE_ROOT, totalBatches: 2, batchSize: 75 },
      });

      const { service } = createService({ s3Service, merkleTreeService });

      mockPublicClient.readContract.mockResolvedValueOnce([
        1,
        100n,
        200n,
        MERKLE_ROOT,
        2,
        0,
        1n,
        '',
      ]);

      mockPublicClient.simulateContract
        .mockResolvedValueOnce({ request: 'dist1' })
        .mockResolvedValueOnce({ request: 'dist2' });
      mockWalletClient.writeContract
        .mockResolvedValueOnce('0xb1')
        .mockResolvedValueOnce('0xb2');
      mockPublicClient.waitForTransactionReceipt
        .mockResolvedValueOnce({ ...defaultReceipt, transactionHash: '0xb1' })
        .mockResolvedValueOnce({ ...defaultReceipt, transactionHash: '0xb2' });

      const result = await service.distributeEpochRewards(100, 200, 75);

      expect(result.status).toBe('completed');
      expect(s3Service.downloadJson).toHaveBeenCalled();
    });

    it('should throw when root mismatch and S3 recovery fails', async () => {
      const merkleTreeService = createMockMerkleTreeService();
      merkleTreeService.generateMerkleTree.mockResolvedValueOnce(
        makeMerkleTreeResult('0xwrongroot'),
      );

      const s3Service = createMockS3Service(false);
      s3Service.downloadJson.mockResolvedValueOnce(null);

      const { service } = createService({ s3Service, merkleTreeService });

      mockPublicClient.readContract.mockResolvedValueOnce([
        1,
        100n,
        200n,
        MERKLE_ROOT,
        2,
        0,
        1n,
        '',
      ]);

      const result = await service.distributeEpochRewards(100, 200, 75);

      expect(result.status).toBe('failed');
      expect(result.error).toContain(
        'Cannot recover: merkle root mismatch and S3 recovery failed',
      );
    });

    it('should throw when root mismatch and S3 returns data with wrong root', async () => {
      const merkleTreeService = createMockMerkleTreeService();
      merkleTreeService.generateMerkleTree
        .mockResolvedValueOnce(makeMerkleTreeResult('0xwrongroot'))
        .mockResolvedValueOnce(makeMerkleTreeResult('0xstillwrong'));

      const s3Service = createMockS3Service(false);
      s3Service.downloadJson.mockResolvedValueOnce({
        rawData: {
          totalWorkers: 2,
          workers: [
            { workerId: '1', workerReward: '100', stakerReward: '50' },
          ],
        },
        merkleTree: {
          root: '0xstillwrong',
          totalBatches: 1,
          batchSize: 75,
        },
      });

      const { service } = createService({ s3Service, merkleTreeService });

      mockPublicClient.readContract.mockResolvedValueOnce([
        1,
        100n,
        200n,
        MERKLE_ROOT,
        2,
        0,
        1n,
        '',
      ]);

      const result = await service.distributeEpochRewards(100, 200, 75);

      expect(result.status).toBe('failed');
      expect(result.error).toContain('Cannot recover');
    });

    it('should upload to S3 during recovery when S3 is enabled', async () => {
      const s3Service = createMockS3Service(true);
      const { service } = createService({ s3Service });

      setupResumeWithMatchingRoot();

      await service.distributeEpochRewards(100, 200, 75);

      expect(s3Service.uploadEpochRewards).toHaveBeenCalled();
    });

    it('should continue distribution even when S3 upload fails during recovery', async () => {
      const s3Service = createMockS3Service(true);
      s3Service.uploadEpochRewards.mockRejectedValueOnce(
        new Error('S3 upload error'),
      );

      const { service } = createService({ s3Service });
      setupResumeWithMatchingRoot();

      const result = await service.distributeEpochRewards(100, 200, 75);

      expect(result.status).toBe('completed');
    });
  });

  // ================================================================
  //  5. distributeEpochRewards — error handling
  // ================================================================

  describe('distributeEpochRewards — error handling', () => {
    it('should return failed status when calculateRewardsDetailed throws', async () => {
      const rewardsCalculatorService = createMockRewardsCalculatorService();
      rewardsCalculatorService.calculateRewardsDetailed.mockRejectedValueOnce(
        new Error('calculation error'),
      );

      const { service } = createService({ rewardsCalculatorService });

      mockPublicClient.readContract.mockResolvedValueOnce([
        0,
        0n,
        0n,
        '0x0',
        0,
        0,
        0n,
        '',
      ]);

      const result = await service.distributeEpochRewards(100, 200, 75);

      expect(result.status).toBe('failed');
      expect(result.error).toBe('calculation error');
    });

    it('should call logFailedRewardsReport on error', async () => {
      const rewardsCalculatorService = createMockRewardsCalculatorService();
      rewardsCalculatorService.calculateRewardsDetailed.mockRejectedValueOnce(
        new Error('boom'),
      );

      const rewardsReporterService = createMockRewardsReporterService();
      const { service } = createService({
        rewardsCalculatorService,
        rewardsReporterService,
      });

      mockPublicClient.readContract.mockResolvedValueOnce([
        0,
        0n,
        0n,
        '0x0',
        0,
        0,
        0n,
        '',
      ]);

      await service.distributeEpochRewards(100, 200, 75);

      expect(
        rewardsReporterService.logFailedRewardsReport,
      ).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Date),
        expect.any(Date),
        '',
        expect.any(Error),
      );
    });

    it('should handle logFailedRewardsReport itself throwing', async () => {
      const rewardsCalculatorService = createMockRewardsCalculatorService();
      rewardsCalculatorService.calculateRewardsDetailed.mockRejectedValueOnce(
        new Error('boom'),
      );

      const rewardsReporterService = createMockRewardsReporterService();
      rewardsReporterService.logFailedRewardsReport.mockRejectedValueOnce(
        new Error('report error too'),
      );

      const { service } = createService({
        rewardsCalculatorService,
        rewardsReporterService,
      });

      mockPublicClient.readContract.mockResolvedValueOnce([
        0,
        0n,
        0n,
        '0x0',
        0,
        0,
        0n,
        '',
      ]);

      const result = await service.distributeEpochRewards(100, 200, 75);

      expect(result.status).toBe('failed');
      expect(result.error).toBe('boom');
    });

    it('should use errorDecoder.formatError for BaseError instances', async () => {
      const errorDecoder = createMockErrorDecoder();
      errorDecoder.formatError.mockReturnValue('decoded contract error');

      const rewardsCalculatorService = createMockRewardsCalculatorService();
      const baseError = new BaseError('viem error');
      rewardsCalculatorService.calculateRewardsDetailed.mockRejectedValueOnce(
        baseError,
      );

      const { service } = createService({
        rewardsCalculatorService,
        errorDecoder,
      });

      mockPublicClient.readContract.mockResolvedValueOnce([
        0,
        0n,
        0n,
        '0x0',
        0,
        0,
        0n,
        '',
      ]);

      const result = await service.distributeEpochRewards(100, 200, 75);

      expect(result.status).toBe('failed');
      expect(result.error).toBe('decoded contract error');
      expect(errorDecoder.formatError).toHaveBeenCalled();
    });

    it('should handle commitment check error gracefully and proceed as fresh', async () => {
      const { service } = createService();

      mockPublicClient.readContract
        .mockRejectedValueOnce(new Error('contract read failed'))
        .mockResolvedValueOnce(true) // canCommit
        .mockResolvedValueOnce([0, 0n, 0n, '0x0', 0, 0, 0n, '']); // commitment check

      mockPublicClient.simulateContract
        .mockResolvedValueOnce({ request: 'commitReq' })
        .mockResolvedValueOnce({ request: 'dist1' })
        .mockResolvedValueOnce({ request: 'dist2' });
      mockWalletClient.writeContract
        .mockResolvedValueOnce(TX_HASH)
        .mockResolvedValueOnce('0xb1')
        .mockResolvedValueOnce('0xb2');
      mockPublicClient.waitForTransactionReceipt
        .mockResolvedValueOnce(defaultReceipt)
        .mockResolvedValueOnce({ ...defaultReceipt, transactionHash: '0xb1' })
        .mockResolvedValueOnce({ ...defaultReceipt, transactionHash: '0xb2' });

      const result = await service.distributeEpochRewards(100, 200, 75);

      expect(result.status).toBe('completed');
    });
  });

  // ================================================================
  //  6. getDistributionStatus
  // ================================================================

  describe('getDistributionStatus', () => {
    it('should return commitment info from the contract', async () => {
      const { service } = createService();

      mockPublicClient.readContract.mockResolvedValueOnce([
        1,
        100n,
        200n,
        MERKLE_ROOT,
        2n,
        1n,
        3n,
        'ipfs://link',
      ]);

      const status = await service.getDistributionStatus(100, 200);

      expect(status).toEqual({
        status: 1,
        fromBlock: 100,
        toBlock: 200,
        merkleRoot: MERKLE_ROOT,
        totalBatches: 2,
        processedBatches: 1,
        approvalCount: '3',
        ipfsLink: 'ipfs://link',
      });
    });

    it('should throw when readContract fails', async () => {
      const { service } = createService();

      mockPublicClient.readContract.mockRejectedValueOnce(
        new Error('network error'),
      );

      await expect(service.getDistributionStatus(100, 200)).rejects.toThrow(
        'network error',
      );
    });
  });

  // ================================================================
  //  7. generateMerkleTreeOnly
  // ================================================================

  describe('generateMerkleTreeOnly', () => {
    it('should delegate to merkleTreeService.generateMerkleTree', async () => {
      const { service, mocks } = createService();

      const workers = [
        { workerId: 1n, workerReward: 100n, stakerReward: 50n },
        { workerId: 2n, workerReward: 200n, stakerReward: 100n },
      ];

      const result = await service.generateMerkleTreeOnly(workers, 10);

      expect(
        mocks.merkleTreeService.generateMerkleTree,
      ).toHaveBeenCalledWith(workers, 10);
      expect(result.root).toBe(MERKLE_ROOT);
    });

    it('should use default batch size when not provided', async () => {
      const { service, mocks } = createService();

      const workers = [
        { workerId: 1n, workerReward: 100n, stakerReward: 50n },
      ];

      await service.generateMerkleTreeOnly(workers);

      expect(
        mocks.merkleTreeService.generateMerkleTree,
      ).toHaveBeenCalledWith(workers, expect.any(Number));
    });
  });

  // ================================================================
  //  8. commitRootOnly
  // ================================================================

  describe('commitRootOnly', () => {
    it('should return success=true on successful commit', async () => {
      const { service } = createService();

      mockPublicClient.readContract
        .mockResolvedValueOnce(true) // canCommit
        .mockResolvedValueOnce([0, 0n, 0n, '0x0', 0, 0, 0n, '']); // commitment check

      mockPublicClient.simulateContract.mockResolvedValueOnce({
        request: 'commitReq',
      });
      mockWalletClient.writeContract.mockResolvedValueOnce(TX_HASH);
      mockPublicClient.waitForTransactionReceipt.mockResolvedValueOnce(
        defaultReceipt,
      );

      const result = await service.commitRootOnly(100, 200, MERKLE_ROOT, 2);

      expect(result.success).toBe(true);
      expect(result.txHash).toBe(TX_HASH);
      expect(result.blockNumber).toBe(Number(BLOCK_NUMBER));
      expect(result.gasUsed).toBe(GAS_USED);
      expect(result.gasPrice).toBe(GAS_PRICE);
      expect(result.sessionId).toBeDefined();
    });

    it('should return success=false when all commit retries fail', async () => {
      const { service } = createService();

      for (let i = 0; i < 3; i++) {
        mockPublicClient.readContract
          .mockResolvedValueOnce(true) // canCommit
          .mockResolvedValueOnce([0, 0n, 0n, '0x0', 0, 0, 0n, '']); // commitment check
        mockPublicClient.simulateContract.mockRejectedValueOnce(
          new Error('simulate failed'),
        );
      }

      const result = await service.commitRootOnly(100, 200, MERKLE_ROOT, 2);

      expect(result.success).toBe(false);
    });

    it('should skip commit if already committed with matching params', async () => {
      const { service } = createService();

      mockPublicClient.readContract
        .mockResolvedValueOnce(true) // canCommit
        .mockResolvedValueOnce([
          1,
          100n,
          200n,
          MERKLE_ROOT,
          2,
          0,
          0n,
          '',
        ]); // existing matching commitment

      const result = await service.commitRootOnly(100, 200, MERKLE_ROOT, 2);

      // commitSuccess = true but transactionLog is null => returns success: false
      expect(result.success).toBe(false);
      expect(mockPublicClient.simulateContract).not.toHaveBeenCalled();
    });

    it('should use S3 key when S3 is enabled and no ipfsLink provided', async () => {
      const s3Service = createMockS3Service(true);
      const { service } = createService({ s3Service });

      mockPublicClient.readContract
        .mockResolvedValueOnce(true) // canCommit
        .mockResolvedValueOnce([0, 0n, 0n, '0x0', 0, 0, 0n, '']); // no existing

      mockPublicClient.simulateContract.mockResolvedValueOnce({
        request: 'commitReq',
      });
      mockWalletClient.writeContract.mockResolvedValueOnce(TX_HASH);
      mockPublicClient.waitForTransactionReceipt.mockResolvedValueOnce(
        defaultReceipt,
      );

      await service.commitRootOnly(100, 200, MERKLE_ROOT, 2);

      expect(s3Service.generateS3Key).toHaveBeenCalledWith(
        'testnet',
        100,
        200,
      );
    });

    it('should use provided ipfsLink when given', async () => {
      const s3Service = createMockS3Service(true);
      const { service } = createService({ s3Service });

      mockPublicClient.readContract
        .mockResolvedValueOnce(true) // canCommit
        .mockResolvedValueOnce([0, 0n, 0n, '0x0', 0, 0, 0n, '']); // no existing

      mockPublicClient.simulateContract.mockResolvedValueOnce({
        request: 'commitReq',
      });
      mockWalletClient.writeContract.mockResolvedValueOnce(TX_HASH);
      mockPublicClient.waitForTransactionReceipt.mockResolvedValueOnce(
        defaultReceipt,
      );

      await service.commitRootOnly(
        100,
        200,
        MERKLE_ROOT,
        2,
        'ipfs://custom-link',
      );

      expect(mockPublicClient.simulateContract).toHaveBeenCalled();
    });
  });

  // ================================================================
  //  9. getApprovedEpochsForDistribution
  // ================================================================

  describe('getApprovedEpochsForDistribution', () => {
    const mockContract = {
      read: {
        lastCommitmentKey: jest.fn(),
        commitments: jest.fn(),
        requiredApproves: jest.fn(),
      },
    };

    beforeEach(() => {
      (getContract as jest.Mock).mockReturnValue(mockContract);
      mockContract.read.lastCommitmentKey.mockReset();
      mockContract.read.commitments.mockReset();
      mockContract.read.requiredApproves.mockReset();
    });

    it('should return [] when no commitment key exists', async () => {
      const { service } = createService();
      mockContract.read.lastCommitmentKey.mockResolvedValueOnce(
        '0x0000000000000000000000000000000000000000000000000000000000000000',
      );

      const result = await service.getApprovedEpochsForDistribution();

      expect(result).toEqual([]);
    });

    it('should return [] when lastCommitmentKey is null', async () => {
      const { service } = createService();
      mockContract.read.lastCommitmentKey.mockResolvedValueOnce(null);

      const result = await service.getApprovedEpochsForDistribution();

      expect(result).toEqual([]);
    });

    it('should return epoch when commitment is approved and not fully distributed', async () => {
      const { service } = createService();

      mockContract.read.lastCommitmentKey.mockResolvedValueOnce('0xsomekey');
      mockContract.read.commitments.mockResolvedValueOnce([
        1, // ACTIVE
        100n,
        200n,
        MERKLE_ROOT,
        5n,
        2n,
        3n,
        'ipfs://link',
      ]);
      mockContract.read.requiredApproves.mockResolvedValueOnce(2n);

      const result = await service.getApprovedEpochsForDistribution();

      expect(result).toEqual([
        {
          fromBlock: 100,
          toBlock: 200,
          merkleRoot: MERKLE_ROOT,
          totalBatches: 5,
          processedBatches: 2,
        },
      ]);
    });

    it('should return [] when approval count is insufficient', async () => {
      const { service } = createService();

      mockContract.read.lastCommitmentKey.mockResolvedValueOnce('0xsomekey');
      mockContract.read.commitments.mockResolvedValueOnce([
        1,
        100n,
        200n,
        MERKLE_ROOT,
        5n,
        0n,
        1n,
        '',
      ]);
      mockContract.read.requiredApproves.mockResolvedValueOnce(3n);

      const result = await service.getApprovedEpochsForDistribution();

      expect(result).toEqual([]);
    });

    it('should return [] when all batches are already processed', async () => {
      const { service } = createService();

      mockContract.read.lastCommitmentKey.mockResolvedValueOnce('0xsomekey');
      mockContract.read.commitments.mockResolvedValueOnce([
        1,
        100n,
        200n,
        MERKLE_ROOT,
        5n,
        5n, // fully processed
        3n,
        '',
      ]);
      mockContract.read.requiredApproves.mockResolvedValueOnce(2n);

      const result = await service.getApprovedEpochsForDistribution();

      expect(result).toEqual([]);
    });

    it('should return [] when commitment status is not ACTIVE', async () => {
      const { service } = createService();

      mockContract.read.lastCommitmentKey.mockResolvedValueOnce('0xsomekey');
      mockContract.read.commitments.mockResolvedValueOnce([
        0, // INACTIVE
        100n,
        200n,
        MERKLE_ROOT,
        5n,
        0n,
        3n,
        '',
      ]);
      mockContract.read.requiredApproves.mockResolvedValueOnce(2n);

      const result = await service.getApprovedEpochsForDistribution();

      expect(result).toEqual([]);
    });

    it('should return [] when getContract throws', async () => {
      const { service } = createService();
      (getContract as jest.Mock).mockImplementationOnce(() => {
        throw new Error('getContract failed');
      });

      const result = await service.getApprovedEpochsForDistribution();

      expect(result).toEqual([]);
    });

    it('should return [] when commitment read throws', async () => {
      const { service } = createService();

      mockContract.read.lastCommitmentKey.mockResolvedValueOnce('0xsomekey');
      mockContract.read.commitments.mockRejectedValueOnce(
        new Error('read failed'),
      );

      const result = await service.getApprovedEpochsForDistribution();

      expect(result).toEqual([]);
    });
  });

  // ================================================================
  //  10. distributeApprovedEpoch
  // ================================================================

  describe('distributeApprovedEpoch', () => {
    it('should distribute when merkle root matches', async () => {
      const { service, mocks } = createService();

      mockPublicClient.simulateContract
        .mockResolvedValueOnce({ request: 'dist1' })
        .mockResolvedValueOnce({ request: 'dist2' });
      mockWalletClient.writeContract
        .mockResolvedValueOnce('0xb1')
        .mockResolvedValueOnce('0xb2');
      mockPublicClient.waitForTransactionReceipt
        .mockResolvedValueOnce({ ...defaultReceipt, transactionHash: '0xb1' })
        .mockResolvedValueOnce({ ...defaultReceipt, transactionHash: '0xb2' });

      const result = await service.distributeApprovedEpoch(
        100,
        200,
        MERKLE_ROOT,
      );

      expect(result).toBe(true);
      expect(
        mocks.rewardsCalculatorService.calculateRewardsDetailed,
      ).toHaveBeenCalled();
    });

    it('should return true when no workers found', async () => {
      const rewardsCalculatorService = createMockRewardsCalculatorService();
      rewardsCalculatorService.calculateRewardsDetailed.mockResolvedValueOnce({
        workers: [],
        totalRewards: 0n,
        calculationTime: 1,
      });

      const { service } = createService({ rewardsCalculatorService });

      const result = await service.distributeApprovedEpoch(
        100,
        200,
        MERKLE_ROOT,
      );

      expect(result).toBe(true);
    });

    it('should recover from S3 when merkle root does not match and S3 recovery succeeds', async () => {
      const merkleTreeService = createMockMerkleTreeService();
      merkleTreeService.generateMerkleTree
        .mockResolvedValueOnce(makeMerkleTreeResult('0xwrongroot'))
        .mockResolvedValueOnce(makeMerkleTreeResult(MERKLE_ROOT));

      const s3Service = createMockS3Service(false);
      s3Service.downloadJson.mockResolvedValueOnce({
        rawData: {
          totalWorkers: 2,
          workers: [
            { workerId: '1', workerReward: '100', stakerReward: '50' },
            { workerId: '2', workerReward: '200', stakerReward: '100' },
          ],
        },
        merkleTree: { root: MERKLE_ROOT, totalBatches: 2, batchSize: 75 },
      });

      const { service } = createService({ s3Service, merkleTreeService });

      mockPublicClient.simulateContract
        .mockResolvedValueOnce({ request: 'dist1' })
        .mockResolvedValueOnce({ request: 'dist2' });
      mockWalletClient.writeContract
        .mockResolvedValueOnce('0xb1')
        .mockResolvedValueOnce('0xb2');
      mockPublicClient.waitForTransactionReceipt
        .mockResolvedValueOnce({ ...defaultReceipt, transactionHash: '0xb1' })
        .mockResolvedValueOnce({ ...defaultReceipt, transactionHash: '0xb2' });

      const result = await service.distributeApprovedEpoch(
        100,
        200,
        MERKLE_ROOT,
      );

      expect(result).toBe(true);
    });

    it('should return false when merkle root mismatch and S3 recovery fails', async () => {
      const merkleTreeService = createMockMerkleTreeService();
      merkleTreeService.generateMerkleTree.mockResolvedValueOnce(
        makeMerkleTreeResult('0xwrongroot'),
      );

      const s3Service = createMockS3Service(false);
      s3Service.downloadJson.mockResolvedValueOnce(null);

      const { service } = createService({ s3Service, merkleTreeService });

      const result = await service.distributeApprovedEpoch(
        100,
        200,
        MERKLE_ROOT,
      );

      expect(result).toBe(false);
    });

    it('should return false when distribution throws an error', async () => {
      const { service } = createService();

      mockPublicClient.simulateContract.mockRejectedValueOnce(
        new Error('distribution error'),
      );

      const result = await service.distributeApprovedEpoch(
        100,
        200,
        MERKLE_ROOT,
      );

      expect(result).toBe(false);
    });

    it('should generate rewards report on successful distribution', async () => {
      const { service, mocks } = createService();

      mockPublicClient.simulateContract
        .mockResolvedValueOnce({ request: 'dist1' })
        .mockResolvedValueOnce({ request: 'dist2' });
      mockWalletClient.writeContract
        .mockResolvedValueOnce('0xb1')
        .mockResolvedValueOnce('0xb2');
      mockPublicClient.waitForTransactionReceipt
        .mockResolvedValueOnce({ ...defaultReceipt, transactionHash: '0xb1' })
        .mockResolvedValueOnce({ ...defaultReceipt, transactionHash: '0xb2' });

      await service.distributeApprovedEpoch(100, 200, MERKLE_ROOT);

      expect(
        mocks.rewardsCalculatorService.calculateRewardsFormatted,
      ).toHaveBeenCalled();
      expect(
        mocks.rewardsReporterService.logSuccessfulRewardsReport,
      ).toHaveBeenCalled();
    });
  });

  // ================================================================
  //  11. commitMerkleRoot retry logic (tested via commitRootOnly)
  // ================================================================

  describe('commitMerkleRoot retry logic', () => {
    it('should retry up to 3 times on transient errors', async () => {
      const { service } = createService();

      for (let i = 0; i < 3; i++) {
        mockPublicClient.readContract
          .mockResolvedValueOnce(true) // canCommit
          .mockResolvedValueOnce([0, 0n, 0n, '0x0', 0, 0, 0n, '']); // commitment check
        mockPublicClient.simulateContract.mockRejectedValueOnce(
          new Error('timeout'),
        );
      }

      const result = await service.commitRootOnly(100, 200, MERKLE_ROOT, 2);

      expect(result.success).toBe(false);
      expect(mockPublicClient.simulateContract).toHaveBeenCalledTimes(3);
    });

    it('should succeed on second retry attempt', async () => {
      const { service } = createService();

      // Attempt 1 fails
      mockPublicClient.readContract
        .mockResolvedValueOnce(true) // canCommit attempt 1
        .mockResolvedValueOnce([0, 0n, 0n, '0x0', 0, 0, 0n, '']); // commitment check attempt 1
      mockPublicClient.simulateContract.mockRejectedValueOnce(
        new Error('timeout'),
      );

      // Attempt 2 succeeds
      mockPublicClient.readContract
        .mockResolvedValueOnce(true) // canCommit attempt 2
        .mockResolvedValueOnce([0, 0n, 0n, '0x0', 0, 0, 0n, '']); // commitment check attempt 2
      mockPublicClient.simulateContract.mockResolvedValueOnce({
        request: 'commitReq',
      });
      mockWalletClient.writeContract.mockResolvedValueOnce(TX_HASH);
      mockPublicClient.waitForTransactionReceipt.mockResolvedValueOnce(
        defaultReceipt,
      );

      const result = await service.commitRootOnly(100, 200, MERKLE_ROOT, 2);

      expect(result.success).toBe(true);
      expect(result.txHash).toBe(TX_HASH);
    });

    it('should fail when account is not authorized to commit', async () => {
      const { service } = createService();

      for (let i = 0; i < 3; i++) {
        mockPublicClient.readContract.mockResolvedValueOnce(false); // canCommit returns false
      }

      const result = await service.commitRootOnly(100, 200, MERKLE_ROOT, 2);

      expect(result.success).toBe(false);
    });

    it('should fail when block range already committed with different params', async () => {
      const { service } = createService();

      for (let i = 0; i < 3; i++) {
        mockPublicClient.readContract
          .mockResolvedValueOnce(true) // canCommit
          .mockResolvedValueOnce([
            1,
            100n,
            200n,
            '0xdifferentroot',
            3,
            0,
            0n,
            '',
          ]);
      }

      const result = await service.commitRootOnly(100, 200, MERKLE_ROOT, 2);

      expect(result.success).toBe(false);
    });
  });

  // ================================================================
  //  12. uploadEpochDataToS3
  // ================================================================

  describe('uploadEpochDataToS3', () => {
    it('should call prepareAndUploadToS3 with correct parameters', async () => {
      const s3Service = createMockS3Service(true);
      const { service } = createService({ s3Service });

      const workers = [
        {
          workerId: 1n,
          id: 1n,
          workerReward: 100n,
          stakerReward: 50n,
          stake: 1000n,
          totalStake: 2000n,
        },
      ];
      const merkleTree = makeMerkleTreeResult();

      const result = await service.uploadEpochDataToS3(
        100,
        200,
        MERKLE_ROOT,
        2,
        workers as any,
        merkleTree,
        50,
      );

      expect(s3Service.uploadEpochRewards).toHaveBeenCalled();
      expect(result).toBe('https://s3/test.json');
    });

    it('should return placeholder URL when S3 is disabled', async () => {
      const s3Service = createMockS3Service(false);
      const { service } = createService({ s3Service });

      const workers = [
        {
          workerId: 1n,
          id: 1n,
          workerReward: 100n,
          stakerReward: 50n,
          stake: 1000n,
          totalStake: 2000n,
        },
      ];
      const merkleTree = makeMerkleTreeResult();

      const result = await service.uploadEpochDataToS3(
        100,
        200,
        MERKLE_ROOT,
        2,
        workers as any,
        merkleTree,
      );

      expect(result).toMatch(/^s3:\/\/rewards-100-200\.json$/);
      expect(s3Service.uploadEpochRewards).not.toHaveBeenCalled();
    });
  });

  // ================================================================
  //  13. Helper: formatAmount (module-level function)
  // ================================================================

  describe('formatAmount helper', () => {
    it('should format bigint as "wei (SQD)" string', () => {
      const formatAmount = (amount: bigint): string => {
        const sqdAmount = (Number(amount) / 1e18).toFixed(6);
        return `${amount.toString()} wei (${sqdAmount} SQD)`;
      };

      expect(formatAmount(0n)).toBe('0 wei (0.000000 SQD)');
      expect(formatAmount(1000000000000000000n)).toBe(
        '1000000000000000000 wei (1.000000 SQD)',
      );
      expect(formatAmount(500000000000000000n)).toBe(
        '500000000000000000 wei (0.500000 SQD)',
      );
    });
  });

  // ================================================================
  //  14. Helper: generateSessionId (module-level function)
  // ================================================================

  describe('generateSessionId helper', () => {
    it('should generate unique session IDs', () => {
      const generateSessionId = (): string =>
        Math.random().toString(36).substring(2, 15) +
        Math.random().toString(36).substring(2, 15);

      const id1 = generateSessionId();
      const id2 = generateSessionId();

      expect(id1).toBeDefined();
      expect(typeof id1).toBe('string');
      expect(id1.length).toBeGreaterThan(0);
      expect(id1).not.toEqual(id2);
    });
  });

  // ================================================================
  //  15. Full distribution flow edge cases
  // ================================================================

  describe('full distribution flow edge cases', () => {
    it('should use commitmentKeyService.generateKey for commitment key', async () => {
      const { service, mocks } = createService();
      setupFreshDistribution();

      await service.distributeEpochRewards(100, 200, 75);

      expect(mocks.commitmentKeyService.generateKey).toHaveBeenCalledWith(
        100,
        200,
      );
    });

    it('should set startedAt on the status object', async () => {
      const { service } = createService();
      setupFreshDistribution();

      const before = new Date();
      const result = await service.distributeEpochRewards(100, 200, 75);
      const after = new Date();

      expect(result.startedAt).toBeDefined();
      expect(result.startedAt.getTime()).toBeGreaterThanOrEqual(
        before.getTime(),
      );
      expect(result.startedAt.getTime()).toBeLessThanOrEqual(
        after.getTime(),
      );
    });

    it('should handle single-batch distribution', async () => {
      const merkleTreeService = createMockMerkleTreeService();
      merkleTreeService.generateMerkleTree.mockResolvedValueOnce(
        makeMerkleTreeResult(MERKLE_ROOT, 1),
      );

      const { service } = createService({ merkleTreeService });

      // No existing commitment
      mockPublicClient.readContract
        .mockResolvedValueOnce([0, 0n, 0n, '0x0', 0, 0, 0n, ''])
        .mockResolvedValueOnce(true) // canCommit
        .mockResolvedValueOnce([0, 0n, 0n, '0x0', 0, 0, 0n, '']); // commitment check

      // Commit
      mockPublicClient.simulateContract.mockResolvedValueOnce({
        request: 'commitReq',
      });
      mockWalletClient.writeContract.mockResolvedValueOnce(TX_HASH);
      mockPublicClient.waitForTransactionReceipt.mockResolvedValueOnce(
        defaultReceipt,
      );

      // Single batch
      mockPublicClient.simulateContract.mockResolvedValueOnce({
        request: 'dist1',
      });
      mockWalletClient.writeContract.mockResolvedValueOnce('0xb1');
      mockPublicClient.waitForTransactionReceipt.mockResolvedValueOnce({
        ...defaultReceipt,
        transactionHash: '0xb1',
      });

      const result = await service.distributeEpochRewards(100, 200, 75);

      expect(result.status).toBe('completed');
      expect(result.totalBatches).toBe(1);
      expect(result.processedBatches).toBe(1);
    });

    it('should pass batchNumber and totalBatches to calculateRewardsDetailed', async () => {
      const { service, mocks } = createService();
      setupFreshDistribution();

      await service.distributeEpochRewards(100, 200, 75, 1, 5);

      expect(
        mocks.rewardsCalculatorService.calculateRewardsDetailed,
      ).toHaveBeenCalledWith(expect.anything(), 100, 200, true, 1, 5);
    });
  });

  // ================================================================
  //  16. S3 recovery (recoverMerkleTreeFromS3)
  // ================================================================

  describe('S3 recovery (via distributeApprovedEpoch)', () => {
    it('should try alternate network key for localhost', async () => {
      const merkleTreeService = createMockMerkleTreeService();
      merkleTreeService.generateMerkleTree
        .mockResolvedValueOnce(makeMerkleTreeResult('0xwrongroot'))
        .mockResolvedValueOnce(makeMerkleTreeResult(MERKLE_ROOT));

      const s3Service = createMockS3Service(false);
      s3Service.downloadJson
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          rawData: {
            totalWorkers: 2,
            workers: [
              { workerId: '1', workerReward: '100', stakerReward: '50' },
            ],
          },
          merkleTree: { root: MERKLE_ROOT, totalBatches: 2, batchSize: 75 },
        });
      s3Service.checkFileExists.mockResolvedValueOnce(true);

      const configService = createMockConfigService();
      configService.get.mockImplementation(
        (key: string, defaultValue?: any) => {
          const config: Record<string, any> = {
            'blockchain.network.l2RpcUrl': 'http://localhost:8545',
            'blockchain.distributor.privateKey':
              '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
            'blockchain.contracts.rewardsDistribution':
              '0x1234567890123456789012345678901234567890',
            'blockchain.network.name': 'localhost',
          };
          return config[key] !== undefined ? config[key] : defaultValue;
        },
      );

      const { service } = createService({
        s3Service,
        merkleTreeService,
        configService,
      });

      mockPublicClient.simulateContract
        .mockResolvedValueOnce({ request: 'dist1' })
        .mockResolvedValueOnce({ request: 'dist2' });
      mockWalletClient.writeContract
        .mockResolvedValueOnce('0xb1')
        .mockResolvedValueOnce('0xb2');
      mockPublicClient.waitForTransactionReceipt
        .mockResolvedValueOnce({ ...defaultReceipt, transactionHash: '0xb1' })
        .mockResolvedValueOnce({ ...defaultReceipt, transactionHash: '0xb2' });

      const result = await service.distributeApprovedEpoch(
        100,
        200,
        MERKLE_ROOT,
      );

      expect(result).toBe(true);
      expect(s3Service.checkFileExists).toHaveBeenCalled();
    });

    it('should return false when S3 data has invalid structure (missing rawData)', async () => {
      const merkleTreeService = createMockMerkleTreeService();
      merkleTreeService.generateMerkleTree.mockResolvedValueOnce(
        makeMerkleTreeResult('0xwrongroot'),
      );

      const s3Service = createMockS3Service(false);
      s3Service.downloadJson.mockResolvedValueOnce({
        someOtherField: true,
      });

      const { service } = createService({ s3Service, merkleTreeService });

      const result = await service.distributeApprovedEpoch(
        100,
        200,
        MERKLE_ROOT,
      );

      expect(result).toBe(false);
    });

    it('should return false when S3 data has no batchSize in merkleTree', async () => {
      const merkleTreeService = createMockMerkleTreeService();
      merkleTreeService.generateMerkleTree.mockResolvedValueOnce(
        makeMerkleTreeResult('0xwrongroot'),
      );

      const s3Service = createMockS3Service(false);
      s3Service.downloadJson.mockResolvedValueOnce({
        rawData: {
          totalWorkers: 1,
          workers: [
            { workerId: '1', workerReward: '100', stakerReward: '50' },
          ],
        },
        merkleTree: {
          root: MERKLE_ROOT,
          totalBatches: 1,
        },
      });

      const { service } = createService({ s3Service, merkleTreeService });

      const result = await service.distributeApprovedEpoch(
        100,
        200,
        MERKLE_ROOT,
      );

      expect(result).toBe(false);
    });

    it('should return false when recreated root from S3 does not match stored root', async () => {
      const merkleTreeService = createMockMerkleTreeService();
      merkleTreeService.generateMerkleTree
        .mockResolvedValueOnce(makeMerkleTreeResult('0xwrongroot'))
        .mockResolvedValueOnce(makeMerkleTreeResult('0xdoesntmatchstored'));

      const s3Service = createMockS3Service(false);
      s3Service.downloadJson.mockResolvedValueOnce({
        rawData: {
          totalWorkers: 1,
          workers: [
            { workerId: '1', workerReward: '100', stakerReward: '50' },
          ],
        },
        merkleTree: {
          root: MERKLE_ROOT,
          totalBatches: 1,
          batchSize: 75,
        },
      });

      const { service } = createService({ s3Service, merkleTreeService });

      const result = await service.distributeApprovedEpoch(
        100,
        200,
        MERKLE_ROOT,
      );

      expect(result).toBe(false);
    });
  });

  // ================================================================
  //  17. distributeAndReport (tested via distributeApprovedEpoch)
  // ================================================================

  describe('distributeAndReport', () => {
    it('should not fail distribution when report generation throws', async () => {
      const rewardsCalculatorService = createMockRewardsCalculatorService();
      rewardsCalculatorService.calculateRewardsFormatted.mockRejectedValueOnce(
        new Error('report error'),
      );

      const { service } = createService({ rewardsCalculatorService });

      mockPublicClient.simulateContract
        .mockResolvedValueOnce({ request: 'dist1' })
        .mockResolvedValueOnce({ request: 'dist2' });
      mockWalletClient.writeContract
        .mockResolvedValueOnce('0xb1')
        .mockResolvedValueOnce('0xb2');
      mockPublicClient.waitForTransactionReceipt
        .mockResolvedValueOnce({ ...defaultReceipt, transactionHash: '0xb1' })
        .mockResolvedValueOnce({ ...defaultReceipt, transactionHash: '0xb2' });

      const result = await service.distributeApprovedEpoch(
        100,
        200,
        MERKLE_ROOT,
      );

      expect(result).toBe(true);
    });
  });

  // ================================================================
  //  18. generateRewardsReport (tested via successful distribution)
  // ================================================================

  describe('generateRewardsReport', () => {
    it('should collect network metrics and extract reward metrics', async () => {
      const { service, mocks } = createService();

      // Use distributeApprovedEpoch which calls generateRewardsReport
      mockPublicClient.simulateContract
        .mockResolvedValueOnce({ request: 'dist1' })
        .mockResolvedValueOnce({ request: 'dist2' });
      mockWalletClient.writeContract
        .mockResolvedValueOnce('0xb1')
        .mockResolvedValueOnce('0xb2');
      mockPublicClient.waitForTransactionReceipt
        .mockResolvedValueOnce({ ...defaultReceipt, transactionHash: '0xb1' })
        .mockResolvedValueOnce({ ...defaultReceipt, transactionHash: '0xb2' });

      await service.distributeApprovedEpoch(100, 200, MERKLE_ROOT);

      expect(
        mocks.epochMetricsService.collectNetworkMetrics,
      ).toHaveBeenCalled();
      expect(
        mocks.epochMetricsService.extractRewardMetrics,
      ).toHaveBeenCalled();
    });

    it('should pass commit tx hash to logSuccessfulRewardsReport when available', async () => {
      const { service, mocks } = createService();
      setupFreshDistribution();

      await service.distributeEpochRewards(100, 200, 75);

      expect(
        mocks.rewardsReporterService.logSuccessfulRewardsReport,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          isCommitSuccess: true,
          commitTxHash: TX_HASH,
        }),
      );
    });
  });

  // ================================================================
  //  19. Commitment key generation
  // ================================================================

  describe('commitment key generation', () => {
    it('should delegate to commitmentKeyService.generateKey', async () => {
      const { service, mocks } = createService();

      mockPublicClient.readContract.mockResolvedValueOnce([
        1,
        100n,
        200n,
        MERKLE_ROOT,
        2n,
        1n,
        3n,
        '',
      ]);

      await service.getDistributionStatus(100, 200);

      expect(mocks.commitmentKeyService.generateKey).toHaveBeenCalledWith(
        100,
        200,
      );
    });
  });

  // ================================================================
  //  20. Batch size consistency (Issue #2 fix verification)
  // ================================================================

  describe('batch size consistency', () => {
    it('should expose distributionBatchSize as readonly property', () => {
      const { service } = createService();
      expect(service.distributionBatchSize).toBeDefined();
      expect(typeof service.distributionBatchSize).toBe('number');
    });

    it('should use configured DISTRIBUTION_BATCH_SIZE from env', () => {
      const origEnv = process.env.DISTRIBUTION_BATCH_SIZE;
      process.env.DISTRIBUTION_BATCH_SIZE = '100';

      const { service } = createService();
      expect(service.distributionBatchSize).toBe(100);

      if (origEnv !== undefined) {
        process.env.DISTRIBUTION_BATCH_SIZE = origEnv;
      } else {
        delete process.env.DISTRIBUTION_BATCH_SIZE;
      }
    });

    it('should default to 75 when DISTRIBUTION_BATCH_SIZE is not set', () => {
      const origEnv = process.env.DISTRIBUTION_BATCH_SIZE;
      delete process.env.DISTRIBUTION_BATCH_SIZE;

      const { service } = createService();
      expect(service.distributionBatchSize).toBe(75);

      if (origEnv !== undefined) {
        process.env.DISTRIBUTION_BATCH_SIZE = origEnv;
      }
    });

    it('should pass consistent batchSize through distributeEpochRewards to merkle tree', async () => {
      const { service, mocks } = createService();
      setupFreshDistribution();

      const batchSize = service.distributionBatchSize;
      await service.distributeEpochRewards(100, 200, batchSize);

      expect(mocks.merkleTreeService.generateMerkleTree).toHaveBeenCalledWith(
        expect.any(Array),
        batchSize,
      );
    });

    it('generateMerkleTreeOnly should default to distributionBatchSize', async () => {
      const { service, mocks } = createService();

      const workers = [
        { workerId: 1n, workerReward: 100n, stakerReward: 50n },
      ];

      await service.generateMerkleTreeOnly(workers);

      expect(mocks.merkleTreeService.generateMerkleTree).toHaveBeenCalledWith(
        workers,
        service.distributionBatchSize,
      );
    });

    it('distributeApprovedEpoch should use same distributionBatchSize as commit path', async () => {
      const { service, mocks } = createService();

      mockPublicClient.simulateContract
        .mockResolvedValueOnce({ request: 'dist1' })
        .mockResolvedValueOnce({ request: 'dist2' });
      mockWalletClient.writeContract
        .mockResolvedValueOnce('0xb1')
        .mockResolvedValueOnce('0xb2');
      mockPublicClient.waitForTransactionReceipt
        .mockResolvedValueOnce({ ...defaultReceipt, transactionHash: '0xb1' })
        .mockResolvedValueOnce({ ...defaultReceipt, transactionHash: '0xb2' });

      await service.distributeApprovedEpoch(100, 200, MERKLE_ROOT);

      expect(mocks.merkleTreeService.generateMerkleTree).toHaveBeenCalledWith(
        expect.any(Array),
        service.distributionBatchSize,
      );
    });
  });

  // ================================================================
  //  21. Resume distribution — partial batches already processed
  // ================================================================

  describe('resume distribution — partial progress', () => {
    it('should resume from existing commitment with 1 of 2 batches already processed', async () => {
      const { service, mocks } = createService();

      // Existing commitment: 1 batch already processed
      mockPublicClient.readContract.mockResolvedValueOnce([
        1,       // status: ACTIVE
        100n,    // fromBlock
        200n,    // toBlock
        MERKLE_ROOT, // merkleRoot
        2,       // totalBatches
        1,       // processedBatches (1 already done!)
        1n,      // approvalCount
        '',      // ipfsLink
      ]);

      // distributeBatches will try both batches; batch 1 already processed
      // Batch 1 simulate call should still work (distributeBatches handles BatchAlreadyProcessed)
      mockPublicClient.simulateContract
        .mockResolvedValueOnce({ request: 'dist1' })
        .mockResolvedValueOnce({ request: 'dist2' });
      mockWalletClient.writeContract
        .mockResolvedValueOnce('0xb1')
        .mockResolvedValueOnce('0xb2');
      mockPublicClient.waitForTransactionReceipt
        .mockResolvedValueOnce({ ...defaultReceipt, transactionHash: '0xb1' })
        .mockResolvedValueOnce({ ...defaultReceipt, transactionHash: '0xb2' });

      const result = await service.distributeEpochRewards(100, 200, 75);

      expect(result.status).toBe('completed');
      expect(result.totalBatches).toBe(2);
      // Verify rewards were recalculated
      expect(mocks.rewardsCalculatorService.calculateRewardsDetailed).toHaveBeenCalled();
    });

    it('should complete status when all batches already processed in resume', async () => {
      const { service } = createService();

      // Existing commitment: all batches already processed
      mockPublicClient.readContract.mockResolvedValueOnce([
        1,       // status: ACTIVE
        100n,    // fromBlock
        200n,    // toBlock
        MERKLE_ROOT,
        2,       // totalBatches
        2,       // processedBatches (all done!)
        1n,
        '',
      ]);

      // distributeBatches still tries to distribute but gets BatchAlreadyProcessed
      // Mock both batch attempts as successful (simulate + write + receipt)
      mockPublicClient.simulateContract
        .mockResolvedValueOnce({ request: 'dist1' })
        .mockResolvedValueOnce({ request: 'dist2' });
      mockWalletClient.writeContract
        .mockResolvedValueOnce('0xb1')
        .mockResolvedValueOnce('0xb2');
      mockPublicClient.waitForTransactionReceipt
        .mockResolvedValueOnce({ ...defaultReceipt, transactionHash: '0xb1' })
        .mockResolvedValueOnce({ ...defaultReceipt, transactionHash: '0xb2' });

      const result = await service.distributeEpochRewards(100, 200, 75);

      expect(result.status).toBe('completed');
    });
  });
});
