import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RewardsCalculatorService } from '../rewards/calculation/rewards-calculator.service';
import { ContractService } from '../blockchain/contract.service';
import { StatelessCoordinatorService } from './stateless-coordinator.service';
import { DistributionService } from '../rewards/distribution/distribution.service';
import { DistributionRecoveryService } from '../rewards/distribution/distribution-recovery.service';
import { TaskContext, CommitmentKeyService } from '../common';

@Injectable()
export class EpochProcessorService implements OnModuleInit {
  private readonly enableRecoveryCheck: boolean;

  constructor(
    private configService: ConfigService,
    private rewardsCalculatorService: RewardsCalculatorService,
    private contractService: ContractService,
    private distributionService: DistributionService,
    private recoveryService: DistributionRecoveryService,
    private statelessCoordinator: StatelessCoordinatorService,
    private commitmentKeyService: CommitmentKeyService,
  ) {
    this.enableRecoveryCheck = this.configService.get(
      'rewards.enableStartupRecoveryCheck',
      true,
    );
  }

  async onModuleInit() {
    if (!this.enableRecoveryCheck) return;

    const ctx = new TaskContext('startup:recovery-check');

    try {
      ctx.logger.info('Checking for interrupted distributions on startup...');

      let lastBlockRewarded: number;
      try {
        lastBlockRewarded =
          await this.contractService.getLastBlockRewarded(ctx);
      } catch (error: any) {
        if (
          error.message?.includes('ContractFunctionExecutionError') ||
          error.message?.includes('lastBlockRewarded') ||
          error.cause?.message?.includes('reverted')
        ) {
          ctx.logger.warn(
            'Contract does not support lastBlockRewarded. Skipping recovery check.',
          );
          return;
        }
        throw error;
      }

      if (lastBlockRewarded === 0) {
        ctx.logger.info('No previous distributions found');
        return;
      }

      ctx.logger.info(`Last block rewarded: ${lastBlockRewarded}`);

      // Check last commitment status
      let lastCommitmentKey: string;
      try {
        lastCommitmentKey =
          await this.contractService.getLastCommitmentKey(ctx);
      } catch (error) {
        lastCommitmentKey =
          '0x0000000000000000000000000000000000000000000000000000000000000000';
      }

      const zeroKey =
        '0x0000000000000000000000000000000000000000000000000000000000000000';

      if (lastCommitmentKey !== zeroKey) {
        try {
          const pendingInfo =
            await this.recoveryService.checkPendingDistributions(ctx);

          if (pendingInfo.lastCommitment) {
            const { fromBlock, toBlock, status, processedBatches, totalBatches } =
              pendingInfo.lastCommitment;

            if (status === 1) {
              ctx.logger.warn(
                `Active commitment for blocks ${fromBlock}-${toBlock}: ${processedBatches}/${totalBatches} batches. Use /admin/distribute to resume.`,
              );
            } else if (status === 2) {
              ctx.logger.info(
                `Last commitment (${fromBlock}-${toBlock}) is completed`,
              );
            }
          }
        } catch (error) {
          ctx.logger.debug('Error checking last commitment status');
        }
      }

      // Check for other pending distributions
      const pendingInfo =
        await this.recoveryService.checkPendingDistributions(ctx);

      if (pendingInfo.pendingRanges.length > 0) {
        ctx.logger.warn(
          `${pendingInfo.pendingRanges.length} pending distribution ranges found. Use /admin/distribute to resume.`,
        );
      } else if (
        !pendingInfo.lastCommitment ||
        pendingInfo.lastCommitment.status === 2
      ) {
        ctx.logger.info('No interrupted distributions found');
      }

      const currentL1Block =
        await this.contractService.getL1BlockNumber(ctx);
      const epochLength = await this.contractService.getEpochLength(ctx);
      const blocksSinceLastReward = currentL1Block - lastBlockRewarded;

      if (blocksSinceLastReward > epochLength) {
        const missedEpochs = Math.floor(blocksSinceLastReward / epochLength);
        ctx.logger.warn(
          `${missedEpochs} epochs missed since last distribution (${blocksSinceLastReward} blocks)`,
        );
      } else {
        ctx.logger.info(`${blocksSinceLastReward} blocks since last reward`);
      }
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to complete startup recovery check');
    }
  }

  /**
   * Check if commitment exists for current epoch and get approval status.
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
        return { exists: false, currentApprovals: 0, requiredApprovals: 0 };
      }

      const commitmentKey = this.commitmentKeyService.generateKey(
        fromBlock,
        toBlock,
      );

      const commitmentInfo =
        await this.contractService.getCommitmentInfo(commitmentKey);

      const requiredApprovals =
        await this.contractService.getRequiredApprovals();

      if (!commitmentInfo || commitmentInfo.status === 0) {
        return {
          exists: false,
          currentApprovals: 0,
          requiredApprovals,
          fromBlock,
          toBlock,
        };
      }

      ctx.logger.info(
        `Commitment exists for ${fromBlock}-${toBlock}: status=${commitmentInfo.status}, approvals=${commitmentInfo.approvalCount}/${requiredApprovals}`,
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
      return { exists: false, currentApprovals: 0, requiredApprovals: 0 };
    }
  }

  /**
   * Create a new commitment for the current epoch range.
   */
  async processNewCommitment(): Promise<boolean> {
    const ctx = new TaskContext('epoch-processor:new-commitment');

    try {
      const [fromBlock, toBlock] = await this.getEpochRange();

      if (fromBlock >= toBlock) {
        ctx.logger.warn('No new blocks to process for commitment');
        return true;
      }

      ctx.logger.info(`Creating new commitment for blocks ${fromBlock}-${toBlock}`);
      return await this.processApprovalWithMerkleTree(fromBlock, toBlock);
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to create new commitment');
      return false;
    }
  }

  /**
   * Process approval phase - commitment and approval of Merkle root.
   */
  async processApproval(): Promise<boolean> {
    const ctx = new TaskContext('epoch-processor:approval');

    try {
      const [fromBlock, toBlock] = await this.getEpochRange();

      if (fromBlock >= toBlock) {
        ctx.logger.warn('No new blocks to process for approval');
        return true;
      }

      ctx.logger.info(`Starting approval phase for blocks ${fromBlock}-${toBlock}`);
      return await this.processApprovalWithMerkleTree(fromBlock, toBlock);
    } catch (error) {
      ctx.logger.error({ error }, 'Approval processing failed');
      return false;
    }
  }

  /**
   * Process distribution phase - distribute approved epochs using Merkle proofs.
   */
  async processDistribution(): Promise<boolean> {
    const ctx = new TaskContext('epoch-processor:distribution');

    try {
      const committerCheck =
        await this.statelessCoordinator.isCurrentCommitter();

      if (!committerCheck.isCommitter) {
        ctx.logger.info(
          `Not current committer - skipping distribution (window: ${committerCheck.currentWindow})`,
        );
        return true;
      }

      return await this.processApprovedEpochs();
    } catch (error) {
      ctx.logger.error({ error }, 'Distribution processing failed');
      return false;
    }
  }

  /**
   * Process epoch using Merkle tree distribution.
   */
  async processEpoch(): Promise<boolean> {
    const ctx = new TaskContext('epoch-processor:process-epoch');

    try {
      const [fromBlock, toBlock] = await this.getEpochRange();

      if (fromBlock >= toBlock) {
        ctx.logger.warn('No new blocks to process');
        return true;
      }

      return await this.processEpochWithMerkleTree(fromBlock, toBlock);
    } catch (error) {
      ctx.logger.error({ error }, 'Epoch processing failed');
      return false;
    }
  }

  /**
   * Process approval of existing commitments (for non-committer bots).
   */
  async processExistingApprovals(): Promise<boolean> {
    const ctx = new TaskContext('epoch-processor:existing-approvals');

    try {
      const approvalCheck =
        await this.statelessCoordinator.checkForPendingApprovals();

      if (!approvalCheck.hasApprovals) {
        ctx.logger.debug('No commitments need approval');
        return true;
      }

      let allSuccess = true;
      for (const commitment of approvalCheck.pendingCommitments) {
        try {
          const success = await this.contractService.approveCommitment(
            commitment.fromBlock,
            commitment.toBlock,
          );

          if (success) {
            ctx.logger.info(
              `Approved commitment ${commitment.fromBlock}-${commitment.toBlock}`,
            );
          } else {
            ctx.logger.error(
              `Failed to approve commitment ${commitment.fromBlock}-${commitment.toBlock}`,
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
      ctx.logger.error({ error }, 'Existing approvals processing failed');
      return false;
    }
  }

  private async getEpochRange(): Promise<[number, number]> {
    const ctx = new TaskContext('epoch-processor:get-epoch-range');
    try {
      const status = await this.contractService.getDistributionStatus(ctx);

      ctx.logger.info(
        `Distribution status: blocks ${status.nextFromBlock}-${status.nextToBlock}, ` +
          `ready: ${status.isReadyForDistribution}, hasCommitment: ${status.hasExistingCommitment}`,
      );

      return [status.nextFromBlock, status.nextToBlock];
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to get epoch range');
      return [0, 0];
    }
  }

  private async processEpochWithMerkleTree(
    fromBlock: number,
    toBlock: number,
  ): Promise<boolean> {
    const ctx = new TaskContext(`epoch-processor:merkle-distribution:${fromBlock}-${toBlock}`);

    try {
      const distributionStatus =
        await this.distributionService.distributeEpochRewards(
          fromBlock,
          toBlock,
          this.distributionService.distributionBatchSize,
        );

      if (distributionStatus.status === 'completed') {
        ctx.logger.info(
          `Merkle distribution completed: ${distributionStatus.totalWorkers} workers, ${distributionStatus.totalBatches} batches, ${Number(distributionStatus.totalRewards) / 1e18} SQD`,
        );
        return true;
      } else {
        ctx.logger.error(`Merkle distribution failed: ${distributionStatus.error}`);
        return false;
      }
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to process epoch with Merkle tree');
      return false;
    }
  }

  private async processApprovalWithMerkleTree(
    fromBlock: number,
    toBlock: number,
  ): Promise<boolean> {
    const ctx = new TaskContext(`epoch-processor:approval-merkle:${fromBlock}-${toBlock}`);

    try {
      const commitmentKey = this.commitmentKeyService.generateKey(
        fromBlock,
        toBlock,
      );

      // Check if commitment already exists
      try {
        const existingCommitment =
          await this.contractService.getCommitmentInfo(commitmentKey);

        if (existingCommitment && existingCommitment.status !== 0) {
          ctx.logger.info(
            `Commitment already exists for ${fromBlock}-${toBlock}, status: ${existingCommitment.status}`,
          );

          const committerCheck =
            await this.statelessCoordinator.isCurrentCommitter();

          if (committerCheck.isCommitter) {
            return true; // Handled by distribution phase
          }

          // Non-committer: approve if needed
          if (
            existingCommitment.status === 1 &&
            existingCommitment.approvalCount === 0n
          ) {
            ctx.logger.info('Commitment needs approval - approving');
            return await this.contractService.approveCommitment(
              fromBlock,
              toBlock,
            );
          }
          return true;
        }
      } catch (error) {
        ctx.logger.debug('Could not check existing commitment - proceeding');
      }

      // No existing commitment - only committer should create one
      const committerCheck =
        await this.statelessCoordinator.isCurrentCommitter();
      if (!committerCheck.isCommitter) {
        return true; // Nothing to do
      }

      const eligibilityCheck =
        await this.statelessCoordinator.checkCommitEligibility();

      if (!eligibilityCheck.eligible) {
        ctx.logger.info(
          `Skipping commit: ${eligibilityCheck.reason || 'not eligible'}`,
        );
        return true;
      }

      ctx.logger.info(
        `Commit eligible - ${eligibilityCheck.blocksLeft} blocks left in window`,
      );

      const result =
        await this.rewardsCalculatorService.calculateRewardsDetailed(
          ctx,
          fromBlock,
          toBlock,
          true,
        );

      if (result.workers.length === 0) {
        ctx.logger.warn('No workers found for approval');
        return true;
      }

      const batchSize = this.distributionService.distributionBatchSize;
      const merkleTree = await this.distributionService.generateMerkleTreeOnly(
        result.workers,
        batchSize,
      );

      const commitResult = await this.distributionService.commitRootOnly(
        fromBlock,
        toBlock,
        merkleTree.root,
        merkleTree.totalBatches,
        '',
        result.workers,
        merkleTree,
        batchSize,
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
          batchSize,
        );
        ctx.logger.info(`Epoch data uploaded to S3: ${s3Url}`);
      } catch (e) {
        ctx.logger.error({ error: e }, 'Failed to upload epoch data to S3');
      }

      ctx.logger.info(
        `Approval completed for ${fromBlock}-${toBlock}: root=${merkleTree.root}, batches=${merkleTree.totalBatches}`,
      );

      return true;
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to process approval with Merkle tree');
      return false;
    }
  }

  private async processApprovedEpochs(): Promise<boolean> {
    const ctx = new TaskContext('epoch-processor:process-approved');

    try {
      const approvedEpochs =
        await this.distributionService.getApprovedEpochsForDistribution();

      if (approvedEpochs.length === 0) {
        ctx.logger.debug('No approved epochs ready for distribution');
        return true;
      }

      let allSuccess = true;
      for (const epoch of approvedEpochs) {
        // Re-check committer status in case window changed
        const currentCommitterCheck =
          await this.statelessCoordinator.isCurrentCommitter();
        if (!currentCommitterCheck.isCommitter) {
          ctx.logger.warn(
            `No longer current committer - stopping distribution`,
          );
          break;
        }

        const shouldStart =
          await this.statelessCoordinator.shouldStartDistribution(
            epoch.fromBlock,
            epoch.toBlock,
          );

        if (!shouldStart) {
          ctx.logger.info(
            `Skipping epoch ${epoch.fromBlock}-${epoch.toBlock} - another bot is distributing`,
          );
          continue;
        }

        ctx.logger.info(
          `Starting distribution for epoch ${epoch.fromBlock}-${epoch.toBlock}`,
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
            `Distributed epoch ${epoch.fromBlock}-${epoch.toBlock}`,
          );
        }
      }

      return allSuccess;
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to process approved epochs');
      return false;
    }
  }
}
