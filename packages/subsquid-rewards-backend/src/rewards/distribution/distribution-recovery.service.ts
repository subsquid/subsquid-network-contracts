import { Injectable } from '@nestjs/common';
import { ContractService } from '../../blockchain/contract.service';
import { MerkleTreeService, MerkleLeaf } from './merkle-tree.service';
import { RewardsCalculatorService, WorkerReward } from '../calculation/rewards-calculator.service';
import { TaskContext, Context } from '../../common';

export interface CommitmentInfo {
  exists: boolean;
  merkleRoot: string;
  totalBatches: number;
  processedBatches: number;
  approvalCount: number;
  ipfsLink: string;
}

export interface RecoveryStatus {
  interrupted: boolean;
  commitment?: CommitmentInfo;
  processedBatchIndices?: number[];
  remainingBatchIndices?: number[];
  merkleTreeMatch?: boolean;
}

@Injectable()
export class DistributionRecoveryService {
  constructor(
    private contractService: ContractService,
    private merkleTreeService: MerkleTreeService,
    private rewardsCalculatorService: RewardsCalculatorService,
  ) {}

  /**
   * check if a distribution was interrupted
   */
  async checkInterruptedDistribution(
    ctx: Context,
    fromBlock: number,
    toBlock: number,
  ): Promise<RecoveryStatus> {
    try {
      ctx.logger.info(
        `🔍 Checking for interrupted distribution for blocks ${fromBlock}-${toBlock}`,
      );

      // get commitment from contract
      const commitment = await this.contractService.getCommitment(
        ctx,
        fromBlock,
        toBlock,
      );

      if (!commitment.exists) {
        ctx.logger.debug('No commitment found - this is a new distribution');
        return { interrupted: false };
      }

      ctx.logger.info(
        `📋 Found existing commitment: ${commitment.processedBatches}/${commitment.totalBatches} batches processed`,
      );

      // check if fully processed
      if (commitment.processedBatches === commitment.totalBatches) {
        ctx.logger.info('✅ Distribution already completed');
        return { interrupted: false, commitment };
      }

      // distribution was interrupted
      return {
        interrupted: true,
        commitment,
      };
    } catch (error) {
      ctx.logger.error(
        { error },
        'Failed to check for interrupted distribution',
      );
      throw error;
    }
  }

  /**
   * Recover merkle tree state from contract and verify it matches
   */
  async recoverMerkleTree(
    ctx: Context,
    fromBlock: number,
    toBlock: number,
    batchSize: number,
  ): Promise<{
    merkleRoot: string;
    totalBatches: number;
    leaves: MerkleLeaf[];
    processedLeaves: boolean[];
  }> {
    try {
      ctx.logger.info(
        `🔄 Recovering merkle tree for blocks ${fromBlock}-${toBlock}`,
      );

      // Get commitment from contract
      const commitment = await this.contractService.getCommitment(
        ctx,
        fromBlock,
        toBlock,
      );

      if (!commitment.exists) {
        throw new Error('No commitment found to recover from');
      }

      // Calculate rewards exactly as before
      const workerRewards = await this.rewardsCalculatorService.calculateEpochRewards(
        ctx,
        fromBlock,
        toBlock,
        true, // skipSignatureValidation
      );

      if (workerRewards.length === 0) {
        throw new Error('No workers found for recovery');
      }

      // sort workers deterministically by ID
      const sortedWorkers = [...workerRewards].sort((a, b) => {
        if (a.workerId < b.workerId) return -1;
        if (a.workerId > b.workerId) return 1;
        return 0;
      });

      ctx.logger.debug(
        `📊 Calculated rewards for ${sortedWorkers.length} workers`,
      );

      // generate merkle tree with same batch size
      const merkleTree = await this.merkleTreeService.generateMerkleTree(
        sortedWorkers,
        batchSize,
      );

      // verify merkle root matches
      if (merkleTree.root !== commitment.merkleRoot) {
        ctx.logger.error(
          `❌ Merkle root mismatch! Contract: ${commitment.merkleRoot}, Generated: ${merkleTree.root}`,
        );
        throw new Error(
          'Generated merkle root does not match contract commitment',
        );
      }

      ctx.logger.info(
        `✅ Merkle root matches! Checking processed batches...`,
      );

      // check which batches have been processed
      const leafHashes = merkleTree.leaves.map((leaf) => leaf.leafHash);
      const processedLeaves = await this.contractService.getProcessedBatches(
        ctx,
        fromBlock,
        toBlock,
        leafHashes,
      );

      const processedCount = processedLeaves.filter((p) => p).length;
      ctx.logger.info(
        `📊 ${processedCount}/${merkleTree.totalBatches} batches already processed`,
      );

      return {
        merkleRoot: merkleTree.root,
        totalBatches: merkleTree.totalBatches,
        leaves: merkleTree.leaves,
        processedLeaves,
      };
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to recover merkle tree');
      throw error;
    }
  }

  /**
   * get the indices of processed and remaining batches
   */
  getProcessedAndRemainingBatches(
    processedLeaves: boolean[],
  ): {
    processedBatchIndices: number[];
    remainingBatchIndices: number[];
  } {
    const processedBatchIndices: number[] = [];
    const remainingBatchIndices: number[] = [];

    processedLeaves.forEach((processed, index) => {
      if (processed) {
        processedBatchIndices.push(index);
      } else {
        remainingBatchIndices.push(index);
      }
    });

    return { processedBatchIndices, remainingBatchIndices };
  }

  /**
   * check if we should recover on startup
   */
  async checkPendingDistributions(ctx: Context): Promise<{
    lastBlockRewarded: number;
    pendingRanges: Array<{ fromBlock: number; toBlock: number; status: string }>;
  }> {
    try {
      const lastBlockRewarded = await this.contractService.getLastBlockRewarded(ctx);
      
      ctx.logger.info(
        `📊 Last block rewarded: ${lastBlockRewarded}`,
      );

      return {
        lastBlockRewarded,
        pendingRanges: [],
      };
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to check pending distributions');
      throw error;
    }
  }
}