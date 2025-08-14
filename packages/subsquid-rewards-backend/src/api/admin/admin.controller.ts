import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  Param,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { RewardsCalculatorService } from '../../rewards/calculation/rewards-calculator.service';
import {
  DistributionService,
  DistributionStatus,
} from '../../rewards/distribution/distribution.service';
import { Web3Service } from '../../blockchain/web3.service';
import { BlockSchedulerService } from '../../epochs/block-scheduler.service';
import { TaskContext } from '../../common';
// todo: add protection for admin endpoints

export interface ManualDistributionRequest {
  fromBlock: number;
  toBlock: number;
  batchSize?: number;
}

@Controller('admin')
export class AdminController {
  // Store active distributions in memory for demo purposes
  private activeDistributions = new Map<string, DistributionStatus>();

  constructor(
    private rewardsCalculatorService: RewardsCalculatorService,
    private distributionService: DistributionService,
    private web3Service: Web3Service,
    private blockSchedulerService: BlockSchedulerService,
  ) {}

  /**
   * Calculate rewards for a specific block range
   */
  @Get('rewards/calculate/:fromBlock/:toBlock')
  async calculateRewards(
    @Param('fromBlock') fromBlock: string,
    @Param('toBlock') toBlock: string,
    @Query('limit') limit?: string,
  ) {
    const ctx = new TaskContext(
      `admin:calculate-rewards:${fromBlock}-${toBlock}`,
    );
    const fromBlockNum = parseInt(fromBlock, 10);
    const toBlockNum = parseInt(toBlock, 10);
    const limitNum = limit ? parseInt(limit, 10) : undefined;

    try {
      const result =
        await this.rewardsCalculatorService.calculateRewardsFormatted(
          ctx,
          fromBlockNum,
          toBlockNum,
          true,
        );

      const workers = limitNum
        ? result.workers.slice(0, limitNum)
        : result.workers;

      return {
        totalRewards: result.totalRewards,
        workers: workers,
      };
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        { error },
        `Failed to calculate rewards`,
      );
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Start complete distribution process (rewards → Merkle → contract)
   */
  @Post('distribute')
  async startDistribution(@Body() body: ManualDistributionRequest) {
    const { fromBlock, toBlock, batchSize = 50 } = body;
    const epochId = `${fromBlock}-${toBlock}`;

    try {
      // Validate input
      if (fromBlock >= toBlock) {
        throw new HttpException(
          'Invalid block range: fromBlock must be less than toBlock',
          HttpStatus.BAD_REQUEST,
        );
      }

      // Check if already running
      if (this.activeDistributions.has(epochId)) {
        const existing = this.activeDistributions.get(epochId);
        if (
          existing &&
          existing.status !== 'completed' &&
          existing.status !== 'failed'
        ) {
          return {
            success: false,
            error: 'Distribution already running for this epoch',
            status: this.formatStatus(existing),
          };
        }
      }

      const ctx = new TaskContext(`admin:distribution:${epochId}`);
      ctx.logger.debug(`🚀 Starting distribution for epoch ${epochId}`);

      // Store initial status
      const initialStatus: DistributionStatus = {
        epochId,
        fromBlock,
        toBlock,
        status: 'calculating',
        totalWorkers: 0,
        totalBatches: 0,
        processedBatches: 0,
        totalRewards: 0n,
        startedAt: new Date(),
      };

      this.activeDistributions.set(epochId, initialStatus);

      try {
        // wait for distribution to complete
        const finalStatus =
          await this.distributionService.distributeEpochRewards(
            fromBlock,
            toBlock,
            batchSize,
          );

        // update with final status
        this.activeDistributions.set(epochId, finalStatus);

        ctx.logger.debug(
          `✅ Distribution completed for epoch ${epochId}: ${finalStatus.status}`,
        );

        return {
          success: true,
          message: 'Distribution completed successfully',
          epochId,
          status: this.formatStatus(finalStatus),
        };
      } catch (error) {
        const errorStatus: DistributionStatus = {
          ...initialStatus,
          status: 'failed',
          error: error.message,
          completedAt: new Date(),
        };
        this.activeDistributions.set(epochId, errorStatus);

        ctx.logger.error(
          { error },
          `❌ Distribution failed for epoch ${epochId}`,
        );

        throw new HttpException(
          `Distribution failed: ${error.message}`,
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        { error },
        `Failed to start distribution`,
      );
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get distribution status for a specific epoch
   */
  @Get('distributions/:epochId')
  async getDistributionStatus(@Param('epochId') epochId: string) {
    try {
      const status = this.activeDistributions.get(epochId);

      if (!status) {
        return {
          success: false,
          error: 'Distribution not found',
        };
      }

      return {
        success: true,
        status: this.formatStatus(status),
      };
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        { error },
        `Failed to get distribution status`,
      );
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get all active/recent distributions
   */
  @Get('distributions')
  async getAllDistributions(
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ) {
    try {
      let distributions = Array.from(this.activeDistributions.values());

      if (status) {
        distributions = distributions.filter((d) => d.status === status);
      }

      distributions.sort(
        (a, b) => b.startedAt.getTime() - a.startedAt.getTime(),
      );

      const maxResults = limit ? parseInt(limit, 10) : 50;
      const result = distributions.slice(0, maxResults);

      return {
        success: true,
        distributions: result.map((d) => this.formatStatus(d)),
        total: distributions.length,
        returned: result.length,
      };
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        { error },
        `Failed to get distributions`,
      );
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get contract status for a specific epoch
   */
  @Get('contract/status/:fromBlock/:toBlock')
  async getContractStatus(
    @Param('fromBlock') fromBlock: string,
    @Param('toBlock') toBlock: string,
  ) {
    try {
      const fromBlockNum = parseInt(fromBlock, 10);
      const toBlockNum = parseInt(toBlock, 10);

      const contractStatus =
        await this.distributionService.getDistributionStatus(
          fromBlockNum,
          toBlockNum,
        );

      return {
        success: true,
        contractStatus,
        epoch: `${fromBlockNum}-${toBlockNum}`,
      };
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `Failed to get contract status: ${error.message}`,
      );
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Check WorkerRegistration contract status including bond amount
   */
  @Get('contract/worker-registration')
  async getWorkerRegistrationStatus() {
    const ctx = new TaskContext('admin:worker-registration-status');
    try {
      const bondAmount =
        await this.rewardsCalculatorService['web3Service'].getBondAmount(ctx);
      const activeWorkerCount =
        await this.rewardsCalculatorService['web3Service'].getActiveWorkerCount(
          ctx,
        );

      return {
        success: true,
        bondAmount: bondAmount.toString(),
        bondAmountSQD: Number(bondAmount) / 1e18,
        activeWorkerCount: activeWorkerCount.toString(),
        contractAddress: this.rewardsCalculatorService['configService'].get(
          'blockchain.contracts.workerRegistration',
        ),
      };
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `Failed to get WorkerRegistration status: ${error.message}`,
      );
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Health check endpoint
   */
  @Get('health')
  async health() {
    const distributions = Array.from(this.activeDistributions.values());
    const stats = {
      calculating: distributions.filter((d) => d.status === 'calculating')
        .length,
      generating_tree: distributions.filter(
        (d) => d.status === 'generating_tree',
      ).length,
      committing: distributions.filter((d) => d.status === 'committing').length,
      distributing: distributions.filter((d) => d.status === 'distributing')
        .length,
      completed: distributions.filter((d) => d.status === 'completed').length,
      failed: distributions.filter((d) => d.status === 'failed').length,
    };

    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      activeDistributions: this.activeDistributions.size,
      distributionStats: stats,
    };
  }

  /**
   * Clean up old completed/failed distributions
   */
  @Post('cleanup')
  async cleanup(@Body() body: { maxAgeHours?: number }) {
    try {
      const maxAgeHours = body.maxAgeHours || 24; // 24 hours default
      const maxAge = maxAgeHours * 60 * 60 * 1000;
      const cutoff = new Date(Date.now() - maxAge);

      let cleanedCount = 0;
      for (const [epochId, status] of this.activeDistributions.entries()) {
        const shouldClean =
          status.completedAt &&
          status.completedAt < cutoff &&
          (status.status === 'completed' || status.status === 'failed');

        if (shouldClean) {
          this.activeDistributions.delete(epochId);
          cleanedCount++;
        }
      }

      new TaskContext('method-call').logger.debug(
        `Cleaned up ${cleanedCount} old distributions`,
      );

      return {
        success: true,
        message: `Cleaned up ${cleanedCount} old distributions`,
        remaining: this.activeDistributions.size,
        cutoffAge: `${maxAgeHours} hours`,
      };
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `Cleanup failed: ${error.message}`,
      );
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get system status overview
   */
  @Get('status')
  async getSystemStatus() {
    try {
      const distributions = Array.from(this.activeDistributions.values());
      const active = distributions.filter((d) =>
        [
          'calculating',
          'generating_tree',
          'committing',
          'distributing',
        ].includes(d.status),
      ).length;

      return {
        success: true,
        status: 'operational',
        distributions: {
          active,
          completed: distributions.filter((d) => d.status === 'completed')
            .length,
          failed: distributions.filter((d) => d.status === 'failed').length,
          total: distributions.length,
        },
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `Failed to get system status: ${error.message}`,
      );
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Format distribution status for API responses
   */
  private formatStatus(status: DistributionStatus) {
    return {
      ...status,
      totalRewards: status.totalRewards.toString(),
      duration: status.completedAt
        ? status.completedAt.getTime() - status.startedAt.getTime()
        : Date.now() - status.startedAt.getTime(),
    };
  }

  /**
   * Get block scheduler status
   */
  @Get('scheduler/status')
  async getSchedulerStatus() {
    try {
      const status = this.blockSchedulerService.getStatus();
      const ctx = new TaskContext('admin:get-scheduler-status');
      const currentBlock = await this.web3Service.getL1BlockNumber(ctx);
      const lastRewardedBlock =
        await this.rewardsCalculatorService[
          'contractService'
        ].getLastRewardedBlock(ctx);

      return {
        success: true,
        scheduler: status,
        network: {
          currentBlock,
          lastRewardedBlock,
          blocksSinceLastReward: currentBlock - lastRewardedBlock,
        },
      };
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `Failed to get scheduler status: ${error.message}`,
      );
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Manually trigger approval check
   */
  @Post('scheduler/trigger-approval')
  async triggerApprovalCheck() {
    try {
      new TaskContext('method-call').logger.debug(
        '🔄 Manual approval trigger requested',
      );
      const result =
        await this.blockSchedulerService.triggerManualApprovalCheck();

      return {
        success: true,
        triggered: result,
        message: result
          ? 'Approval check completed successfully'
          : 'Approval check completed - no approval needed',
      };
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `Failed to trigger approval: ${error.message}`,
      );
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Manually trigger distribution check
   */
  @Post('scheduler/trigger-distribution')
  async triggerDistributionCheck() {
    try {
      new TaskContext('method-call').logger.debug(
        '🔄 Manual distribution trigger requested',
      );
      const result =
        await this.blockSchedulerService.triggerManualDistributionCheck();

      return {
        success: true,
        triggered: result,
        message: result
          ? 'Distribution check completed successfully'
          : 'Distribution check completed - no distribution needed',
      };
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `Failed to trigger distribution: ${error.message}`,
      );
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Manually trigger recovery check for stuck commitments
   */
  @Post('scheduler/trigger-recovery')
  async triggerRecoveryCheck() {
    try {
      new TaskContext('method-call').logger.debug(
        '🔄 Manual recovery trigger requested',
      );
      const result =
        await this.blockSchedulerService.triggerManualRecoveryCheck();

      return {
        success: true,
        triggered: result,
        message: result
          ? 'Recovery check completed successfully'
          : 'Recovery check completed - no stuck commitments found',
      };
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `Failed to trigger recovery: ${error.message}`,
      );
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Force commit phase for specific block range
   */
  @Post('scheduler/force-commit')
  async forceCommit(@Body() body: { fromBlock: number; toBlock: number }) {
    try {
      const { fromBlock, toBlock } = body;
      new TaskContext('method-call').logger.debug(
        `🔧 Force commit requested for ${fromBlock}-${toBlock}`,
      );

      const result = await this.blockSchedulerService.forceCommit(
        fromBlock,
        toBlock,
      );

      return {
        success: result,
        message: result
          ? `Commit completed for ${fromBlock}-${toBlock}`
          : 'Commit failed',
      };
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `Force commit failed: ${error.message}`,
      );
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Force distribution phase for specific block range
   */
  @Post('scheduler/force-distribution')
  async forceDistribution(
    @Body() body: { fromBlock: number; toBlock: number },
  ) {
    try {
      const { fromBlock, toBlock } = body;
      new TaskContext('method-call').logger.debug(
        `🔧 Force distribution requested for ${fromBlock}-${toBlock}`,
      );

      const result = await this.blockSchedulerService.forceDistribution(
        fromBlock,
        toBlock,
      );

      return {
        success: result,
        message: result
          ? `Distribution completed for ${fromBlock}-${toBlock}`
          : 'Distribution failed',
      };
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `Force distribution failed: ${error.message}`,
      );
      return {
        success: false,
        error: error.message,
      };
    }
  }

  @Get('network/apr-metrics')
  async getAPRMetrics() {
    try {
      const ctx = new TaskContext('admin:get-apr-metrics');
      new TaskContext('method-call').logger.debug(
        '📊 Calculating current APR metrics...',
      );

      // get network capacity metrics
      const activeWorkerCount =
        await this.web3Service.getActiveWorkerCount(ctx);
      const bondAmount = await this.web3Service.getBondAmount(ctx);

      // calc network capacity
      const WORKER_CAPACITY_TB = 1;
      const CHURN_FACTOR = 0.9;
      const actualCapacity =
        Number(activeWorkerCount) * WORKER_CAPACITY_TB * CHURN_FACTOR;
      const targetCapacity =
        Number(activeWorkerCount) * WORKER_CAPACITY_TB * 1.2; // 20% buffer

      // calc stake metrics
      const estimatedTotalStaked = activeWorkerCount * bondAmount * 3n; // 3x multiplier for delegation
      const estimatedTotalSupply = BigInt('10000000000') * BigInt(1e18); // 10B SQD total supply

      // calc utilization and stake factors
      const utilizationRate =
        targetCapacity > 0
          ? Math.max(0, (targetCapacity - actualCapacity) / targetCapacity)
          : 0;

      const stakeFactor =
        Number(estimatedTotalStaked) / Number(estimatedTotalSupply);

      // calc APR components
      const baseAPR = this.calculateBaseAPR(utilizationRate);
      const discountFactor = this.calculateStakeDiscountFactor(stakeFactor);
      const finalAPR = baseAPR * discountFactor;

      new TaskContext('method-call').logger.debug(
        `✅ APR metrics calculated successfully`,
      );

      return {
        success: true,
        networkMetrics: {
          activeWorkers: Number(activeWorkerCount),
          bondAmount: bondAmount.toString(),
          actualCapacity: `${actualCapacity.toFixed(2)} TB`,
          targetCapacity: `${targetCapacity.toFixed(2)} TB`,
          utilizationRate: `${(utilizationRate * 100).toFixed(2)}%`,
        },
        stakeMetrics: {
          estimatedTotalStaked: `${(Number(estimatedTotalStaked) / 1e18).toLocaleString()} SQD`,
          estimatedTotalSupply: `${(Number(estimatedTotalSupply) / 1e18).toLocaleString()} SQD`,
          stakeFactor: `${(stakeFactor * 100).toFixed(2)}%`,
        },
        aprCalculation: {
          baseAPR: `${(baseAPR * 100).toFixed(2)}%`,
          discountFactor: discountFactor.toFixed(4),
          finalAPR: `${(finalAPR * 100).toFixed(2)}%`,
        },
        aprRanges: {
          description: 'APR ranges based on utilization',
          lowUtilization: '5% - 20% (under-utilized network)',
          optimalRange: '20% (balanced network)',
          highUtilization: '20% - 70% (over-utilized network)',
          stakeDiscount: 'Applied when >25% of supply is staked',
        },
        calculations: {
          utilizationFormula:
            'u_rate = (target_capacity - actual_capacity) / target_capacity',
          stakeFormula: 'stake_factor = total_staked / total_supply',
          aprFormula:
            'final_APR = base_apr(u_rate) * discount_factor(stake_factor)',
        },
      };
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `Failed to get APR metrics: ${error.message}`,
      );
      return {
        success: false,
        error: error.message,
      };
    }
  }

  // helper methods for APR calculation (duplicated from RewardsCalculatorService for admin endpoint)
  private calculateBaseAPR(utilizationRate: number): number {
    const BASE_APR = 0.2; // 20%
    const MIN_APR = 0.05; // 5%
    const MAX_APR = 0.7; // 70%

    if (utilizationRate <= 0.1) {
      return Math.max(MIN_APR, BASE_APR * (1 - (0.1 - utilizationRate) * 2));
    } else if (utilizationRate <= 0.2) {
      return BASE_APR;
    } else {
      const scalingFactor = Math.min(3.5, 1 + (utilizationRate - 0.2) * 5);
      return Math.min(MAX_APR, BASE_APR * scalingFactor);
    }
  }

  private calculateStakeDiscountFactor(stakeFactor: number): number {
    const OPTIMAL_STAKE_FACTOR = 0.25; // 25%

    if (stakeFactor <= OPTIMAL_STAKE_FACTOR) {
      return 1.0;
    }

    const excessStake = stakeFactor - OPTIMAL_STAKE_FACTOR;
    const maxExcess = 0.75;
    const discountRate = 0.9;

    return Math.max(0.1, 1.0 - (excessStake / maxExcess) * discountRate);
  }
}
