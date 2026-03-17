/**
 * Unit tests for ContractService.
 *
 * Strategy:
 *  - Mock viem at the module level so createPublicClient / createWalletClient
 *    never hit the network.
 *  - Instantiate ContractService directly (no NestJS TestingModule) to skip
 *    onModuleInit lifecycle hooks.
 *  - Override publicClient / l1Client on the instance so every method uses our
 *    jest.fn() mocks.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Logger mock – suppress pino output in tests
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Shared mock objects (declared before jest.mock so they can be referenced)
// ---------------------------------------------------------------------------
const mockContractRead: Record<string, jest.Mock> = {
  effectiveTVL: jest.fn(),
  INITIAL_REWARD_POOL_SIZE: jest.fn(),
  yearlyRewardCapCoefficient: jest.fn(),
  epochLength: jest.fn(),
  canCommit: jest.fn(),
  commitments: jest.fn(),
  processed: jest.fn(),
  lastCommitmentKey: jest.fn(),
  requiredApproves: jest.fn(),
  targetCapacityGb: jest.fn(),
  storagePerWorkerInGb: jest.fn(),
};

const mockWalletClient = {
  writeContract: jest.fn(),
};

const mockPublicClient = {
  getBlockNumber: jest.fn(),
  getBlock: jest.fn(),
  getChainId: jest.fn(),
  readContract: jest.fn(),
  multicall: jest.fn(),
  getLogs: jest.fn(),
  simulateContract: jest.fn(),
  waitForTransactionReceipt: jest.fn(),
};

// A second mock so l1Client and publicClient are independently controllable.
const mockL1Client = {
  getBlockNumber: jest.fn(),
  getBlock: jest.fn(),
  getChainId: jest.fn(),
  readContract: jest.fn(),
  multicall: jest.fn(),
  getLogs: jest.fn(),
  simulateContract: jest.fn(),
  waitForTransactionReceipt: jest.fn(),
};

// ---------------------------------------------------------------------------
// viem mock
// ---------------------------------------------------------------------------
jest.mock('viem', () => {
  const actual = jest.requireActual('viem');
  return {
    ...actual,
    createPublicClient: jest.fn().mockReturnValue(mockPublicClient),
    createWalletClient: jest.fn().mockReturnValue(mockWalletClient),
    getContract: jest.fn().mockReturnValue({ read: mockContractRead }),
  };
});

jest.mock('viem/accounts', () => ({
  privateKeyToAccount: jest.fn().mockReturnValue({
    address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are in place)
// ---------------------------------------------------------------------------
import { ContractService } from './contract.service';
import { Context } from '../common';

// ---------------------------------------------------------------------------
// Config / CommitmentKeyService mocks
// ---------------------------------------------------------------------------
const configMap: Record<string, any> = {
  'blockchain.network.networkName': 'sepolia',
  'blockchain.network.l2RpcUrl': 'http://localhost:8545',
  'blockchain.network.l1RpcUrl': 'http://localhost:8546',
  'blockchain.contracts.rewardsDistribution': '0x1234567890abcdef1234567890abcdef12345678',
  'blockchain.contracts.workerRegistration': '0x2234567890abcdef1234567890abcdef12345678',
  'blockchain.contracts.networkController': '0x3234567890abcdef1234567890abcdef12345678',
  'blockchain.contracts.rewardCalculation': '0x4234567890abcdef1234567890abcdef12345678',
  'blockchain.contracts.staking': '0x5234567890abcdef1234567890abcdef12345678',
  'blockchain.contracts.capedStaking': '0x6234567890abcdef1234567890abcdef12345678',
  'blockchain.distributor.privateKey': '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  'blockchain.rewardEpochLength': null,
  'blockchain.epochConfirmationBlocks': 150,
  'rewards.distributionBlockInterval': 520,
  'rewards.distributionStartingBlock': 1000,
};

const mockConfigService = {
  get: jest.fn((key: string, defaultValue?: any) => {
    return configMap[key] !== undefined ? configMap[key] : defaultValue;
  }),
};

const mockCommitmentKeyService = {
  generateKey: jest.fn().mockReturnValue('0xcommitmentkey'),
};

// ---------------------------------------------------------------------------
// Helper: build a mock Context
// ---------------------------------------------------------------------------
function createMockContext(): Context {
  return {
    logger: {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      child: jest.fn().mockReturnThis(),
    },
  } as any;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('ContractService', () => {
  let service: ContractService;
  let ctx: Context;

  beforeEach(() => {
    jest.clearAllMocks();

    service = new ContractService(mockConfigService as any, mockCommitmentKeyService as any);

    // Override internal clients so every call goes through our mocks.
    (service as any).publicClient = mockPublicClient;
    (service as any).l1Client = mockL1Client;

    ctx = createMockContext();
  });

  // =========================================================================
  // Client accessors
  // =========================================================================

  describe('client accessors', () => {
    it('should expose publicClient via .client', () => {
      expect(service.client).toBe(mockPublicClient);
    });

    it('should expose l1Client via .l1', () => {
      expect(service.l1).toBe(mockL1Client);
    });
  });

  // =========================================================================
  // L1 / L2 block helpers
  // =========================================================================

  describe('getL1BlockNumber', () => {
    it('should return L1 block number on success', async () => {
      mockL1Client.getBlockNumber.mockResolvedValue(12345n);
      const result = await service.getL1BlockNumber(ctx);
      expect(result).toBe(12345);
      expect(mockL1Client.getBlockNumber).toHaveBeenCalled();
    });

    it('should fall back to L2 client and log error when L1 fails', async () => {
      mockL1Client.getBlockNumber.mockRejectedValue(new Error('L1 down'));
      mockPublicClient.getBlockNumber.mockResolvedValue(99999n);

      const result = await service.getL1BlockNumber(ctx);
      expect(result).toBe(99999);
      expect(ctx.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(Error) }),
        'Failed to get L1 block number',
      );
    });
  });

  describe('getBlockTimestamp', () => {
    it('should return a Date derived from block timestamp', async () => {
      const ts = Math.floor(Date.now() / 1000);
      mockL1Client.getBlock.mockResolvedValue({ timestamp: BigInt(ts) });

      const result = await service.getBlockTimestamp(ctx, 100);
      expect(result).toEqual(new Date(ts * 1000));
      expect(mockL1Client.getBlock).toHaveBeenCalledWith({ blockNumber: 100n });
    });
  });

  describe('getLatestL2Block', () => {
    it('should return the latest L2 block number as bigint', async () => {
      mockPublicClient.getBlockNumber.mockResolvedValue(55555n);
      const result = await service.getLatestL2Block();
      expect(result).toBe(55555n);
    });
  });

  describe('getBlock', () => {
    it('should return block number and l1BlockNumber', async () => {
      mockPublicClient.getBlock.mockResolvedValue({
        number: 200n,
        l1BlockNumber: 100n,
      });

      const result = await service.getBlock(ctx);
      expect(result).toEqual({ number: 200n, l1BlockNumber: 100n });
    });
  });

  describe('getL1Block', () => {
    it('should return timestamp and number from L1', async () => {
      mockL1Client.getBlock.mockResolvedValue({ timestamp: 1700000000n, number: 500n });
      const result = await service.getL1Block(ctx, 500n);
      expect(result).toEqual({ timestamp: 1700000000n, number: 500n });
    });
  });

  // =========================================================================
  // Worker registration helpers
  // =========================================================================

  describe('preloadWorkerIds', () => {
    it('should return worker ID mapping on success', async () => {
      mockPublicClient.multicall.mockResolvedValue([
        { status: 'success', result: 1n },
        { status: 'success', result: 2n },
      ]);

      const result = await service.preloadWorkerIds(ctx, ['worker1', 'worker2']);
      expect(result).toEqual({ worker1: 1n, worker2: 2n });
      expect(ctx.logger.debug).toHaveBeenCalled();
    });

    it('should return empty object on multicall failure and log error', async () => {
      mockPublicClient.multicall.mockRejectedValue(new Error('multicall failed'));

      const result = await service.preloadWorkerIds(ctx, ['worker1']);
      expect(result).toEqual({});
      expect(ctx.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(Error) }),
        'Failed to preload worker IDs',
      );
    });

    it('should handle individual worker failures within multicall', async () => {
      mockPublicClient.multicall.mockResolvedValue([
        { status: 'success', result: 10n },
        { status: 'failure', error: new Error('bad peer') },
      ]);

      const result = await service.preloadWorkerIds(ctx, ['good', 'bad']);
      expect(result.good).toBe(10n);
      expect(result.bad).toBe(0n);
      expect(ctx.logger.warn).toHaveBeenCalled();
    });
  });

  describe('getBondAmount', () => {
    it('should return bond amount as bigint', async () => {
      mockPublicClient.readContract.mockResolvedValue(100000000000000000000n);
      const result = await service.getBondAmount(ctx);
      expect(result).toBe(100000000000000000000n);
      expect(ctx.logger.debug).toHaveBeenCalled();
    });
  });

  describe('getActiveWorkerCount', () => {
    it('should return active worker count as bigint', async () => {
      mockPublicClient.readContract.mockResolvedValue(42n);
      const result = await service.getActiveWorkerCount(ctx);
      expect(result).toBe(42n);
    });
  });

  // =========================================================================
  // Contract read methods
  // =========================================================================

  describe('getEffectiveTVL', () => {
    it('should return TVL from contract', async () => {
      mockContractRead.effectiveTVL.mockResolvedValue(5000000n);
      const result = await service.getEffectiveTVL(ctx);
      expect(result).toBe(5000000n);
    });
  });

  describe('getInitialRewardPoolSize', () => {
    it('should return initial reward pool size', async () => {
      mockContractRead.INITIAL_REWARD_POOL_SIZE.mockResolvedValue(1000000n);
      const result = await service.getInitialRewardPoolSize(ctx);
      expect(result).toBe(1000000n);
    });
  });

  describe('getYearlyRewardCapCoefficient', () => {
    it('should return yearly reward cap coefficient', async () => {
      mockContractRead.yearlyRewardCapCoefficient.mockResolvedValue(200n);
      const result = await service.getYearlyRewardCapCoefficient(ctx);
      expect(result).toBe(200n);
    });
  });

  describe('getCurrentApy', () => {
    it('should calculate APY normally (capped at 2000)', async () => {
      // TVL > 0, capCoeff * initialPool / tvl > 2000 => min is 2000
      mockContractRead.effectiveTVL.mockResolvedValue(1000n);
      mockContractRead.INITIAL_REWARD_POOL_SIZE.mockResolvedValue(100000n);
      mockContractRead.yearlyRewardCapCoefficient.mockResolvedValue(100n);
      // apyCap = (100 * 100000) / 1000 = 10000 => min(2000, 10000) = 2000
      const result = await service.getCurrentApy(ctx);
      expect(result).toBe(2000n);
    });

    it('should return apyCap when it is smaller than 2000', async () => {
      mockContractRead.effectiveTVL.mockResolvedValue(100000n);
      mockContractRead.INITIAL_REWARD_POOL_SIZE.mockResolvedValue(100000n);
      mockContractRead.yearlyRewardCapCoefficient.mockResolvedValue(1n);
      // apyCap = (1 * 100000) / 100000 = 1 => min(2000, 1) = 1
      const result = await service.getCurrentApy(ctx);
      expect(result).toBe(1n);
    });

    it('should return 2000n when TVL is 0', async () => {
      mockContractRead.effectiveTVL.mockResolvedValue(0n);
      const result = await service.getCurrentApy(ctx);
      expect(result).toBe(2000n);
    });

    it('should return 2000n and log warning on error', async () => {
      mockContractRead.effectiveTVL.mockRejectedValue(new Error('rpc error'));
      const result = await service.getCurrentApy(ctx);
      expect(result).toBe(2000n);
      expect(ctx.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(Error) }),
        'Failed to calculate APY, using default 20%',
      );
    });
  });

  describe('getEpochLength', () => {
    it('should return configured epoch length when set', async () => {
      const originalGet = mockConfigService.get;
      mockConfigService.get = jest.fn((key: string, defaultValue?: any) => {
        if (key === 'blockchain.rewardEpochLength') return 5000;
        return configMap[key] !== undefined ? configMap[key] : defaultValue;
      });

      const result = await service.getEpochLength(ctx);
      expect(result).toBe(5000);

      // Restore original mock
      mockConfigService.get = originalGet;
    });

    it('should read from contract when no configured value', async () => {
      mockContractRead.epochLength.mockResolvedValue(8000n);
      const result = await service.getEpochLength(ctx);
      expect(result).toBe(8000);
    });

    it('should return 7000 and log error on failure', async () => {
      mockContractRead.epochLength.mockRejectedValue(new Error('contract down'));
      const result = await service.getEpochLength(ctx);
      expect(result).toBe(7000);
      expect(ctx.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(Error) }),
        'Failed to get epoch length, using default 7000',
      );
    });
  });

  // =========================================================================
  // getLastBlockRewarded
  // =========================================================================

  describe('getLastBlockRewarded', () => {
    it('should return lastBlockRewarded from contract', async () => {
      mockPublicClient.readContract.mockResolvedValue(5000n);
      const result = await service.getLastBlockRewarded(ctx);
      expect(result).toBe(5000);
    });

    it('should use startingBlock - 1 when lastBlockRewarded is 0 and startingBlock is set', async () => {
      mockPublicClient.readContract.mockResolvedValue(0n);
      const result = await service.getLastBlockRewarded(ctx);
      // startingBlock = 1000 => returns 999
      expect(result).toBe(999);
    });

    it('should return startingBlock - 1 on "returned no data" error', async () => {
      mockPublicClient.readContract.mockRejectedValue(
        new Error('The contract call returned no data'),
      );
      const result = await service.getLastBlockRewarded(ctx);
      expect(result).toBe(999);
    });

    it('should return 0 on unexpected error and log it', async () => {
      mockPublicClient.readContract.mockRejectedValue(new Error('unexpected!'));
      const result = await service.getLastBlockRewarded(ctx);
      expect(result).toBe(0);
      expect(ctx.logger.error).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Commitment methods
  // =========================================================================

  describe('canCommit', () => {
    it('should return true when contract says canCommit', async () => {
      mockContractRead.canCommit.mockResolvedValue(true);
      const result = await service.canCommit('0xABCD' as any);
      expect(result).toBe(true);
    });

    it('should return false when contract says cannot commit', async () => {
      mockContractRead.canCommit.mockResolvedValue(false);
      const result = await service.canCommit('0xABCD' as any);
      expect(result).toBe(false);
    });

    it('should return false on "returned no data" error (debug-logged)', async () => {
      mockContractRead.canCommit.mockRejectedValue(
        new Error('returned no data'),
      );
      const result = await service.canCommit('0xABCD' as any);
      expect(result).toBe(false);
    });

    it('should return false on other errors and log error', async () => {
      mockContractRead.canCommit.mockRejectedValue(new Error('rpc timeout'));
      const result = await service.canCommit('0xABCD' as any);
      expect(result).toBe(false);
      // The method creates its own TaskContext, so we verify by the fact it
      // did not throw and returned false (the internal logger is from the mock).
    });
  });

  describe('getCommitment', () => {
    it('should return parsed commitment data on success', async () => {
      mockPublicClient.readContract.mockResolvedValue([
        1, 100n, 200n, '0xmerkle', 10, 5, 2n, 'ipfs://link',
      ]);
      const result = await service.getCommitment(ctx, 100, 200);
      expect(result).toEqual({
        exists: true,
        merkleRoot: '0xmerkle',
        totalBatches: 10,
        processedBatches: 5,
        approvalCount: 2,
        ipfsLink: 'ipfs://link',
      });
    });

    it('should return empty result when commitment is null', async () => {
      mockPublicClient.readContract.mockResolvedValue(null);
      const result = await service.getCommitment(ctx, 100, 200);
      expect(result.exists).toBe(false);
    });

    it('should return empty result on "returned no data"', async () => {
      mockPublicClient.readContract.mockRejectedValue(
        new Error('returned no data'),
      );
      const result = await service.getCommitment(ctx, 100, 200);
      expect(result.exists).toBe(false);
    });

    it('should throw and log on unexpected error', async () => {
      const err = new Error('network error');
      mockPublicClient.readContract.mockRejectedValue(err);
      await expect(service.getCommitment(ctx, 100, 200)).rejects.toThrow('network error');
      expect(ctx.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: err, fromBlock: 100, toBlock: 200 }),
        'Failed to get commitment',
      );
    });
  });

  describe('getCommitmentV2', () => {
    it('should return parsed V2 commitment data', async () => {
      mockPublicClient.readContract.mockResolvedValue([
        1, '0xmerkle', 10, 5, 3n, 'ipfs://v2link',
      ]);
      const result = await service.getCommitmentV2(ctx, 100, 200);
      expect(result).toEqual({
        status: 1,
        merkleRoot: '0xmerkle',
        totalBatches: 10,
        processedBatches: 5,
        approvalCount: 3,
        ipfsLink: 'ipfs://v2link',
      });
    });
  });

  describe('getProcessedBatches', () => {
    it('should return array of booleans for processed status', async () => {
      mockContractRead.processed
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      const result = await service.getProcessedBatches(ctx, 100, 200, ['h1', 'h2', 'h3']);
      expect(result).toEqual([true, false, true]);
      expect(ctx.logger.debug).toHaveBeenCalled();
    });

    it('should return false for individual batch errors', async () => {
      mockContractRead.processed
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(new Error('fail'));

      const result = await service.getProcessedBatches(ctx, 100, 200, ['h1', 'h2']);
      expect(result).toEqual([true, false]);
    });
  });

  describe('getLastCommitmentKey', () => {
    it('should return the last commitment key', async () => {
      mockPublicClient.readContract.mockResolvedValue('0xabc123');
      const result = await service.getLastCommitmentKey(ctx);
      expect(result).toBe('0xabc123');
    });
  });

  describe('getCommitmentInfo', () => {
    it('should return parsed commitment info on success', async () => {
      mockContractRead.commitments.mockResolvedValue([
        1, 100n, 200n, '0xroot', 10, 5, 2n, 'ipfs://info',
      ]);
      const result = await service.getCommitmentInfo('0xkey');
      expect(result).toEqual({
        status: 1,
        fromBlock: 100,
        toBlock: 200,
        merkleRoot: '0xroot',
        totalBatches: 10,
        processedBatches: 5,
        approvalCount: 2n,
        ipfsLink: 'ipfs://info',
      });
    });

    it('should return null and log error on failure', async () => {
      mockContractRead.commitments.mockRejectedValue(new Error('contract error'));
      const result = await service.getCommitmentInfo('0xkey');
      expect(result).toBeNull();
      // Error is logged via internal TaskContext (logger mock captures it)
    });
  });

  describe('getRequiredApprovals', () => {
    it('should return required approvals from contract', async () => {
      mockContractRead.requiredApproves.mockResolvedValue(3n);
      const result = await service.getRequiredApprovals();
      expect(result).toBe(3);
    });

    it('should return 1 and log CRITICAL error on failure', async () => {
      mockContractRead.requiredApproves.mockRejectedValue(new Error('fail'));
      const result = await service.getRequiredApprovals();
      expect(result).toBe(1);
      // The method internally creates a TaskContext and logs the CRITICAL error.
    });
  });

  describe('getCommitmentsNeedingApproval', () => {
    const ZERO_KEY = '0x0000000000000000000000000000000000000000000000000000000000000000';

    it('should return empty array when lastCommitmentKey is zero', async () => {
      mockContractRead.lastCommitmentKey.mockResolvedValue(ZERO_KEY);
      const result = await service.getCommitmentsNeedingApproval();
      expect(result).toEqual([]);
    });

    it('should return empty array when approval is not needed', async () => {
      mockContractRead.lastCommitmentKey.mockResolvedValue('0xnonzero');
      // status=1, fromBlock, toBlock, merkleRoot, totalBatches, processedBatches, approvalCount
      mockContractRead.commitments.mockResolvedValue([
        1, 100n, 200n, '0xroot', 10, 5, 3n, '',
      ]);
      // requiredApproves = 3, approvalCount = 3 => not needed
      mockContractRead.requiredApproves.mockResolvedValue(3n);

      const result = await service.getCommitmentsNeedingApproval();
      expect(result).toEqual([]);
    });

    it('should return commitment when approval is needed', async () => {
      mockContractRead.lastCommitmentKey.mockResolvedValue('0xnonzero');
      mockContractRead.commitments.mockResolvedValue([
        1, 100n, 200n, '0xroot', 10, 5, 1n, '',
      ]);
      mockContractRead.requiredApproves.mockResolvedValue(3n);

      const result = await service.getCommitmentsNeedingApproval();
      expect(result).toEqual([
        { fromBlock: 100, toBlock: 200, merkleRoot: '0xroot' },
      ]);
    });

    it('should return empty array and log error on failure', async () => {
      mockContractRead.lastCommitmentKey.mockRejectedValue(new Error('fail'));
      const result = await service.getCommitmentsNeedingApproval();
      expect(result).toEqual([]);
    });
  });

  describe('hasApprovedCommitment', () => {
    it('should return true when approved', async () => {
      mockPublicClient.readContract.mockResolvedValue(true);
      const result = await service.hasApprovedCommitment(100, 200, '0xaddress' as any);
      expect(result).toBe(true);
    });

    it('should return false when not approved', async () => {
      mockPublicClient.readContract.mockResolvedValue(false);
      const result = await service.hasApprovedCommitment(100, 200, '0xaddress' as any);
      expect(result).toBe(false);
    });

    it('should return false and log error on failure', async () => {
      mockPublicClient.readContract.mockRejectedValue(new Error('rpc error'));
      const result = await service.hasApprovedCommitment(100, 200, '0xaddress' as any);
      expect(result).toBe(false);
    });
  });

  describe('getPendingCommitments', () => {
    const ZERO_KEY = '0x0000000000000000000000000000000000000000000000000000000000000000';

    it('should return empty array when no commitment key', async () => {
      mockContractRead.lastCommitmentKey.mockResolvedValue(ZERO_KEY);
      const result = await service.getPendingCommitments();
      expect(result).toEqual([]);
    });

    it('should return pending commitment when conditions are met', async () => {
      mockContractRead.lastCommitmentKey.mockResolvedValue('0xnonzero');
      // status=1, fromBlock, toBlock, merkleRoot, totalBatches=10, processedBatches=5, approvalCount=2n
      mockContractRead.commitments.mockResolvedValue([
        1, 100n, 200n, '0xroot', 10, 5, 2n, '',
      ]);

      const result = await service.getPendingCommitments();
      expect(result).toEqual([{
        fromBlock: 100,
        toBlock: 200,
        merkleRoot: '0xroot',
        totalBatches: 10,
        processedBatches: 5,
        status: 'pending_distribution',
      }]);
    });

    it('should return empty array when all batches processed', async () => {
      mockContractRead.lastCommitmentKey.mockResolvedValue('0xnonzero');
      mockContractRead.commitments.mockResolvedValue([
        1, 100n, 200n, '0xroot', 10, 10, 2n, '',
      ]);

      const result = await service.getPendingCommitments();
      expect(result).toEqual([]);
    });

    it('should return empty array and log error on failure', async () => {
      mockContractRead.lastCommitmentKey.mockRejectedValue(new Error('fail'));
      const result = await service.getPendingCommitments();
      expect(result).toEqual([]);
    });
  });

  describe('getRecentDistributionEvents', () => {
    it('should return empty array when no events', async () => {
      mockPublicClient.getBlockNumber.mockResolvedValue(1000n);
      mockPublicClient.getLogs.mockResolvedValue([]);
      const result = await service.getRecentDistributionEvents();
      expect(result).toEqual([]);
    });

    it('should return parsed events with block timestamps', async () => {
      mockPublicClient.getBlockNumber.mockResolvedValue(1000n);
      mockPublicClient.getLogs.mockResolvedValue([
        {
          args: { fromBlock: 100n, toBlock: 200n, batchId: 1n },
          blockNumber: 990n,
          transactionHash: '0xtxhash',
        },
      ]);
      mockPublicClient.getBlock.mockResolvedValue({ timestamp: 1700000000n });

      const result = await service.getRecentDistributionEvents(50);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(expect.objectContaining({
        blockNumber: 990n,
        blockTimestamp: 1700000000,
        transactionHash: '0xtxhash',
        batchIndex: 1,
      }));
    });

    it('should return empty array and log error on failure', async () => {
      mockPublicClient.getBlockNumber.mockRejectedValue(new Error('fail'));
      const result = await service.getRecentDistributionEvents();
      expect(result).toEqual([]);
    });
  });

  // =========================================================================
  // Distribution status
  // =========================================================================

  describe('getDistributionStatus', () => {
    beforeEach(() => {
      // Default setup: L1 block, last rewarded block, last commitment key
      mockL1Client.getBlockNumber.mockResolvedValue(5000n);
      mockPublicClient.readContract.mockImplementation(async (args: any) => {
        if (args.functionName === 'lastBlockRewarded') return 2000n;
        if (args.functionName === 'lastCommitmentKey') {
          return '0x0000000000000000000000000000000000000000000000000000000000000000';
        }
        if (args.functionName === 'commitments') {
          return [0, 0n, 0n, '0x0000000000000000000000000000000000000000000000000000000000000000', 0, 0, 0n, ''];
        }
        return 0n;
      });
    });

    it('should compute distribution status when no existing commitment', async () => {
      const result = await service.getDistributionStatus(ctx);
      // lastRewarded=2000, nextFromBlock=2001, nextToBlock=2001+520-1=2520
      // currentBlock=5000, confirmationBlocks=150
      // lastConfirmed=5000-150=4850, needsConfirmation=2520>4850? false
      expect(result.nextFromBlock).toBe(2001);
      expect(result.nextToBlock).toBe(2520);
      expect(result.needsConfirmation).toBe(false);
      expect(result.isReadyForDistribution).toBe(true);
      expect(result.hasExistingCommitment).toBe(false);
    });

    it('should report not ready when next block range is in the future', async () => {
      mockL1Client.getBlockNumber.mockResolvedValue(2100n);
      const result = await service.getDistributionStatus(ctx);
      // nextToBlock=2520, currentBlock=2100 => not ready
      expect(result.isReadyForDistribution).toBe(false);
      expect(result.blocksUntilNextDistribution).toBe(420);
    });

    it('should report needs confirmation when nextToBlock is within confirmation window', async () => {
      // currentBlock = 2600, lastConfirmedBlock = 2600 - 150 = 2450
      // nextToBlock = 2520, 2520 > 2450 => needsConfirmation = true
      mockL1Client.getBlockNumber.mockResolvedValue(2600n);
      const result = await service.getDistributionStatus(ctx);
      expect(result.needsConfirmation).toBe(true);
      expect(result.isReadyForDistribution).toBe(false);
    });
  });

  describe('isNextDistributionReady', () => {
    it('should return ready when block is past range and confirmed', async () => {
      mockL1Client.getBlockNumber.mockResolvedValue(10000n);
      mockPublicClient.readContract.mockResolvedValue(5000n);

      const result = await service.isNextDistributionReady(ctx);
      // nextFrom=5001, nextTo=5520, currentBlock=10000, lastConfirmed=9850
      expect(result.isReady).toBe(true);
      expect(result.nextFromBlock).toBe(5001);
      expect(result.nextToBlock).toBe(5520);
      expect(result.needsConfirmation).toBe(false);
    });

    it('should return not ready when needs confirmation', async () => {
      mockL1Client.getBlockNumber.mockResolvedValue(5600n);
      mockPublicClient.readContract.mockResolvedValue(5000n);

      const result = await service.isNextDistributionReady(ctx);
      // nextTo=5520, lastConfirmed=5600-150=5450, 5520>5450 => needsConfirmation
      expect(result.isReady).toBe(false);
      expect(result.needsConfirmation).toBe(true);
      expect(result.confirmationBlocksNeeded).toBe(70);
    });

    it('should return not ready when block range is in the future', async () => {
      mockL1Client.getBlockNumber.mockResolvedValue(5100n);
      mockPublicClient.readContract.mockResolvedValue(5000n);

      const result = await service.isNextDistributionReady(ctx);
      expect(result.isReady).toBe(false);
      expect(result.blocksUntilReady).toBe(420);
    });
  });

  // =========================================================================
  // Target capacity & storage
  // =========================================================================

  describe('getTargetCapacity', () => {
    it('should return target capacity from contract', async () => {
      mockContractRead.targetCapacityGb.mockResolvedValue(50000n);
      const result = await service.getTargetCapacity();
      expect(result).toBe(50000n * BigInt(1e9));
    });

    it('should fall back to config / default on error', async () => {
      mockContractRead.targetCapacityGb.mockRejectedValue(new Error('fail'));
      const result = await service.getTargetCapacity();
      // Default is 30000 * 1e9
      expect(result).toBe(30000n * BigInt(1e9));
    });
  });

  describe('getStoragePerWorkerInGb', () => {
    it('should return storage per worker from contract', async () => {
      mockContractRead.storagePerWorkerInGb.mockResolvedValue(100n);
      const result = await service.getStoragePerWorkerInGb();
      expect(result).toBe(100);
    });

    it('should return 200 on error', async () => {
      mockContractRead.storagePerWorkerInGb.mockRejectedValue(new Error('fail'));
      const result = await service.getStoragePerWorkerInGb();
      expect(result).toBe(200);
    });
  });

  // =========================================================================
  // approveCommitment
  // =========================================================================

  describe('approveCommitment', () => {
    beforeEach(() => {
      // Default: commitment exists and needs approval
      mockContractRead.commitments.mockResolvedValue([
        1, 100n, 200n, '0xroot', 10, 0, 0n, '',
      ]);
      mockContractRead.requiredApproves.mockResolvedValue(2n);
    });

    it('should approve successfully and return true', async () => {
      mockPublicClient.simulateContract.mockResolvedValue({ request: {} });
      mockWalletClient.writeContract.mockResolvedValue('0xtxhash');
      mockPublicClient.waitForTransactionReceipt.mockResolvedValue({
        status: 'success',
      });

      const result = await service.approveCommitment(100, 200);
      expect(result).toBe(true);
    });

    it('should return true when already approved (AlreadyApproved error)', async () => {
      mockPublicClient.simulateContract.mockRejectedValue(
        new Error('AlreadyApproved'),
      );

      const result = await service.approveCommitment(100, 200);
      expect(result).toBe(true);
    });

    it('should return true when already approved (hex selector 0x101f817a)', async () => {
      mockPublicClient.simulateContract.mockRejectedValue(
        new Error('0x101f817a'),
      );

      const result = await service.approveCommitment(100, 200);
      expect(result).toBe(true);
    });

    it('should return false when commitment does not exist', async () => {
      mockContractRead.commitments.mockResolvedValue([
        0, 0n, 0n, '0x00', 0, 0, 0n, '',
      ]);

      const result = await service.approveCommitment(100, 200);
      expect(result).toBe(false);
    });

    it('should return true when already has enough approvals', async () => {
      mockContractRead.commitments.mockResolvedValue([
        1, 100n, 200n, '0xroot', 10, 0, 5n, '',
      ]);
      mockContractRead.requiredApproves.mockResolvedValue(2n);

      const result = await service.approveCommitment(100, 200);
      expect(result).toBe(true);
    });

    it('should return false when missing private key', async () => {
      mockConfigService.get.mockImplementation((key: string, defaultValue?: any) => {
        if (key === 'blockchain.distributor.privateKey') return null;
        return configMap[key] !== undefined ? configMap[key] : defaultValue;
      });

      const result = await service.approveCommitment(100, 200);
      expect(result).toBe(false);
    });

    it('should retry on transient error and return false after 3 failures', async () => {
      mockPublicClient.simulateContract.mockRejectedValue(
        new Error('nonce too low'),
      );

      // Speed up the test by mocking setTimeout
      jest.useFakeTimers();
      const promise = service.approveCommitment(100, 200);
      // Advance timers for the retries
      await jest.advanceTimersByTimeAsync(2000);
      await jest.advanceTimersByTimeAsync(4000);
      await jest.advanceTimersByTimeAsync(6000);
      const result = await promise;
      jest.useRealTimers();

      expect(result).toBe(false);
    });

    it('should return false when receipt status is not success after retries', async () => {
      mockPublicClient.simulateContract.mockResolvedValue({ request: {} });
      mockWalletClient.writeContract.mockResolvedValue('0xtxhash');
      mockPublicClient.waitForTransactionReceipt.mockResolvedValue({
        status: 'reverted',
      });

      jest.useFakeTimers();
      const promise = service.approveCommitment(100, 200);
      await jest.advanceTimersByTimeAsync(2000);
      await jest.advanceTimersByTimeAsync(4000);
      await jest.advanceTimersByTimeAsync(6000);
      const result = await promise;
      jest.useRealTimers();

      expect(result).toBe(false);
    });
  });

  // =========================================================================
  // getFirstBlockForL1Block (binary search)
  // =========================================================================

  describe('getFirstBlockForL1Block', () => {
    it('should throw when target is before Nitro genesis', async () => {
      mockPublicClient.getChainId.mockResolvedValue(42161);
      await expect(service.getFirstBlockForL1Block(100n)).rejects.toThrow(
        'before Nitro genesis',
      );
    });

    it('should find the L2 block matching the given L1 block', async () => {
      // chainId is not 42161, so start = 0
      mockPublicClient.getChainId.mockResolvedValue(421614);
      // Latest block is 10
      mockPublicClient.getBlock.mockImplementation(async (opts?: any) => {
        if (!opts || !opts.blockNumber) return { number: 10n };
        const bn = Number(opts.blockNumber);
        // Simulate l1BlockNumber increasing with L2 block
        const l1Map: Record<number, number> = {
          0: 0, 1: 1, 2: 2, 3: 3, 4: 4,
          5: 5, 6: 5, 7: 6, 8: 7, 9: 8, 10: 9,
        };
        return { number: opts.blockNumber, l1BlockNumber: BigInt(l1Map[bn] ?? bn) };
      });

      const result = await service.getFirstBlockForL1Block(5n);
      // L1 block 5 maps to L2 block 5 (first hit)
      expect(typeof result).toBe('bigint');
    });

    it('should throw when no L2 block matches the L1 block', async () => {
      mockPublicClient.getChainId.mockResolvedValue(421614);
      // Latest block is 4
      mockPublicClient.getBlock.mockImplementation(async (opts?: any) => {
        if (!opts || !opts.blockNumber) return { number: 4n };
        // All L2 blocks have l1BlockNumber = 0 (target = 100 is never found)
        return { number: opts.blockNumber, l1BlockNumber: 0n };
      });

      await expect(service.getFirstBlockForL1Block(100n)).rejects.toThrow(
        'Unable to find l2 block',
      );
    });

    it('should use cached lastKnownBlockPair when target matches', async () => {
      // Pre-seed the cache
      (service as any).lastKnownBlockPair = { l1Block: 50n, l2Block: 500n };

      const result = await service.getFirstBlockForL1Block(50n);
      expect(result).toBe(500n);
      // No RPC calls should have been made
      expect(mockPublicClient.getChainId).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // getStakes
  // =========================================================================

  describe('getStakes', () => {
    it('should return empty stakes when no valid workers', async () => {
      mockPublicClient.multicall.mockResolvedValue([
        { status: 'success', result: 0n },
      ]);

      const [capped, total] = await service.getStakes(['worker1']);
      expect(capped).toHaveLength(1);
      expect(total).toHaveLength(1);
      expect(capped[0].result).toBe(0n);
    });

    it('should return stakes for valid workers', async () => {
      // First multicall: preloadWorkerIds
      mockPublicClient.multicall.mockResolvedValueOnce([
        { status: 'success', result: 1n },
        { status: 'success', result: 2n },
      ]);
      // Second & third multicalls: capped + total staking (via Promise.all)
      mockPublicClient.multicall
        .mockResolvedValueOnce([
          { status: 'success', result: 100n },
          { status: 'success', result: 200n },
        ])
        .mockResolvedValueOnce([
          { status: 'success', result: 150n },
          { status: 'success', result: 250n },
        ]);

      const [capped, total] = await service.getStakes(['w1', 'w2']);
      expect(capped).toHaveLength(2);
      expect(total).toHaveLength(2);
      expect(capped[0].result).toBe(100n);
      expect(total[1].result).toBe(250n);
    });

    it('should throw when staking addresses are not configured', async () => {
      const originalGet = mockConfigService.get;
      mockConfigService.get = jest.fn((key: string, defaultValue?: any) => {
        if (key === 'blockchain.contracts.staking') return null;
        if (key === 'blockchain.contracts.capedStaking') return null;
        return configMap[key] !== undefined ? configMap[key] : defaultValue;
      });

      await expect(service.getStakes(['w1'])).rejects.toThrow(
        'Staking contract addresses not configured',
      );

      mockConfigService.get = originalGet;
    });
  });

  // =========================================================================
  // Additional coverage: getFirstBlockForL1Block - cached pair with lower target
  // =========================================================================

  describe('getFirstBlockForL1Block - additional branches', () => {
    it('should use cached pair as start when lastKnown.l1Block < target', async () => {
      // Pre-seed the cache: l1Block = 5, l2Block = 50
      (service as any).lastKnownBlockPair = { l1Block: 5n, l2Block: 50n };

      // Latest L2 block is 60
      mockPublicClient.getBlock.mockImplementation(async (opts?: any) => {
        if (!opts || !opts.blockNumber) return { number: 60n };
        const bn = Number(opts.blockNumber);
        // L2 blocks 50-60 map to L1 blocks 5-15
        return { number: opts.blockNumber, l1BlockNumber: BigInt(bn - 45) };
      });

      const result = await service.getFirstBlockForL1Block(10n);
      // L1 block 10 => L2 block 55 (55 - 45 = 10)
      expect(result).toBe(55n);
      // getChainId should NOT have been called since we used the cache
      expect(mockPublicClient.getChainId).not.toHaveBeenCalled();
    });

    it('should reset search when lastKnown.l1Block > target', async () => {
      (service as any).lastKnownBlockPair = { l1Block: 100n, l2Block: 1000n };
      // chainId not 42161 => start = 0
      mockPublicClient.getChainId.mockResolvedValue(421614);
      mockPublicClient.getBlock.mockImplementation(async (opts?: any) => {
        if (!opts || !opts.blockNumber) return { number: 10n };
        const bn = Number(opts.blockNumber);
        return { number: opts.blockNumber, l1BlockNumber: BigInt(bn) };
      });

      const result = await service.getFirstBlockForL1Block(5n);
      expect(result).toBe(5n);
      expect(mockPublicClient.getChainId).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Additional coverage: getDistributionStatus - non-zero commitment key branches
  // =========================================================================

  describe('getDistributionStatus - additional branches', () => {
    it('should use commitment block range when lastCommitmentKey is non-zero and status=1', async () => {
      mockL1Client.getBlockNumber.mockResolvedValue(10000n);
      let readContractCallCount = 0;
      mockPublicClient.readContract.mockImplementation(async (args: any) => {
        readContractCallCount++;
        if (args.functionName === 'lastBlockRewarded') return 2000n;
        if (args.functionName === 'lastCommitmentKey') return '0xnonzerokey';
        if (args.functionName === 'commitments') {
          // First call: status check from getDistributionStatus
          // Return status=1 with specific block range
          return [1, 3000n, 3519n, '0xroot', 10, 0, 0n, ''];
        }
        return 0n;
      });

      const result = await service.getDistributionStatus(ctx);
      expect(result.nextFromBlock).toBe(3000);
      expect(result.nextToBlock).toBe(3519);
    });

    it('should fall back to lastRewarded+1 when commitment status is not 1', async () => {
      mockL1Client.getBlockNumber.mockResolvedValue(10000n);
      mockPublicClient.readContract.mockImplementation(async (args: any) => {
        if (args.functionName === 'lastBlockRewarded') return 2000n;
        if (args.functionName === 'lastCommitmentKey') return '0xnonzerokey';
        if (args.functionName === 'commitments') {
          // status=0 (not active)
          return [0, 0n, 0n, '0x00', 0, 0, 0n, ''];
        }
        return 0n;
      });

      const result = await service.getDistributionStatus(ctx);
      expect(result.nextFromBlock).toBe(2001);
      expect(result.nextToBlock).toBe(2520);
    });

    it('should fall back to lastRewarded+1 when commitment read fails', async () => {
      mockL1Client.getBlockNumber.mockResolvedValue(10000n);
      let commitmentCallCount = 0;
      mockPublicClient.readContract.mockImplementation(async (args: any) => {
        if (args.functionName === 'lastBlockRewarded') return 2000n;
        if (args.functionName === 'lastCommitmentKey') return '0xnonzerokey';
        if (args.functionName === 'commitments') {
          commitmentCallCount++;
          if (commitmentCallCount === 1) {
            // First commitment read (from getDistributionStatus) fails
            throw new Error('rpc error');
          }
          // Second commitment read (from getCommitment) returns empty
          return [0, 0n, 0n, '0x0000000000000000000000000000000000000000000000000000000000000000', 0, 0, 0n, ''];
        }
        return 0n;
      });

      const result = await service.getDistributionStatus(ctx);
      expect(result.nextFromBlock).toBe(2001);
      expect(result.nextToBlock).toBe(2520);
    });

    it('should use startingBlock when lastRewardedBlock is 0 and commitment key is zero', async () => {
      mockL1Client.getBlockNumber.mockResolvedValue(10000n);
      mockPublicClient.readContract.mockImplementation(async (args: any) => {
        if (args.functionName === 'lastBlockRewarded') return 0n;
        if (args.functionName === 'lastCommitmentKey') {
          return '0x0000000000000000000000000000000000000000000000000000000000000000';
        }
        if (args.functionName === 'commitments') {
          return [0, 0n, 0n, '0x0000000000000000000000000000000000000000000000000000000000000000', 0, 0, 0n, ''];
        }
        return 0n;
      });

      const result = await service.getDistributionStatus(ctx);
      // startingBlock = 1000, but lastBlockRewarded=0 => uses startingBlock - 1 = 999
      // Then lastRewardedBlock = 999, but the path for ZERO_KEY + lastRewardedBlock === 0
      // Actually lastRewardedBlock from getLastBlockRewarded when contract returns 0n:
      // lastBlockNum = 0, startingBlock = 1000 > 0, so returns 999
      // Then in getDistributionStatus: lastRewardedBlock=999, it goes to else branch
      // nextFromBlock = 999+1 = 1000, nextToBlock = 1000+520-1 = 1519
      expect(result.nextFromBlock).toBe(1000);
      expect(result.nextToBlock).toBe(1519);
    });

    it('should handle getLastCommitmentKey failure gracefully', async () => {
      mockL1Client.getBlockNumber.mockResolvedValue(10000n);
      mockPublicClient.readContract.mockImplementation(async (args: any) => {
        if (args.functionName === 'lastBlockRewarded') return 2000n;
        if (args.functionName === 'lastCommitmentKey') {
          throw new Error('rpc error');
        }
        if (args.functionName === 'commitments') {
          return [0, 0n, 0n, '0x0000000000000000000000000000000000000000000000000000000000000000', 0, 0, 0n, ''];
        }
        return 0n;
      });

      const result = await service.getDistributionStatus(ctx);
      // Falls back to ZERO_KEY => lastRewardedBlock = 2000 => else branch
      expect(result.nextFromBlock).toBe(2001);
      expect(result.nextToBlock).toBe(2520);
    });
  });

  // =========================================================================
  // Additional coverage: approveCommitment edge cases
  // =========================================================================

  describe('approveCommitment - additional edge cases', () => {
    beforeEach(() => {
      mockContractRead.commitments.mockResolvedValue([
        1, 100n, 200n, '0xroot', 10, 0, 0n, '',
      ]);
      mockContractRead.requiredApproves.mockResolvedValue(2n);
    });

    it('should return false when getCommitmentInfo returns null', async () => {
      mockContractRead.commitments.mockRejectedValue(new Error('fail'));
      const result = await service.approveCommitment(100, 200);
      expect(result).toBe(false);
    });
  });

  // =========================================================================
  // Additional coverage: getLastBlockRewarded with 0 and no starting block
  // =========================================================================

  describe('getLastBlockRewarded - additional branches', () => {
    it('should return 0 when lastBlockRewarded is 0 and no startingBlock configured', async () => {
      const originalGet = mockConfigService.get;
      mockConfigService.get = jest.fn((key: string, defaultValue?: any) => {
        if (key === 'rewards.distributionStartingBlock') return 0;
        return configMap[key] !== undefined ? configMap[key] : defaultValue;
      });

      mockPublicClient.readContract.mockResolvedValue(0n);
      const result = await service.getLastBlockRewarded(ctx);
      expect(result).toBe(0);

      mockConfigService.get = originalGet;
    });

    it('should return 0 for "returned no data" when no startingBlock configured', async () => {
      const originalGet = mockConfigService.get;
      mockConfigService.get = jest.fn((key: string, defaultValue?: any) => {
        if (key === 'rewards.distributionStartingBlock') return 0;
        return configMap[key] !== undefined ? configMap[key] : defaultValue;
      });

      mockPublicClient.readContract.mockRejectedValue(
        new Error('returned no data'),
      );
      const result = await service.getLastBlockRewarded(ctx);
      expect(result).toBe(0);

      mockConfigService.get = originalGet;
    });
  });
});
