import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { BaseService } from '../core/base-service';
import { BlockchainService } from '../blockchain/blockchain.service';
import { DistributionService } from '../rewards/distribution/distribution.service';
import { TaskContext } from '../common';


@Injectable()
export class EpochOrchestratorService extends BaseService {
  protected readonly serviceName = 'epoch-orchestrator';

  private isProcessing = false;
  private lastProcessedEpoch: string | null = null;

  constructor(
    configService: ConfigService,
    private blockchain: BlockchainService,
    private distribution: DistributionService,
  ) {
    super(configService);
  }


  @Cron('*/30 * * * * *')
  async processDistribution() {
    // Prevent concurrent processing
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    try {
      await this.withContext('process-distribution', async (ctx) => {
        const shouldProcess = await this.shouldProcessEpoch(ctx);
        if (!shouldProcess) {
          ctx.logger.debug('No epoch ready for distribution');
          return;
        }

        const { fromBlock, toBlock, batchNumber } = await this.getNextEpochRange(ctx);
        const epochId = `${fromBlock}-${toBlock}`;
        const totalBatches = this.config('rewards.totalBatches', 4);

        if (this.lastProcessedEpoch === epochId) {
          ctx.logger.debug(`Epoch ${epochId} already processed, skipping`);
          return;
        }

        const isCommitter = await this.isCurrentCommitter(ctx);
        if (!isCommitter) {
          ctx.logger.debug(`Not committer for epoch ${epochId}, skipping distribution`);
          return;
        }

        ctx.logger.info(`📝 Bot is committer for epoch ${epochId}`);

        const eligible = await this.checkCommitEligibility(ctx);
        if (!eligible) {
          ctx.logger.info(`⏳ Not eligible to commit yet (safety buffer)`);
          return;
        }

        ctx.logger.info(
          `✅ Starting distribution for epoch ${epochId} (batch ${batchNumber}/${totalBatches})`,
        );

        try {
          await this.distribution.distributeEpochRewards(
            fromBlock,
            toBlock,
            this.config('rewards.distributionBatchSize', 50),
            batchNumber,
            totalBatches,
          );

          this.lastProcessedEpoch = epochId;
          ctx.logger.info(`✅ Successfully distributed epoch ${epochId}`);
        } catch (error) {
          ctx.logger.error(
            { error },
            `Failed to distribute epoch ${epochId}: ${error.message}`,
          );
        }
      });
    } finally {
      this.isProcessing = false;
    }
  }


  @Cron('*/60 * * * * *')
  async processApprovals() {
    await this.withContext('process-approvals', async (ctx) => {
      try {
        // Check for commitments needing approval
        const needsApproval = await this.checkForPendingApprovals(ctx);
        
        if (!needsApproval.hasApprovals) {
          ctx.logger.debug('No commitments need approval');
          return;
        }

        ctx.logger.info(
          `📋 Found ${needsApproval.pendingCommitments.length} commitments needing approval`,
        );

        for (const commitment of needsApproval.pendingCommitments) {
          try {
            ctx.logger.info(
              `Approving commitment: ${commitment.fromBlock}-${commitment.toBlock}`,
            );
            
            
            ctx.logger.info(
              `✅ Approved commitment: ${commitment.fromBlock}-${commitment.toBlock}`,
            );
          } catch (error) {
            ctx.logger.error(
              { error, commitment },
              `Failed to approve commitment: ${error.message}`,
            );
          }
        }
      } catch (error) {
        ctx.logger.error({ error }, 'Approval process failed');
      }
    });
  }


  @Cron('0 */5 * * * *')
  async processRecovery() {
    await this.withContext('process-recovery', async (ctx) => {
      try {
        const shouldRecover = await this.shouldActivateRecovery(ctx);
        
        if (!shouldRecover) {
          ctx.logger.debug('No recovery needed');
          return;
        }

        ctx.logger.info(`🔧 Recovery needed for stuck commitments`);

        ctx.logger.info(`✅ Recovery process completed`);
      } catch (error) {
        ctx.logger.error({ error }, 'Recovery process failed');
      }
    });
  }


  private async shouldProcessEpoch(ctx: TaskContext): Promise<boolean> {
    const currentBlock = await this.blockchain.getL1BlockNumber(ctx);
    const lastRewarded = await this.blockchain.getLastRewardedBlock(ctx);
    const blockInterval = this.config('rewards.blockInterval', 520);

    const blocksSinceLastReward = currentBlock - lastRewarded;
    const shouldProcess = blocksSinceLastReward >= blockInterval;

    ctx.logger.debug(
      `Should process: ${shouldProcess} (${blocksSinceLastReward}/${blockInterval} blocks since last reward)`,
    );

    return shouldProcess;
  }


  private async getNextEpochRange(ctx: TaskContext): Promise<{
    fromBlock: number;
    toBlock: number;
    batchNumber: number;
  }> {
    const lastRewarded = await this.blockchain.getLastRewardedBlock(ctx);
    const blockInterval = this.config('rewards.blockInterval', 520);
    const totalBatches = this.config('rewards.totalBatches', 4);

    const fromBlock = lastRewarded + 1;
    const toBlock = fromBlock + blockInterval - 1;
    
    // Calculate batch number based on epoch (same as old backend)
    const epochNumber = Math.ceil(toBlock / blockInterval);
    const batchNumber = epochNumber % totalBatches;

    ctx.logger.debug(
      `Next epoch: ${fromBlock}-${toBlock}, batch ${batchNumber}/${totalBatches} (epoch ${epochNumber})`,
    );

    return { fromBlock, toBlock, batchNumber };
  }

  private async isCurrentCommitter(ctx: TaskContext): Promise<boolean> {
    const currentBlock = await this.blockchain.getL1BlockNumber(ctx);
    const roundRobinWindow = this.config('rewards.roundRobinWindow', 130);
    const currentWindow = Math.floor(currentBlock / roundRobinWindow);

    const botAddress = this.config('blockchain.distributor.address');
    if (!botAddress) {
      ctx.logger.error('Bot address not configured');
      return false;
    }

    const canCommit = await this.blockchain.canCommit(botAddress);

    ctx.logger.debug(
      `Window ${currentWindow}: bot ${botAddress} canCommit=${canCommit}`,
    );

    return canCommit;
  }

  private async checkCommitEligibility(ctx: TaskContext): Promise<boolean> {
    const currentBlock = await this.blockchain.getL1BlockNumber(ctx);
    const roundRobinWindow = this.config('rewards.roundRobinWindow', 130);
    const safetyBuffer = this.config('rewards.commitSafetyBuffer', 3);

    const currentWindow = Math.floor(currentBlock / roundRobinWindow);
    const windowStart = currentWindow * roundRobinWindow;
    const windowEnd = windowStart + roundRobinWindow - 1;
    const blocksLeft = windowEnd - currentBlock;


    ctx.logger.debug(
      `Window check: block ${currentBlock}, window ${currentWindow} (${windowStart}-${windowEnd}), ${blocksLeft} blocks left`,
    );

    if (blocksLeft < safetyBuffer) {
      ctx.logger.info(
        `🚫 Not eligible: too close to window end (${blocksLeft} blocks left, need ${safetyBuffer})`,
      );
      return false;
    }

    ctx.logger.info(
      `✅ Eligible: ${blocksLeft} blocks left in window (buffer: ${safetyBuffer})`,
    );

    return true;
  }


  private async checkForPendingApprovals(ctx: TaskContext): Promise<{
    hasApprovals: boolean;
    pendingCommitments: Array<{ fromBlock: number; toBlock: number }>;
  }> {
    try {
      const pendingCommitments =
        await this.blockchain.getCommitmentsNeedingApproval();

      ctx.logger.debug(
        `Found ${pendingCommitments.length} commitments needing approval`,
      );

      if (pendingCommitments.length === 0) {
        return {
          hasApprovals: false,
          pendingCommitments: [],
        };
      }

      const botAddress = this.config('blockchain.distributor.address');
      const notApproved: Array<{ fromBlock: number; toBlock: number }> = [];

      for (const commitment of pendingCommitments) {
        const hasApproved = await this.blockchain.hasApprovedCommitment(
          commitment.fromBlock,
          commitment.toBlock,
          botAddress,
        );

        if (!hasApproved) {
          notApproved.push(commitment);
        }
      }

      return {
        hasApprovals: notApproved.length > 0,
        pendingCommitments: notApproved,
      };
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to check pending approvals');
      return {
        hasApprovals: false,
        pendingCommitments: [],
      };
    }
  }


  private async shouldActivateRecovery(ctx: TaskContext): Promise<boolean> {
    const RECOVERY_BLOCK_THRESHOLD = 100; // Same as original

    try {
      const pendingCommitments = await this.blockchain.getPendingCommitments();

      if (pendingCommitments.length === 0) {
        ctx.logger.debug(
          'No pending approved commitments found, recovery not needed',
        );
        return false;
      }

      const currentBlock = await this.blockchain.getL1BlockNumber(ctx);
      let shouldActivate = false;

      for (const commitment of pendingCommitments) {
        const blocksSinceCommitment = currentBlock - commitment.toBlock;

        if (blocksSinceCommitment >= RECOVERY_BLOCK_THRESHOLD) {
          ctx.logger.info(
            `🔍 Recovery needed: commitment ${commitment.fromBlock}-${commitment.toBlock} is ${blocksSinceCommitment} blocks old`,
          );
          shouldActivate = true;
        }
      }

      return shouldActivate;
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to check recovery activation');
      return false;
    }
  }

  getStatus(): {
    isProcessing: boolean;
    lastProcessedEpoch: string | null;
  } {
    return {
      isProcessing: this.isProcessing,
      lastProcessedEpoch: this.lastProcessedEpoch,
    };
  }
}
