import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Web3Service } from '../blockchain/web3.service';
import { ContractService } from '../blockchain/contract.service';
import { DistributionService } from '../rewards/distribution/distribution.service';
import { RewardsCalculatorService } from '../rewards/calculation/rewards-calculator.service';
import { MetricsLoggerService } from '../common/metrics-logger.service';

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
  private readonly logger = new Logger(BlockSchedulerService.name);
  private readonly blockInterval: number;
  private readonly enableAutoDistribution: boolean;
  private readonly confirmationBlocks: number;
  private lastCheckedBlock = 0;
  private isProcessing = false;
  private currentPhase: 'commit' | 'approve' | 'distribute' | 'idle' = 'idle';
  private lastCommittedRange?: { fromBlock: number; toBlock: number };

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

    this.logger.log(`🔄 Block Scheduler initialized:`);
    this.logger.log(
      `   - Auto distribution: ${this.enableAutoDistribution ? '✅' : '❌'}`,
    );
    this.logger.log(`   - Block interval: ${this.blockInterval} blocks`);
    this.logger.log(`   - Confirmation blocks: ${this.confirmationBlocks}`);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async checkBlockInterval() {
    if (!this.enableAutoDistribution || this.isProcessing) {
      return;
    }

    try {
      await this.processBlockInterval();
    } catch (error) {
      this.logger.error(`Block interval check failed: ${error.message}`);
    }
  }

  private async processBlockInterval(): Promise<void> {
    this.isProcessing = true;
    this.currentPhase = 'idle';

    try {
      const currentBlock = await this.web3Service.getL1BlockNumber();
      this.lastCheckedBlock = currentBlock;

      const commitRange = await this.getCommitRange();
      if (commitRange.fromBlock > 0 && commitRange.toBlock > 0) {
        this.logger.log(
          `🚀 Block interval reached! Processing range ${commitRange.fromBlock}-${commitRange.toBlock}`,
        );

        await this.processCommitPhase(
          commitRange.fromBlock,
          commitRange.toBlock,
        );

        await this.processApprovalPhase(
          commitRange.fromBlock,
          commitRange.toBlock,
        );

        await this.processDistributionPhase(
          commitRange.fromBlock,
          commitRange.toBlock,
        );

        this.logger.log(
          `✅ Block-triggered workflow completed for ${commitRange.fromBlock}-${commitRange.toBlock}`,
        );
      } else {
        const lastRewardedBlock =
          await this.contractService.getLastRewardedBlock();
        const blocksSinceLastReward = currentBlock - lastRewardedBlock;

        this.logger.debug(
          `📊 Block status: current=${currentBlock}, lastRewarded=${lastRewardedBlock}, gap=${blocksSinceLastReward}/${this.blockInterval}`,
        );

        if (blocksSinceLastReward < this.blockInterval) {
          this.logger.debug(
            `⏳ Waiting for more blocks (${this.blockInterval - blocksSinceLastReward} remaining)`,
          );
        }
      }
    } catch (error) {
      this.logger.error(`Block interval processing failed: ${error.message}`);
      this.currentPhase = 'idle';
    } finally {
      this.isProcessing = false;
      this.currentPhase = 'idle';
    }
  }

  private async processCommitPhase(
    fromBlock: number,
    toBlock: number,
  ): Promise<void> {
    try {
      this.currentPhase = 'commit';
      this.logger.log(
        `📝 Phase 1: Committing Merkle root for ${fromBlock}-${toBlock}`,
      );

      const isCommitted = await this.contractService.isCommitted(
        fromBlock,
        toBlock,
      );
      if (isCommitted) {
        this.logger.log(`✅ Range ${fromBlock}-${toBlock} already committed`);
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
        this.logger.warn(
          `⚠️  Cannot commit right now (not our turn in round-robin)`,
        );
        return;
      }

      this.logger.log(`🧮 Calculating rewards for ${fromBlock}-${toBlock}...`);

      const skipSignatureValidation =
        this.configService.get('rewards.skipSignatureValidation') || false;
      const calculationResult =
        await this.rewardsCalculatorService.calculateRewardsDetailed(
          fromBlock,
          toBlock,
          skipSignatureValidation,
        );

      const workers = calculationResult.workers;

      if (workers.length === 0) {
        this.logger.warn(
          `⚠️  No workers found for range ${fromBlock}-${toBlock}, skipping commit`,
        );
        return;
      }

      // generate Merkle tree using the MerkleTreeService directly
      const merkleTree = await this.distributionService[
        'merkleTreeService'
      ].generateMerkleTree(workers, 50);

      // commit the root to contract
      this.logger.log(
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
        this.logger.log(`✅ Committed successfully: ${txHash}`);
        this.lastCommittedRange = { fromBlock, toBlock };
      } else {
        throw new Error('Commit transaction failed');
      }
    } catch (error) {
      this.logger.error(`❌ Commit phase failed: ${error.message}`);
      throw error;
    }
  }

  private async processApprovalPhase(
    fromBlock: number,
    toBlock: number,
  ): Promise<void> {
    try {
      this.currentPhase = 'approve';
      this.logger.log(
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

      this.logger.log(
        `📊 Approval status: ${currentApprovals}/${requiredApprovals} required`,
      );

      if (currentApprovals < requiredApprovals) {
        // if we haven't approved yet, approve now
        const distributorAddress = this.configService.get(
          'blockchain.distributor.address',
        );

        this.logger.log(
          `📝 Approving commitment for ${fromBlock}-${toBlock}...`,
        );
        const txHash = await this.contractService.approveRoot(
          fromBlock,
          toBlock,
        );

        if (txHash) {
          this.logger.log(`✅ Approved successfully: ${txHash}`);
        } else {
          this.logger.warn(`⚠️  Approval may have failed or was already done`);
        }
      } else {
        this.logger.log(`✅ Sufficient approvals already received`);
      }
    } catch (error) {
      this.logger.error(`❌ Approval phase failed: ${error.message}`);
      throw error;
    }
  }

  private async processDistributionPhase(
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
      this.logger.log(
        `💰 Phase 3: Distributing rewards for ${fromBlock}-${toBlock}`,
      );

      // get network metrics for logging
      const activeWorkerCount = await this.web3Service.getActiveWorkerCount();
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

        this.logger.log(`✅ Distribution completed successfully:`);
        this.logger.log(`   - Workers: ${distributionStatus.totalWorkers}`);
        this.logger.log(`   - Batches: ${distributionStatus.totalBatches}`);
        this.logger.log(
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
      this.logger.error(`❌ Distribution phase failed: ${error.message}`);

      // log failed distribution
      try {
        const activeWorkerCount = await this.web3Service.getActiveWorkerCount();
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
        this.logger.error(`Failed to log error metrics: ${logError.message}`);
      }

      throw error;
    }
  }

  private async getCommitRange(): Promise<{
    fromBlock: number;
    toBlock: number;
  }> {
    try {
      const currentBlock = await this.web3Service.getL1BlockNumber();
      const lastRewardedBlock =
        await this.contractService.getLastRewardedBlock();
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
      this.logger.error(`Failed to get commit range: ${error.message}`);
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
    try {
      this.logger.log('🔄 Manual trigger initiated');
      await this.processBlockInterval();
      return true;
    } catch (error) {
      this.logger.error(`Manual trigger failed: ${error.message}`);
      return false;
    }
  }

  // Force a specific phase for testing/admin use
  async forceCommit(fromBlock: number, toBlock: number): Promise<boolean> {
    try {
      this.logger.log(`🔧 Force commit initiated for ${fromBlock}-${toBlock}`);
      this.isProcessing = true;
      await this.processCommitPhase(fromBlock, toBlock);
      return true;
    } catch (error) {
      this.logger.error(`Force commit failed: ${error.message}`);
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
    try {
      this.logger.log(
        `🔧 Force distribution initiated for ${fromBlock}-${toBlock}`,
      );
      this.isProcessing = true;
      await this.processDistributionPhase(fromBlock, toBlock);
      return true;
    } catch (error) {
      this.logger.error(`Force distribution failed: ${error.message}`);
      return false;
    } finally {
      this.isProcessing = false;
      this.currentPhase = 'idle';
    }
  }
}
