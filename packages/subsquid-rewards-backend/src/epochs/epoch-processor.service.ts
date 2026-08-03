import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  RewardsCalculatorService,
  WorkerReward,
} from '../rewards/calculation/rewards-calculator.service';
import { Web3Service } from '../blockchain/web3.service';
import { ContractService } from '../blockchain/contract.service';
import { StatelessCoordinatorService } from './stateless-coordinator.service';
import { Hex } from 'viem';
import { DistributionService } from '../rewards/distribution/distribution.service';
import { TaskContext, Context, CommitmentKeyService } from '../common';

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
    private statelessCoordinator: StatelessCoordinatorService,
    private commitmentKeyService: CommitmentKeyService,
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
            epochRange.batchNumber,
            this.TOTAL_BATCHES,
          );

        const batchWorkers = rewardResult;

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

        console.log(
          JSON.stringify({
            time: new Date(),
            type: 'rewards_commited',
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
            approvalInfo.batchNumber,
            this.TOTAL_BATCHES,
          );

        const batchWorkers = rewardResult;

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
        this.configService.get('blockchain.epochConfirmationBlocks') || 1000;
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
   * Check if commitment exists for current epoch and get approval status
   */
  async checkCommitmentStatus(): Promise<{
    exists: boolean;
    currentApprovals: number;
    requiredApprovals: number;
    fromBlock?: number;
    toBlock?: number;
    status?: number;
  }> {
    const ctx = new TaskContext('epoch-processor:check-commitment-status');

    try {
      const [fromBlock, toBlock] = await this.getEpochRange();

      if (fromBlock >= toBlock) {
        return {
          exists: false,
          currentApprovals: 0,
          requiredApprovals: 0,
        };
      }

      const commitmentKey = this.commitmentKeyService.generateKey(
        fromBlock,
        toBlock,
      );

      const commitmentInfo =
        await this.contractService.getCommitmentInfo(commitmentKey);

      if (!commitmentInfo || commitmentInfo.status === 0) {
        const requiredApprovals =
          await this.contractService.getRequiredApprovals();

        if (!commitmentInfo) {
          ctx.logger.debug(
            `📋 No commitment found for ${fromBlock}-${toBlock}`,
          );
        } else {
          ctx.logger.debug(
            `📋 Commitment found for ${fromBlock}-${toBlock} but status=0 (NONEXISTENT)`,
          );
        }

        return {
          exists: false,
          currentApprovals: 0,
          requiredApprovals,
          fromBlock,
          toBlock,
        };
      }

      const requiredApprovals =
        await this.contractService.getRequiredApprovals();

      ctx.logger.info(
        `📋 Commitment exists for ${fromBlock}-${toBlock}: status=${commitmentInfo.status}, approvals=${commitmentInfo.approvalCount}/${requiredApprovals}`,
      );

      return {
        exists: true,
        currentApprovals: Number(commitmentInfo.approvalCount),
        requiredApprovals,
        fromBlock,
        toBlock,
        status: commitmentInfo.status,
      };
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to check commitment status');
      return {
        exists: false,
        currentApprovals: 0,
        requiredApprovals: 0,
      };
    }
  }

  /**
   * Process new commitment creation
   */
  async processNewCommitment(): Promise<boolean> {
    const ctx = new TaskContext('epoch-processor:new-commitment');

    try {
      const [fromBlock, toBlock] = await this.getEpochRange();

      if (fromBlock >= toBlock) {
        ctx.logger.warn('No new blocks to process for commitment');
        return true;
      }

      ctx.logger.info(
        `🔐 Creating new commitment for blocks ${fromBlock}-${toBlock}`,
      );

      return await this.processApprovalWithMerkleTree(fromBlock, toBlock);
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to create new commitment');
      return false;
    }
  }

  /**
   * Process approval phase - commitment and approval of Merkle root
   */
  async processApproval(): Promise<boolean> {
    try {
      const [fromBlock, toBlock] = await this.getEpochRange();

      if (fromBlock >= toBlock) {
        new TaskContext('approval:warning').logger.warn(
          'No new blocks to process for approval',
        );
        return true;
      }

      new TaskContext('approval:start').logger.info(
        `🔐 Starting approval phase for blocks ${fromBlock}-${toBlock}`,
      );

      // check if we should use Merkle tree distribution
      const useMerkleTree = this.configService.get(
        'rewards.useMerkleTree',
        true,
      );

      if (useMerkleTree) {
        return await this.processApprovalWithMerkleTree(fromBlock, toBlock);
      } else {
        // fallback to legacy batch system
        new TaskContext('approval:legacy').logger.warn(
          'Legacy approval not implemented, using Merkle tree',
        );
        return await this.processApprovalWithMerkleTree(fromBlock, toBlock);
      }
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `Approval processing failed: ${error.message}`,
        error.stack,
      );
      return false;
    }
  }

  /**
   * Process distribution phase - distribute approved epochs using Merkle proofs
   */
  async processDistribution(): Promise<boolean> {
    try {
      const ctx = new TaskContext('distribution:start');
      ctx.logger.debug('🚀 Checking for approved epochs to distribute');

      const committerCheck =
        await this.statelessCoordinator.isCurrentCommitter();

      if (!committerCheck.isCommitter) {
        ctx.logger.info(
          `🚫 Not current committer - skipping distribution (window: ${committerCheck.currentWindow}, reason: ${committerCheck.reason || 'not in window'})`,
        );
        return true;
      }

      ctx.logger.info(
        `✅ We are the current committer - proceeding with distribution check`,
      );

      // Check if there are any approved epochs ready for distribution
      const success = await this.processApprovedEpochs();

      return success;
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `Distribution processing failed: ${error.message}`,
        error.stack,
      );
      return false;
    }
  }

  /**
   * Updated main process method to use Merkle tree distribution (backward compatibility)
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
      // Get distribution status which handles all the logic
      const status = await this.contractService.getDistributionStatus(ctx);

      ctx.logger.info(
        `📊 Distribution status: blocks ${status.nextFromBlock}-${status.nextToBlock}, ` +
          `ready: ${status.isReadyForDistribution}, has commitment: ${status.hasExistingCommitment}`,
      );

      return [status.nextFromBlock, status.nextToBlock];
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `Failed to get epoch range: ${error.message}`,
      );
      return [0, 0];
    }
  }

  /**
   * Process approval of existing commitments (for non-committer bots)
   */
  async processExistingApprovals(): Promise<boolean> {
    try {
      const ctx = new TaskContext('approval:existing');
      ctx.logger.info('📝 Checking for commitments needing approval');

      const approvalCheck =
        await this.statelessCoordinator.checkForPendingApprovals();

      if (!approvalCheck.hasApprovals) {
        ctx.logger.debug('no commitments need approval');
        return true;
      }

      let allSuccess = true;
      for (const commitment of approvalCheck.pendingCommitments) {
        ctx.logger.info(
          `📋 Approving commitment ${commitment.fromBlock}-${commitment.toBlock}`,
        );

        try {
          const success = await this.contractService.approveCommitment(
            commitment.fromBlock,
            commitment.toBlock,
          );

          if (success) {
            ctx.logger.info(
              `✅ Approved commitment ${commitment.fromBlock}-${commitment.toBlock}`,
            );
          } else {
            ctx.logger.error(
              `❌ Failed to approve commitment ${commitment.fromBlock}-${commitment.toBlock}`,
            );
            allSuccess = false;
          }
        } catch (error) {
          ctx.logger.error(
            { error },
            `Failed to approve commitment ${commitment.fromBlock}-${commitment.toBlock}`,
          );
          allSuccess = false;
        }
      }

      return allSuccess;
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `Existing approvals processing failed: ${error.message}`,
        error.stack,
      );
      return false;
    }
  }

  /**
   * Process approval phase with Merkle tree - only commit and approve, no distribution
   */
  private async processApprovalWithMerkleTree(
    fromBlock: number,
    toBlock: number,
  ): Promise<boolean> {
    try {
      const ctx = new TaskContext(`approval:merkle:${fromBlock}-${toBlock}`);
      ctx.logger.info(
        `🌳 Processing approval with Merkle tree for epoch ${fromBlock}-${toBlock}`,
      );

      const commitmentKey = this.commitmentKeyService.generateKey(
        fromBlock,
        toBlock,
      );

      try {
        const existingCommitment =
          await this.contractService.getCommitmentInfo(commitmentKey);

        if (existingCommitment && existingCommitment.status !== 0) {
          // 0 = INACTIVE
          ctx.logger.info(
            `📋 Commitment already exists for ${fromBlock}-${toBlock}, status: ${existingCommitment.status}`,
          );

          const committerCheck =
            await this.statelessCoordinator.isCurrentCommitter();
          if (committerCheck.isCommitter) {
            ctx.logger.info(
              `🎯 Bot is committer - existing commitment should be handled by distribution phase`,
            );
            return true;
          } else {
            ctx.logger.info(
              `👀 Bot is not committer - checking if commitment needs approval`,
            );
            if (
              existingCommitment.status === 1 &&
              existingCommitment.approvalCount === 0n
            ) {
              ctx.logger.info(`📝 Commitment needs approval - approving now`);
              const approveSuccess =
                await this.contractService.approveCommitment(
                  fromBlock,
                  toBlock,
                );
              return approveSuccess;
            } else {
              ctx.logger.info(
                `✅ Commitment already approved or in different state (approvals: ${existingCommitment.approvalCount})`,
              );
              return true;
            }
          }
        }
      } catch (error) {
        ctx.logger.debug(
          `Could not check existing commitment: ${error.message} - proceeding with new commit check`,
        );
      }

      const committerCheck =
        await this.statelessCoordinator.isCurrentCommitter();
      if (!committerCheck.isCommitter) {
        ctx.logger.info(
          `👀 No commitment exists and bot is not committer - nothing to do`,
        );
        return true;
      }

      ctx.logger.info(
        `🎯 Bot is committer - creating new commitment for ${fromBlock}-${toBlock}`,
      );

      const eligibilityCheck =
        await this.statelessCoordinator.checkCommitEligibility();

      if (!eligibilityCheck.eligible) {
        ctx.logger.info(
          `🚫 skipping commit - ${eligibilityCheck.reason || 'not eligible'} (${eligibilityCheck.blocksLeft} blocks left in window)`,
        );
        ctx.logger.info(
          `   next window starts at block ${eligibilityCheck.windowInfo.nextWindowStart}`,
        );
        return true;
      }

      ctx.logger.info(
        `✅ commit eligibility confirmed - ${eligibilityCheck.blocksLeft} blocks left in window (safe with buffer)`,
      );

      const result =
        await this.rewardsCalculatorService.calculateRewardsDetailed(
          ctx,
          fromBlock,
          toBlock,
          true, // skip signature validation
        );

      if (result.workers.length === 0) {
        ctx.logger.warn('No workers found for approval');
        return true;
      }

      // Generate Merkle tree
      const merkleTree = await this.distributionService.generateMerkleTreeOnly(
        result.workers,
        50,
      );

      // Commit root only
      const commitResult = await this.distributionService.commitRootOnly(
        fromBlock,
        toBlock,
        merkleTree.root,
        merkleTree.totalBatches,
        '',
        result.workers,
        merkleTree,
        50,
      );

      if (!commitResult.success) {
        ctx.logger.error('Failed to commit Merkle root');
        return false;
      }

      try {
        const s3Url = await this.distributionService.uploadEpochDataToS3(
          fromBlock,
          toBlock,
          merkleTree.root,
          merkleTree.totalBatches,
          result.workers,
          merkleTree,
          50,
        );
        ctx.logger.info(`✅ Epoch data uploaded to S3 after commit: ${s3Url}`);
      } catch (e) {
        ctx.logger.error(
          { error: e },
          `❌ Failed to upload epoch data to S3 after commit: ${e.message}`,
        );
      }

      ctx.logger.info(
        `✅ Approval phase completed for ${fromBlock}-${toBlock}`,
      );
      ctx.logger.info(`   Merkle root: ${merkleTree.root}`);
      ctx.logger.info(`   Total batches: ${merkleTree.totalBatches}`);

      return true;
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `Failed to process approval with Merkle tree: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Process approved epochs - find committed roots and distribute batches
   */
  private async processApprovedEpochs(): Promise<boolean> {
    try {
      const ctx = new TaskContext('distribution:process-approved');

      const approvedEpochs =
        await this.distributionService.getApprovedEpochsForDistribution();

      if (approvedEpochs.length === 0) {
        ctx.logger.debug('No approved epochs ready for distribution');
        return true;
      }

      let allSuccess = true;
      for (const epoch of approvedEpochs) {
        ctx.logger.info(
          `🚀 Checking if we should distribute epoch ${epoch.fromBlock}-${epoch.toBlock}`,
        );

        // Double-check we're still the committer (in case window changed)
        const currentCommitterCheck =
          await this.statelessCoordinator.isCurrentCommitter();
        if (!currentCommitterCheck.isCommitter) {
          ctx.logger.warn(
            `⚠️ No longer the current committer - stopping distribution (was processing ${epoch.fromBlock}-${epoch.toBlock})`,
          );
          break; // Stop processing further epochs
        }

        const shouldStart =
          await this.statelessCoordinator.shouldStartDistribution(
            epoch.fromBlock,
            epoch.toBlock,
          );

        if (!shouldStart) {
          ctx.logger.info(
            `🚫 Skipping epoch ${epoch.fromBlock}-${epoch.toBlock} - another bot is distributing it`,
          );
          continue;
        }

        ctx.logger.info(
          `🚀 Starting distribution for epoch ${epoch.fromBlock}-${epoch.toBlock}`,
        );

        const success = await this.distributionService.distributeApprovedEpoch(
          epoch.fromBlock,
          epoch.toBlock,
          epoch.merkleRoot,
        );

        if (!success) {
          ctx.logger.error(
            `Failed to distribute epoch ${epoch.fromBlock}-${epoch.toBlock}`,
          );
          allSuccess = false;
        } else {
          ctx.logger.info(
            `✅ Successfully distributed epoch ${epoch.fromBlock}-${epoch.toBlock}`,
          );
        }
      }

      return allSuccess;
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `Failed to process approved epochs: ${error.message}`,
      );
      return false;
    }
  }
}
