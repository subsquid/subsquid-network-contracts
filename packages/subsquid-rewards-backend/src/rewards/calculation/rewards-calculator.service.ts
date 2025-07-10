import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ClickHouseService,
  WorkerQueryData,
} from '../../database/clickhouse.service';
import { Web3Service } from '../../blockchain/web3.service';
import { ContractService } from '../../blockchain/contract.service';
import { MetricsLoggerService } from '../../common/metrics-logger.service';
import { Context } from '../../common';

export interface WorkerReward {
  workerId: bigint;
  id: bigint;
  workerReward: bigint;
  stakerReward: bigint;
  stake: bigint;
  totalStake: bigint;
  calculationTime: number;
}

export interface RewardCalculationResult {
  workers: WorkerReward[];
  totalRewards: bigint;
  calculationTime: number;
}

@Injectable()
export class RewardsCalculatorService {
  private readonly logger = {
    log: (msg: string) => console.log(`[RewardsCalculator] ${msg}`),
    warn: (msg: string) => console.warn(`[RewardsCalculator] ⚠️  ${msg}`),
    error: (msg: string) => console.error(`[RewardsCalculator] ❌ ${msg}`),
  };
  
  private workerIdMapping: Record<string, { peerId: string; contractId: bigint }> = {};

  constructor(
    private configService: ConfigService,
    private clickHouseService: ClickHouseService,
    private web3Service: Web3Service,
    private contractService: ContractService,
    private metricsLoggerService: MetricsLoggerService,
  ) {}

  async calculateEpochRewards(
    ctx: Context,
    fromBlock: number,
    toBlock: number,
    skipSignatureValidation?: boolean,
    batchNumberOverride?: number,
    totalBatchesOverride?: number,
  ): Promise<WorkerReward[]> {
    const shouldSkipValidation =
      skipSignatureValidation ??
      this.configService.get('rewards.skipSignatureValidation', true);

    if (shouldSkipValidation) {
      ctx.logger.warn(
        '🚨 Signature validation is DISABLED - this is for development/testing only',
      );
    }

    const result = await this.calculateRewardsDetailed(
      ctx,
      fromBlock,
      toBlock,
      shouldSkipValidation,
      batchNumberOverride,
      totalBatchesOverride,
    );
    return result.workers;
  }

  async calculateRewardsDetailed(
    ctx: Context,
    fromBlock: number,
    toBlock: number,
    skipSignatureValidation?: boolean,
    batchNumberOverride?: number,
    totalBatchesOverride?: number,
  ): Promise<RewardCalculationResult> {
    const shouldSkipValidation =
      skipSignatureValidation ??
      this.configService.get('rewards.skipSignatureValidation', true);

    return this.calculateRewards(ctx, fromBlock, toBlock, shouldSkipValidation, batchNumberOverride, totalBatchesOverride);
  }

  private async calculateRewards(
    ctx: Context,
    fromBlock: number,
    toBlock: number,
    skipSignatureValidation = true,
    batchNumberOverride?: number,
    totalBatchesOverride?: number,
  ): Promise<RewardCalculationResult> {
    try {
      // get block timestamps
      const startTime = await this.web3Service.getBlockTimestamp(ctx, fromBlock);
      const endTime = await this.web3Service.getBlockTimestamp(ctx, toBlock);

      ctx.logger.debug(
        `\n🎯 Calculating rewards for blocks ${fromBlock} - ${toBlock}`,
      );
      ctx.logger.debug(
        `   Period: ${startTime.toISOString()} to ${endTime.toISOString()}`,
      );

      // get active workers from ClickHouse
      const totalQueries = await this.clickHouseService.logTotalQueries(
        ctx,
        startTime,
        endTime,
      );
      const activeWorkerData = await this.clickHouseService.getActiveWorkers(
        ctx,
        startTime,
        endTime,
        skipSignatureValidation,
      );

      ctx.logger.debug(
        `✅ Found ${activeWorkerData.length} active workers with ${totalQueries} total queries`,
      );

      // filter valid workers (with actual queries/traffic)
      const validWorkers = activeWorkerData.filter(
        (w) => Number(w.totalRequests) > 0,
      );

      ctx.logger.debug(
        `✅ ${validWorkers.length} workers have valid traffic data`,
      );

      if (validWorkers.length === 0) {
        ctx.logger.warn('No workers found with query data in this epoch');
        return this.createEmptyResult(fromBlock, toBlock, startTime, endTime);
      }

      // get worker contract IDs and filter out unregistered workers
      ctx.logger.debug(
        `🔍 Getting contract worker IDs for ${validWorkers.length} workers`,
      );
      const workerIdMapping = await this.web3Service.preloadWorkerIds(
        ctx,
        validWorkers.map((w) => w.worker_id),
      );

      // filter workers that are actually registered in the contract
      const registeredWorkers = validWorkers.filter((w) => {
        const contractId = workerIdMapping[w.worker_id];
        return contractId && contractId !== 0n;
      });

      ctx.logger.debug(
        `✅ Found ${registeredWorkers.length} registered workers out of ${validWorkers.length} active workers`,
      );

      if (registeredWorkers.length === 0) {
        ctx.logger.warn('No registered workers found for this epoch');
        return this.createEmptyResult(fromBlock, toBlock, startTime, endTime);
      }

      // get on-chain stake data for all active workers (not just registered ones)
      ctx.logger.debug(
        `💰 Fetching stakes for ${activeWorkerData.length} active workers...`,
      );
      const [capedStakes, totalStakes] = await this.contractService.getStakes(
        activeWorkerData.map((w) => w.worker_id),
      );
      ctx.logger.debug(
        `✅ Retrieved stakes from contracts for ${capedStakes.length} workers`,
      );

      // get bond amount from WorkerRegistration contract
      let bondAmount: bigint;
      try {
        bondAmount = await this.web3Service.getBondAmount(ctx);
        ctx.logger.debug(
          `✅ Retrieved bond amount from WorkerRegistration contract: ${Number(bondAmount) / 1e18} SQD`,
        );
      } catch (error) {
        ctx.logger.warn(
          { error },
          `Failed to get bond amount from WorkerRegistration`,
        );
        // fallback to contract service
        try {
          bondAmount = await this.contractService.getBondAmount();
          ctx.logger.debug('Using bond amount from fallback contract service');
        } catch (fallbackError) {
          ctx.logger.warn({ error: fallbackError }, `Fallback also failed`);
          bondAmount = BigInt('100000000000000000000000'); // 100k SQD default
          ctx.logger.debug(
            'Using default bond amount (100k SQD) for development testing',
          );
        }
      }

      // calc liveness factors
      const livenessFactor =
        await this.clickHouseService.calculateLivenessFactor(
          ctx,
          startTime,
          endTime,
        );

      // calc APR based on configuration method
      let baseApr: number;
      const aprMethod =
        this.configService.get('rewards.aprCalculationMethod') || 'clickhouse';

      ctx.logger.debug(`🧮 Using APR calculation method: "${aprMethod}"`);

      try {
        switch (aprMethod) {
          case 'contracts':
            ctx.logger.debug('🔗 Using old rewards calculator method (contracts)');
            return await this.calculateRewardsOldMethod(
              ctx,
              fromBlock,
              toBlock,
              startTime,
              endTime,
              skipSignatureValidation,
              batchNumberOverride,
              totalBatchesOverride,
            );
            break;

          case 'clickhouse':
            const aprFromClickHouse = await this.getAPRFromClickHouse(
              ctx,
              startTime,
              endTime,
            );
            if (aprFromClickHouse !== null) {
              baseApr = aprFromClickHouse;
              ctx.logger.debug(
                `✅ Using ClickHouse APR: ${(baseApr * 100).toFixed(2)}%`,
              );
            } else {
              ctx.logger.warn(
                'No ClickHouse APR data found, falling back to contracts method',
              );
              baseApr = await this.getAPRFromContracts(ctx);
              ctx.logger.debug(
                `✅ Fallback to contract APR: ${(baseApr * 100).toFixed(2)}%`,
              );
            }
            break;

          case 'dynamic':
            const { targetCapacity, actualCapacity } =
              await this.calculateNetworkCapacity(ctx);
            const { totalStakedSupply, totalSupply } =
              await this.getStakeMetrics(ctx);
            baseApr = await this.calculateDynamicAPR(
              ctx,
              totalStakedSupply,
              totalSupply,
              targetCapacity,
              actualCapacity,
            );
            ctx.logger.debug(
              `✅ Using dynamic APR: ${(baseApr * 100).toFixed(2)}%`,
            );
            break;

          default:
            ctx.logger.warn(
              `Unknown APR method "${aprMethod}", falling back to clickhouse`,
            );
            const aprFromClickHouseDefault = await this.getAPRFromClickHouse(
              ctx,
              startTime,
              endTime,
            );
            baseApr = aprFromClickHouseDefault || 0.2; // 20% default
            ctx.logger.debug(
              `✅ Using fallback APR: ${(baseApr * 100).toFixed(2)}%`,
            );
        }
      } catch (error) {
        ctx.logger.error(
          { error },
          `Failed to calculate APR using method '${aprMethod}'`,
        );

        // final fallback: use realistic production APR
        baseApr = 0.2; // 20% APR as default
        ctx.logger.debug(`Using hardcoded APR (20%) as final fallback`);
      }

      // filter workers that have stakes > 0 (these are the ones actually registered and staked)
      const stakedWorkers = activeWorkerData.filter((worker, index) => {
        const capedStake = capedStakes[index];
        const totalStake = totalStakes[index];
        return (
          (capedStake?.status === 'success' &&
            capedStake?.result &&
            capedStake.result > 0n) ||
          (totalStake?.status === 'success' &&
            totalStake?.result &&
            totalStake.result > 0n)
        );
      });

      ctx.logger.debug(
        `🎯 Found ${stakedWorkers.length} workers with actual stakes out of ${activeWorkerData.length} active workers`,
      );

      if (stakedWorkers.length === 0) {
        ctx.logger.warn('No workers with stakes found for this epoch');
        return this.createEmptyResult(fromBlock, toBlock, startTime, endTime);
      }

      const workers = await this.calculateIndividualRewards(
        ctx,
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

      ctx.logger.debug(
        `✅ Calculated rewards for ${workers.length} workers, total: ${workers.reduce((sum, w) => sum + w.workerReward, 0n)} wei`,
      );

      return {
        workers,
        totalRewards: workers.reduce((sum, w) => sum + w.workerReward, 0n),
        calculationTime: (endTime.getTime() - startTime.getTime()) / 1000,
      };
    } catch (error) {
      ctx.logger.error({ error }, `Failed to calculate epoch rewards`);
      throw error;
    }
  }

  async calculateIndividualRewards(
    ctx: Context,
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
    ctx.logger.debug(`\n=== EXACT Old Backend Calculation Flow ===`);
    ctx.logger.debug(`Worker data length: ${workerData.length}`);
    ctx.logger.debug(`Base APR input: ${baseApr} (${(baseApr * 100).toFixed(2)}%)`);

    const validWorkers: Array<{
      worker: WorkerQueryData;
      capedStake: bigint;
      totalStake: bigint;
      contractWorkerId: bigint;
    }> = [];

    this.workerIdMapping = {};
    
    for (let i = 0; i < workerData.length; i++) {
      const worker = workerData[i];
      const capedStake = BigInt(capedStakes[i]?.result || 0);
      const totalStake = BigInt(totalStakes[i]?.result || 0);

      const contractWorkerId = workerIdMapping[worker.worker_id];
      if (!contractWorkerId || contractWorkerId === 0n) {
        continue;
      }
      
      this.workerIdMapping[worker.worker_id] = {
        peerId: worker.worker_id,
        contractId: contractWorkerId,
      };

      validWorkers.push({
        worker,
        capedStake,
        totalStake,
        contractWorkerId,
      });
    }

    ctx.logger.debug(`✅ Filtered to ${validWorkers.length} valid workers`);

    if (validWorkers.length === 0) {
      return [];
    }

    const totalBytesSent = validWorkers.reduce((sum, { worker }) => sum + Number(worker.output_size), 0);
    const totalChunksRead = validWorkers.reduce((sum, { worker }) => sum + Number(worker.num_read_chunks), 0);
    
    ctx.logger.debug(`Total traffic: ${totalBytesSent} bytes, ${totalChunksRead} chunks`);

    const totalWorkerStakes = validWorkers.reduce((sum, { capedStake }) => sum + capedStake, 0n);
    const totalBonds = bondAmount * BigInt(validWorkers.length);
    const totalSupply = totalBonds + totalWorkerStakes;
    
    ctx.logger.debug(`Total supply: ${totalSupply} wei (${Number(totalSupply) / 1e18} SQD)`);

    const duration = Math.floor((endTime.getTime() - startTime.getTime()) / 1000);
    const YEAR = 365 * 24 * 60 * 60;
    
    const rMax = (baseApr * duration) / YEAR;
    
    ctx.logger.debug(`Duration: ${duration}s, Base APR: ${(baseApr * 100).toFixed(2)}%, rMax: ${rMax}`);

    const epochLengthInBlocks = await this.contractService.getEpochLength(ctx);
    const SECONDS_PER_BLOCK = 12;
    const epochLengthSeconds = epochLengthInBlocks * SECONDS_PER_BLOCK;
    const TENURE_EPOCH_COUNT = 10;
    
    const epochStartBlocks = [...new Array(TENURE_EPOCH_COUNT + 1)].map(
      (_, idx) => new Date(startTime.getTime() - ((TENURE_EPOCH_COUNT - idx) * epochLengthSeconds * 1000))
    );
    
    const historicalLiveness = await this.getHistoricalLiveness(epochStartBlocks);
    ctx.logger.debug(`✅ Historical liveness calculated for ${Object.keys(historicalLiveness).length} workers`);

    const rewards: WorkerReward[] = [];

    for (let i = 0; i < validWorkers.length; i++) {
      const { worker, capedStake, totalStake, contractWorkerId } = validWorkers[i];

      const bytesFactor = totalBytesSent > 0 ? Number(worker.output_size) / totalBytesSent : 0;
      const chunksFactor = totalChunksRead > 0 ? Number(worker.num_read_chunks) / totalChunksRead : 0;
      const trafficWeight = Math.sqrt(bytesFactor * chunksFactor);

      const workerSupply = bondAmount + capedStake;
      const supplyRatio = totalSupply > 0n ? Number(workerSupply) / Number(totalSupply) : 0;
      const dTrafficAlpha = 0.1;
      const dTraffic = supplyRatio > 0 ? Math.min(1.0, Math.pow(trafficWeight / supplyRatio, dTrafficAlpha)) : 0;

      const networkStats = livenessFactor[worker.worker_id] || { livenessFactor: 0 };
      const { livenessFactor: rawLiveness } = networkStats;
      let livenessCoefficient = 0;
      if (rawLiveness >= 0.95) {
        livenessCoefficient = 1;
      } else if (rawLiveness >= 0.9) {
        livenessCoefficient = 2 * rawLiveness - 0.9;
      } else if (rawLiveness >= 0.8) {
        livenessCoefficient = 9 * rawLiveness - 7.2;
      } else {
        livenessCoefficient = 0;
      }

      const historicalLivenessData = historicalLiveness[worker.worker_id] ?? [];
      const LIVENESS_THRESHOLD = 0.9;
      const liveEpochs = historicalLivenessData.filter(liveness => liveness >= LIVENESS_THRESHOLD).length;
      const dTenure = 0.5 + Math.floor((liveEpochs / 2) + 0.05) * 0.1;

      const actualYield = rMax * livenessCoefficient * dTraffic * dTenure;

      const bondDecimal = Number(bondAmount) / 1e18;
      const stakeDecimal = Number(capedStake) / 1e18;
      
      const workerRewardDecimal = actualYield * (bondDecimal + stakeDecimal / 2);
      const stakerRewardDecimal = actualYield * (stakeDecimal / 2);
      

      const finalWorkerReward = BigInt(Math.floor(workerRewardDecimal * 1e18));
      const finalStakerReward = BigInt(Math.floor(stakerRewardDecimal * 1e18));

      // Debug logging for first few workers
      if (i < 3) {
        ctx.logger.debug(`\n--- Worker ${i + 1}: ${worker.worker_id.slice(0, 20)}... ---`);
        ctx.logger.debug(`  Traffic: bytes=${worker.output_size}, chunks=${worker.num_read_chunks}`);
        ctx.logger.debug(`  Traffic weight: ${trafficWeight.toFixed(8)}`);
        ctx.logger.debug(`  Supply ratio: ${supplyRatio.toFixed(8)}`);
        ctx.logger.debug(`  dTraffic: ${dTraffic.toFixed(8)}`);
        ctx.logger.debug(`  Raw liveness: ${rawLiveness.toFixed(4)}`);
        ctx.logger.debug(`  Liveness coefficient: ${livenessCoefficient.toFixed(8)}`);
        ctx.logger.debug(`  dTenure: ${dTenure.toFixed(8)}`);
        ctx.logger.debug(`  Actual yield: ${actualYield.toFixed(12)}`);
        ctx.logger.debug(`  Bond: ${bondDecimal} SQD, Stake: ${stakeDecimal} SQD`);
        ctx.logger.debug(`  Worker reward: ${workerRewardDecimal.toFixed(18)} SQD = ${finalWorkerReward} wei`);
        ctx.logger.debug(`  Staker reward: ${stakerRewardDecimal.toFixed(18)} SQD = ${finalStakerReward} wei`);
      }

      this.metricsLoggerService.logWorkerReport({
        workerId: worker.worker_id,
        trafficWeight: trafficWeight,
        stakeWeight: Number(capedStake) / Number(totalStake || 1n),
        rewardWeight: livenessCoefficient * dTraffic * dTenure,
        workerApr: baseApr * livenessCoefficient * dTraffic * dTenure,
        delegatorApr: totalStake > capedStake ? baseApr : 0,
        workerReward: finalWorkerReward,
        stakerReward: finalStakerReward,
        stake: capedStake,
        bytesSent: Number(worker.output_size),
        chunksRead: Number(worker.num_read_chunks),
      });

      rewards.push({
        workerId: contractWorkerId,
        id: contractWorkerId,
        workerReward: finalWorkerReward,
        stakerReward: finalStakerReward,
        stake: capedStake,
        totalStake,
        calculationTime: duration,
      });
    }

    const totalRewards = rewards.reduce((sum, w) => sum + w.workerReward, 0n);
    ctx.logger.debug(`\n=== Final Results ===`);
    ctx.logger.debug(`Total workers: ${rewards.length}`);
    ctx.logger.debug(`Total worker rewards: ${Number(totalRewards) / 1e18} SQD`);
    ctx.logger.debug(`Average reward: ${Number(totalRewards) / rewards.length / 1e18} SQD`);

    return rewards;
  }





  private splitPingsByEpochs(timestamps: number[], epochTimestamps: number[]): number[][] {
    // replicates the splitLogs function from old backend
    const sortedTimestamps = [...timestamps].sort((a, b) => a - b);
    const splits: number[][] = [[epochTimestamps[0]]];
    let index = 1;
    
    for (const timestamp of sortedTimestamps) {
      while (index < epochTimestamps.length && timestamp > epochTimestamps[index]) {
        splits[splits.length - 1].push(epochTimestamps[index]);
        splits.push([epochTimestamps[index]]);
        index++;
      }
      splits[splits.length - 1].push(timestamp);
    }
    
    return splits;
  }

  private calculateLivenessFromPings(timestamps: number[], epochDuration: number): number {
    if (timestamps.length < 2) {
      return 0;
    }
    
    const diffs = timestamps.slice(1).map((timestamp, i) => timestamp - timestamps[i]);
    
    const WORKER_OFFLINE_THRESHOLD = 65;
    const totalOfflineTime = diffs
      .filter(diff => diff > WORKER_OFFLINE_THRESHOLD)
      .reduce((sum, diff) => sum + diff, 0);
    
    const livenessFactor = Math.max(0, 1 - totalOfflineTime / epochDuration);
    
    return livenessFactor;
  }

  private calculateDTrafficFactor(
    ctx: Context,
    capedStake: bigint,
    bondAmount: bigint,
    worker: WorkerQueryData,
    allWorkers: WorkerQueryData[],
    allCapedStakes: any[],
    allTotalStakes: any[],
  ): number {
    const workerCount = allCapedStakes.length;
    const totalBond = bondAmount * BigInt(workerCount);
    
    const totalStakes = allCapedStakes.reduce((sum, stake, i) => {
      const capedStakeValue = BigInt(stake?.result || 0);
      return sum + capedStakeValue;
    }, 0n);
    
    const totalSupply = totalBond + totalStakes;
    
    if (totalSupply === 0n) {
      return 1.0;
    }
    
    const workerSupply = bondAmount + capedStake;
    const supplyRatio = Number(workerSupply) / Number(totalSupply);
    
    if (supplyRatio === 0) {
      return 0.001;
    }
    
    const trafficWeight = this.calculateTrafficFactor(ctx, worker, allWorkers);
    
    const dTrafficAlpha = 0.1;
    const dTraffic = Math.min(1.0, Math.pow(trafficWeight / supplyRatio, dTrafficAlpha));
    
    const workerIndex = allWorkers.indexOf(worker);
    if (workerIndex < 3) {
      ctx.logger.debug(`DTraffic calc for worker ${worker.worker_id.slice(0, 20)}:`);
      ctx.logger.debug(`  Traffic weight: ${trafficWeight.toFixed(6)}`);
      ctx.logger.debug(`  Supply ratio: ${supplyRatio.toFixed(6)}`);
      ctx.logger.debug(`  DTraffic alpha: ${dTrafficAlpha}`);
      ctx.logger.debug(`  Final dTraffic: ${dTraffic.toFixed(6)}`);
    }
    
    return Math.max(0.001, Math.min(1.0, dTraffic));
  }

  private calculateTrafficFactor(
    ctx: Context,
    worker: WorkerQueryData,
    allWorkers: WorkerQueryData[],
  ): number {
    // calculate total traffic across all workers
    const totalBytes = allWorkers.reduce(
      (sum, w) => sum + Number(w.output_size),
      0,
    );
    const totalChunks = allWorkers.reduce(
      (sum, w) => sum + Number(w.num_read_chunks),
      0,
    );

    if (totalBytes === 0 || totalChunks === 0) {
      return 1.0; // if no traffic data, give neutral factor
    }

    // calculate this worker's relative contribution
    const workerBytes = Number(worker.output_size);
    const workerChunks = Number(worker.num_read_chunks);

    const bytesFactor = workerBytes / totalBytes;
    const chunksFactor = workerChunks / totalChunks;

    const trafficFactor = Math.sqrt(bytesFactor * chunksFactor);

    if (allWorkers.indexOf(worker) < 3) {
      ctx.logger.debug(
        `Traffic calc for worker ${worker.worker_id.slice(0, 20)}:`,
      );
      ctx.logger.debug(
        `  Worker: ${workerChunks} chunks, ${workerBytes} bytes`,
      );
      ctx.logger.debug(`  Total: ${totalChunks} chunks, ${totalBytes} bytes`);
      ctx.logger.debug(
        `  Factors: chunks=${chunksFactor.toFixed(6)}, bytes=${bytesFactor.toFixed(6)}`,
      );
      ctx.logger.debug(`  Final traffic factor: ${trafficFactor.toFixed(6)}`);
    }

    // cap between reasonable bounds (0.001 to 2.0)
    return Math.max(0.001, Math.min(2.0, trafficFactor));
  }

  private calculateStakingReward(
    ctx: Context,
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
      const rewardScaled =
        (capedStake * aprScaled * durationBigInt) /
        (yearSecondsBigInt * scalingFactor);

      ctx.logger.debug(
        `Staking reward calc: stake=${capedStake}, APR=${baseApr}, duration=${duration}s, result=${rewardScaled}`,
      );

      return rewardScaled;
    } catch (error) {
      ctx.logger.error(
        { error },
        `BigInt calculation error in calculateStakingReward`,
      );
      ctx.logger.error(
        `  capedStake: ${capedStake}, baseApr: ${baseApr}, duration: ${duration}, yearSeconds: ${yearSeconds}`,
      );
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
    // Creating sample result for development testing

    //  sample rewards for active workers
    const sampleWorkers: WorkerReward[] = activeWorkerData
      .slice(0, 5)
      .map((worker, index) => {
        // simple reward calculation: 1 SQD per 1000 requests
        const baseReward =
          BigInt(Math.floor(worker.totalRequests / 1000)) *
          BigInt('1000000000000000000'); // 1 SQD = 1e18 wei
        const stakerReward = baseReward / 10n; // 10% for stakers

        return {
          workerId: BigInt(index + 1), // sequential IDs for testing
          id: BigInt(index + 1),
          workerReward: baseReward,
          stakerReward: stakerReward,
          stake: BigInt('10000000000000000000'), // 10 SQD default stake
          totalStake: BigInt('10000000000000000000'),
          calculationTime: (endTime.getTime() - startTime.getTime()) / 1000,
        };
      });

    const totalRewards = sampleWorkers.reduce(
      (sum, w) => sum + w.workerReward,
      0n,
    );

    // Generated ${sampleWorkers.length} sample workers with ${totalRewards} wei total rewards

    return {
      workers: sampleWorkers,
      totalRewards,
      calculationTime: (endTime.getTime() - startTime.getTime()) / 1000,
    };
  }

  async filterWorkersBatch(
    ctx: Context,
    workers: WorkerReward[],
    batchNumber: number,
    totalBatches: number,
  ): Promise<WorkerReward[]> {
    const bs58 = await import('bs58');
    
    if (totalBatches > 64) {
      throw new Error('Total batches cannot exceed 64');
    }
    
    const filtered = workers.filter((worker) => {
      try {
        const workerData = Object.values(this.workerIdMapping || {}).find(
          (data) => data.contractId === worker.workerId
        );
        
        if (!workerData?.peerId) {
          const workerIdBytes = Buffer.from(worker.workerId.toString(16).padStart(32, '0'), 'hex');
          const group = workerIdBytes[workerIdBytes.length - 1] % totalBatches;
          return batchNumber === group;
        }
        
        const peerIdBytes = bs58.default.decode(workerData.peerId);
        const group = peerIdBytes[peerIdBytes.length - 1] % totalBatches;
        return batchNumber === group;
      } catch (error) {
        ctx.logger.warn(
          `Failed to determine batch for worker ${worker.workerId}: ${error.message}`,
        );
        const fallbackIndex = workers.indexOf(worker);
        return fallbackIndex % totalBatches === batchNumber;
      }
    });
    
    ctx.logger.debug(
      `Stable batch filtering: ${filtered.length} workers for batch ${batchNumber}/${totalBatches}`,
    );
    return filtered;
  }

  /**
   * calculate dynamic APR based on network utilization and stake factors
   * following Tokenomics 2.1 specification
   */
  private async calculateDynamicAPR(
    ctx: Context,
    totalStakedSupply: bigint,
    totalSupply: bigint,
    targetCapacity: number,
    actualCapacity: number,
  ): Promise<number> {
    // calculate utilization rate: u_rate = (target_capacity - actual_capacity) / target_capacity
    const utilizationRate =
      targetCapacity > 0
        ? Math.max(0, (targetCapacity - actualCapacity) / targetCapacity)
        : 0;

    // calculate stake factor: percentage of total supply that is staked
    const stakeFactor =
      totalSupply > 0n ? Number(totalStakedSupply) / Number(totalSupply) : 0;

    ctx.logger.debug(`📊 APR Calculation Inputs:`);
    ctx.logger.debug(
      `  Utilization rate: ${(utilizationRate * 100).toFixed(2)}%`,
    );
    ctx.logger.debug(`  Stake factor: ${(stakeFactor * 100).toFixed(2)}%`);
    ctx.logger.debug(`  Target capacity: ${targetCapacity} TB`);
    ctx.logger.debug(`  Actual capacity: ${actualCapacity} TB`);

    // base APR calculation: balanced at 20%, scales 5%-70% based on utilization
    const baseAPR = this.calculateBaseAPR(utilizationRate);

    // discount factor based on stake percentage (reduces rewards if >25% staked)
    const discountFactor = this.calculateStakeDiscountFactor(stakeFactor);

    // final APR
    const finalAPR = baseAPR * discountFactor;

    ctx.logger.debug(`📈 APR Calculation Results:`);
    ctx.logger.debug(`  Base APR: ${(baseAPR * 100).toFixed(2)}%`);
    ctx.logger.debug(`  Discount factor: ${discountFactor.toFixed(4)}`);
    ctx.logger.debug(`  Final APR: ${(finalAPR * 100).toFixed(2)}%`);

    return finalAPR;
  }

  // calc base APR based on network utilization
  // Following Tokenomics 2.1: 20% balanced state, scales 5%-70% based on utilization
  private calculateBaseAPR(utilizationRate: number): number {
    // Base APR in balanced state (20%)
    const BASE_APR = 0.2; // 20%
    const MIN_APR = 0.05; // 5%
    const MAX_APR = 0.7; // 70%

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
      const scaledAPR =
        BASE_APR + (MAX_APR - BASE_APR) * ((utilizationRate - 0.2) / 0.8);
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
  private async calculateNetworkCapacity(ctx: Context): Promise<{
    targetCapacity: number;
    actualCapacity: number;
  }> {
    try {
      // Get current active worker count from contract
      const activeWorkerCount = await this.web3Service.getActiveWorkerCount(ctx);

      // Network parameters from tokenomics
      const WORKER_CAPACITY_TB = 1; // 1TB per worker
      const CHURN_FACTOR = 0.9; // 90% efficiency factor

      // Actual capacity: num_of_active_workers() * WORKER_CAPACITY * CHURN
      const actualCapacity =
        Number(activeWorkerCount) * WORKER_CAPACITY_TB * CHURN_FACTOR;

      // Target capacity: sum([d.reserved_space * d.replication_factor]) for non-disabled datasets
      // For now, we'll estimate based on network size
      // In production, this would query dataset metadata
      let targetCapacity: number;

      // Try to get target capacity from contract or estimate it
      try {
        const targetCapacityBytes =
          await this.contractService.getTargetCapacity();
        targetCapacity = Number(targetCapacityBytes) / 1024 ** 4; // Convert bytes to TB
      } catch (error) {
        // Estimate: assume network wants 50% more capacity than current active workers provide
        targetCapacity = Number(activeWorkerCount) * WORKER_CAPACITY_TB * 1.5;
        ctx.logger.warn({ error }, `Using estimated target capacity`);
      }

      // Ensure target capacity is reasonable
      if (targetCapacity === 0 || targetCapacity > actualCapacity * 10) {
        targetCapacity = actualCapacity * 1.2; // Default to 20% more than actual
      }

      ctx.logger.debug(`🏗️ Network Capacity (per Tokenomics 2.1):`);
      ctx.logger.debug(`  Active workers: ${activeWorkerCount}`);
      ctx.logger.debug(`  Worker capacity: ${WORKER_CAPACITY_TB} TB`);
      ctx.logger.debug(`  Churn factor: ${CHURN_FACTOR}`);
      ctx.logger.debug(`  Actual capacity: ${actualCapacity.toFixed(2)} TB`);
      ctx.logger.debug(`  Target capacity: ${targetCapacity.toFixed(2)} TB`);
      ctx.logger.debug(
        `  Utilization rate: ${(((targetCapacity - actualCapacity) / targetCapacity) * 100).toFixed(2)}%`,
      );

      return { targetCapacity, actualCapacity };
    } catch (error) {
      ctx.logger.warn({ error }, `Failed to calculate network capacity`);
      // Fallback values for development
      return { targetCapacity: 100, actualCapacity: 80 };
    }
  }

  private async getStakeMetrics(ctx: Context): Promise<{
    totalStakedSupply: bigint;
    totalSupply: bigint;
  }> {
    try {
      // Try to get real delegation data from ClickHouse
      const databaseName =
        this.configService.get('database.clickhouse.database') || 'testnet';
      const query = `
        SELECT 
          SUM(stake) as totalStake,
          COUNT(DISTINCT worker_id) as workerCount
        FROM ${databaseName}.worker_stats 
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

            ctx.logger.debug(`💰 Stake Metrics (from ClickHouse):`);
            ctx.logger.debug(
              `  Total staked: ${Number(totalStakedSupply) / 1e18} SQD`,
            );
            ctx.logger.debug(`  Worker count: ${workerCount}`);
            ctx.logger.debug(
              `  Total supply: ${Number(totalSupply) / 1e18} SQD`,
            );
            ctx.logger.debug(
              `  Stake percentage: ${((Number(totalStakedSupply) / Number(totalSupply)) * 100).toFixed(2)}%`,
            );

            return { totalStakedSupply, totalSupply };
          }
        }
      } catch (error) {
        ctx.logger.warn(
          { error },
          `Failed to fetch stake data from ClickHouse`,
        );
      }

      // Fallback to estimation if ClickHouse query fails
      const activeWorkerCount = await this.web3Service.getActiveWorkerCount(ctx);
      const bondAmount = await this.web3Service.getBondAmount(ctx);

      // estimate: bonded amount + delegated stake (assume 2x bond on average)
      const estimatedTotalStaked = activeWorkerCount * bondAmount * 3n; // 3x multiplier for delegation

      // total supply: 1 billion SQD
      const estimatedTotalSupply = BigInt('1000000000') * BigInt(1e18);

      ctx.logger.debug(`💰 Stake Metrics (estimated):`);
      ctx.logger.debug(
        `  Estimated total staked: ${Number(estimatedTotalStaked) / 1e18} SQD`,
      );
      ctx.logger.debug(
        `  Estimated total supply: ${Number(estimatedTotalSupply) / 1e18} SQD`,
      );

      return {
        totalStakedSupply: estimatedTotalStaked,
        totalSupply: estimatedTotalSupply,
      };
    } catch (error) {
      ctx.logger.warn({ error }, `Failed to get stake metrics`);
      // fallback values for development
      return {
        totalStakedSupply: BigInt('100000000') * BigInt(1e18), // 100M SQD staked
        totalSupply: BigInt('10000000000') * BigInt(1e18), // 10B SQD total
      };
    }
  }

  /**
   * Get APR from ClickHouse rewards_stats table
   */
  private async getAPRFromClickHouse(
    ctx: Context,
    startTime: Date,
    endTime: Date,
  ): Promise<number | null> {
    try {
      const databaseName =
        this.configService.get('database.clickhouse.database') || 'testnet';

      // Get the latest successful APR from rewards_stats
      // This is more robust than trying to filter by time range
      const query = `
        SELECT 
          base_apr / 10000 as apr
        FROM ${databaseName}.rewards_stats
        WHERE is_commit_success = true
        ORDER BY epoch_end DESC
        LIMIT 1
      `;

      ctx.logger.debug(`🔍 Fetching latest APR from ClickHouse rewards_stats`);

      const client = (this.clickHouseService as any).client;
      if (!client) {
        ctx.logger.warn('ClickHouse client not available');
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
        ctx.logger.debug(
          `✅ Found latest APR in rewards_stats: ${(apr * 100).toFixed(2)}%`,
        );
        return apr;
      }

      ctx.logger.debug('No APR data found in rewards_stats');
      return null;
    } catch (error) {
      ctx.logger.warn({ error }, `Failed to fetch APR from ClickHouse`);
      return null;
    }
  }

  private async calculateRewardsOldMethod(
    ctx: Context,
    fromBlock: number,
    toBlock: number,
    startTime: Date,
    endTime: Date,
    skipSignatureValidation: boolean,
    batchNumberOverride?: number,
    totalBatchesOverride?: number,
  ): Promise<RewardCalculationResult> {
    console.log('🔄 Starting EXACT old rewards calculator method...');

    const { 
      OldWorkers, 
      calculateLivenessFactor,
    } = await import('./old-rewards-calculator');

    const epochLength = await this.contractService.getEpochLength(ctx);
    const totalBatchesForWindow = totalBatchesOverride ?? this.configService.get('rewards.totalBatches') ?? 4;
    
    const calculationStartBlock = toBlock - (epochLength * totalBatchesForWindow);
    const calculationStartTime = await this.web3Service.getBlockTimestamp(ctx, calculationStartBlock);
    
    console.log(`📊 Using four-epoch window for calculation:`);
    console.log(`   Single epoch: ${fromBlock} - ${toBlock} (${startTime.toISOString()} - ${endTime.toISOString()})`);
    console.log(`   Calculation window: ${calculationStartBlock} - ${toBlock} (${calculationStartTime.toISOString()} - ${endTime.toISOString()})`);
    console.log(`   Epoch length: ${epochLength} blocks, Total batches: ${totalBatchesForWindow}`);

    const oldWorkers = new OldWorkers(calculationStartTime, endTime);

    const activeWorkerData = await this.getWorkersFromClickHouse(
      calculationStartTime,
      endTime,
      skipSignatureValidation,
    );

    if (activeWorkerData.length === 0) {
      this.logger.warn('No workers found in ClickHouse data');
      return this.createEmptyResult(fromBlock, toBlock, startTime, endTime);
    }

    ctx.logger.debug(`📊 Found ${activeWorkerData.length} workers from ClickHouse`);

    for (const workerData of activeWorkerData) {
      const worker = oldWorkers.add(workerData.worker_id);

      await worker.processQuery({
        output_size: workerData.output_size,
        num_read_chunks: workerData.num_read_chunks,
      });

      worker.totalRequests = workerData.totalRequests;
    }

    ctx.logger.debug(`✅ Added ${oldWorkers.count()} workers to old backend calculator`);

    const workerIdMapping = await this.web3Service.preloadWorkerIds(
      ctx,
      activeWorkerData.map((w) => w.worker_id),
    );
    await oldWorkers.clearUnknownWorkers(workerIdMapping);

    if (oldWorkers.count() === 0) {
      this.logger.warn('No known workers found in contract mapping');
      return this.createEmptyResult(fromBlock, toBlock, startTime, endTime);
    }

    console.log(`🎯 Filtered to ${oldWorkers.count()} known workers`);

    const workerPeerIds = oldWorkers.getWorkerPeerIds();
    const [capedStakes, totalStakes] = await this.contractService.getStakes(
      workerPeerIds,
    );
    await oldWorkers.setStakes(
      capedStakes, 
      totalStakes, 
      workerPeerIds
    );

    const bondAmount = await this.web3Service.getBondAmount(ctx);
    await oldWorkers.fetchCurrentBond(bondAmount);

    oldWorkers.getT();

    oldWorkers.getDTraffic();

    const livenessFactor = await calculateLivenessFactor(
      this.clickHouseService,
      calculationStartTime,
      endTime,
    );
    await oldWorkers.getLiveness(livenessFactor);

    const epochLengthInBlocks = await this.contractService.getEpochLength(ctx);
    const SECONDS_PER_BLOCK = 12;
    const epochLengthSeconds = epochLengthInBlocks * SECONDS_PER_BLOCK;
    const TENURE_EPOCH_COUNT = 10;
    
    const epochStartBlocks = [...new Array(TENURE_EPOCH_COUNT + 1)].map(
      (_, i) => new Date(calculationStartTime.getTime() - ((TENURE_EPOCH_COUNT - i) * epochLengthSeconds * 1000))
    );
    
    const historicalLiveness = await this.getHistoricalLiveness(epochStartBlocks);
    await oldWorkers.getDTenure(historicalLiveness);

    const baseApr = await this.getAPRFromContracts(ctx);
    await oldWorkers.calculateRewards(baseApr);

    oldWorkers.logDebugInfo();

    let finalWorkers = oldWorkers;
    let batchNumber = batchNumberOverride ?? this.configService.get('rewards.batchNumber');
    const totalBatches = totalBatchesOverride ?? this.configService.get('rewards.totalBatches');
    
    if (batchNumber === undefined && totalBatches !== undefined) {
      const epochLength = 7000;
      batchNumber = Math.ceil(toBlock / epochLength) % totalBatches;
      console.log(`🧮 Auto-calculated batch number: Math.ceil(${toBlock} / ${epochLength}) % ${totalBatches} = ${batchNumber}`);
    }
    
    if (batchNumber !== undefined && totalBatches !== undefined) {
      console.log(`🔄 Applying batch filtering: ${batchNumber}/${totalBatches}`);
      finalWorkers = oldWorkers.filterBatch(batchNumber, totalBatches);
      console.log(`✅ Filtered to ${finalWorkers.count()} workers for batch ${batchNumber}`);
    } else {
      console.log(`⚠️  No batch filtering configured - processing ALL workers`);
      console.log(`   💡 To enable batch filtering, set BATCH_NUMBER and TOTAL_BATCHES environment variables`);
      console.log(`   📊 For block ${toBlock}: suggested batch = ${Math.ceil(toBlock / 7000) % (totalBatches || 4)}`);
    }

    const oldRewards = await finalWorkers.rewards();
    const workers: WorkerReward[] = [];
    const calculationTime = Date.now();

    for (const [peerId, reward] of Object.entries(oldRewards)) {
      workers.push({
        workerId: reward.id,
        id: reward.id,
        workerReward: reward.workerReward,
        stakerReward: reward.stakerReward,
        stake: 0n, 
        totalStake: 0n,
        calculationTime,
      });
    }

    const totalRewards = workers.reduce((sum, w) => sum + w.workerReward, 0n);

    console.log(`✅ EXACT old method calculated rewards for ${workers.length} workers`);
    console.log(`💰 Total rewards: ${Number(totalRewards) / 1e18} SQD`);

    return {
      workers,
      totalRewards,
      calculationTime: (endTime.getTime() - startTime.getTime()) / 1000,
    };
  }

  private async getWorkersFromClickHouse(
    startTime: Date,
    endTime: Date,
    skipSignatureValidation: boolean,
  ): Promise<any[]> {
    const databaseName = this.configService.get('database.clickhouse.database') || 'testnet';
    
    if (skipSignatureValidation) {
      const query = `
        SELECT 
          worker_id,
          sum(num_read_chunks) as num_read_chunks,
          sum(output_size) as output_size,
          count(*) as totalRequests
        FROM ${databaseName}.worker_query_logs
                WHERE
          ${databaseName}.worker_query_logs.worker_timestamp >= '${this.formatDateForClickHouse(startTime)}' AND
          ${databaseName}.worker_query_logs.worker_timestamp <= '${this.formatDateForClickHouse(endTime)}' AND
          (toUnixTimestamp64Micro(collector_timestamp) - toUnixTimestamp64Micro(worker_timestamp)) / 60000000 < 20
        GROUP BY worker_id
      `;

      console.log(`🔍 ClickHouse Query (EXACT old backend format):`);
      console.log(`   FROM: ${this.formatDateForClickHouse(startTime)}`);
      console.log(`   TO: ${this.formatDateForClickHouse(endTime)}`);

      const client = (this.clickHouseService as any).client;
      const resultSet = await client.query({ query, format: 'JSONEachRow' });
      const results = await resultSet.json();
      const resultArray = Array.isArray(results) ? results : [results];
      
      console.log(`📊 ClickHouse returned ${resultArray.length} workers`);
      
      return resultArray;
    } else {
      throw new Error('Signature validation mode not implemented in new backend');
    }
  }

  private formatDateForClickHouse(date: Date): string {
    return date.toISOString().slice(0, 19).replace('T', ' ');
  }

  private async getHistoricalLiveness(epochRanges: Date[]): Promise<Record<string, number[]>> {
    const sortedEpochRanges = epochRanges.sort(
      (a, b) => a.getTime() - b.getTime(),
    );
    const from = sortedEpochRanges[0];
    const to = sortedEpochRanges.at(-1)!;
    const pings = await this.getPingsFromClickHouse(from, to);
    const epochRangesTimestamps = sortedEpochRanges.map((date) =>
      Math.floor(date.getTime() / 1000),
    );
    const splittedPings = Object.entries(pings).map(([workerId, timestamps]) => {
      return [workerId, this.splitLogs(timestamps, epochRangesTimestamps)] as const;
    });
    const _networkStats = splittedPings.map(
      ([workerId, splits]) =>
        [
          workerId,
          splits.map((split, i) => {
            return this.networkStats(
              split,
              epochRangesTimestamps[i + 1] - epochRangesTimestamps[i],
            ).livenessFactor;
          }),
        ] as const,
    );
    return Object.fromEntries(_networkStats);
  }

  private async getPingsFromClickHouse(from: Date, to: Date): Promise<Record<string, number[]>> {
    const databaseName = this.configService.get('database.clickhouse.database') || 'testnet';
    const query = `
      SELECT
        worker_id,
        arrayConcat(
          [toUnixTimestamp('${this.formatDateForClickHouse(from)}')],
          arraySort(groupArray(toUnixTimestamp(timestamp))),
          [toUnixTimestamp('${this.formatDateForClickHouse(to)}')]
        ) as timestamps 
      FROM ${databaseName}.worker_pings_v2 
      WHERE timestamp >= '${this.formatDateForClickHouse(from)}' 
        AND timestamp <= '${this.formatDateForClickHouse(to)}' 
      GROUP BY worker_id
    `;

    const client = (this.clickHouseService as any).client;
    if (!client) {
      return {};
    }

    try {
      const resultSet = await client.query({ query, format: 'JSONEachRow' });
      const results = await resultSet.json();
      const resultArray = Array.isArray(results) ? results : [results];
      
      const pings: Record<string, number[]> = {};
      for (const row of resultArray) {
        if (row.worker_id && row.timestamps) {
          pings[row.worker_id] = row.timestamps;
        }
      }
      return pings;
    } catch (error) {
      console.warn(`Failed to get pings from ClickHouse: ${error}`);
      return {};
    }
  }

  private splitLogs(timestamps: number[], epochRanges: number[]): number[][] {
    const sortedTimestamps = timestamps.sort();
    const splits: number[][] = [[epochRanges[0]]];
    let index = 1;
    for (const timestamp of sortedTimestamps) {
      while (index < epochRanges.length && timestamp > epochRanges[index]) {
        splits.at(-1)!.push(epochRanges[index]);
        splits.push([epochRanges[index]]);
        index++;
      }
      const lastSplit = splits.at(-1)!;
      lastSplit.push(timestamp);
    }
    return splits;
  }

  private secondDiffs(dates: number[]): number[] {
    return dates
      .map((date, i) => {
        if (i === 0) return 0;
        return date - dates[i - 1];
      })
      .slice(1);
  }

  private totalOfflineSeconds(diffs: number[]): number {
    const WORKER_OFFLINE_THRESHOLD = 600;
    return diffs
      .filter((diff) => diff > WORKER_OFFLINE_THRESHOLD)
      .reduce((sum, diff) => sum + diff, 0);
  }

  private networkStats(pingTimestamps: number[], epochLength: number): { totalPings: number; totalTimeOffline: number; livenessFactor: number } {
    const diffs = this.secondDiffs(pingTimestamps);
    const totalTimeOffline = this.totalOfflineSeconds(diffs);

    return {
      totalPings: diffs.length - 1,
      totalTimeOffline: totalTimeOffline,
      livenessFactor: 1 - totalTimeOffline / epochLength,
    };
  }

  private calculateLivenessCoefficient(networkStats: { livenessFactor: number; totalPings: number; totalTimeOffline: number }): number {
    if (!networkStats) return 0;
    const { livenessFactor } = networkStats;
    if (livenessFactor < 0.8) {
      return 0;
    } else if (livenessFactor < 0.9) {
      return 9 * livenessFactor - 7.2;
    } else if (livenessFactor < 0.95) {
      return 2 * livenessFactor - 0.9;
    } else {
      return 1;
    }
  }

  private calculateAllTrafficFactors(ctx: Context, workerData: WorkerQueryData[]): number[] {
    const totalBytes = workerData.reduce((sum, w) => sum + Number(w.output_size), 0);
    const totalChunks = workerData.reduce((sum, w) => sum + Number(w.num_read_chunks), 0);

    if (totalBytes === 0 || totalChunks === 0) {
      return workerData.map(() => 1.0);
    }

    return workerData.map((worker) => {
      const workerBytes = Number(worker.output_size);
      const workerChunks = Number(worker.num_read_chunks);
      const bytesFactor = workerBytes / totalBytes;
      const chunksFactor = workerChunks / totalChunks;
      const trafficFactor = Math.sqrt(bytesFactor * chunksFactor);
      return Math.max(0.001, Math.min(2.0, trafficFactor));
    });
  }

  private calculateAllDTrafficFactors(
    ctx: Context,
    validWorkers: Array<{
      worker: WorkerQueryData;
      capedStake: bigint;
      totalStake: bigint;
    }>,
    bondAmount: bigint,
  ): number[] {
    const workerCount = validWorkers.length;
    const totalBond = bondAmount * BigInt(workerCount);
    
    const totalStakes = validWorkers.reduce((sum, { capedStake }) => sum + capedStake, 0n);
    const totalSupply = totalBond + totalStakes;
    
    if (totalSupply === 0n) {
      return validWorkers.map(() => 1.0);
    }

    const trafficFactors = this.calculateAllTrafficFactors(ctx, validWorkers.map(w => w.worker));

    return validWorkers.map(({ capedStake }, index) => {
      const workerSupply = bondAmount + capedStake;
      const supplyRatio = Number(workerSupply) / Number(totalSupply);
      
      if (supplyRatio === 0) {
        return 0.001;
      }
      
      const trafficWeight = trafficFactors[index];
      const dTrafficAlpha = 0.1;
      const dTraffic = Math.min(1.0, Math.pow(trafficWeight / supplyRatio, dTrafficAlpha));
      
      return Math.max(0.001, Math.min(1.0, dTraffic));
    });
  }

  /**
   * Get APR from contracts using the old rewards calculator approach
   * This replicates the currentApy() function from packages/rewards-calculator/src/chain.ts
   */
  private async getAPRFromContracts(ctx: Context): Promise<number> {
    try {
      ctx.logger.debug(`🔗 Calculating APR from contracts (old backend method)`);

      // Get current block for consistent reads
      const currentBlock = await this.web3Service.getLatestL2Block();

      try {
        const tvl = await this.contractService.getEffectiveTVL(ctx, currentBlock);
        ctx.logger.debug(`TVL: ${tvl.toString()}`);
        
        if (tvl === 0n) {
          ctx.logger.debug('TVL is 0, returning 20% APR as per old backend logic');
          return 0.2; 
        }

        const initialRewardPoolSize = await this.contractService.getInitialRewardPoolSize(ctx, currentBlock);
        ctx.logger.debug(`Initial Reward Pool Size: ${initialRewardPoolSize.toString()}`);

        const yearlyRewardCapCoefficient = await this.contractService.getYearlyRewardCapCoefficient(ctx, currentBlock);
        ctx.logger.debug(`Yearly Reward Cap Coefficient: ${yearlyRewardCapCoefficient.toString()}`);


        const apyCap = (yearlyRewardCapCoefficient * initialRewardPoolSize) / tvl;
        ctx.logger.debug(`APY Cap: ${apyCap.toString()}`);

        const finalApyBasisPoints = apyCap < 2000n ? apyCap : 2000n;

        const finalApr = Number(finalApyBasisPoints) / 10000;

        ctx.logger.debug(
          `✅ Contract-based APR calculation: ${(finalApr * 100).toFixed(2)}% (${finalApyBasisPoints} basis points)`,
        );
        return finalApr;

      } catch (contractError) {
        ctx.logger.warn(
          { error: contractError },
          `Contract APR calculation failed, using 20% fallback`,
        );
        return 0.2;
      }
    } catch (error) {
      ctx.logger.error({ error }, `Failed to get APR from contracts`);
      return 0.2; // 20% fallback
    }
  }
}
