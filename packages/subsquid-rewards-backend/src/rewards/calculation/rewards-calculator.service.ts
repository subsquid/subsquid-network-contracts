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
      // get block timestamps
      const startTime = await this.web3Service.getBlockTimestamp(fromBlock);
      const endTime = await this.web3Service.getBlockTimestamp(toBlock);

      this.logger.log(`\n🎯 Calculating rewards for blocks ${fromBlock} - ${toBlock}`);
      this.logger.log(`   Period: ${startTime.toISOString()} to ${endTime.toISOString()}`);

      // get active workers from ClickHouse
      const totalQueries = await this.clickHouseService.logTotalQueries(startTime, endTime);
      const activeWorkerData = await this.clickHouseService.getActiveWorkers(fromBlock, toBlock, skipSignatureValidation);
      
      this.logger.log(`✅ Found ${activeWorkerData.length} active workers with ${totalQueries} total queries`);

      // filter valid workers (with actual queries/traffic)
      const validWorkers = activeWorkerData.filter(w => Number(w.totalRequests) > 0);
      
      this.logger.log(`✅ ${validWorkers.length} workers have valid traffic data`);

      if (validWorkers.length === 0) {
        this.logger.warn('No workers found with query data in this epoch');
        return this.createEmptyResult(fromBlock, toBlock, startTime, endTime);
      }

      // get worker contract IDs and filter out unregistered workers
      this.logger.log(`🔍 Getting contract worker IDs for ${validWorkers.length} workers`);
      const workerIdMapping = await this.web3Service.preloadWorkerIds(
        validWorkers.map(w => w.worker_id)
      );
      
      // filter workers that are actually registered in the contract
      const registeredWorkers = validWorkers.filter(w => {
        const contractId = workerIdMapping[w.worker_id];
        return contractId && contractId !== 0n;
      });
      
      this.logger.log(`✅ Found ${registeredWorkers.length} registered workers out of ${validWorkers.length} active workers`);
      
      if (registeredWorkers.length === 0) {
        this.logger.warn('No registered workers found for this epoch');
        return this.createEmptyResult(fromBlock, toBlock, startTime, endTime);
      }

      // get on-chain stake data for all active workers (not just registered ones)
      this.logger.log(`💰 Fetching stakes for ${activeWorkerData.length} active workers...`);
      const [capedStakes, totalStakes] = await this.contractService.getStakes(
        activeWorkerData.map(w => w.worker_id),
      );
      this.logger.log(`✅ Retrieved stakes from contracts for ${capedStakes.length} workers`);

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
          this.logger.log('Using default bond amount (100k SQD) for development testing');
        }
      }

      // calc liveness factors
      const livenessFactor = await this.clickHouseService.calculateLivenessFactor(startTime, endTime);

      // calc APR based on configuration method
      let baseApr: number;
      const aprMethod = this.configService.get('rewards.aprCalculationMethod') || 'clickhouse';
      
      this.logger.log(`🧮 Using APR calculation method: "${aprMethod}"`);
      
      try {
        switch (aprMethod) {
          case 'contracts':
            baseApr = await this.getAPRFromContracts();
            this.logger.log(`✅ Using contract-based APR: ${(baseApr * 100).toFixed(2)}%`);
            break;
            
          case 'clickhouse':
            const aprFromClickHouse = await this.getAPRFromClickHouse(startTime, endTime);
            if (aprFromClickHouse !== null) {
              baseApr = aprFromClickHouse;
              this.logger.log(`✅ Using ClickHouse APR: ${(baseApr * 100).toFixed(2)}%`);
            } else {
              this.logger.warn('No ClickHouse APR data found, falling back to contracts method');
              baseApr = await this.getAPRFromContracts();
              this.logger.log(`✅ Fallback to contract APR: ${(baseApr * 100).toFixed(2)}%`);
            }
            break;
            
          case 'dynamic':
            const { targetCapacity, actualCapacity } = await this.calculateNetworkCapacity();
            const { totalStakedSupply, totalSupply } = await this.getStakeMetrics();
            baseApr = await this.calculateDynamicAPR(totalStakedSupply, totalSupply, targetCapacity, actualCapacity);
            this.logger.log(`✅ Using dynamic APR: ${(baseApr * 100).toFixed(2)}%`);
            break;
            
          default:
            this.logger.warn(`Unknown APR method "${aprMethod}", falling back to clickhouse`);
            const aprFromClickHouseDefault = await this.getAPRFromClickHouse(startTime, endTime);
            baseApr = aprFromClickHouseDefault || 0.20; // 20% default
            this.logger.log(`✅ Using fallback APR: ${(baseApr * 100).toFixed(2)}%`);
        }
      } catch (error) {
        this.logger.error(`Failed to calculate APR using method '${aprMethod}': ${error.message}`);
        
        // final fallback: use realistic production APR
        baseApr = 0.20; // 20% APR as default
        this.logger.log(`Using hardcoded APR (20%) as final fallback`);
      }

      // filter workers that have stakes > 0 (these are the ones actually registered and staked)
      const stakedWorkers = activeWorkerData.filter((worker, index) => {
        const capedStake = capedStakes[index];
        const totalStake = totalStakes[index];
        return (capedStake?.status === 'success' && capedStake?.result && capedStake.result > 0n) || 
               (totalStake?.status === 'success' && totalStake?.result && totalStake.result > 0n);
      });
      
      this.logger.log(`🎯 Found ${stakedWorkers.length} workers with actual stakes out of ${activeWorkerData.length} active workers`);
      
      if (stakedWorkers.length === 0) {
        this.logger.warn('No workers with stakes found for this epoch');
        return this.createEmptyResult(fromBlock, toBlock, startTime, endTime);
      }

      const workers = await this.calculateIndividualRewards(
        stakedWorkers,
        capedStakes,
        totalStakes,
        bondAmount,
        livenessFactor,
        baseApr,
        startTime,
        endTime,
        workerIdMapping,
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
    workerIdMapping: Record<string, bigint>,
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

      // use the actual contract worker ID  
      const contractWorkerId = workerIdMapping[worker.worker_id];
      if (!contractWorkerId || contractWorkerId === 0n) {
        this.logger.warn(`Worker ${worker.worker_id} not found in contract mapping, skipping`);
        continue;
      }

      const liveness = livenessFactor[worker.worker_id]?.livenessFactor || 0;

      // calculate traffic factor based on chunks read and bytes sent
      const trafficFactor = this.calculateTrafficFactor(worker, workerData);
      
      // calculate tenure factor (simplified for now)
      const tenureFactor = 1.0; // plch - would need historical data
      
      // calculate base staking reward (before performance factors)
      const baseStakingReward = this.calculateStakingReward(
        capedStake,
        totalStake,
        baseApr,
        (endTime.getTime() - startTime.getTime()) / 1000,
        365 * 24 * 60 * 60,
      );
      
      const performanceMultiplier = liveness * trafficFactor * tenureFactor;
      const performanceMultiplierBigInt = BigInt(Math.floor(performanceMultiplier * 1_000_000));
      
      // worker reward: caped stake * base reward * performance multiplier
      const finalWorkerReward = (baseStakingReward * performanceMultiplierBigInt) / 1_000_000n;
      
      // staker reward: delegated stake * base reward (no performance multiplier for stakers)
      let calculatedStakerReward: bigint;
      try {
        if (totalStake > capedStake && totalStake !== 0n) {
          const delegatedStake = totalStake - capedStake;
          // calculate staker reward based on delegated stake only
          const delegatedStakeReward = this.calculateStakingReward(
            delegatedStake,
            delegatedStake, // Use delegated stake as "total" for this calculation
            baseApr,
            (endTime.getTime() - startTime.getTime()) / 1000,
            365 * 24 * 60 * 60,
          );
          calculatedStakerReward = delegatedStakeReward;
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
        this.logger.log(`    - Base staking reward: ${baseStakingReward} wei (${Number(baseStakingReward) / 1e18} SQD)`);
        this.logger.log(`    - Final worker reward: ${finalWorkerReward} wei (${Number(finalWorkerReward) / 1e18} SQD)`);
        this.logger.log(`    - Staker reward: ${calculatedStakerReward} wei (${Number(calculatedStakerReward) / 1e18} SQD)`);
      }

      rewards.push({
        workerId: contractWorkerId, // actual contract worker ID
        id: contractWorkerId, // use contract ID for identification
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
  // Following Tokenomics 2.1: 20% balanced state, scales 5%-70% based on utilization
  private calculateBaseAPR(utilizationRate: number): number {
    // Base APR in balanced state (20%)
    const BASE_APR = 0.20; // 20% 
    const MIN_APR = 0.05;  // 5%
    const MAX_APR = 0.70;  // 70%

    // According to tokenomics: base_apr is set to 20% in balanced state
    // and is increased up to 70% to incentivize more workers if utilization is high
    
    if (utilizationRate <= 0.1) {
      // Low utilization - network has too much capacity, reduce APR
      return Math.max(MIN_APR, BASE_APR * (1 - (0.1 - utilizationRate) * 2));
    } else if (utilizationRate <= 0.2) {
      // Optimal/balanced range - use base APR
      return BASE_APR;
    } else {
      // High utilization - increase APR to attract more workers
      // Linear scaling from 20% to 70% as utilization goes from 0.2 to 1.0
      const scaledAPR = BASE_APR + (MAX_APR - BASE_APR) * ((utilizationRate - 0.2) / 0.8);
      return Math.min(MAX_APR, scaledAPR);
    }
  }

  // calc discount factor D(stake_factor) based on stake percentage
  // Following Tokenomics 2.1: D(s) function that adjusts rewards based on total stake
  private calculateStakeDiscountFactor(stakeFactor: number): number {
    // According to the tokenomics spec, this function should incentivize optimal staking levels
    // For now, using a simple model that doesn't penalize staking
    // In production, this would be based on the governance-defined D(s) function
    
    // Simple implementation: no discount for now
    // TODO: Implement proper D(s) function based on governance parameters
    return 1.0;
  }

  /**
   * calculate network capacity metrics for APR calculation
   * Following Tokenomics 2.1 specification
   */
  private async calculateNetworkCapacity(): Promise<{ targetCapacity: number; actualCapacity: number }> {
    try {
      // Get current active worker count from contract
      const activeWorkerCount = await this.web3Service.getActiveWorkerCount();
      
      // Network parameters from tokenomics
      const WORKER_CAPACITY_TB = 1; // 1TB per worker
      const CHURN_FACTOR = 0.9; // 90% efficiency factor
      
      // Actual capacity: num_of_active_workers() * WORKER_CAPACITY * CHURN
      const actualCapacity = Number(activeWorkerCount) * WORKER_CAPACITY_TB * CHURN_FACTOR;
      
      // Target capacity: sum([d.reserved_space * d.replication_factor]) for non-disabled datasets
      // For now, we'll estimate based on network size
      // In production, this would query dataset metadata
      let targetCapacity: number;
      
      // Try to get target capacity from contract or estimate it
      try {
        const targetCapacityBytes = await this.contractService.getTargetCapacity();
        targetCapacity = Number(targetCapacityBytes) / (1024 ** 4); // Convert bytes to TB
      } catch (error) {
        // Estimate: assume network wants 50% more capacity than current active workers provide
        targetCapacity = Number(activeWorkerCount) * WORKER_CAPACITY_TB * 1.5;
        this.logger.warn(`Using estimated target capacity: ${error.message}`);
      }
      
      // Ensure target capacity is reasonable
      if (targetCapacity === 0 || targetCapacity > actualCapacity * 10) {
        targetCapacity = actualCapacity * 1.2; // Default to 20% more than actual
      }
      
      this.logger.log(`🏗️ Network Capacity (per Tokenomics 2.1):`);
      this.logger.log(`  Active workers: ${activeWorkerCount}`);
      this.logger.log(`  Worker capacity: ${WORKER_CAPACITY_TB} TB`);
      this.logger.log(`  Churn factor: ${CHURN_FACTOR}`);
      this.logger.log(`  Actual capacity: ${actualCapacity.toFixed(2)} TB`);
      this.logger.log(`  Target capacity: ${targetCapacity.toFixed(2)} TB`);
      this.logger.log(`  Utilization rate: ${((targetCapacity - actualCapacity) / targetCapacity * 100).toFixed(2)}%`);
      
      return { targetCapacity, actualCapacity };
    } catch (error) {
      this.logger.warn(`Failed to calculate network capacity: ${error.message}`);
      // Fallback values for development
      return { targetCapacity: 100, actualCapacity: 80 };
    }
  }

  private async getStakeMetrics(): Promise<{ totalStakedSupply: bigint; totalSupply: bigint }> {
    try {
      // Try to get real delegation data from ClickHouse
      const networkName = this.configService.get('blockchain.networkName') || 'mainnet';
      const query = `
        SELECT 
          SUM(stake) as totalStake,
          COUNT(DISTINCT worker_id) as workerCount
        FROM ${networkName}.worker_stats 
        WHERE time >= NOW() - INTERVAL 1 DAY
          AND stake > 0
        ORDER BY time DESC
        LIMIT 1
      `;

      try {
        const client = (this.clickHouseService as any).client;
        if (client) {
          const resultSet = await client.query({
            query,
            format: 'JSONEachRow',
          });

          const results = await resultSet.json();
          const resultArray = Array.isArray(results) ? results : [results];
          
          if (resultArray.length > 0 && resultArray[0].totalStake) {
            const totalStakedSupply = BigInt(resultArray[0].totalStake);
            const workerCount = parseInt(resultArray[0].workerCount) || 0;
            
            // Total supply: 1 billion SQD (from tokenomics)
            const totalSupply = BigInt('1000000000') * BigInt(1e18);
            
            this.logger.log(`💰 Stake Metrics (from ClickHouse):`);
            this.logger.log(`  Total staked: ${Number(totalStakedSupply) / 1e18} SQD`);
            this.logger.log(`  Worker count: ${workerCount}`);
            this.logger.log(`  Total supply: ${Number(totalSupply) / 1e18} SQD`);
            this.logger.log(`  Stake percentage: ${(Number(totalStakedSupply) / Number(totalSupply) * 100).toFixed(2)}%`);
            
            return { totalStakedSupply, totalSupply };
          }
        }
      } catch (error) {
        this.logger.warn(`Failed to fetch stake data from ClickHouse: ${error.message}`);
      }

      // Fallback to estimation if ClickHouse query fails
      const activeWorkerCount = await this.web3Service.getActiveWorkerCount();
      const bondAmount = await this.web3Service.getBondAmount();
      
      // estimate: bonded amount + delegated stake (assume 2x bond on average)
      const estimatedTotalStaked = activeWorkerCount * bondAmount * 3n; // 3x multiplier for delegation
      
      // total supply: 1 billion SQD
      const estimatedTotalSupply = BigInt('1000000000') * BigInt(1e18);
      
      this.logger.log(`💰 Stake Metrics (estimated):`);
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

  /**
   * Get APR from ClickHouse rewards_stats table
   */
  private async getAPRFromClickHouse(startTime: Date, endTime: Date): Promise<number | null> {
    try {
      const networkName = this.configService.get('blockchain.networkName') || 'mainnet';
      
      // Get the latest successful APR from rewards_stats
      // This is more robust than trying to filter by time range
      const query = `
        SELECT 
          base_apr / 10000 as apr
        FROM ${networkName}.rewards_stats
        WHERE is_commit_success = true
        ORDER BY epoch_end DESC
        LIMIT 1
      `;

      this.logger.log(`🔍 Fetching latest APR from ClickHouse rewards_stats`);
      
      const client = (this.clickHouseService as any).client;
      if (!client) {
        this.logger.warn('ClickHouse client not available');
        return null;
      }

      const resultSet = await client.query({
        query,
        format: 'JSONEachRow',
      });

      const results = await resultSet.json();
      const resultArray = Array.isArray(results) ? results : [results];
      
      if (resultArray.length > 0 && resultArray[0].apr !== undefined) {
        const apr = parseFloat(resultArray[0].apr);
        this.logger.log(`✅ Found latest APR in rewards_stats: ${(apr * 100).toFixed(2)}%`);
        return apr;
      }

      this.logger.log('No APR data found in rewards_stats');
      return null;
    } catch (error) {
      this.logger.warn(`Failed to fetch APR from ClickHouse: ${error.message}`);
      return null;
    }
  }

  /**
   * Get APR from contracts using the old rewards calculator approach
   * This mimics the currentApy() function from packages/rewards-calculator/src/chain.ts
   */
  private async getAPRFromContracts(): Promise<number> {
    try {
      this.logger.log(`🔗 Calculating APR from contracts (old backend method)`);
      
      // Get current block for consistent reads
      const currentBlock = await this.web3Service.getLatestL2Block();
      
      // Try to get contract addresses
      const rewardCalculationAddress = this.configService.get('blockchain.contracts.rewardCalculation');
      const networkControllerAddress = this.configService.get('blockchain.contracts.networkController');
      
      if (!rewardCalculationAddress || !networkControllerAddress) {
        this.logger.warn('Contract addresses not configured, using fallback APR');
        return 0.20; // 20% fallback like old backend
      }

      // Try to implement the old backend's currentApy calculation
      // The old logic was: min(20%, (yearlyRewardCapCoefficient * initialRewardPoolsSize) / effectiveTVL)
      
      try {
        // For now, since we don't have access to the exact same contract methods,
        // we'll use the contract service's getCurrentApy method which tries to get from contracts
        const currentApyBasisPoints = await this.contractService.getCurrentApy();
        const aprDecimal = Number(currentApyBasisPoints) / 10000; // Convert basis points to decimal
        
        this.logger.log(`📊 Contract APY calculation result: ${(aprDecimal * 100).toFixed(2)}%`);
        
        // Apply the same min logic as old backend (min of 20% or calculated)
        const finalApr = Math.min(0.20, aprDecimal);
        
        this.logger.log(`✅ Final contract-based APR (min 20%): ${(finalApr * 100).toFixed(2)}%`);
        return finalApr;
        
      } catch (contractError) {
        this.logger.warn(`Contract APY calculation failed: ${contractError.message}`);
        
        // Fallback: use 20% default like old backend did when TVL = 0
        this.logger.log('Using 20% fallback APR (same as old backend when TVL = 0)');
        return 0.20;
      }
      
    } catch (error) {
      this.logger.error(`Failed to get APR from contracts: ${error.message}`);
      return 0.20; // 20% fallback
    }
  }
} 