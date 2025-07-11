import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  RewardsCalculatorService,
  WorkerReward,
} from '../rewards/calculation/rewards-calculator.service';
import { Web3Service } from '../blockchain/web3.service';
import { ContractService } from '../blockchain/contract.service';
import { Hex } from 'viem';
import { DistributionService } from '../rewards/distribution/distribution.service';
import { TaskContext, Context } from '../common';

export interface EpochRange {
  fromBlock: number;
  toBlock: number;
  epochLength: number;
  batchNumber: number;
}

@Injectable()
export class EpochProcessorService {
  private readonly TOTAL_BATCHES: number;
  private readonly workTimeout: number;
  private readonly commitTimeout: number;
  private readonly approveTimeout: number;
  private isProcessing = false;

  constructor(
    private configService: ConfigService,
    private rewardsCalculatorService: RewardsCalculatorService,
    private web3Service: Web3Service,
    private contractService: ContractService,
    private distributionService: DistributionService,
  ) {
    this.TOTAL_BATCHES = this.configService.get('rewards.totalBatches') || 4;
    this.workTimeout = this.configService.get('rewards.workTimeout') || 300000; // 5 minutes
    this.commitTimeout =
      this.configService.get('rewards.commitTimeout') || 30000; // 30 seconds
    this.approveTimeout =
      this.configService.get('rewards.approveTimeout') || 30000; // 30 seconds
  }

  public startBot(distributorAddress: Hex, distributorIndex: number) {
    new TaskContext('epoch-processor:start-bot').logger.debug(
      `Starting reward bot with distributor ${distributorAddress} (index: ${distributorIndex})`,
    );

    this.scheduleCommitProcess(distributorAddress, distributorIndex);
    this.scheduleApproveProcess(distributorAddress, distributorIndex);
  }

  private scheduleCommitProcess(
    distributorAddress: Hex,
    distributorIndex: number,
  ) {
    setTimeout(async () => {
      await this.commitIfPossible(distributorAddress, distributorIndex);
      this.scheduleCommitProcess(distributorAddress, distributorIndex);
    }, this.workTimeout);
  }

  private scheduleApproveProcess(
    distributorAddress: Hex,
    distributorIndex: number,
  ) {
    setTimeout(async () => {
      await this.approveIfNecessary(distributorAddress, distributorIndex);
      this.scheduleApproveProcess(distributorAddress, distributorIndex);
    }, this.workTimeout);
  }

  private async commitIfPossible(
    distributorAddress: Hex,
    distributorIndex: number,
  ) {
    if (this.isProcessing) {
      new TaskContext(
        `epoch-processor:commit-if-possible:${distributorAddress}`,
      ).logger.debug('Already processing, skipping commit check');
      return;
    }

    try {
      this.isProcessing = true;

      const epochRange = await this.getCommitRange(
        new TaskContext(
          `epoch-processor:get-commit-range:${distributorAddress}`,
        ),
      );

      if (
        await this.canCommit(
          distributorAddress,
          epochRange.fromBlock,
          epochRange.toBlock,
        )
      ) {
        new TaskContext('epoch-processor:can-commit').logger.debug(
          `Can commit ${epochRange.fromBlock} — ${epochRange.toBlock} from ${distributorAddress}`,
        );

        // calc rewards for the full period (including multiple epochs for batching)
        const skipSignatureValidation =
          this.configService.get('rewards.skipSignatureValidation') || false;
        const calculationStartBlock =
          epochRange.toBlock - epochRange.epochLength * this.TOTAL_BATCHES;

        const commitCtx = new TaskContext(
          `epoch-processor:commit-rewards:${epochRange.fromBlock}-${epochRange.toBlock}`,
        );
        const rewardResult =
          await this.rewardsCalculatorService.calculateEpochRewards(
            commitCtx,
            calculationStartBlock,
            epochRange.toBlock,
            skipSignatureValidation,
          );

        // filter workers for this batch
        const batchWorkers =
          await this.rewardsCalculatorService.filterWorkersBatch(
            commitCtx,
            rewardResult,
            epochRange.batchNumber,
            this.TOTAL_BATCHES,
          );

        await this.tryToCommit(
          epochRange.fromBlock,
          epochRange.toBlock,
          batchWorkers,
          distributorAddress,
          distributorIndex,
        );
      } else {
        new TaskContext('method-call').logger.debug(
          `Nothing to commit ${epochRange.fromBlock} — ${epochRange.toBlock}`,
        );
      }
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `Commit process failed: ${error.message}`,
      );
    } finally {
      this.isProcessing = false;
    }
  }

  private async canCommit(
    distributorAddress: Hex,
    fromBlock: number,
    toBlock: number,
  ): Promise<boolean> {
    try {
      return (
        fromBlock < toBlock &&
        (await this.contractService.canCommit(distributorAddress)) &&
        !(await this.contractService.isCommitted(fromBlock, toBlock))
      );
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `Failed to check if can commit: ${error.message}`,
      );
      return false;
    }
  }

  private async tryToCommit(
    fromBlock: number,
    toBlock: number,
    workers: WorkerReward[],
    distributorAddress: Hex,
    distributorIndex: number,
  ) {
    try {
      const workerIds = workers.map((w) => w.id);
      const workerRewards = workers.map((w) => w.workerReward);
      const stakerRewards = workers.map((w) => w.stakerReward);

      const txHash = await this.contractService.commitRewards(
        fromBlock,
        toBlock,
        workerIds,
        workerRewards,
        stakerRewards,
      );

      if (txHash) {
        const totalStake = workers.reduce((sum, w) => sum + w.totalStake, 0n);
        const capedStake = workers.reduce((sum, w) => sum + w.stake, 0n);

        new TaskContext('method-call').logger.debug(
          JSON.stringify({
            time: new Date(),
            type: 'rewards_committed',
            bot_wallet: distributorAddress,
            tx_hash: txHash,
            from_block: fromBlock,
            to_block: toBlock,
            totalStake: totalStake.toString(),
            capedStake: capedStake.toString(),
            workers_count: workers.length,
          }),
        );
      }
    } catch (error: any) {
      if (error.message?.includes('Already approved')) {
        new TaskContext('method-call').logger.debug(
          'Rewards already approved, skipping',
        );
        return;
      }
      if (error.message?.includes('not all blocks covered')) {
        new TaskContext('method-call').logger.debug(
          'Not all blocks covered, skipping',
        );
        return;
      }
      new TaskContext('error-handling').logger.error(
        `Failed to commit rewards: ${error.message}`,
      );
    }
  }

  private async approveIfNecessary(
    distributorAddress: Hex,
    distributorIndex: number,
  ) {
    try {
      const approvalInfo = await this.getApprovalRanges();

      if (approvalInfo.shouldApprove) {
        const ctx = new TaskContext('method-call');
        ctx.logger.debug(
          `Approving rewards for ${approvalInfo.fromBlock} — ${approvalInfo.toBlock}`,
        );

        const skipSignatureValidation =
          this.configService.get('rewards.skipSignatureValidation') || false;
        const calculationStartBlock =
          approvalInfo.toBlock - approvalInfo.epochLength * this.TOTAL_BATCHES;

        const rewardResult =
          await this.rewardsCalculatorService.calculateEpochRewards(
            ctx,
            calculationStartBlock,
            approvalInfo.toBlock,
            skipSignatureValidation,
          );

        // filter workers for this batch
        const batchWorkers =
          await this.rewardsCalculatorService.filterWorkersBatch(
            ctx,
            rewardResult,
            approvalInfo.batchNumber,
            this.TOTAL_BATCHES,
          );

        const workerIds = batchWorkers.map((w) => w.id);
        const workerRewards = batchWorkers.map((w) => w.workerReward);
        const stakerRewards = batchWorkers.map((w) => w.stakerReward);

        const txHash = await this.contractService.approveRewards(
          approvalInfo.fromBlock,
          approvalInfo.toBlock,
          workerIds,
          workerRewards,
          stakerRewards,
        );

        if (txHash) {
          new TaskContext('method-call').logger.debug(
            JSON.stringify({
              time: new Date(),
              type: 'rewards_approved',
              bot_wallet: distributorAddress,
              tx_hash: txHash,
              from_block: approvalInfo.fromBlock,
              to_block: approvalInfo.toBlock,
              workers_count: batchWorkers.length,
            }),
          );
        }
      }
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `Approve process failed: ${error.message}`,
      );
    }
  }

  private async getCommitRange(ctx: Context): Promise<EpochRange> {
    try {
      const epochLength = await this.contractService.getEpochLength(ctx);
      const maxEpochsPerCommit =
        this.configService.get('blockchain.maxEpochsPerCommit') || 1;
      const maxCommitBlocksCovered = epochLength * maxEpochsPerCommit;

      let lastRewardedBlock =
        await this.contractService.getLastRewardedBlock(ctx);

      if (lastRewardedBlock === 0) {
        ctx.logger.error('Last reward block is 0!');
        const registrations = await this.web3Service.getRegistrations(ctx);
        lastRewardedBlock = Math.min(
          ...registrations.map((r) => Number(r.registeredAt)),
        );
      }

      const currentBlock = await this.web3Service.getL1BlockNumber(ctx);
      const epochConfirmationBlocks =
        this.configService.get('blockchain.epochConfirmationBlocks') || 150;
      const lastConfirmedBlock = currentBlock - epochConfirmationBlocks;

      if (lastConfirmedBlock - lastRewardedBlock < epochLength) {
        return { fromBlock: 0, toBlock: 0, epochLength, batchNumber: 0 };
      }

      const toBlock = Math.min(
        lastRewardedBlock + maxCommitBlocksCovered,
        lastConfirmedBlock,
      );
      const fromBlock = lastRewardedBlock + 1;

      return {
        fromBlock,
        toBlock,
        epochLength,
        batchNumber: this.getBatchNumber(toBlock, epochLength),
      };
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `Failed to get commit range: ${error.message}`,
      );
      return { fromBlock: 0, toBlock: 0, epochLength: 7000, batchNumber: 0 };
    }
  }

  private getBatchNumber(blockNumber: number, epochLength: number): number {
    return Math.ceil(blockNumber / epochLength) % this.TOTAL_BATCHES;
  }

  private async getApprovalRanges(): Promise<
    | { shouldApprove: false }
    | {
        shouldApprove: true;
        fromBlock: number;
        toBlock: number;
        batchNumber: number;
        epochLength: number;
        commitment?: Hex;
      }
  > {
    const ctx = new TaskContext('epoch-processor:get-approval-ranges');
    try {
      const latestCommitment = await this.contractService.getLatestCommitment();

      if (!latestCommitment) {
        return { shouldApprove: false };
      }

      const commitment = latestCommitment.merkleRoot;
      const fromBlock = Number(latestCommitment.fromBlock);
      const toBlock = Number(latestCommitment.toBlock);

      const epochLength = await this.contractService.getEpochLength(ctx);
      const batchNumber = this.getBatchNumber(fromBlock, epochLength);

      // check if this needs approval
      if (latestCommitment.approvalCount > 0n) {
        return { shouldApprove: false }; // already has approvals
      }

      return {
        shouldApprove: true,
        fromBlock,
        toBlock,
        batchNumber,
        epochLength,
        commitment,
      };
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `Failed to get approval ranges: ${error.message}`,
      );
      return { shouldApprove: false };
    }
  }

  // manual trigger methods for testing/admin use
  async manualCommit(
    distributorAddress: Hex,
    distributorIndex: number,
  ): Promise<boolean> {
    try {
      await this.commitIfPossible(distributorAddress, distributorIndex);
      return true;
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `Manual commit failed: ${error.message}`,
      );
      return false;
    }
  }

  async manualApprove(
    distributorAddress: Hex,
    distributorIndex: number,
  ): Promise<boolean> {
    try {
      await this.approveIfNecessary(distributorAddress, distributorIndex);
      return true;
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `Manual approve failed: ${error.message}`,
      );
      return false;
    }
  }

  // process epoch using the new Merkle tree distribution workflow
  async processEpochWithMerkleTree(
    fromBlock: number,
    toBlock: number,
  ): Promise<boolean> {
    try {
      new TaskContext('method-call').logger.debug(
        `🌳 Using Merkle tree distribution for epoch ${fromBlock}-${toBlock}`,
      );

      // use the new distribution service which handles the complete flow
      const distributionStatus =
        await this.distributionService.distributeEpochRewards(
          fromBlock,
          toBlock,
          50, // def batch size
        );

      if (distributionStatus.status === 'completed') {
        new TaskContext('epoch-processor:distribution-completed').logger.debug(
          `✅ Merkle tree distribution completed for epoch ${fromBlock}-${toBlock}`,
        );
        new TaskContext('epoch-processor:distribution-stats').logger.debug(
          `   Workers: ${distributionStatus.totalWorkers}`,
        );
        new TaskContext('epoch-processor:distribution-stats').logger.debug(
          `   Batches: ${distributionStatus.totalBatches}`,
        );
        new TaskContext('epoch-processor:distribution-stats').logger.debug(
          `   Total Rewards: ${Number(distributionStatus.totalRewards) / 1e18} SQD`,
        );
        return true;
      } else {
        new TaskContext('error-handling').logger.error(
          `❌ Merkle tree distribution failed: ${distributionStatus.error}`,
        );
        return false;
      }
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `Failed to process epoch with Merkle tree: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Updated main process method to use Merkle tree distribution
   */
  async processEpoch(): Promise<boolean> {
    try {
      const [fromBlock, toBlock] = await this.getEpochRange();

      if (fromBlock >= toBlock) {
        new TaskContext('warning').logger.warn('No new blocks to process');
        return true;
      }

      // check if we should use Merkle tree distribution
      const useMerkleTree = this.configService.get(
        'rewards.useMerkleTree',
        true,
      );

      if (useMerkleTree) {
        return await this.processEpochWithMerkleTree(fromBlock, toBlock);
      } else {
        // fallback to legacy batch system
        return await this.processEpochLegacy(fromBlock, toBlock);
      }
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `Epoch processing failed: ${error.message}`,
        error.stack,
      );
      return false;
    }
  }

  // legacy batch processing (for backward compatibility)
  private async processEpochLegacy(
    fromBlock: number,
    toBlock: number,
  ): Promise<boolean> {
    new TaskContext('epoch-processor:legacy-warning').logger.warn(
      'Using legacy batch distribution - consider migrating to Merkle tree',
    );
    // for now, delegate to the new Merkle tree method
    return await this.processEpochWithMerkleTree(fromBlock, toBlock);
  }

  // get the next epoch range for processing
  private async getEpochRange(): Promise<[number, number]> {
    const ctx = new TaskContext('epoch-processor:get-epoch-range');
    try {
      const epochLength = await this.contractService.getEpochLength(ctx);
      const lastRewardedBlock =
        await this.contractService.getLastRewardedBlock(ctx);
      const currentBlock = await this.web3Service.getL1BlockNumber(ctx);
      const confirmationBlocks =
        this.configService.get('blockchain.epochConfirmationBlocks') || 150;

      const lastConfirmedBlock = currentBlock - confirmationBlocks;
      const fromBlock = lastRewardedBlock + 1;
      const toBlock = Math.min(fromBlock + epochLength - 1, lastConfirmedBlock);

      return [fromBlock, toBlock];
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `Failed to get epoch range: ${error.message}`,
      );
      return [0, 0];
    }
  }

  // sleep utility method
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
