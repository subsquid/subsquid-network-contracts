import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Web3Service } from '../../blockchain/web3.service';
import { ContractService } from '../../blockchain/contract.service';
import { DistributionService } from '../../rewards/distribution/distribution.service';
import { RewardsCalculatorService } from '../../rewards/calculation/rewards-calculator.service';
import { Context } from '../../common';
import { EpochMetricsService, NetworkMetrics, RewardMetrics } from './epoch-metrics.service';
import { RewardsReporterService } from './rewards-reporter.service';

export interface EpochProcessingResult {
  isSuccess: boolean;
  commitTxHash: string;
  networkMetrics: NetworkMetrics;
  rewardMetrics: RewardMetrics;
  error?: string;
}

@Injectable()
export class EpochProcessorService {
  constructor(
    private configService: ConfigService,
    private web3Service: Web3Service,
    private contractService: ContractService,
    private distributionService: DistributionService,
    private rewardsCalculatorService: RewardsCalculatorService,
    private epochMetrics: EpochMetricsService,
    private rewardsReporter: RewardsReporterService,
  ) {}

  async processEpoch(ctx: Context, fromBlock: number, toBlock: number): Promise<EpochProcessingResult> {
    const epochStart = await this.web3Service.getBlockTimestamp(ctx, fromBlock);
    const epochEnd = await this.web3Service.getBlockTimestamp(ctx, toBlock);
    let commitTxHash = '';
    let lastCalculatedRewards: any;
    
    try {
      // phase 1: commit
      commitTxHash = await this.processCommitPhase(ctx, fromBlock, toBlock);
      
      // store rewards for reporting
      lastCalculatedRewards = this.getLastCalculatedRewards();
      
      // phase 2: approval  
      await this.processApprovalPhase(ctx, fromBlock, toBlock);
      
      // phase 3: distribution
      await this.processDistributionPhase(ctx, fromBlock, toBlock);
      
      // success - collect metrics and report
      const networkMetrics = await this.epochMetrics.collectNetworkMetrics(ctx);
      const rewardMetrics = this.epochMetrics.extractRewardMetrics(lastCalculatedRewards);
      
      await this.rewardsReporter.logSuccessfulRewardsReport({
        epochStart,
        epochEnd,
        isCommitSuccess: true,
        commitTxHash,
        networkMetrics,
        rewardMetrics,
      });
      
      return {
        isSuccess: true,
        commitTxHash,
        networkMetrics,
        rewardMetrics,
      };
      
    } catch (error) {
      // failure - report error
      await this.rewardsReporter.logFailedRewardsReport(
        ctx,
        epochStart,
        epochEnd,
        commitTxHash,
        error as Error,
      );
      
      // still return basic metrics for error case
      const networkMetrics = await this.epochMetrics.collectNetworkMetrics(ctx);
      const emptyRewardMetrics: RewardMetrics = {
        totalReward: 0n,
        totalBytesSent: 0,
        totalChunksRead: 0,
        totalRequests: 0,
        validRequests: 0,
      };
      
      return {
        isSuccess: false,
        commitTxHash,
        networkMetrics,
        rewardMetrics: emptyRewardMetrics,
        error: (error as Error).message,
      };
    }
  }

  private async processCommitPhase(ctx: Context, fromBlock: number, toBlock: number): Promise<string> {
    ctx.logger.debug(`📝 Phase 1: Committing Merkle root for ${fromBlock}-${toBlock}`);
    
    ctx.logger.debug(`🔄 Proceeding with commit for ${fromBlock}-${toBlock}`)

    const distributorAddress = this.configService.get('blockchain.distributor.address');
    if (!distributorAddress) {
      throw new Error('Distributor address not configured');
    }

    const canCommit = await this.contractService.canCommit(distributorAddress);
    if (!canCommit) {
      ctx.logger.debug(`Not our turn in round-robin, skipping commit`);
      return '';
    }

    ctx.logger.debug(`🧮 Calculating rewards for ${fromBlock}-${toBlock}...`);

    const skipSignatureValidation = this.configService.get('rewards.skipSignatureValidation') || false;
    
    // calculate formatted rewards to get all metrics
    const formattedRewards = await this.rewardsCalculatorService.calculateRewardsFormatted(
      ctx,
      fromBlock,
      toBlock,
      skipSignatureValidation,
    );
    
    // store for use in distribution phase logging (exact same as original)
    this.setLastCalculatedRewards(formattedRewards);
    
    // also get detailed result for merkle tree
    const calculationResult = await this.rewardsCalculatorService.calculateRewardsDetailed(
      ctx,
      fromBlock,
      toBlock,
      skipSignatureValidation,
    );

    const workers = calculationResult.workers;

    if (workers.length === 0) {
      ctx.logger.warn(`⚠️  No workers found for range ${fromBlock}-${toBlock}, skipping commit`);
      return '';
    }

    // generate Merkle tree using the MerkleTreeService directly (exact same as original)
    const merkleTree = await this.distributionService['merkleTreeService'].generateMerkleTree(workers, 50);

    // commit the root to contract
    ctx.logger.debug(`📤 Committing Merkle root ${merkleTree.root} with ${merkleTree.totalBatches} batches...`);

    const txHash = await this.contractService.commitRoot(
      fromBlock,
      toBlock,
      merkleTree.root as `0x${string}`,
      merkleTree.totalBatches,
      `ipfs://rewards-${fromBlock}-${toBlock}`,
    );

    if (txHash) {
      ctx.logger.debug(`✅ Committed successfully: ${txHash}`);
      return txHash;
    } else {
      throw new Error('Commit transaction failed');
    }
  }

  private async processApprovalPhase(ctx: Context, fromBlock: number, toBlock: number): Promise<void> {
    ctx.logger.debug(`✅ Phase 2: Checking approvals for ${fromBlock}-${toBlock}`);

    const latestCommitment = await this.contractService.getLatestCommitment();

    if (
      !latestCommitment ||
      Number(latestCommitment.fromBlock) !== fromBlock ||
      Number(latestCommitment.toBlock) !== toBlock
    ) {
      ctx.logger.debug(`No commitment found for range ${fromBlock}-${toBlock}, skipping approval`);
      return;
    }

    const requiredApprovals = 1; // TODO: get from contract configuration
    const currentApprovals = Number(latestCommitment.approvalCount);

    ctx.logger.debug(`📊 Approval status: ${currentApprovals}/${requiredApprovals} required`);

    if (currentApprovals < requiredApprovals) {
      ctx.logger.debug(`📝 Approving commitment for ${fromBlock}-${toBlock}...`);
      const txHash = await this.contractService.approveRoot(fromBlock, toBlock);

      if (txHash) {
        ctx.logger.debug(`✅ Approved successfully: ${txHash}`);
      } else {
        ctx.logger.warn(`⚠️  Approval may have failed or was already done`);
      }
    } else {
      ctx.logger.debug(`✅ Sufficient approvals already received`);
    }
  }

  private async processDistributionPhase(ctx: Context, fromBlock: number, toBlock: number): Promise<void> {
    ctx.logger.debug(`💰 Phase 3: Distributing rewards for ${fromBlock}-${toBlock}`);

    // use the existing distribution service which handles Merkle proof generation and batch distribution
    const distributionStatus = await this.distributionService.distributeEpochRewards(
      fromBlock,
      toBlock,
      50, // batch size
    );

    if (distributionStatus.status === 'completed') {
      ctx.logger.debug(`✅ Distribution completed successfully:`);
      ctx.logger.debug(`   - Workers: ${distributionStatus.totalWorkers}`);
      ctx.logger.debug(`   - Batches: ${distributionStatus.totalBatches}`);
      ctx.logger.debug(`   - Total Rewards: ${Number(distributionStatus.totalRewards) / 1e18} SQD`);
    } else {
      throw new Error(`Distribution failed: ${distributionStatus.error}`);
    }
  }

  // storage for calculated rewards (exact same pattern as original)
  private lastCalculatedRewards: any;

  private setLastCalculatedRewards(rewards: any): void {
    this.lastCalculatedRewards = rewards;
  }

  private getLastCalculatedRewards(): any {
    return this.lastCalculatedRewards;
  }

  clearLastCalculatedRewards(): void {
    this.lastCalculatedRewards = undefined;
  }
} 