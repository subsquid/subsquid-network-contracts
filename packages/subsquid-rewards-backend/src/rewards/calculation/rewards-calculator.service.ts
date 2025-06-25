import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClickHouseService, WorkerQueryData } from '../../database/clickhouse.service';
import { Web3Service } from '../../blockchain/web3.service';
import { ContractService } from '../../blockchain/contract.service';

export interface WorkerReward {
  workerId: bigint;
  id: bigint;
  workerReward: bigint;
  stakerReward: bigint;
  stake: bigint;
  totalStake: bigint;
}

export interface RewardCalculationResult {
  workers: WorkerReward[];
  totalRewards: bigint;
  calculationTime: number;
}

@Injectable()
export class RewardsCalculatorService {
  private readonly logger = new Logger(RewardsCalculatorService.name);

  constructor(
    private configService: ConfigService,
    private clickHouseService: ClickHouseService,
    private web3Service: Web3Service,
    private contractService: ContractService,
  ) {}

  async calculateEpochRewards(
    fromBlock: number,
    toBlock: number,
    skipSignatureValidation?: boolean,
  ): Promise<WorkerReward[]> {
    const shouldSkipValidation = skipSignatureValidation ?? this.configService.get('rewards.skipSignatureValidation', true);
    
    if (shouldSkipValidation) {
      this.logger.warn('🚨 Signature validation is DISABLED - this is for development/testing only');
    }
    
    const result = await this.calculateRewardsDetailed(fromBlock, toBlock, shouldSkipValidation);
    return result.workers;
  }

  async calculateRewardsDetailed(
    fromBlock: number,
    toBlock: number,
    skipSignatureValidation?: boolean,
  ): Promise<RewardCalculationResult> {
    const shouldSkipValidation = skipSignatureValidation ?? this.configService.get('rewards.skipSignatureValidation', true);
    
    return this.calculateRewards(fromBlock, toBlock, shouldSkipValidation);
  }

  private async calculateRewards(
    fromBlock: number,
    toBlock: number,
    skipSignatureValidation = true,   
  ): Promise<RewardCalculationResult> {
    try {
      this.logger.log(`Calculating rewards for epoch ${fromBlock} - ${toBlock}`);
      
      if (skipSignatureValidation) {
        this.logger.warn('⚠️  Signature validation skipped - using all worker data without verification');
      }

      // get timestamp range for the epoch
      const startTime = await this.web3Service.getBlockTimestamp(fromBlock);
      const endTime = await this.web3Service.getBlockTimestamp(toBlock);
      
      this.logger.log(`Epoch time range: ${startTime.toISOString()} - ${endTime.toISOString()}`);

      // get active workers from ClickHouse
      const activeWorkerData = await this.clickHouseService.getActiveWorkers(
        startTime,
        endTime,
        skipSignatureValidation,
      );

      if (activeWorkerData.length === 0) {
        this.logger.warn('No active workers found for this epoch');
        return this.createEmptyResult(fromBlock, toBlock, startTime, endTime);
      }

      this.logger.log(`Found ${activeWorkerData.length} active workers from ClickHouse`);

      // get worker IDs and filter out unknown workers
      const workerIds = activeWorkerData.map(w => w.worker_id);
      
      // @dev: skip worker registration validation if using sample data
      let validWorkers = activeWorkerData;
      
      if (!skipSignatureValidation) {
        const registeredWorkerIds = await this.web3Service.preloadWorkerIds(workerIds);
        validWorkers = activeWorkerData.filter(w => registeredWorkerIds[w.worker_id] !== undefined);
        this.logger.log(`Found ${validWorkers.length} valid workers out of ${activeWorkerData.length} active`);
      } else {
        this.logger.log(`Using all ${activeWorkerData.length} workers (registration check skipped)`);
      }

      // @dev: if no valid workers from contract, use sample data
      if (validWorkers.length === 0 && skipSignatureValidation) {
        this.logger.warn('🔧 No registered workers found - using sample data for development testing');
        return this.createSampleResult(fromBlock, toBlock, startTime, endTime, activeWorkerData);
      }

      // get stakes for valid workers
      let capedStakes: any[] = [];
      let totalStakes: any[] = [];
      
      try {
        [capedStakes, totalStakes] = await this.contractService.getStakes(
          validWorkers.map(w => w.worker_id),
        );
      } catch (error) {
        this.logger.warn(`Failed to get stakes from contract: ${error.message}`);
        if (skipSignatureValidation) {
          // @dev: use def stakes for development testing
          capedStakes = validWorkers.map(() => ({ result: BigInt('10000000000000000000') })); // 10 SQD
          totalStakes = validWorkers.map(() => ({ result: BigInt('10000000000000000000') })); // 10 SQD
          this.logger.log('Using default stakes for development testing');
        } else {
          throw error;
        }
      }

      // get bond amount from WorkerRegistration contract
      let bondAmount: bigint;
      try {
        bondAmount = await this.web3Service.getBondAmount();
        this.logger.log(`✅ Retrieved bond amount from WorkerRegistration contract: ${Number(bondAmount) / 1e18} SQD`);
      } catch (error) {
        this.logger.warn(`Failed to get bond amount from WorkerRegistration: ${error.message}`);
        // fallback to contract service
        try {
          bondAmount = await this.contractService.getBondAmount();  
          this.logger.log('Using bond amount from fallback contract service');
        } catch (fallbackError) {
          this.logger.warn(`Fallback also failed: ${fallbackError.message}`);
          bondAmount = BigInt('100000000000000000000000'); // 100k SQD default
          this.logger.log('Using default bond amount (1 SQD) for development testing');
        }
      }

      // calc liveness factors
      const livenessFactor = await this.clickHouseService.calculateLivenessFactor(startTime, endTime);

      // calc dynamic APR based on network utilization and stake factors
      let baseApr: number;
      try {
        const { targetCapacity, actualCapacity } = await this.calculateNetworkCapacity();
        const { totalStakedSupply, totalSupply } = await this.getStakeMetrics();
        
        baseApr = await this.calculateDynamicAPR(totalStakedSupply, totalSupply, targetCapacity, actualCapacity);
        
        this.logger.log(`✅ Using dynamic APR: ${(baseApr * 100).toFixed(2)}%`);
      } catch (error) {
        this.logger.warn(`Failed to calculate dynamic APR: ${error.message}`);
        
        // fallback: try to get from contract service
        try {
          const currentApy = await this.contractService.getCurrentApy();
          baseApr = Number(currentApy) / 100; // convert basis points to percentage
          this.logger.log(`Using contract APY fallback: ${(baseApr * 100).toFixed(2)}%`);
        } catch (contractError) {
          baseApr = 0.15; // 15% final fallback for dev testing
          this.logger.log('Using hardcoded APR (15%) as final fallback');
        }
      }

      const workers = await this.calculateIndividualRewards(
        validWorkers,
        capedStakes,
        totalStakes,
        bondAmount,
        livenessFactor,
        baseApr,
        startTime,
        endTime,
      );

      const stakeFactor = this.calculateStakeFactor(workers);
      const rAPR = baseApr; // for now, same as base APR

      this.logger.log(`✅ Calculated rewards for ${workers.length} workers, total: ${workers.reduce((sum, w) => sum + w.workerReward, 0n)} wei`);

      return {
        workers,
        totalRewards: workers.reduce((sum, w) => sum + w.workerReward, 0n),
        calculationTime: (endTime.getTime() - startTime.getTime()) / 1000,
      };
    } catch (error) {
      this.logger.error(`Failed to calculate epoch rewards: ${error.message}`);
      throw error;
    }
  }

  async calculateIndividualRewards(
    workerData: WorkerQueryData[],
    capedStakes: any[],
    totalStakes: any[],
    bondAmount: bigint,
    livenessFactor: Record<string, any>,
    baseApr: number,
    startTime: Date,
    endTime: Date,
  ): Promise<WorkerReward[]> {
    const rewards: WorkerReward[] = [];
    
    this.logger.log(`\n=== Calculating Individual Rewards ===`);
    this.logger.log(`Worker data length: ${workerData.length}`);
    this.logger.log(`Caped stakes length: ${capedStakes.length}`);
    this.logger.log(`Total stakes length: ${totalStakes.length}`);

    // @dev: we process all workers and use -> hash-based ID for calculations
    // @dev: the actual contract worker ID mapping will be done during dist phase
    this.logger.log(`Processing rewards for ${workerData.length} workers`);

    for (let i = 0; i < workerData.length; i++) {
      const worker = workerData[i];
      // ensure stakes are properly converted to bigint 
      const capedStake = BigInt(capedStakes[i]?.result || 0);
      const totalStake = BigInt(totalStakes[i]?.result || 0);

      // se a simple sequential ID or hash-based ID
      // his will be mapped to actual contract worker IDs during distribution
      const calculationWorkerId = BigInt(i + 1); // Simple sequential ID for calculations

      const liveness = livenessFactor[worker.worker_id]?.livenessFactor || 0;

      // calculate traffic factor based on chunks read and bytes sent
      const trafficFactor = this.calculateTrafficFactor(worker, workerData);
      
      // calculate tenure factor (simplified for now)
      const tenureFactor = 1.0; // plch - would need historical data
      
      // calculate reward components
      const stakingReward = this.calculateStakingReward(
        capedStake,
        totalStake,
        baseApr,
        (endTime.getTime() - startTime.getTime()) / 1000,
        365 * 24 * 60 * 60,
      );
      
      const performanceMultiplier = liveness * trafficFactor * tenureFactor;
      
      const performanceMultiplierBigInt = BigInt(Math.floor(performanceMultiplier * 1_000_000));
      const finalWorkerReward = (stakingReward * performanceMultiplierBigInt) / 1_000_000n;
      
      let calculatedStakerReward: bigint;
      try {
      if (totalStake > capedStake && totalStake !== 0n) {
        const stakeDifference = totalStake - capedStake;
          calculatedStakerReward = (stakingReward * stakeDifference) / totalStake;
      } else {
          calculatedStakerReward = 0n;
        }
      } catch (error) {
        this.logger.error(`BigInt calculation error in staker reward: ${error.message}`);
        calculatedStakerReward = 0n;
      }

      // log details for first 3 workers to debug
      if (i < 3) {
        this.logger.log(`\n--- Worker ${i + 1}: ${worker.worker_id.slice(0, 20)}... ---`);
        this.logger.log(`  Input data:`);
        this.logger.log(`    - Chunks read: ${worker.num_read_chunks}`);
        this.logger.log(`    - Bytes sent: ${worker.output_size}`);
        this.logger.log(`    - Total requests: ${worker.totalRequests}`);
        this.logger.log(`  Stakes:`);
        this.logger.log(`    - Capped stake: ${capedStake} wei (${Number(capedStake) / 1e18} SQD)`);
        this.logger.log(`    - Total stake: ${totalStake} wei (${Number(totalStake) / 1e18} SQD)`);
        this.logger.log(`  Performance factors:`);
        this.logger.log(`    - Liveness: ${liveness}`);
        this.logger.log(`    - Traffic factor: ${trafficFactor}`);
        this.logger.log(`    - Tenure factor: ${tenureFactor}`);
        this.logger.log(`    - Combined multiplier: ${performanceMultiplier}`);
        this.logger.log(`    - Multiplier as BigInt: ${performanceMultiplierBigInt}/1,000,000`);
        this.logger.log(`  Reward calculation:`);
        this.logger.log(`    - Base staking reward: ${stakingReward} wei (${Number(stakingReward) / 1e18} SQD)`);
        this.logger.log(`    - Final worker reward: ${finalWorkerReward} wei (${Number(finalWorkerReward) / 1e18} SQD)`);
        this.logger.log(`    - Staker reward: ${calculatedStakerReward} wei (${Number(calculatedStakerReward) / 1e18} SQD)`);
      }

      rewards.push({
        workerId: calculationWorkerId, // sequential ID for calculations
        id: BigInt(i), // sequential ID for this calculation
        workerReward: finalWorkerReward,
        stakerReward: calculatedStakerReward,
        stake: capedStake,
        totalStake,
      });
    }

    const totalRewards = rewards.reduce((sum, w) => sum + w.workerReward, 0n);
    this.logger.log(`\n=== Calculation Summary ===`);
    this.logger.log(`Total rewards calculated: ${totalRewards} wei (${Number(totalRewards) / 1e18} SQD)`);
    this.logger.log(`Average reward per worker: ${Number(totalRewards) / rewards.length / 1e18} SQD`);

    return rewards;
  }

  private calculateTrafficFactor(worker: WorkerQueryData, allWorkers: WorkerQueryData[]): number {
    // calculate total traffic across all workers
    const totalBytes = allWorkers.reduce((sum, w) => sum + Number(w.output_size), 0);
    const totalChunks = allWorkers.reduce((sum, w) => sum + Number(w.num_read_chunks), 0);
    
    if (totalBytes === 0 || totalChunks === 0) {
      return 1.0; // if no traffic data, give neutral factor
    }

    // calculate this worker's relative contribution
    const workerBytes = Number(worker.output_size);
    const workerChunks = Number(worker.num_read_chunks);
    
    const bytesFactor = workerBytes / totalBytes;
    const chunksFactor = workerChunks / totalChunks;
    
    // average the two factors 
    const trafficFactor = (bytesFactor + chunksFactor) / 2;
    
    if (allWorkers.indexOf(worker) < 3) {
      this.logger.debug(`Traffic calc for worker ${worker.worker_id.slice(0, 20)}:`);
      this.logger.debug(`  Worker: ${workerChunks} chunks, ${workerBytes} bytes`);
      this.logger.debug(`  Total: ${totalChunks} chunks, ${totalBytes} bytes`);
      this.logger.debug(`  Factors: chunks=${chunksFactor.toFixed(6)}, bytes=${bytesFactor.toFixed(6)}`);
      this.logger.debug(`  Final traffic factor: ${trafficFactor.toFixed(6)}`);
    }
    
    // cap between reasonable bounds (0.001 to 2.0)
    return Math.max(0.001, Math.min(2.0, trafficFactor));
  }

  private calculateStakingReward(
    capedStake: bigint,
    totalStake: bigint,
    baseApr: number,
    duration: number,
    yearSeconds: number,
  ): bigint {
    if (capedStake === 0n) {
      return 0n;
    }

    try {
    const aprScaled = BigInt(Math.floor(baseApr * 1e18)); // scale APR by 1e18
      const durationBigInt = BigInt(Math.floor(duration));
      const yearSecondsBigInt = BigInt(Math.floor(yearSeconds));
      const scalingFactor = BigInt(1e18);
    
    // calculate: stake * APR * duration / year_seconds
    // all in BigInt with 1e18 precision scaling
      const rewardScaled = (capedStake * aprScaled * durationBigInt) / (yearSecondsBigInt * scalingFactor);
    
    this.logger.debug(`Staking reward calc: stake=${capedStake}, APR=${baseApr}, duration=${duration}s, result=${rewardScaled}`);
    
    return rewardScaled;
    } catch (error) {
      this.logger.error(`BigInt calculation error in calculateStakingReward: ${error.message}`);
      this.logger.error(`  capedStake: ${capedStake}, baseApr: ${baseApr}, duration: ${duration}, yearSeconds: ${yearSeconds}`);
      return 0n; // Return 0 on error to prevent crash
    }
  }

  private calculateStakeFactor(workers: WorkerReward[]): number {
    if (workers.length === 0) {
      return 1.0;
    }

    const totalStake = workers.reduce((sum, w) => sum + w.stake, 0n);
    const totalRewards = workers.reduce((sum, w) => sum + w.workerReward, 0n);
    
    if (totalStake === 0n) {
      return 1.0;
    }

    // simple stake factor calculation
    return Number(totalRewards) / Number(totalStake);
  }

  private createEmptyResult(
    fromBlock: number,
    toBlock: number,
    startTime: Date,
    endTime: Date,
  ): RewardCalculationResult {
    return {
      workers: [],
      totalRewards: 0n,
      calculationTime: (endTime.getTime() - startTime.getTime()) / 1000,
    };
  }

  private createSampleResult(
    fromBlock: number,
    toBlock: number,
    startTime: Date,
    endTime: Date,
    activeWorkerData: WorkerQueryData[],
  ): RewardCalculationResult {
    this.logger.log('Creating sample result for development testing');
    
    //  sample rewards for active workers 
    const sampleWorkers: WorkerReward[] = activeWorkerData.slice(0, 5).map((worker, index) => {
      // simple reward calculation: 1 SQD per 1000 requests
      const baseReward = BigInt(Math.floor(worker.totalRequests / 1000)) * BigInt('1000000000000000000'); // 1 SQD = 1e18 wei
      const stakerReward = baseReward / 10n; // 10% for stakers

      return {
        workerId: BigInt(index + 1), // sequential IDs for testing
        id: BigInt(index + 1),  
        workerReward: baseReward,
        stakerReward: stakerReward,
        stake: BigInt('10000000000000000000'), // 10 SQD default stake
        totalStake: BigInt('10000000000000000000'),
      };
    });

    const totalRewards = sampleWorkers.reduce((sum, w) => sum + w.workerReward, 0n);
    
    this.logger.log(`📋 Generated ${sampleWorkers.length} sample workers with ${totalRewards} wei total rewards`);
    
    return {
      workers: sampleWorkers,
      totalRewards,
      calculationTime: (endTime.getTime() - startTime.getTime()) / 1000,
    };
  }

  async filterWorkersBatch(workers: WorkerReward[], batchNumber: number, totalBatches: number): Promise<WorkerReward[]> {
    //  batch filtering based on peer ID modulo like in the original
    // for now, simple modulo on worker ID
    const filtered = workers.filter((_, index) => index % totalBatches === batchNumber);
    this.logger.log(`Filtered ${filtered.length} workers for batch ${batchNumber}/${totalBatches}`);
    return filtered;
  }

  async mapToContractWorkerIds(
    workers: WorkerReward[], 
    workerData: WorkerQueryData[]
  ): Promise<WorkerReward[]> {
    try {
      // get the mapping from peer IDs to actual contract worker IDs
      const peerIds = workerData.map(worker => worker.worker_id);
      const workerIdMapping = await this.web3Service.preloadWorkerIds(peerIds);
      
      const mappedWorkers: WorkerReward[] = [];
      
      for (let i = 0; i < workers.length && i < workerData.length; i++) {
        const worker = workers[i];
        const workerInfo = workerData[i];
        const contractWorkerId = workerIdMapping[workerInfo.worker_id];
        
        if (!contractWorkerId || contractWorkerId === 0n) {
          this.logger.warn(`Skipping worker ${workerInfo.worker_id} - not registered in contract`);
          continue;
        }
        
        // map to actual contract worker ID
        mappedWorkers.push({
          ...worker,
          workerId: contractWorkerId, // use actual contract worker ID
        });
      }
      
      this.logger.log(`Mapped ${mappedWorkers.length} workers out of ${workers.length} calculated workers to contract IDs`);
      return mappedWorkers;
      
    } catch (error) {
      this.logger.error(`Failed to map worker IDs to contract: ${error.message}`);
      throw error;
    }
  }

  /**
   * calculate dynamic APR based on network utilization and stake factors
   * following Tokenomics 2.1 specification
   */
  private async calculateDynamicAPR(
    totalStakedSupply: bigint,
    totalSupply: bigint,
    targetCapacity: number,
    actualCapacity: number,
  ): Promise<number> {
    // calculate utilization rate: u_rate = (target_capacity - actual_capacity) / target_capacity
    const utilizationRate = targetCapacity > 0 
      ? Math.max(0, (targetCapacity - actualCapacity) / targetCapacity)
      : 0;

    // calculate stake factor: percentage of total supply that is staked
    const stakeFactor = totalSupply > 0n 
      ? Number(totalStakedSupply) / Number(totalSupply)
      : 0;

    this.logger.log(`📊 APR Calculation Inputs:`);
    this.logger.log(`  Utilization rate: ${(utilizationRate * 100).toFixed(2)}%`);
    this.logger.log(`  Stake factor: ${(stakeFactor * 100).toFixed(2)}%`);
    this.logger.log(`  Target capacity: ${targetCapacity} TB`);
    this.logger.log(`  Actual capacity: ${actualCapacity} TB`);

    // base APR calculation: balanced at 20%, scales 5%-70% based on utilization
    const baseAPR = this.calculateBaseAPR(utilizationRate);
    
    // discount factor based on stake percentage (reduces rewards if >25% staked)
    const discountFactor = this.calculateStakeDiscountFactor(stakeFactor);
    
    // final APR
    const finalAPR = baseAPR * discountFactor;

    this.logger.log(`📈 APR Calculation Results:`);
    this.logger.log(`  Base APR: ${(baseAPR * 100).toFixed(2)}%`);
    this.logger.log(`  Discount factor: ${discountFactor.toFixed(4)}`);
    this.logger.log(`  Final APR: ${(finalAPR * 100).toFixed(2)}%`);

    return finalAPR;
  }

  // calc base APR based on network utilization
  // 20% balanced, 5%-70% range based on capacity needs
  private calculateBaseAPR(utilizationRate: number): number {
    // Balanced APR when utilization is optimal (around 0.1-0.2)
    const BASE_APR = 0.20; // 20% 
    const MIN_APR = 0.05;  // 5%
    const MAX_APR = 0.70;  // 70%

    if (utilizationRate <= 0.1) {
      // low utilization - reduce APR to discourage over-staking
      return Math.max(MIN_APR, BASE_APR * (1 - (0.1 - utilizationRate) * 2));
    } else if (utilizationRate <= 0.2) {
      // optimal range - base APR
      return BASE_APR;
    } else {
      // high utilization - increase APR --> to attract more workers
      const scalingFactor = Math.min(3.5, 1 + (utilizationRate - 0.2) * 5); // Cap at 3.5x
      return Math.min(MAX_APR, BASE_APR * scalingFactor);
    }
  }

  // calc discount factor based on stake percentage
  // penalizes over-staking (>25% of supply staked)
  private calculateStakeDiscountFactor(stakeFactor: number): number {
    const OPTIMAL_STAKE_FACTOR = 0.25; // 25%
    
    if (stakeFactor <= OPTIMAL_STAKE_FACTOR) {
      return 1.0; // no discount
    }
    
    // linear discount from 1.0 to 0.1 as stake factor goes from 25% to 100%
    const excessStake = stakeFactor - OPTIMAL_STAKE_FACTOR;
    const maxExcess = 0.75; // 100% - 25%
    const discountRate = 0.9; // max 90% discount
    
    return Math.max(0.1, 1.0 - (excessStake / maxExcess) * discountRate);
  }

  /**
   * calculate network capacity metrics for APR calculation
   */
  private async calculateNetworkCapacity(): Promise<{ targetCapacity: number; actualCapacity: number }> {
    try {
      // get current active worker count from contract
      const activeWorkerCount = await this.web3Service.getActiveWorkerCount();
      
      // network parameters from tokenomics
      const WORKER_CAPACITY_TB = 1; // 1TB per worker
      const CHURN_FACTOR = 0.9; // 90% efficiency factor
      
      // actual capacity: active workers * capacity * churn factor
      const actualCapacity = Number(activeWorkerCount) * WORKER_CAPACITY_TB * CHURN_FACTOR;
      
      // target capacity: for now, we use active worker count as baseline
      // --> prod: from dataset metadata: sum(reserved_space * replication_factor)
      const targetCapacity = Number(activeWorkerCount) * WORKER_CAPACITY_TB * 1.2; // 20% buffer
      
      this.logger.log(`🏗️ Network Capacity:`);
      this.logger.log(`  Active workers: ${activeWorkerCount}`);
      this.logger.log(`  Actual capacity: ${actualCapacity.toFixed(2)} TB`);
      this.logger.log(`  Target capacity: ${targetCapacity.toFixed(2)} TB`);
      
      return { targetCapacity, actualCapacity };
    } catch (error) {
      this.logger.warn(`Failed to calculate network capacity: ${error.message}`);
      // fallback values for development
      return { targetCapacity: 100, actualCapacity: 80 };
    }
  }

  private async getStakeMetrics(): Promise<{ totalStakedSupply: bigint; totalSupply: bigint }> {
    try {
      // todo
      const activeWorkerCount = await this.web3Service.getActiveWorkerCount();
      const bondAmount = await this.web3Service.getBondAmount();
      
      // estimate: bonded amount + delegated stake (assume 2x bond on average)
      const estimatedTotalStaked = activeWorkerCount * bondAmount * 3n; // 3x multiplier for delegation
      
      // total supply estimate (todo)
      const estimatedTotalSupply = BigInt('10000000000') * BigInt(1e18); //todo: supply from contract
      
      this.logger.log(`💰 Stake Metrics:`);
      this.logger.log(`  Estimated total staked: ${Number(estimatedTotalStaked) / 1e18} SQD`);
      this.logger.log(`  Estimated total supply: ${Number(estimatedTotalSupply) / 1e18} SQD`);
      
      return { 
        totalStakedSupply: estimatedTotalStaked, 
        totalSupply: estimatedTotalSupply 
      };
    } catch (error) {
      this.logger.warn(`Failed to get stake metrics: ${error.message}`);
      // fallback values for development
      return { 
        totalStakedSupply: BigInt('100000000') * BigInt(1e18), // 100M SQD staked
        totalSupply: BigInt('10000000000') * BigInt(1e18)     // 10B SQD total
      };
    }
  }
} 