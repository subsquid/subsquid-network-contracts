import { Controller, Get, Post, Query, Body, Param, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { RewardsCalculatorService } from '../../rewards/calculation/rewards-calculator.service';
import { DistributionService, DistributionStatus } from '../../rewards/distribution/distribution.service';
import { ClickHouseService } from '../../database/clickhouse.service';
import { Web3Service } from '../../blockchain/web3.service';
// todo: add protection for admin endpoints

export interface ManualDistributionRequest {
  fromBlock: number;
  toBlock: number;
  batchSize?: number;
}

export interface DebugWorkerInfo {
  peerId: string;
  peerIdShort: string;
  contractWorkerId: string;
  isRegistered: boolean;
  totalRequests: number;
  outputSize: number;
  chunksRead: number;
}

export interface DebugRegistrationInfo {
  workerId: string;
  peerId: string;
  peerIdShort: string;
  registrar: string;
  registeredAt: string;
  metadata: string;
}

@Controller('admin')
export class AdminController {
  private readonly logger = new Logger(AdminController.name);
  
  // Store active distributions in memory for demo purposes
  private activeDistributions = new Map<string, DistributionStatus>();

  constructor(
    private rewardsCalculatorService: RewardsCalculatorService,
    private distributionService: DistributionService,
    private clickHouseService: ClickHouseService,
    private web3Service: Web3Service,
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
    const fromBlockNum = parseInt(fromBlock, 10);
    const toBlockNum = parseInt(toBlock, 10);
    const limitNum = limit ? parseInt(limit, 10) : undefined;

    try {
      const rewards = await this.rewardsCalculatorService.calculateEpochRewards(
        fromBlockNum,
        toBlockNum,
        true, // skip signature validation for development
      );

      const result = limitNum ? rewards.slice(0, limitNum) : rewards;

      return {
        success: true,
        fromBlock: fromBlockNum,
        toBlock: toBlockNum,
        totalWorkers: rewards.length,
        returnedWorkers: result.length,
        totalRewards: rewards.reduce((sum, w) => sum + w.workerReward, 0n).toString(),
        workers: result.map(w => ({
          workerId: w.workerId.toString(),
          workerReward: w.workerReward.toString(),
          stakerReward: w.stakerReward.toString(),
          stake: w.stake.toString(),
          totalStake: w.totalStake.toString(),
        })),
      };
    } catch (error) {
      this.logger.error(`Failed to calculate rewards: ${error.message}`);
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
        throw new HttpException('Invalid block range: fromBlock must be less than toBlock', HttpStatus.BAD_REQUEST);
      }

      // Check if already running
      if (this.activeDistributions.has(epochId)) {
        const existing = this.activeDistributions.get(epochId);
        if (existing && existing.status !== 'completed' && existing.status !== 'failed') {
          return {
            success: false,
            error: 'Distribution already running for this epoch',
            status: this.formatStatus(existing),
          };
        }
      }

      this.logger.log(`🚀 Starting distribution for epoch ${epochId}`);

      // Start distribution in background
      const distributionPromise = this.distributionService.distributeEpochRewards(
        fromBlock,
        toBlock,
        batchSize
      );

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

      // Update status when complete
      distributionPromise.then(finalStatus => {
        this.activeDistributions.set(epochId, finalStatus);
        this.logger.log(`✅ Distribution completed for epoch ${epochId}: ${finalStatus.status}`);
      }).catch(error => {
        const errorStatus: DistributionStatus = {
          ...initialStatus,
          status: 'failed',
          error: error.message,
          completedAt: new Date(),
        };
        this.activeDistributions.set(epochId, errorStatus);
        this.logger.error(`❌ Distribution failed for epoch ${epochId}: ${error.message}`);
      });

      return {
        success: true,
        message: 'Distribution started successfully',
        epochId,
        status: this.formatStatus(initialStatus),
      };

    } catch (error) {
      this.logger.error(`Failed to start distribution: ${error.message}`);
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
      this.logger.error(`Failed to get distribution status: ${error.message}`);
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
        distributions = distributions.filter(d => d.status === status);
      }

      distributions.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

      const maxResults = limit ? parseInt(limit, 10) : 50;
      const result = distributions.slice(0, maxResults);

      return {
        success: true,
        distributions: result.map(d => this.formatStatus(d)),
        total: distributions.length,
        returned: result.length,
      };
    } catch (error) {
      this.logger.error(`Failed to get distributions: ${error.message}`);
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

      const contractStatus = await this.distributionService.getDistributionStatus(
        fromBlockNum,
        toBlockNum
      );

      return {
        success: true,
        contractStatus,
        epoch: `${fromBlockNum}-${toBlockNum}`,
      };
    } catch (error) {
      this.logger.error(`Failed to get contract status: ${error.message}`);
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
    try {
      const bondAmount = await this.rewardsCalculatorService['web3Service'].getBondAmount();
      const activeWorkerCount = await this.rewardsCalculatorService['web3Service'].getActiveWorkerCount();
      
      return {
        success: true,
        bondAmount: bondAmount.toString(),
        bondAmountSQD: Number(bondAmount) / 1e18,
        activeWorkerCount: activeWorkerCount.toString(),
        contractAddress: this.rewardsCalculatorService['configService'].get('blockchain.contracts.workerRegistration'),
             };
     } catch (error) {
       this.logger.error(`Failed to get WorkerRegistration status: ${error.message}`);
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
      calculating: distributions.filter(d => d.status === 'calculating').length,
      generating_tree: distributions.filter(d => d.status === 'generating_tree').length,
      committing: distributions.filter(d => d.status === 'committing').length,
      distributing: distributions.filter(d => d.status === 'distributing').length,
      completed: distributions.filter(d => d.status === 'completed').length,
      failed: distributions.filter(d => d.status === 'failed').length,
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
        const shouldClean = status.completedAt && 
                           status.completedAt < cutoff && 
                           (status.status === 'completed' || status.status === 'failed');
        
        if (shouldClean) {
          this.activeDistributions.delete(epochId);
          cleanedCount++;
        }
      }

      this.logger.log(`Cleaned up ${cleanedCount} old distributions`);

      return {
        success: true,
        message: `Cleaned up ${cleanedCount} old distributions`,
        remaining: this.activeDistributions.size,
        cutoffAge: `${maxAgeHours} hours`,
      };
    } catch (error) {
      this.logger.error(`Cleanup failed: ${error.message}`);
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
      const active = distributions.filter(d => 
        ['calculating', 'generating_tree', 'committing', 'distributing'].includes(d.status)
      ).length;

      return {
        success: true,
        status: 'operational',
        distributions: {
          active,
          completed: distributions.filter(d => d.status === 'completed').length,
          failed: distributions.filter(d => d.status === 'failed').length,
          total: distributions.length,
        },
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error(`Failed to get system status: ${error.message}`);
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

  @Get('debug/worker-states')
  async debugWorkerStates(@Query('sampleSize') sampleSize?: string) {
    try {
      const size = sampleSize ? parseInt(sampleSize) : 10;
      
      // Get sample workers from ClickHouse for the last 7 days
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 7 * 24 * 60 * 60 * 1000);
      const allWorkers = await this.clickHouseService.getActiveWorkers(startTime, endTime, true);
      const sampleWorkers = allWorkers.slice(0, size);
      
      this.logger.log(`🔍 Debugging ${size} workers from ClickHouse (out of ${allWorkers.length} total)`);
      
      // Check their registration status
      const workerIds = await this.web3Service.preloadWorkerIds(
        sampleWorkers.map(w => w.worker_id)
      );
      
      const debugInfo: DebugWorkerInfo[] = [];
      for (const worker of sampleWorkers) {
        const contractWorkerId = workerIds[worker.worker_id];
        const isRegistered = contractWorkerId && contractWorkerId !== 0n;
        
        debugInfo.push({
          peerId: worker.worker_id,
          peerIdShort: `${worker.worker_id.slice(0, 10)}...${worker.worker_id.slice(-10)}`,
          contractWorkerId: contractWorkerId?.toString() || 'null',
          isRegistered: Boolean(isRegistered),
          totalRequests: worker.totalRequests,
          outputSize: worker.output_size,
          chunksRead: worker.num_read_chunks,
        });
      }
      
      const registeredCount = debugInfo.filter(w => w.isRegistered).length;
      const totalClickHouseWorkers = allWorkers.length;
      
      this.logger.log(`📊 Registration Summary:`);
      this.logger.log(`  Total workers in ClickHouse: ${totalClickHouseWorkers}`);
      this.logger.log(`  Sample checked: ${debugInfo.length}`);
      this.logger.log(`  Registered in contract: ${registeredCount}`);
      this.logger.log(`  Registration rate: ${((registeredCount / debugInfo.length) * 100).toFixed(1)}%`);
      
      return {
        summary: {
          totalWorkersInClickHouse: totalClickHouseWorkers,
          sampleChecked: debugInfo.length,
          registeredInContract: registeredCount,
          registrationRate: `${((registeredCount / debugInfo.length) * 100).toFixed(1)}%`,
        },
        workerDetails: debugInfo,
        note: registeredCount === 0 
          ? "⚠️  No workers are currently registered. This explains why distribution fails with 'Cannot build Merkle tree with no leaves'"
          : `✅ Found ${registeredCount} registered workers that can receive rewards`,
      };
      
    } catch (error) {
      this.logger.error(`Failed to debug worker states: ${error.message}`);
      throw new Error(`Debug failed: ${error.message}`);
    }
  }

  @Get('debug/recent-registrations')
  async debugRecentRegistrations(@Query('limit') limit?: string) {
    try {
      const maxResults = limit ? parseInt(limit) : 50;
      
      // Get recent registration events from the blockchain
      const registrations = await this.web3Service.getRegistrations();
      const recentRegistrations = registrations
        .sort((a, b) => Number(b.registeredAt) - Number(a.registeredAt))
        .slice(0, maxResults);
        
      this.logger.log(`📋 Found ${recentRegistrations.length} recent registrations (out of ${registrations.length} total)`);
      
      const debugInfo: DebugRegistrationInfo[] = [];
      for (const reg of recentRegistrations) {
        // convert hex peerId back to base58 for comparison
        const peerIdBase58 = this.hexToBase58(reg.peerId);
        
        debugInfo.push({
          workerId: reg.workerId.toString(),
          peerId: peerIdBase58,
          peerIdShort: `${peerIdBase58.slice(0, 10)}...${peerIdBase58.slice(-10)}`,
          registrar: reg.registrar,
          registeredAt: reg.registeredAt.toString(),
          metadata: reg.metadata,
        });
      }
      
      return {
        summary: {
          totalRegistrations: registrations.length,
          recentShown: debugInfo.length,
        },
        recentRegistrations: debugInfo,
        note: "These are workers that have registered at some point. Check if they're still active with /debug/worker-states",
      };
      
    } catch (error) {
      this.logger.error(`Failed to debug recent registrations: ${error.message}`);
      throw new Error(`Debug failed: ${error.message}`);
    }
  }

  private hexToBase58(hex: string): string {
    try {
      // Remove 0x prefix and convert to Buffer
      const buffer = Buffer.from(hex.replace('0x', ''), 'hex');
      
      // Simple base58 encoding
      const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
      const base = BigInt(alphabet.length);
      
      let value = BigInt('0x' + buffer.toString('hex'));
      let result = '';
      
      while (value > 0) {
        const remainder = value % base;
        result = alphabet[Number(remainder)] + result;
        value = value / base;
      }
      
      // add leading zeros
      for (let i = 0; i < buffer.length && buffer[i] === 0; i++) {
        result = alphabet[0] + result;
      }
      
      return result || alphabet[0];
    } catch (error) {
      this.logger.error(`Failed to convert hex to base58: ${error.message}`);
      return hex; // return original hex on error
    }
  }

  @Get('network/apr-metrics')
  async getAPRMetrics() {
    try {
      this.logger.log('📊 Calculating current APR metrics...');
      
      // get network capacity metrics
      const activeWorkerCount = await this.web3Service.getActiveWorkerCount();
      const bondAmount = await this.web3Service.getBondAmount();
      
      // calc network capacity
      const WORKER_CAPACITY_TB = 1;
      const CHURN_FACTOR = 0.9;
      const actualCapacity = Number(activeWorkerCount) * WORKER_CAPACITY_TB * CHURN_FACTOR;
      const targetCapacity = Number(activeWorkerCount) * WORKER_CAPACITY_TB * 1.2; // 20% buffer
      
      // calc stake metrics
      const estimatedTotalStaked = activeWorkerCount * bondAmount * 3n; // 3x multiplier for delegation
      const estimatedTotalSupply = BigInt('10000000000') * BigInt(1e18); // 10B SQD total supply
      
      // calc utilization and stake factors
      const utilizationRate = targetCapacity > 0 
        ? Math.max(0, (targetCapacity - actualCapacity) / targetCapacity)
        : 0;
      
      const stakeFactor = Number(estimatedTotalStaked) / Number(estimatedTotalSupply);
      
      // calc APR components
      const baseAPR = this.calculateBaseAPR(utilizationRate);
      const discountFactor = this.calculateStakeDiscountFactor(stakeFactor);
      const finalAPR = baseAPR * discountFactor;
      
      this.logger.log(`✅ APR metrics calculated successfully`);
      
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
          description: "APR ranges based on utilization",
          lowUtilization: "5% - 20% (under-utilized network)",
          optimalRange: "20% (balanced network)",
          highUtilization: "20% - 70% (over-utilized network)",
          stakeDiscount: "Applied when >25% of supply is staked",
        },
        calculations: {
          utilizationFormula: "u_rate = (target_capacity - actual_capacity) / target_capacity",
          stakeFormula: "stake_factor = total_staked / total_supply",
          aprFormula: "final_APR = base_apr(u_rate) * discount_factor(stake_factor)",
        },
      };
      
    } catch (error) {
      this.logger.error(`Failed to get APR metrics: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  // helper methods for APR calculation (duplicated from RewardsCalculatorService for admin endpoint)
  private calculateBaseAPR(utilizationRate: number): number {
    const BASE_APR = 0.20; // 20%
    const MIN_APR = 0.05;  // 5%
    const MAX_APR = 0.70;  // 70%

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