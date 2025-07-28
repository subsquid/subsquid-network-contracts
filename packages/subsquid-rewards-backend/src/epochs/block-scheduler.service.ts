import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
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
export class BlockSchedulerService implements OnModuleInit {
  private readonly blockInterval: number;
  private readonly distributionStartingBlock: number;
  private readonly enableAutoDistribution: boolean;
  private readonly confirmationBlocks: number;
  private lastCheckedBlock = 0;
  private isProcessing = false;
  private currentPhase: 'commit' | 'approve' | 'distribute' | 'idle' = 'idle';
  private lastCommittedRange?: { fromBlock: number; toBlock: number };
  private logger: Logger;
  
  private internalLastProcessedBlock: number | null = null;

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
    this.distributionStartingBlock =
      this.configService.get('rewards.distributionStartingBlock') || 0;
    this.enableAutoDistribution =
      this.configService.get('rewards.enableAutoDistribution') === true;
    this.confirmationBlocks =
      this.configService.get('blockchain.epochConfirmationBlocks') || 150;

    const ctx = new TaskContext('block-scheduler-init');
    this.logger = ctx.logger;

    ctx.logger.info(`🔄 Block Scheduler initialized:`);
    ctx.logger.info(
      `   - Auto distribution: ${this.enableAutoDistribution ? '✅ ENABLED' : '❌ DISABLED'}`,
    );
    ctx.logger.info(`   - Block interval: ${this.blockInterval} blocks`);
    ctx.logger.info(`   - Starting block: ${this.distributionStartingBlock}`);
    ctx.logger.info(`   - Confirmation blocks: ${this.confirmationBlocks}`);
    ctx.logger.info(
      `   - Config value: ${this.configService.get('rewards.enableAutoDistribution')}`,
    );
    ctx.logger.info(
      `   - ENABLE_AUTO_DISTRIBUTION env: ${process.env.ENABLE_AUTO_DISTRIBUTION}`,
    );
  }

  async onModuleInit() {
    if (this.enableAutoDistribution) {
      const ctx = new TaskContext('block-scheduler:init');
      ctx.logger.info('🚀 Auto distribution enabled, performing initial check...');

      setTimeout(async () => {
        try {
          const lastRewardedBlock = await this.contractService.getLastRewardedBlock(ctx);
          
          if (lastRewardedBlock === 0) {
            this.internalLastProcessedBlock = this.distributionStartingBlock - 1;
            ctx.logger.info(
              `📊 Initial state: Starting fresh from block ${this.distributionStartingBlock}`,
            );
          } else {
            this.internalLastProcessedBlock = lastRewardedBlock;
            ctx.logger.info(
              `📊 Initial state: Continuing from lastBlockRewarded = ${lastRewardedBlock}`,
            );
          }
          
          const nextFromBlock = this.internalLastProcessedBlock + 1;
          const nextToBlock = nextFromBlock + this.blockInterval - 1;
          ctx.logger.info(
            `📊 Next expected distribution range: ${nextFromBlock}-${nextToBlock}`,
          );
          
          await this.checkBlockInterval();
        } catch (error) {
          ctx.logger.error({ error }, 'Initial block check failed');
        }
      }, 5000);
    }
  }

  @Cron('*/2 * * * *') // Every 2 minutes
  async checkBlockInterval() {
    const ctx = new TaskContext('block-scheduler:check');
    
    if (!this.enableAutoDistribution) {
      ctx.logger.debug('Auto distribution is disabled, skipping check');
      return;
    }
    
    if (this.isProcessing) {
      ctx.logger.debug('Already processing, skipping check');
      return;
    }
    
    ctx.logger.info('🔄 Running block interval check');
    
    try {
      const lastRewardedBlock = await this.contractService.getLastRewardedBlock(ctx);
      ctx.logger.info(
        `📊 State check:`,
      );
      ctx.logger.info(
        `   - Internal counter: ${this.internalLastProcessedBlock ?? 'not initialized'}`,
      );
      ctx.logger.info(
        `   - Contract lastBlockRewarded: ${lastRewardedBlock}`,
      );
      
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

      if (this.internalLastProcessedBlock === null) {
        const lastRewardedBlock = await this.contractService.getLastRewardedBlock(ctx);
        this.internalLastProcessedBlock = lastRewardedBlock === 0 
          ? this.distributionStartingBlock - 1
          : lastRewardedBlock;
        ctx.logger.info(
          `📊 Initialized internal counter: ${this.internalLastProcessedBlock}`,
        );
      }
      
      const blocksSinceLastReward = currentBlock - this.internalLastProcessedBlock;

      ctx.logger.info(
        `📊 Block status: current=${currentBlock}, internalLastProcessed=${this.internalLastProcessedBlock}, gap=${blocksSinceLastReward}/${this.blockInterval}`,
      );

      if (blocksSinceLastReward >= this.blockInterval) {
        const nextFromBlock = this.internalLastProcessedBlock + 1;
        const nextToBlock = nextFromBlock + this.blockInterval - 1;
        
        ctx.logger.info(
          `📋 Processing distribution range: ${nextFromBlock}-${nextToBlock} (internal counter)`,
        );
        
        const contractLastRewardedBlock = await this.contractService.getLastRewardedBlock(ctx);
        if (contractLastRewardedBlock >= nextToBlock) {
          ctx.logger.warn(
            `🔄 Skipping range ${nextFromBlock}-${nextToBlock} - already processed according to contract (lastBlockRewarded=${contractLastRewardedBlock})`,
          );
          this.internalLastProcessedBlock = contractLastRewardedBlock;
          return;
        }
        
        const existingCommitment = await this.contractService.getCommitment(
          ctx,
          nextFromBlock,
          nextToBlock,
        );

        if (existingCommitment.exists) {
          ctx.logger.info(
            `📋 Found existing commitment for ${nextFromBlock}-${nextToBlock}: ${existingCommitment.processedBatches}/${existingCommitment.totalBatches} batches processed`,
          );

          if (existingCommitment.processedBatches < existingCommitment.totalBatches) {
            ctx.logger.info(
              `🔄 Resuming distribution for ${nextFromBlock}-${nextToBlock}`,
            );
            
            try {
              await this.processDistributionPhase(
                ctx,
                nextFromBlock,
                nextToBlock,
              );
            } catch (error) {
              ctx.logger.error(`Distribution phase failed: ${error.message}`);
            }
            
            return;
          } else {
            ctx.logger.info(
              `✅ Distribution already completed for ${nextFromBlock}-${nextToBlock}`,
            );
            this.internalLastProcessedBlock = nextToBlock;
            ctx.logger.info(
              `📊 Updated internal counter to ${this.internalLastProcessedBlock}`,
            );
            return;
          }
        }
      
        const commitRange = { fromBlock: nextFromBlock, toBlock: nextToBlock };
        
        const lastConfirmedBlock = currentBlock - this.confirmationBlocks;
        if (nextToBlock > lastConfirmedBlock) {
          ctx.logger.info(
            `⏳ Waiting for confirmation: need ${nextToBlock - lastConfirmedBlock} more blocks`,
          );
          return;
        }
        
        ctx.logger.info(
          `📊 processBlockInterval: commitRange = ${JSON.stringify(commitRange)}`
        );
        
        if (commitRange.fromBlock > 0 && commitRange.toBlock > 0) {
          ctx.logger.info(
            `🚀 Block interval reached! Processing range ${commitRange.fromBlock}-${commitRange.toBlock}`,
          );

          try {
            await this.processCommitPhase(
              ctx,
              commitRange.fromBlock,
              commitRange.toBlock,
            );
          } catch (error) {
            ctx.logger.warn(`Commit phase skipped: ${error.message}`);
          }

          try {
            await this.processApprovalPhase(
              ctx,
              commitRange.fromBlock,
              commitRange.toBlock,
            );
          } catch (error) {
            ctx.logger.debug(`Approval phase skipped: ${error.message}`);
          }

          try {
            await this.processDistributionPhase(
              ctx,
              commitRange.fromBlock,
              commitRange.toBlock,
            );
          } catch (error) {
            ctx.logger.error(`Distribution phase failed: ${error.message}`);
          }

          ctx.logger.info(
            `✅ Block-triggered workflow completed for ${commitRange.fromBlock}-${commitRange.toBlock}`,
          );
        }
      } else {
        ctx.logger.info(
          `⏳ Waiting for more blocks (${this.blockInterval - blocksSinceLastReward} remaining)`,
        );
      }
    } catch (error) {
      ctx.logger.error(
        `Block interval processing failed: ${error.message}`
      );
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

      ctx.logger.debug(`🔄 Proceeding with commit for ${fromBlock}-${toBlock}`)

      const distributorAddress = this.configService.get(
        'blockchain.distributor.address',
      );
      if (!distributorAddress) {
        throw new Error('Distributor address not configured');
      }

      const canCommit =
        await this.contractService.canCommit(distributorAddress);
      if (!canCommit) {
        ctx.logger.debug(
          `Not our turn in round-robin, skipping commit`,
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
        ctx.logger.debug(
          `No commitment found for range ${fromBlock}-${toBlock}, skipping approval`
        );
        return;
      }

      const requiredApprovals = 1; // TODO: get from contract configuration
      const currentApprovals = Number(latestCommitment.approvalCount);

      ctx.logger.debug(
        `📊 Approval status: ${currentApprovals}/${requiredApprovals} required`,
      );

      if (currentApprovals < requiredApprovals) {
        // if we haven't approved yet, approve now

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
      const activeWorkerCount =
        await this.web3Service.getActiveWorkerCount(ctx);
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

        this.internalLastProcessedBlock = toBlock;
        
        const updatedLastRewardedBlock = await this.contractService.getLastRewardedBlock(ctx);
        ctx.logger.info(
          `📊 Distribution completed:`,
        );
        ctx.logger.info(
          `   - Internal counter updated: ${fromBlock - 1} → ${this.internalLastProcessedBlock}`,
        );
        ctx.logger.info(
          `   - Contract lastBlockRewarded: ${updatedLastRewardedBlock} (expected: ${toBlock})`,
        );
        
        if (updatedLastRewardedBlock !== toBlock) {
          ctx.logger.warn(
            `⚠️  Contract state mismatch! Using internal counter for next range.`,
          );
        }
        
        const nextFromBlock = this.internalLastProcessedBlock + 1;
        const nextToBlock = nextFromBlock + this.blockInterval - 1;
        ctx.logger.info(
          `📝 Next distribution range will be: ${nextFromBlock}-${nextToBlock}`,
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
        const activeWorkerCount =
          await this.web3Service.getActiveWorkerCount(ctx);
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

  // dep - range calculation now happens in processBlockInterval
  // private async getCommitRange(ctx: Context): Promise<{
  //   fromBlock: number;
  //   toBlock: number;
  // }> {
  //   return { fromBlock: 0, toBlock: 0 };
  // }

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
    const ctx = new TaskContext(
      `block-scheduler:force-commit:${fromBlock}-${toBlock}`,
    );
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
    const ctx = new TaskContext(
      `block-scheduler:force-distribution:${fromBlock}-${toBlock}`,
    );
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
