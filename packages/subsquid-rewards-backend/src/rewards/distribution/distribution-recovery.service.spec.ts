import {
  DistributionRecoveryService,
  CommitmentInfo,
  CommitmentInfoV2,
  RecoveryStatus,
} from './distribution-recovery.service';

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

function createMockCtx() {
  return {
    logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  } as any;
}

function createMockContractService() {
  return {
    getCommitment: jest.fn(),
    getCommitmentV2: jest.fn(),
    getProcessedBatches: jest.fn(),
    getLastBlockRewarded: jest.fn(),
    getLastCommitmentKey: jest.fn(),
    getEpochLength: jest.fn(),
  };
}

function createMockMerkleTreeService() {
  return {
    generateMerkleTree: jest.fn(),
  };
}

function createMockRewardsCalculatorService() {
  return {
    calculateEpochRewards: jest.fn(),
  };
}

describe('DistributionRecoveryService', () => {
  let service: DistributionRecoveryService;
  let mockContractService: ReturnType<typeof createMockContractService>;
  let mockMerkleTreeService: ReturnType<typeof createMockMerkleTreeService>;
  let mockRewardsCalculatorService: ReturnType<
    typeof createMockRewardsCalculatorService
  >;
  let ctx: ReturnType<typeof createMockCtx>;

  beforeEach(() => {
    mockContractService = createMockContractService();
    mockMerkleTreeService = createMockMerkleTreeService();
    mockRewardsCalculatorService = createMockRewardsCalculatorService();

    service = new DistributionRecoveryService(
      mockContractService as any,
      mockMerkleTreeService as any,
      mockRewardsCalculatorService as any,
    );

    ctx = createMockCtx();
    jest.clearAllMocks();
  });

  // ===========================================================================
  // checkInterruptedDistribution
  // ===========================================================================
  describe('checkInterruptedDistribution', () => {
    it('should return interrupted=false when V2 commitment status is 0 (NONEXISTENT)', async () => {
      mockContractService.getCommitmentV2.mockResolvedValue({
        status: 0,
        merkleRoot: '0x0000',
        totalBatches: 0,
        processedBatches: 0,
        approvalCount: 0,
        ipfsLink: '',
      } satisfies CommitmentInfoV2);

      const result = await service.checkInterruptedDistribution(ctx, 100, 200);

      expect(result).toEqual({ interrupted: false });
      expect(mockContractService.getCommitmentV2).toHaveBeenCalledWith(
        ctx,
        100,
        200,
      );
      expect(mockContractService.getCommitment).not.toHaveBeenCalled();
    });

    it('should return interrupted=false with commitment when V2 status is 2 (COMPLETED)', async () => {
      mockContractService.getCommitmentV2.mockResolvedValue({
        status: 2,
        merkleRoot: '0xabc123',
        totalBatches: 5,
        processedBatches: 5,
        approvalCount: 3,
        ipfsLink: 'ipfs://Qm123',
      } satisfies CommitmentInfoV2);

      const result = await service.checkInterruptedDistribution(ctx, 100, 200);

      expect(result.interrupted).toBe(false);
      expect(result.commitment).toBeDefined();
      expect(result.commitment!.exists).toBe(true);
      expect(result.commitment!.merkleRoot).toBe('0xabc123');
      expect(result.commitment!.totalBatches).toBe(5);
      expect(result.commitment!.processedBatches).toBe(5);
      expect(result.commitment!.approvalCount).toBe(3);
      expect(result.commitment!.ipfsLink).toBe('ipfs://Qm123');
    });

    it('should return interrupted=true when V2 status is 1 (ACTIVE)', async () => {
      mockContractService.getCommitmentV2.mockResolvedValue({
        status: 1,
        merkleRoot: '0xdef456',
        totalBatches: 10,
        processedBatches: 4,
        approvalCount: 2,
        ipfsLink: 'ipfs://Qm456',
      } satisfies CommitmentInfoV2);

      const result = await service.checkInterruptedDistribution(ctx, 100, 200);

      expect(result.interrupted).toBe(true);
      expect(result.commitment).toBeDefined();
      expect(result.commitment!.exists).toBe(true);
      expect(result.commitment!.merkleRoot).toBe('0xdef456');
      expect(result.commitment!.totalBatches).toBe(10);
      expect(result.commitment!.processedBatches).toBe(4);
    });

    it('should fall back to old method when V2 call fails and commitment does not exist', async () => {
      mockContractService.getCommitmentV2.mockRejectedValue(
        new Error('V2 not supported'),
      );
      mockContractService.getCommitment.mockResolvedValue({
        exists: false,
        merkleRoot:
          '0x0000000000000000000000000000000000000000000000000000000000000000',
        totalBatches: 0,
        processedBatches: 0,
        approvalCount: 0,
        ipfsLink: '',
      });

      const result = await service.checkInterruptedDistribution(ctx, 100, 200);

      expect(result).toEqual({ interrupted: false });
      expect(mockContractService.getCommitmentV2).toHaveBeenCalled();
      expect(mockContractService.getCommitment).toHaveBeenCalledWith(
        ctx,
        100,
        200,
      );
      expect(ctx.logger.debug).toHaveBeenCalledWith(
        'Could not use getCommitmentV2, falling back to old method',
      );
    });

    it('should fall back to old method when V2 fails and commitment is fully processed', async () => {
      mockContractService.getCommitmentV2.mockRejectedValue(
        new Error('V2 not supported'),
      );
      mockContractService.getCommitment.mockResolvedValue({
        exists: true,
        merkleRoot: '0xaaa',
        totalBatches: 8,
        processedBatches: 8,
        approvalCount: 2,
        ipfsLink: 'ipfs://done',
      });

      const result = await service.checkInterruptedDistribution(ctx, 100, 200);

      expect(result.interrupted).toBe(false);
      expect(result.commitment).toBeDefined();
      expect(result.commitment!.exists).toBe(true);
      expect(result.commitment!.processedBatches).toBe(8);
      expect(result.commitment!.totalBatches).toBe(8);
    });

    it('should fall back to old method when V2 fails and commitment is partially processed', async () => {
      mockContractService.getCommitmentV2.mockRejectedValue(
        new Error('V2 not supported'),
      );
      mockContractService.getCommitment.mockResolvedValue({
        exists: true,
        merkleRoot: '0xbbb',
        totalBatches: 10,
        processedBatches: 3,
        approvalCount: 1,
        ipfsLink: 'ipfs://partial',
      });

      const result = await service.checkInterruptedDistribution(ctx, 100, 200);

      expect(result.interrupted).toBe(true);
      expect(result.commitment).toBeDefined();
      expect(result.commitment!.exists).toBe(true);
      expect(result.commitment!.processedBatches).toBe(3);
      expect(result.commitment!.totalBatches).toBe(10);
    });

    it('should throw when both V2 and old method calls fail', async () => {
      mockContractService.getCommitmentV2.mockRejectedValue(
        new Error('V2 not supported'),
      );
      mockContractService.getCommitment.mockRejectedValue(
        new Error('Network error'),
      );

      await expect(
        service.checkInterruptedDistribution(ctx, 100, 200),
      ).rejects.toThrow('Network error');

      expect(ctx.logger.error).toHaveBeenCalledWith(
        { error: expect.any(Error) },
        'Failed to check for interrupted distribution',
      );
    });

    it('should log block range in info message', async () => {
      mockContractService.getCommitmentV2.mockResolvedValue({
        status: 0,
        merkleRoot: '0x00',
        totalBatches: 0,
        processedBatches: 0,
        approvalCount: 0,
        ipfsLink: '',
      });

      await service.checkInterruptedDistribution(ctx, 500, 1000);

      expect(ctx.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('500-1000'),
      );
    });

    it('should log commitment details when V2 returns ACTIVE status', async () => {
      mockContractService.getCommitmentV2.mockResolvedValue({
        status: 1,
        merkleRoot: '0xfff',
        totalBatches: 6,
        processedBatches: 2,
        approvalCount: 1,
        ipfsLink: '',
      });

      await service.checkInterruptedDistribution(ctx, 100, 200);

      expect(ctx.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('2/6 batches processed'),
      );
    });

    it('should handle V2 returning null by falling back to old method', async () => {
      // If getCommitmentV2 resolves to a falsy value instead of throwing
      mockContractService.getCommitmentV2.mockResolvedValue(null);
      mockContractService.getCommitment.mockResolvedValue({
        exists: false,
        merkleRoot: '0x00',
        totalBatches: 0,
        processedBatches: 0,
        approvalCount: 0,
        ipfsLink: '',
      });

      const result = await service.checkInterruptedDistribution(ctx, 100, 200);

      expect(result).toEqual({ interrupted: false });
      expect(mockContractService.getCommitment).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // recoverMerkleTree
  // ===========================================================================
  describe('recoverMerkleTree', () => {
    const mockLeaves = [
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

    const mockWorkerRewards = [
      {
        workerId: 2n,
        id: 2n,
        workerReward: 200n,
        stakerReward: 100n,
        stake: 0n,
        totalStake: 0n,
        calculationTime: 0,
      },
      {
        workerId: 1n,
        id: 1n,
        workerReward: 100n,
        stakerReward: 50n,
        stake: 0n,
        totalStake: 0n,
        calculationTime: 0,
      },
      {
        workerId: 3n,
        id: 3n,
        workerReward: 300n,
        stakerReward: 150n,
        stake: 0n,
        totalStake: 0n,
        calculationTime: 0,
      },
    ];

    it('should successfully recover merkle tree when roots match', async () => {
      mockContractService.getCommitment.mockResolvedValue({
        exists: true,
        merkleRoot: '0xmatchingroot',
        totalBatches: 2,
        processedBatches: 1,
        approvalCount: 1,
        ipfsLink: 'ipfs://test',
      });

      mockRewardsCalculatorService.calculateEpochRewards.mockResolvedValue(
        mockWorkerRewards,
      );

      mockMerkleTreeService.generateMerkleTree.mockResolvedValue({
        root: '0xmatchingroot',
        leaves: mockLeaves,
        proofs: [['0xproof1'], ['0xproof2']],
        totalBatches: 2,
      });

      mockContractService.getProcessedBatches.mockResolvedValue([true, false]);

      const result = await service.recoverMerkleTree(ctx, 100, 200, 2);

      expect(result.merkleRoot).toBe('0xmatchingroot');
      expect(result.totalBatches).toBe(2);
      expect(result.leaves).toEqual(mockLeaves);
      expect(result.processedLeaves).toEqual([true, false]);
    });

    it('should throw when no commitment exists', async () => {
      mockContractService.getCommitment.mockResolvedValue({
        exists: false,
        merkleRoot: '0x00',
        totalBatches: 0,
        processedBatches: 0,
        approvalCount: 0,
        ipfsLink: '',
      });

      await expect(
        service.recoverMerkleTree(ctx, 100, 200, 10),
      ).rejects.toThrow('No commitment found to recover from');
    });

    it('should throw when no workers are found', async () => {
      mockContractService.getCommitment.mockResolvedValue({
        exists: true,
        merkleRoot: '0xsomething',
        totalBatches: 2,
        processedBatches: 0,
        approvalCount: 1,
        ipfsLink: '',
      });

      mockRewardsCalculatorService.calculateEpochRewards.mockResolvedValue([]);

      await expect(
        service.recoverMerkleTree(ctx, 100, 200, 10),
      ).rejects.toThrow('No workers found for recovery');
    });

    it('should throw when generated merkle root does not match contract', async () => {
      mockContractService.getCommitment.mockResolvedValue({
        exists: true,
        merkleRoot: '0xcontractroot',
        totalBatches: 2,
        processedBatches: 1,
        approvalCount: 1,
        ipfsLink: '',
      });

      mockRewardsCalculatorService.calculateEpochRewards.mockResolvedValue(
        mockWorkerRewards,
      );

      mockMerkleTreeService.generateMerkleTree.mockResolvedValue({
        root: '0xdifferentroot',
        leaves: mockLeaves,
        proofs: [],
        totalBatches: 2,
      });

      await expect(
        service.recoverMerkleTree(ctx, 100, 200, 2),
      ).rejects.toThrow(
        'Generated merkle root does not match contract commitment',
      );

      expect(ctx.logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Merkle root mismatch'),
      );
    });

    it('should pass skipSignatureValidation=true to calculateEpochRewards', async () => {
      mockContractService.getCommitment.mockResolvedValue({
        exists: true,
        merkleRoot: '0xroot',
        totalBatches: 1,
        processedBatches: 0,
        approvalCount: 1,
        ipfsLink: '',
      });

      mockRewardsCalculatorService.calculateEpochRewards.mockResolvedValue(
        mockWorkerRewards,
      );

      mockMerkleTreeService.generateMerkleTree.mockResolvedValue({
        root: '0xroot',
        leaves: [mockLeaves[0]],
        proofs: [['0xp']],
        totalBatches: 1,
      });

      mockContractService.getProcessedBatches.mockResolvedValue([false]);

      await service.recoverMerkleTree(ctx, 100, 200, 10);

      expect(
        mockRewardsCalculatorService.calculateEpochRewards,
      ).toHaveBeenCalledWith(ctx, 100, 200, true);
    });

    it('should sort workers deterministically by workerId before generating merkle tree', async () => {
      const unsortedWorkers = [
        {
          workerId: 3n,
          id: 3n,
          workerReward: 300n,
          stakerReward: 150n,
          stake: 0n,
          totalStake: 0n,
          calculationTime: 0,
        },
        {
          workerId: 1n,
          id: 1n,
          workerReward: 100n,
          stakerReward: 50n,
          stake: 0n,
          totalStake: 0n,
          calculationTime: 0,
        },
      ];

      mockContractService.getCommitment.mockResolvedValue({
        exists: true,
        merkleRoot: '0xroot',
        totalBatches: 1,
        processedBatches: 0,
        approvalCount: 1,
        ipfsLink: '',
      });

      mockRewardsCalculatorService.calculateEpochRewards.mockResolvedValue(
        unsortedWorkers,
      );

      mockMerkleTreeService.generateMerkleTree.mockResolvedValue({
        root: '0xroot',
        leaves: [mockLeaves[0]],
        proofs: [['0xp']],
        totalBatches: 1,
      });

      mockContractService.getProcessedBatches.mockResolvedValue([false]);

      await service.recoverMerkleTree(ctx, 100, 200, 10);

      const passedWorkers =
        mockMerkleTreeService.generateMerkleTree.mock.calls[0][0];
      expect(passedWorkers[0].workerId).toBe(1n);
      expect(passedWorkers[1].workerId).toBe(3n);
    });

    it('should pass leaf hashes to getProcessedBatches', async () => {
      mockContractService.getCommitment.mockResolvedValue({
        exists: true,
        merkleRoot: '0xroot',
        totalBatches: 2,
        processedBatches: 0,
        approvalCount: 1,
        ipfsLink: '',
      });

      mockRewardsCalculatorService.calculateEpochRewards.mockResolvedValue(
        mockWorkerRewards,
      );

      mockMerkleTreeService.generateMerkleTree.mockResolvedValue({
        root: '0xroot',
        leaves: mockLeaves,
        proofs: [['0xp1'], ['0xp2']],
        totalBatches: 2,
      });

      mockContractService.getProcessedBatches.mockResolvedValue([false, false]);

      await service.recoverMerkleTree(ctx, 100, 200, 2);

      expect(mockContractService.getProcessedBatches).toHaveBeenCalledWith(
        ctx,
        100,
        200,
        ['0xleaf1', '0xleaf2'],
      );
    });

    it('should log processed batch count after recovery', async () => {
      mockContractService.getCommitment.mockResolvedValue({
        exists: true,
        merkleRoot: '0xroot',
        totalBatches: 3,
        processedBatches: 2,
        approvalCount: 1,
        ipfsLink: '',
      });

      mockRewardsCalculatorService.calculateEpochRewards.mockResolvedValue(
        mockWorkerRewards,
      );

      const threeLeaves = [
        ...mockLeaves,
        {
          recipients: [4n],
          workerRewards: [400n],
          stakerRewards: [200n],
          leafHash: '0xleaf3',
        },
      ];

      mockMerkleTreeService.generateMerkleTree.mockResolvedValue({
        root: '0xroot',
        leaves: threeLeaves,
        proofs: [['0xp1'], ['0xp2'], ['0xp3']],
        totalBatches: 3,
      });

      mockContractService.getProcessedBatches.mockResolvedValue([
        true,
        true,
        false,
      ]);

      await service.recoverMerkleTree(ctx, 100, 200, 2);

      expect(ctx.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('2/3 batches already processed'),
      );
    });

    it('should re-throw errors from getCommitment after logging', async () => {
      const networkError = new Error('RPC timeout');
      mockContractService.getCommitment.mockRejectedValue(networkError);

      await expect(
        service.recoverMerkleTree(ctx, 100, 200, 10),
      ).rejects.toThrow('RPC timeout');

      expect(ctx.logger.error).toHaveBeenCalledWith(
        { error: networkError },
        'Failed to recover merkle tree',
      );
    });
  });

  // ===========================================================================
  // getProcessedAndRemainingBatches
  // ===========================================================================
  describe('getProcessedAndRemainingBatches', () => {
    it('should return all indices as processed when all are true', () => {
      const result = service.getProcessedAndRemainingBatches([
        true,
        true,
        true,
      ]);

      expect(result.processedBatchIndices).toEqual([0, 1, 2]);
      expect(result.remainingBatchIndices).toEqual([]);
    });

    it('should return all indices as remaining when none are processed', () => {
      const result = service.getProcessedAndRemainingBatches([
        false,
        false,
        false,
      ]);

      expect(result.processedBatchIndices).toEqual([]);
      expect(result.remainingBatchIndices).toEqual([0, 1, 2]);
    });

    it('should correctly split partially processed batches', () => {
      const result = service.getProcessedAndRemainingBatches([
        true,
        false,
        true,
        false,
        true,
      ]);

      expect(result.processedBatchIndices).toEqual([0, 2, 4]);
      expect(result.remainingBatchIndices).toEqual([1, 3]);
    });

    it('should return both empty for empty input array', () => {
      const result = service.getProcessedAndRemainingBatches([]);

      expect(result.processedBatchIndices).toEqual([]);
      expect(result.remainingBatchIndices).toEqual([]);
    });

    it('should handle single element array (processed)', () => {
      const result = service.getProcessedAndRemainingBatches([true]);

      expect(result.processedBatchIndices).toEqual([0]);
      expect(result.remainingBatchIndices).toEqual([]);
    });

    it('should handle single element array (remaining)', () => {
      const result = service.getProcessedAndRemainingBatches([false]);

      expect(result.processedBatchIndices).toEqual([]);
      expect(result.remainingBatchIndices).toEqual([0]);
    });

    it('should preserve index ordering', () => {
      const result = service.getProcessedAndRemainingBatches([
        false,
        true,
        false,
        true,
      ]);

      expect(result.processedBatchIndices).toEqual([1, 3]);
      expect(result.remainingBatchIndices).toEqual([0, 2]);
    });
  });

  // ===========================================================================
  // checkPendingDistributions
  // ===========================================================================
  describe('checkPendingDistributions', () => {
    const ZERO_KEY =
      '0x0000000000000000000000000000000000000000000000000000000000000000';

    it('should return empty pending when last commitment key is zero', async () => {
      mockContractService.getLastBlockRewarded.mockResolvedValue(1000);
      mockContractService.getLastCommitmentKey.mockResolvedValue(ZERO_KEY);

      const result = await service.checkPendingDistributions(ctx);

      expect(result.lastBlockRewarded).toBe(1000);
      expect(result.pendingRanges).toEqual([]);
      expect(result.lastCommitment).toBeUndefined();
      expect(mockContractService.getEpochLength).not.toHaveBeenCalled();
    });

    it('should return ACTIVE commitment in pendingRanges', async () => {
      mockContractService.getLastBlockRewarded.mockResolvedValue(1000);
      mockContractService.getLastCommitmentKey.mockResolvedValue('0xabc123');
      mockContractService.getEpochLength.mockResolvedValue(500);

      // First range check returns ACTIVE
      mockContractService.getCommitmentV2.mockResolvedValueOnce({
        status: 1,
        merkleRoot: '0xroot',
        totalBatches: 10,
        processedBatches: 3,
        approvalCount: 1,
        ipfsLink: '',
      });

      const result = await service.checkPendingDistributions(ctx);

      expect(result.lastBlockRewarded).toBe(1000);
      expect(result.pendingRanges).toHaveLength(1);
      expect(result.pendingRanges[0].status).toContain('ACTIVE');
      expect(result.pendingRanges[0].status).toContain('3/10');
      expect(result.lastCommitment).toBeDefined();
      expect(result.lastCommitment!.status).toBe(1);
      expect(result.lastCommitment!.processedBatches).toBe(3);
      expect(result.lastCommitment!.totalBatches).toBe(10);
    });

    it('should return no pending when commitment key is non-zero but commitments are NONEXISTENT', async () => {
      mockContractService.getLastBlockRewarded.mockResolvedValue(1000);
      mockContractService.getLastCommitmentKey.mockResolvedValue('0xabc');
      mockContractService.getEpochLength.mockResolvedValue(500);

      // Both ranges return NONEXISTENT
      mockContractService.getCommitmentV2
        .mockResolvedValueOnce({
          status: 0,
          merkleRoot: '0x00',
          totalBatches: 0,
          processedBatches: 0,
          approvalCount: 0,
          ipfsLink: '',
        })
        .mockResolvedValueOnce({
          status: 0,
          merkleRoot: '0x00',
          totalBatches: 0,
          processedBatches: 0,
          approvalCount: 0,
          ipfsLink: '',
        });

      const result = await service.checkPendingDistributions(ctx);

      expect(result.pendingRanges).toEqual([]);
      expect(result.lastCommitment).toBeUndefined();
    });

    it('should re-throw error from getLastBlockRewarded', async () => {
      mockContractService.getLastBlockRewarded.mockRejectedValue(
        new Error('RPC failed'),
      );

      await expect(service.checkPendingDistributions(ctx)).rejects.toThrow(
        'RPC failed',
      );

      expect(ctx.logger.error).toHaveBeenCalledWith(
        { error: expect.any(Error) },
        'Failed to check pending distributions',
      );
    });

    it('should calculate correct block ranges based on epochLength and lastBlockRewarded', async () => {
      mockContractService.getLastBlockRewarded.mockResolvedValue(2000);
      mockContractService.getLastCommitmentKey.mockResolvedValue('0xkey');
      mockContractService.getEpochLength.mockResolvedValue(500);

      // First range is NONEXISTENT, second is ACTIVE
      mockContractService.getCommitmentV2
        .mockResolvedValueOnce({
          status: 0,
          merkleRoot: '0x00',
          totalBatches: 0,
          processedBatches: 0,
          approvalCount: 0,
          ipfsLink: '',
        })
        .mockResolvedValueOnce({
          status: 1,
          merkleRoot: '0xroot',
          totalBatches: 5,
          processedBatches: 2,
          approvalCount: 1,
          ipfsLink: '',
        });

      const result = await service.checkPendingDistributions(ctx);

      // First range: Math.max(1, 2000 - 500 + 1) = 1501 to 2000
      expect(mockContractService.getCommitmentV2).toHaveBeenCalledWith(
        ctx,
        1501,
        2000,
      );
      // Second range: 2001 to 2500
      expect(mockContractService.getCommitmentV2).toHaveBeenCalledWith(
        ctx,
        2001,
        2500,
      );

      expect(result.pendingRanges[0].fromBlock).toBe(2001);
      expect(result.pendingRanges[0].toBlock).toBe(2500);
    });

    it('should handle getLastCommitmentKey failure gracefully', async () => {
      mockContractService.getLastBlockRewarded.mockResolvedValue(1000);
      mockContractService.getLastCommitmentKey.mockRejectedValue(
        new Error('Contract not supported'),
      );

      const result = await service.checkPendingDistributions(ctx);

      expect(result.lastBlockRewarded).toBe(1000);
      expect(result.pendingRanges).toEqual([]);
      expect(result.lastCommitment).toBeUndefined();
      expect(ctx.logger.debug).toHaveBeenCalledWith(
        'Could not check last commitment - might be using older contract',
      );
    });

    it('should handle getCommitmentV2 failure for individual ranges gracefully', async () => {
      mockContractService.getLastBlockRewarded.mockResolvedValue(1000);
      mockContractService.getLastCommitmentKey.mockResolvedValue('0xkey');
      mockContractService.getEpochLength.mockResolvedValue(500);

      // Both range checks throw
      mockContractService.getCommitmentV2
        .mockRejectedValueOnce(new Error('range 1 fail'))
        .mockRejectedValueOnce(new Error('range 2 fail'));

      const result = await service.checkPendingDistributions(ctx);

      expect(result.pendingRanges).toEqual([]);
      expect(result.lastCommitment).toBeUndefined();
    });

    it('should break after finding first non-NONEXISTENT commitment', async () => {
      mockContractService.getLastBlockRewarded.mockResolvedValue(1000);
      mockContractService.getLastCommitmentKey.mockResolvedValue('0xkey');
      mockContractService.getEpochLength.mockResolvedValue(500);

      // First range returns COMPLETED (status 2), which is non-NONEXISTENT
      mockContractService.getCommitmentV2.mockResolvedValueOnce({
        status: 2,
        merkleRoot: '0xroot',
        totalBatches: 5,
        processedBatches: 5,
        approvalCount: 3,
        ipfsLink: '',
      });

      const result = await service.checkPendingDistributions(ctx);

      // Should break after first - only 1 call to getCommitmentV2
      expect(mockContractService.getCommitmentV2).toHaveBeenCalledTimes(1);
      // COMPLETED does not get added to pendingRanges (only ACTIVE status=1 does)
      expect(result.pendingRanges).toEqual([]);
      // But lastCommitment should be set
      expect(result.lastCommitment).toBeDefined();
      expect(result.lastCommitment!.status).toBe(2);
    });

    it('should use Math.max(1, ...) for fromBlock to avoid negative values', async () => {
      mockContractService.getLastBlockRewarded.mockResolvedValue(100);
      mockContractService.getLastCommitmentKey.mockResolvedValue('0xkey');
      mockContractService.getEpochLength.mockResolvedValue(500);

      mockContractService.getCommitmentV2
        .mockResolvedValueOnce({
          status: 0,
          merkleRoot: '0x00',
          totalBatches: 0,
          processedBatches: 0,
          approvalCount: 0,
          ipfsLink: '',
        })
        .mockResolvedValueOnce({
          status: 0,
          merkleRoot: '0x00',
          totalBatches: 0,
          processedBatches: 0,
          approvalCount: 0,
          ipfsLink: '',
        });

      await service.checkPendingDistributions(ctx);

      // Math.max(1, 100 - 500 + 1) = Math.max(1, -399) = 1
      expect(mockContractService.getCommitmentV2).toHaveBeenCalledWith(
        ctx,
        1,
        100,
      );
    });

    it('should log the lastBlockRewarded value', async () => {
      mockContractService.getLastBlockRewarded.mockResolvedValue(5000);
      mockContractService.getLastCommitmentKey.mockResolvedValue(ZERO_KEY);

      await service.checkPendingDistributions(ctx);

      expect(ctx.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('5000'),
      );
    });
  });
});
