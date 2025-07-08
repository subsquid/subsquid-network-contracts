import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Web3Service } from '../blockchain/web3.service';
import { ContractService } from '../blockchain/contract.service';
import { DistributionService } from '../rewards/distribution/distribution.service';
import { RewardsCalculatorService } from '../rewards/calculation/rewards-calculator.service';
import { MetricsLoggerService } from '../common/metrics-logger.service';
import { Context, TaskContext } from '../common';

export interface BlockSchedulerStatus {
  enabled: boolean;
  blockInterval: number;
  lastCheckedBlock: number;
  isProcessing: boolean;
  currentPhase?: 'commit' | 'approve' | 'distribute' | 'idle';
  lastCommittedRange?: { fromBlock: number; toBlock: number };
  pendingApprovals?: number;
  requiredApprovals?: number;
}

@Injectable()
export class BlockSchedulerService {
  private readonly blockInterval: number;
  private readonly enableAutoDistribution: boolean;
  private readonly confirmationBlocks: number;
  private lastCheckedBlock = 0;
  private isProcessing = false;
  private currentPhase: 'commit' | 'approve' | 'distribute' | 'idle' = 'idle';
  private lastCommittedRange?: { fromBlock: number; toBlock: number };
  private logger: Logger;

  constructor(
    private configService: ConfigService,
    private web3Service: Web3Service,
    private contractService: ContractService,
    private distributionService: DistributionService,
    private rewardsCalculatorService: RewardsCalculatorService,
    private metricsLoggerService: MetricsLoggerService,
  ) {
    this.blockInterval =
      this.configService.get('rewards.distributionBlockInterval') || 600;
    this.enableAutoDistribution =
      this.configService.get('rewards.enableAutoDistribution') === 'true';
    this.confirmationBlocks =
      this.configService.get('blockchain.epochConfirmationBlocks') || 150;

    const ctx = new TaskContext('block-scheduler-init');
    this.logger = ctx.logger;

    ctx.logger.debug(`🔄 Block Scheduler initialized:`);
    ctx.logger.debug(
      `   - Auto distribution: ${this.enableAutoDistribution ? '✅' : '❌'}`,
    );
    ctx.logger.debug(`   - Block interval: ${this.blockInterval} blocks`);
    ctx.logger.debug(`   - Confirmation blocks: ${this.confirmationBlocks}`);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async checkBlockInterval() {
    if (!this.enableAutoDistribution || this.isProcessing) {
      return;
    }
    const ctx = new TaskContext('block-scheduler:check');
    try {
      await this.processBlockInterval(ctx);
    } catch (error) {
      ctx.logger.error({ error }, `Block interval check failed`);
    }
  }

  private async processBlockInterval(ctx: Context): Promise<void> {
    this.isProcessing = true;
    this.currentPhase = 'idle';

    try {
      const currentBlock = await this.web3Service.getL1BlockNumber(ctx);
      this.lastCheckedBlock = currentBlock;

      const commitRange = await this.getCommitRange(ctx);
      if (commitRange.fromBlock > 0 && commitRange.toBlock > 0) {
        ctx.logger.debug(
          `🚀 Block interval reached! Processing range ${commitRange.fromBlock}-${commitRange.toBlock}`,
        );

        await this.processCommitPhase(
          ctx,
          commitRange.fromBlock,
          commitRange.toBlock,
        );

        await this.processApprovalPhase(
          ctx,
          commitRange.fromBlock,
          commitRange.toBlock,
        );

        await this.processDistributionPhase(
          ctx,
          commitRange.fromBlock,
          commitRange.toBlock,
        );

        ctx.logger.debug(
          `✅ Block-triggered workflow completed for ${commitRange.fromBlock}-${commitRange.toBlock}`,
        );
      } else {
        const lastRewardedBlock =
          await this.contractService.getLastRewardedBlock(ctx);
        const blocksSinceLastReward = currentBlock - lastRewardedBlock;

        ctx.logger.debug(
          `📊 Block status: current=${currentBlock}, lastRewarded=${lastRewardedBlock}, gap=${blocksSinceLastReward}/${this.blockInterval}`,
        );

        if (blocksSinceLastReward < this.blockInterval) {
          ctx.logger.debug(
            `⏳ Waiting for more blocks (${this.blockInterval - blocksSinceLastReward} remaining)`,
          );
        }
      }
    } catch (error) {
      ctx.logger.error({ error }, `Block interval processing failed`);
      this.currentPhase = 'idle';
    } finally {
      this.isProcessing = false;
      this.currentPhase = 'idle';
    }
  }

  private async processCommitPhase(
    ctx: Context,
    fromBlock: number,
    toBlock: number,
  ): Promise<void> {
    try {
      this.currentPhase = 'commit';
      ctx.logger.debug(
        `📝 Phase 1: Committing Merkle root for ${fromBlock}-${toBlock}`,
      );

      const isCommitted = await this.contractService.isCommitted(
        fromBlock,
        toBlock,
      );
      if (isCommitted) {
        ctx.logger.debug(`✅ Range ${fromBlock}-${toBlock} already committed`);
        this.lastCommittedRange = { fromBlock, toBlock };
        return;
      }

      const distributorAddress = this.configService.get(
        'blockchain.distributor.address',
      );
      if (!distributorAddress) {
        throw new Error('Distributor address not configured');
      }

      const canCommit =
        await this.contractService.canCommit(distributorAddress);
      if (!canCommit) {
        ctx.logger.warn(
          `⚠️  Cannot commit right now (not our turn in round-robin)`,
        );
        return;
      }

      ctx.logger.debug(`🧮 Calculating rewards for ${fromBlock}-${toBlock}...`);

      const skipSignatureValidation =
        this.configService.get('rewards.skipSignatureValidation') || false;
      const calculationResult =
        await this.rewardsCalculatorService.calculateRewardsDetailed(
          ctx,
          fromBlock,
          toBlock,
          skipSignatureValidation,
        );

      const workers = calculationResult.workers;

      if (workers.length === 0) {
        ctx.logger.warn(
          `⚠️  No workers found for range ${fromBlock}-${toBlock}, skipping commit`,
        );
        return;
      }

      // generate Merkle tree using the MerkleTreeService directly
      const merkleTree = await this.distributionService[
        'merkleTreeService'
      ].generateMerkleTree(workers, 50);

      // commit the root to contract
      ctx.logger.debug(
        `📤 Committing Merkle root ${merkleTree.root} with ${merkleTree.totalBatches} batches...`,
      );

      const txHash = await this.contractService.commitRoot(
        fromBlock,
        toBlock,
        merkleTree.root as `0x${string}`,
        merkleTree.totalBatches,
        `ipfs://rewards-${fromBlock}-${toBlock}`,
      );

      if (txHash) {
        ctx.logger.debug(`✅ Committed successfully: ${txHash}`);
        this.lastCommittedRange = { fromBlock, toBlock };
      } else {
        throw new Error('Commit transaction failed');
      }
    } catch (error) {
      ctx.logger.error({ error }, `❌ Commit phase failed`);
      throw error;
    }
  }

  private async processApprovalPhase(
    ctx: Context,
    fromBlock: number,
    toBlock: number,
  ): Promise<void> {
    try {
      this.currentPhase = 'approve';
      ctx.logger.debug(
        `✅ Phase 2: Checking approvals for ${fromBlock}-${toBlock}`,
      );

      const latestCommitment = await this.contractService.getLatestCommitment();

      if (
        !latestCommitment ||
        Number(latestCommitment.fromBlock) !== fromBlock ||
        Number(latestCommitment.toBlock) !== toBlock
      ) {
        throw new Error('No matching commitment found');
      }

      const requiredApprovals = 1; // TODO: get from contract configuration
      const currentApprovals = Number(latestCommitment.approvalCount);

      ctx.logger.debug(
        `📊 Approval status: ${currentApprovals}/${requiredApprovals} required`,
      );

      if (currentApprovals < requiredApprovals) {
        // if we haven't approved yet, approve now
        const distributorAddress = this.configService.get(
          'blockchain.distributor.address',
        );

        ctx.logger.debug(
          `📝 Approving commitment for ${fromBlock}-${toBlock}...`,
        );
        const txHash = await this.contractService.approveRoot(
          fromBlock,
          toBlock,
        );

        if (txHash) {
          ctx.logger.debug(`✅ Approved successfully: ${txHash}`);
        } else {
          ctx.logger.warn(`⚠️  Approval may have failed or was already done`);
        }
      } else {
        ctx.logger.debug(`✅ Sufficient approvals already received`);
      }
    } catch (error) {
      ctx.logger.error({ error }, `❌ Approval phase failed`);
      throw error;
    }
  }

  private async processDistributionPhase(
    ctx: Context,
    fromBlock: number,
    toBlock: number,
  ): Promise<void> {
    const epochStart = new Date(); // approximation
    const epochEnd = new Date();
    let isCommitSuccess = false;
    const commitTxHash = '';
    let commitErrorMessage = '';

    try {
      this.currentPhase = 'distribute';
      ctx.logger.debug(
        `💰 Phase 3: Distributing rewards for ${fromBlock}-${toBlock}`,
      );

      // get network metrics for logging
      const activeWorkerCount = await this.web3Service.getActiveWorkerCount(ctx);
      const networkCapacity = await this.contractService.getTargetCapacity();

      // use the existing distribution service which handles Merkle proof generation and batch distribution
      const distributionStatus =
        await this.distributionService.distributeEpochRewards(
          fromBlock,
          toBlock,
          50, // batch size
        );

      if (distributionStatus.status === 'completed') {
        isCommitSuccess = true;

        ctx.logger.debug(`✅ Distribution completed successfully:`);
        ctx.logger.debug(`   - Workers: ${distributionStatus.totalWorkers}`);
        ctx.logger.debug(`   - Batches: ${distributionStatus.totalBatches}`);
        ctx.logger.debug(
          `   - Total Rewards: ${Number(distributionStatus.totalRewards) / 1e18} SQD`,
        );

        // calculate metrics for structured logging
        const currentCapacity = Number(activeWorkerCount) * 200; // 200GB per worker (approximate)
        const targetCapacity = Number(networkCapacity) / 1e9; // convert from bytes to GB

        // estimate APR metrics (simplified)
        const baseApr = 0.2; // 20% base APR
        const stakeFactor = 0.15; // estimated 15% of supply staked
        const finalApr = baseApr;

        // log the rewards report
        this.metricsLoggerService.logRewardsReport({
          epochStart,
          epochEnd,
          isCommitSuccess,
          commitTxHash,
          commitErrorMessage,
          targetCapacity: Math.round(targetCapacity),
          currentCapacity: Math.round(currentCapacity),
          activeWorkersCount: Number(activeWorkerCount),
          baseApr,
          stakeFactor,
          finalApr,
          totalReward: distributionStatus.totalRewards,
        });
      } else {
        commitErrorMessage = distributionStatus.error || 'Distribution failed';
        throw new Error(`Distribution failed: ${distributionStatus.error}`);
      }
    } catch (error) {
      ctx.logger.error({ error }, `❌ Distribution phase failed`);

      // log failed distribution
      try {
        const activeWorkerCount = await this.web3Service.getActiveWorkerCount(ctx);
        const networkCapacity = await this.contractService.getTargetCapacity();
        const currentCapacity = Number(activeWorkerCount) * 200;
        const targetCapacity = Number(networkCapacity) / 1e9;

        this.metricsLoggerService.logRewardsReport({
          epochStart,
          epochEnd,
          isCommitSuccess: false,
          commitTxHash: '',
          commitErrorMessage: error.message,
          targetCapacity: Math.round(targetCapacity),
          currentCapacity: Math.round(currentCapacity),
          activeWorkersCount: Number(activeWorkerCount),
          baseApr: 0.2,
          stakeFactor: 0.15,
          finalApr: 0.2,
          totalReward: 0n,
        });
      } catch (logError) {
        ctx.logger.error({ error: logError }, `Failed to log error metrics`);
      }

      throw error;
    }
  }

  private async getCommitRange(ctx: Context): Promise<{
    fromBlock: number;
    toBlock: number;
  }> {
    try {
      const currentBlock = await this.web3Service.getL1BlockNumber(ctx);
      const lastRewardedBlock =
        await this.contractService.getLastRewardedBlock(ctx);
      const lastConfirmedBlock = currentBlock - this.confirmationBlocks;

      const blocksSinceLastReward = currentBlock - lastRewardedBlock;

      // check if interval reached
      if (blocksSinceLastReward < this.blockInterval) {
        return { fromBlock: 0, toBlock: 0 };
      }

      // calculate the range to commit
      const fromBlock = lastRewardedBlock + 1;
      const toBlock = Math.min(
        fromBlock + this.blockInterval - 1,
        lastConfirmedBlock,
      );

      if (fromBlock >= toBlock) {
        return { fromBlock: 0, toBlock: 0 };
      }

      return { fromBlock, toBlock };
    } catch (error) {
      ctx.logger.error({ error }, `Failed to get commit range`);
      return { fromBlock: 0, toBlock: 0 };
    }
  }

  // Public methods for admin control and status
  getStatus(): BlockSchedulerStatus {
    return {
      enabled: this.enableAutoDistribution,
      blockInterval: this.blockInterval,
      lastCheckedBlock: this.lastCheckedBlock,
      isProcessing: this.isProcessing,
      currentPhase: this.currentPhase,
      lastCommittedRange: this.lastCommittedRange,
    };
  }

  async triggerManualCheck(): Promise<boolean> {
    const ctx = new TaskContext('block-scheduler:manual-trigger');
    try {
      ctx.logger.debug('🔄 Manual trigger initiated');
      await this.processBlockInterval(ctx);
      return true;
    } catch (error) {
      ctx.logger.error({ error }, `Manual trigger failed`);
      return false;
    }
  }

  // Force a specific phase for testing/admin use
  async forceCommit(fromBlock: number, toBlock: number): Promise<boolean> {
    const ctx = new TaskContext(`block-scheduler:force-commit:${fromBlock}-${toBlock}`);
    try {
      ctx.logger.debug(`🔧 Force commit initiated for ${fromBlock}-${toBlock}`);
      this.isProcessing = true;
      await this.processCommitPhase(ctx, fromBlock, toBlock);
      return true;
    } catch (error) {
      ctx.logger.error({ error }, `Force commit failed`);
      return false;
    } finally {
      this.isProcessing = false;
      this.currentPhase = 'idle';
    }
  }

  async forceDistribution(
    fromBlock: number,
    toBlock: number,
  ): Promise<boolean> {
    const ctx = new TaskContext(`block-scheduler:force-distribution:${fromBlock}-${toBlock}`);
    try {
      ctx.logger.debug(
        `🔧 Force distribution initiated for ${fromBlock}-${toBlock}`,
      );
      this.isProcessing = true;
      await this.processDistributionPhase(ctx, fromBlock, toBlock);
      return true;
    } catch (error) {
      ctx.logger.error({ error }, `Force distribution failed`);
      return false;
    } finally {
      this.isProcessing = false;
      this.currentPhase = 'idle';
    }
  }
}
