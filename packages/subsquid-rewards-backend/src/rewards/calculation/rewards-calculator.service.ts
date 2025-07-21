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
import Decimal from 'decimal.js';

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
  private workerIdMapping: Record<
    string,
    { peerId: string; contractId: bigint }
  > = {};

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

    return this.calculateRewards(
      ctx,
      fromBlock,
      toBlock,
      shouldSkipValidation,
      batchNumberOverride,
      totalBatchesOverride,
    );
  }

  async calculateRewardsFormatted(
    ctx: Context,
    fromBlock: number,
    toBlock: number,
    skipSignatureValidation?: boolean,
    batchNumberOverride?: number,
    totalBatchesOverride?: number,
  ): Promise<{
    totalRewards: {
      worker: string;
      staker: string;
    };
    workers: any[];
  }> {
    const shouldSkipValidation: boolean =
      skipSignatureValidation ??
      this.configService.get('rewards.skipSignatureValidation', true);

    if (shouldSkipValidation) {
      ctx.logger.warn(
        '🚨 Signature validation is DISABLED - this is for development/testing only',
      );
    }

    try {
      const startTime = await this.web3Service.getBlockTimestamp(
        ctx,
        fromBlock,
      );
      const endTime = await this.web3Service.getBlockTimestamp(ctx, toBlock);

      ctx.logger.debug('🔄 Starting old rewards calculator method...');

      const { OldWorkers, calculateLivenessFactor, historicalLiveness } =
        await import('./old-rewards-calculator');

      const oldWorkers = new OldWorkers(startTime, endTime);

      const activeWorkerData = await this.clickHouseService.getActiveWorkers(
        ctx,
        startTime,
        endTime,
        shouldSkipValidation,
      );

      if (activeWorkerData.length === 0) {
        ctx.logger.warn('No workers found in ClickHouse data');
        return { totalRewards: { worker: '0', staker: '0' }, workers: [] };
      }

      for (const workerData of activeWorkerData) {
        const worker = oldWorkers.add(workerData.worker_id);
        await worker.processQuery(
          {
            output_size: Number(workerData.output_size),
            num_read_chunks: Number(workerData.num_read_chunks),
          },
          shouldSkipValidation,
        );
        worker.totalRequests = Number(workerData.totalRequests);
        if (shouldSkipValidation) {
          worker.requestsProcessed = Number(workerData.totalRequests);
        }
      }

      await oldWorkers.getNextDistributionStartBlockNumber(BigInt(toBlock));

      const workerIdMapping = await this.web3Service.preloadWorkerIds(
        ctx,
        activeWorkerData.map((w) => w.worker_id),
      );
      await oldWorkers.clearUnknownWorkers(workerIdMapping);

      if (oldWorkers.count() === 0) {
        ctx.logger.warn('No known workers found in contract mapping');
        return { totalRewards: { worker: '0', staker: '0' }, workers: [] };
      }

      const workerPeerIds = oldWorkers.getWorkerPeerIds();
      const [capedStakes, totalStakes] =
        await this.contractService.getStakes(workerPeerIds);
      await oldWorkers.setStakes(capedStakes, totalStakes, workerPeerIds);

      oldWorkers.getT();

      const bondAmount = await this.web3Service.getBondAmount(ctx);
      await oldWorkers.fetchCurrentBond(bondAmount);

      const Decimal = (await import('decimal.js')).default;
      oldWorkers.getDTraffic(new Decimal(0.1));

      const livenessFactor = await calculateLivenessFactor(
        this.clickHouseService,
        startTime,
        endTime,
      );
      await oldWorkers.getLiveness(livenessFactor);

      const epochLengthInBlocks =
        await this.contractService.getEpochLength(ctx);
      const TENURE_EPOCH_COUNT = this.configService.get(
        'rewards.tenureEpochCount',
        10,
      );
      const tenureStartBlock =
        fromBlock - epochLengthInBlocks * TENURE_EPOCH_COUNT;
      const epochStartBlockNumbers = [...new Array(TENURE_EPOCH_COUNT + 1)].map(
        (_, i) => tenureStartBlock + i * epochLengthInBlocks,
      );

      const epochStartTimestamps = await Promise.all(
        epochStartBlockNumbers.map(async (blockNumber) => {
          try {
            return await this.web3Service.getBlockTimestamp(ctx, blockNumber);
          } catch (error) {
            const estimatedTime = new Date(
              startTime.getTime() - (fromBlock - blockNumber) * 12 * 1000,
            );
            return estimatedTime;
          }
        }),
      );

      const historicalLivenessData = await historicalLiveness(
        this.clickHouseService,
        epochStartTimestamps,
      );
      await oldWorkers.getDTenure(historicalLivenessData);

      const baseApr = await this.getAPRFromContracts(ctx);
      await oldWorkers.calculateRewards(baseApr);

      await oldWorkers.logStats();
      await oldWorkers.logDebugInfo();

      let finalWorkers = oldWorkers;
      let batchNumber =
        batchNumberOverride ?? this.configService.get('rewards.batchNumber');
      const totalBatches =
        totalBatchesOverride ?? this.configService.get('rewards.totalBatches');

      if (batchNumber === undefined && totalBatches !== undefined) {
        const epochNumber = Math.ceil(toBlock / epochLengthInBlocks);
        batchNumber = epochNumber % totalBatches;
      }

      if (batchNumber !== undefined && totalBatches !== undefined) {
        finalWorkers = oldWorkers.filterBatch(batchNumber, totalBatches);
      }

      const bn = (value: { toString(): string }) =>
        BigInt(Math.floor(Number(value.toString())));

      const duration = Math.floor(
        (endTime.getTime() - startTime.getTime()) / 1000,
      );

      const workerStats = finalWorkers.map((worker: any) => {
        const aprData = worker.apr(duration, 365 * 24 * 60 * 60);
        
        // debug log for request counts
        if (worker.totalRequests > 0) {
          ctx.logger.debug(
            `Worker ${worker.peerId.slice(0, 10)}... - totalRequests: ${worker.totalRequests}, requestsProcessed: ${worker.requestsProcessed}, errorRate: ${(1 - worker.requestsProcessed / worker.totalRequests).toFixed(4)}`
          );
        }

        return {
          id: worker.peerId,
          workerReward: bn(worker.workerReward).toString(),
          stakerReward: bn(worker.stakerReward).toString(),
          apr: {
            worker_apr: aprData.worker_apr,
            delegator_apr: aprData.delegator_apr,
          },
          traffic: {
            bytesSent: worker.bytesSent,
            chunksRead: worker.chunksRead,
            trafficWeight: worker.trafficWeight.toNumber(),
            dTraffic: worker.dTraffic.toNumber(),
            validRequests: worker.requestsProcessed,
            totalRequests: worker.totalRequests,
            requestErrorRate:
              1 - worker.requestsProcessed / worker.totalRequests,
          },
          delegation: {
            totalDelegated: bn(worker.totalStake).toString(),
            effectiveStake: bn(worker.stake).toString(),
          },
          liveness: {
            livenessCoefficient: worker.livenessCoefficient.toNumber(),
            tenure: worker.dTenure.toNumber(),
          },
        };
      });

      const totalWorkerReward = workerStats
        .map((worker) => BigInt(worker.workerReward))
        .reduce((a, b) => a + b, 0n);
      const totalStakerReward = workerStats
        .map((worker) => BigInt(worker.stakerReward))
        .reduce((a, b) => a + b, 0n);

      return {
        totalRewards: {
          worker: totalWorkerReward.toString(),
          staker: totalStakerReward.toString(),
        },
        workers: workerStats,
      };
    } catch (error) {
      ctx.logger.error({ error }, `Failed to calculate formatted rewards`);
      throw error;
    }
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
      ctx.logger.debug(
        `🔗 Using old rewards calculator method for blocks ${fromBlock} - ${toBlock}`,
      );

      const startTime = await this.web3Service.getBlockTimestamp(
        ctx,
        fromBlock,
      );
      const endTime = await this.web3Service.getBlockTimestamp(ctx, toBlock);

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
    } catch (error) {
      ctx.logger.error({ error }, `Failed to calculate epoch rewards`);
      throw error;
    }
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
          (data) => data.contractId === worker.workerId,
        );

        if (!workerData?.peerId) {
          const workerIdBytes = Buffer.from(
            worker.workerId.toString(16).padStart(32, '0'),
            'hex',
          );
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
    ctx.logger.debug('🔄 Starting old rewards calculator method...');

    const { OldWorkers, calculateLivenessFactor, historicalLiveness } =
      await import('./old-rewards-calculator');

    // oldWorkers instance with the time range
    const oldWorkers = new OldWorkers(startTime, endTime);

    // active workers from ClickHouse
    const activeWorkerData = await this.clickHouseService.getActiveWorkers(
      ctx,
      startTime,
      endTime,
      skipSignatureValidation,
    );

    if (activeWorkerData.length === 0) {
      ctx.logger.warn('No workers found in ClickHouse data');
      return this.createEmptyResult(fromBlock, toBlock, startTime, endTime);
    }

    ctx.logger.debug(
      `📊 Found ${activeWorkerData.length} workers from ClickHouse`,
    );

    // add workers and process their queries
    for (const workerData of activeWorkerData) {
      const worker = oldWorkers.add(workerData.worker_id);

      // process query data with signature validation setting
      await worker.processQuery(
        {
          output_size: Number(workerData.output_size),
          num_read_chunks: Number(workerData.num_read_chunks),
        },
        skipSignatureValidation,
      );

      // set total requests
      worker.totalRequests = Number(workerData.totalRequests);
      
      if (skipSignatureValidation) {
        worker.requestsProcessed = Number(workerData.totalRequests);
      }
    }

    ctx.logger.debug(
      `✅ Added ${oldWorkers.count()} workers to old backend calculator`,
    );

    // get next distribution start block number (not used in calculation but matches the flow)
    await oldWorkers.getNextDistributionStartBlockNumber(BigInt(toBlock));

    // clear unknown workers (filter by contract registration)
    const workerIdMapping = await this.web3Service.preloadWorkerIds(
      ctx,
      activeWorkerData.map((w) => w.worker_id),
    );
    await oldWorkers.clearUnknownWorkers(workerIdMapping);

    if (oldWorkers.count() === 0) {
      ctx.logger.warn('No known workers found in contract mapping');
      return this.createEmptyResult(fromBlock, toBlock, startTime, endTime);
    }

    ctx.logger.debug(`🎯 Filtered to ${oldWorkers.count()} known workers`);

    // get stakes
    const workerPeerIds = oldWorkers.getWorkerPeerIds();
    const [capedStakes, totalStakes] =
      await this.contractService.getStakes(workerPeerIds);
    await oldWorkers.setStakes(capedStakes, totalStakes, workerPeerIds);

    // calculate T (traffic weight)
    oldWorkers.getT();

    // fetch current bond from contract
    let bondAmount: bigint;
    try {
      bondAmount = await this.web3Service.getBondAmount(ctx);
      ctx.logger.debug(
        `✅ Retrieved current bond amount from WorkerRegistration contract: ${Number(bondAmount) / 1e18} SQD (${bondAmount} wei)`,
      );
    } catch (error) {
      ctx.logger.error(
        { error },
        `❌ Failed to get bond amount from WorkerRegistration contract`,
      );
      throw new Error(
        `Cannot proceed without bond amount from contract: ${error.message}`,
      );
    }
    await oldWorkers.fetchCurrentBond(bondAmount);

    // calculate dTraffic
    oldWorkers.getDTraffic(new Decimal(0.1));

    // get liveness
    const livenessFactor = await calculateLivenessFactor(
      this.clickHouseService,
      startTime,
      endTime,
    );
    await oldWorkers.getLiveness(livenessFactor);

    // get dTenure with historical liveness
    const epochLengthInBlocks = await this.contractService.getEpochLength(ctx);
    const TENURE_EPOCH_COUNT = this.configService.get(
      'rewards.tenureEpochCount',
      10,
    );

    // Calculate actual historical block numbers (like the old backend)
    const tenureStartBlock =
      fromBlock - epochLengthInBlocks * TENURE_EPOCH_COUNT;
    const epochStartBlockNumbers = [...new Array(TENURE_EPOCH_COUNT + 1)].map(
      (_, i) => tenureStartBlock + i * epochLengthInBlocks,
    );

    ctx.logger.debug(
      `📅 Calculating dTenure for historical blocks: ${epochStartBlockNumbers[0]} to ${epochStartBlockNumbers[epochStartBlockNumbers.length - 1]}`,
    );

    // Fetch actual timestamps for each historical block (correct method)
    const epochStartTimestamps = await Promise.all(
      epochStartBlockNumbers.map(async (blockNumber) => {
        try {
          return await this.web3Service.getBlockTimestamp(ctx, blockNumber);
        } catch (error) {
          ctx.logger.warn(
            `Failed to get timestamp for block ${blockNumber}, using estimated time`,
          );
          // fallback: estimate based on 12-second block time
          const estimatedTime = new Date(
            startTime.getTime() - (fromBlock - blockNumber) * 12 * 1000,
          );
          return estimatedTime;
        }
      }),
    );

    ctx.logger.debug(
      `✅ Retrieved ${epochStartTimestamps.length} historical timestamps for dTenure calculation`,
    );

    const historicalLivenessData = await historicalLiveness(
      this.clickHouseService,
      epochStartTimestamps,
    );
    await oldWorkers.getDTenure(historicalLivenessData);

    // lalculate rewards with APR from contracts
    const baseApr = await this.getAPRFromContracts(ctx);
    await oldWorkers.calculateRewards(baseApr);

    await oldWorkers.logStats();
    await oldWorkers.logDebugInfo();

    // Apply batch filtering if configured
    let finalWorkers = oldWorkers;
    let batchNumber =
      batchNumberOverride ?? this.configService.get('rewards.batchNumber');
    const totalBatches =
      totalBatchesOverride ?? this.configService.get('rewards.totalBatches');

    // DEBUG: Log batch number sources
    ctx.logger.debug(
      `🔍 Batch number sources: override=${batchNumberOverride}, config=${this.configService.get('rewards.batchNumber')}, env.BATCH_NUMBER=${process.env.BATCH_NUMBER}`,
    );

    if (batchNumber === undefined && totalBatches !== undefined) {
      // Auto-calculate batch number based on epoch
      ctx.logger.debug(
        `🧮 Batch calculation inputs: toBlock=${toBlock}, epochLengthInBlocks=${epochLengthInBlocks}, totalBatches=${totalBatches}`,
      );
      const epochNumber = Math.ceil(toBlock / epochLengthInBlocks);
      batchNumber = epochNumber % totalBatches;
      ctx.logger.debug(
        `🧮 Auto-calculated batch number: epochNumber=${epochNumber} (${toBlock}/${epochLengthInBlocks}) → batchNumber=${batchNumber} (${epochNumber}%${totalBatches})`,
      );
    }

    if (batchNumber !== undefined && totalBatches !== undefined) {
      ctx.logger.debug(
        `🔄 Applying batch filtering: ${batchNumber}/${totalBatches}`,
      );
      finalWorkers = oldWorkers.filterBatch(batchNumber, totalBatches);
      ctx.logger.debug(
        `✅ Filtered to ${finalWorkers.count()} workers for batch ${batchNumber}`,
      );
    }

    // Get final rewards
    const oldRewards = await finalWorkers.rewards();
    const workers: WorkerReward[] = [];

    for (const [peerId, reward] of Object.entries(oldRewards)) {
      // Get worker's stake information
      const workerIndex = workerPeerIds.indexOf(peerId);
      const capedStake =
        workerIndex >= 0 && capedStakes[workerIndex]?.status === 'success'
          ? BigInt(capedStakes[workerIndex].result || 0)
          : 0n;
      const totalStake =
        workerIndex >= 0 && totalStakes[workerIndex]?.status === 'success'
          ? BigInt(totalStakes[workerIndex].result || 0)
          : 0n;

      workers.push({
        workerId: reward.id,
        id: reward.id,
        workerReward: reward.workerReward,
        stakerReward: reward.stakerReward,
        stake: capedStake,
        totalStake: totalStake,
        calculationTime: (endTime.getTime() - startTime.getTime()) / 1000,
      });
    }

    const totalRewards = workers.reduce((sum, w) => sum + w.workerReward, 0n);

    ctx.logger.debug(
      `✅ Old method calculated rewards for ${workers.length} workers`,
    );
    ctx.logger.debug(`💰 Total rewards: ${Number(totalRewards) / 1e18} SQD`);

    return {
      workers,
      totalRewards,
      calculationTime: (endTime.getTime() - startTime.getTime()) / 1000,
    };
  }

  /**
   * Get APR from contracts using the old rewards calculator approach
   * This replicates the currentApy() function from packages/rewards-calculator/src/chain.ts
   */
  private async getAPRFromContracts(ctx: Context): Promise<number> {
    try {
      ctx.logger.debug(
        `🔗 Calculating APR from contracts (old backend method)`,
      );

      // Get current block for consistent reads
      const currentBlock = await this.web3Service.getLatestL2Block();

      try {
        const tvl = await this.contractService.getEffectiveTVL(
          ctx,
          currentBlock,
        );
        ctx.logger.debug(`TVL: ${tvl.toString()}`);

        if (tvl === 0n) {
          ctx.logger.debug(
            'TVL is 0, returning 20% APR as per old backend logic',
          );
          return 0.2;
        }

        const initialRewardPoolSize =
          await this.contractService.getInitialRewardPoolSize(
            ctx,
            currentBlock,
          );
        ctx.logger.debug(
          `Initial Reward Pool Size: ${initialRewardPoolSize.toString()}`,
        );

        const yearlyRewardCapCoefficient =
          await this.contractService.getYearlyRewardCapCoefficient(
            ctx,
            currentBlock,
          );
        ctx.logger.debug(
          `Yearly Reward Cap Coefficient: ${yearlyRewardCapCoefficient.toString()}`,
        );

        const apyCap =
          (yearlyRewardCapCoefficient * initialRewardPoolSize) / tvl;
        ctx.logger.debug(`APY Cap: ${apyCap.toString()}`);

        const finalApyBasisPoints = apyCap < 2000n ? apyCap : 2000n;

        const finalApr = Number(finalApyBasisPoints);

        ctx.logger.debug(
          `✅ Contract-based APR calculation: ${(finalApr / 100).toFixed(2)}% (${finalApyBasisPoints} basis points)`,
        );
        return finalApr;
      } catch (contractError) {
        ctx.logger.warn(
          { error: contractError },
          `Contract APR calculation failed, using 20% fallback`,
        );
        return 2000; // 20% APR in basis points
      }
    } catch (error) {
      ctx.logger.error({ error }, `Failed to get APR from contracts`);
      return 2000; // 20% fallback in basis points
    }
  }
}
