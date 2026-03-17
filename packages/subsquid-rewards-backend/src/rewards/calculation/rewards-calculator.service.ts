import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClickHouseService } from '../../database/clickhouse.service';
import { ContractService } from '../../blockchain/contract.service';
import { MetricsLoggerService } from '../../common/metrics-logger.service';
import { Context } from '../../common';
import Decimal from 'decimal.js';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import bs58 from 'bs58';

dayjs.extend(utc);
Decimal.set({ precision: 28, minE: -9 });

const YEAR = 365 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Exported interfaces
// ---------------------------------------------------------------------------

export interface NetworkStatsEntry {
  totalPings: number;
  totalTimeOffline: number;
  livenessFactor: number;
}

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
  epochMetadata?: {
    adjustedStartTime: Date;
    endTime: Date;
    fromBlock: number;
    toBlock: number;
  };
}

export interface FormattedRewardResult {
  totalRewards: {
    worker: string;
    staker: string;
  };
  workers: any[];
}

// ---------------------------------------------------------------------------
// Inlined reward-formula helpers (moved from old-rewards-calculator.ts)
// ---------------------------------------------------------------------------

/**
 * Minimal per-worker state used during a single reward calculation.
 * Exported so that the unit tests can exercise the formula directly.
 */
export class RewardWorker {
  private contractId: bigint | undefined;
  public networkStats: NetworkStatsEntry | undefined;
  public bytesSent = 0;
  public chunksRead = 0;
  public trafficWeight = new Decimal(0);
  public dTraffic = new Decimal(0);
  public stake = new Decimal(0);
  public totalStake = new Decimal(0);
  public livenessCoefficient = new Decimal(0);
  public bond = new Decimal(0);
  public actualYield = new Decimal(0);
  public workerReward!: Decimal;
  public stakerReward!: Decimal;
  public dTenure!: Decimal;
  public requestsProcessed = 0;
  public totalRequests = 0;

  constructor(public peerId: string) {}

  public setContractId(contractId: bigint) {
    this.contractId = contractId;
  }

  public async processQuery(
    query: { output_size: number; num_read_chunks: number },
    shouldSkipSignatureValidation: boolean = false,
  ) {
    this.bytesSent += query.output_size;
    this.chunksRead += query.num_read_chunks;
    return true;
  }

  public async getId(): Promise<bigint> {
    if (this.contractId) {
      return this.contractId;
    }
    return 0n;
  }

  public async calculateT(totalBytesSent: number, totalChunksRead: number) {
    const { bytesSent, chunksRead } = this.normalizeTraffic(
      totalBytesSent,
      totalChunksRead,
    );
    this.trafficWeight = Decimal.sqrt(bytesSent.mul(chunksRead));
  }

  public async calculateDTraffic(
    totalSupply: Decimal,
    dTrafficAlpha: Decimal = new Decimal(0.1),
  ) {
    if (totalSupply.isZero()) {
      this.dTraffic = new Decimal(0);
      return;
    }
    const supplyRatio = this.stake.add(this.bond).div(totalSupply);
    if (supplyRatio.isZero()) {
      this.dTraffic = new Decimal(1);
      return;
    }
    this.dTraffic = Decimal.min(
      new Decimal(1),
      this.trafficWeight.div(supplyRatio).pow(dTrafficAlpha),
    );
  }

  /**
   * Piecewise liveness coefficient:
   *   <0.8  -> 0
   *   0.8-0.9  -> 9*l - 7.2
   *   0.9-0.95 -> 2*l - 0.9
   *   >=0.95   -> 1
   */
  public async calculateLiveness(networkStats: NetworkStatsEntry) {
    this.networkStats = networkStats;
    if (!networkStats) {
      return;
    }

    const { livenessFactor } = networkStats;

    if (livenessFactor < 0.8) {
      this.livenessCoefficient = new Decimal(0);
    } else if (livenessFactor < 0.9) {
      this.livenessCoefficient = new Decimal(9).mul(livenessFactor).sub(7.2);
    } else if (livenessFactor < 0.95) {
      this.livenessCoefficient = new Decimal(2).mul(livenessFactor).sub(0.9);
    } else {
      this.livenessCoefficient = new Decimal(1);
    }
  }

  public async calculateDTenure(historicalLiveness: number[]) {
    const LIVENESS_THRESHOLD = 0.9;
    const liveEpochs = new Decimal(
      historicalLiveness.filter(
        (liveness) => liveness >= LIVENESS_THRESHOLD,
      ).length,
    );
    this.dTenure = new Decimal(0.5).add(
      Decimal.floor(liveEpochs.div(2).add(0.05)).mul(0.1),
    );
  }

  /**
   * Core reward formula:
   *   actualYield  = rMax * livenessCoefficient * dTraffic * dTenure
   *   workerReward = actualYield * (bond + stake/2)
   *   stakerReward = actualYield * stake / 2
   */
  public async getRewards(rMax: Decimal) {
    this.actualYield = rMax
      .mul(this.livenessCoefficient)
      .mul(this.dTraffic)
      .mul(this.dTenure);

    this.workerReward = this.actualYield.mul(this.bond.add(this.stake.div(2)));
    this.stakerReward = this.actualYield.mul(this.stake).div(2);
  }

  public apr(epochDuration: number, year: number) {
    const bond = new Decimal(this.bond.toString());
    const workerReward = new Decimal(this.workerReward.toString());
    const stakerReward = new Decimal(this.stakerReward.toString());
    if (epochDuration === 0) {
      return { worker_apr: '0', delegator_apr: '0' };
    }
    const duration = new Decimal(year).div(epochDuration);

    return {
      worker_apr: bond.isZero() ? '0' : workerReward.div(bond).mul(duration).toFixed(),
      delegator_apr: this.totalStake.eq(0)
        ? '0'
        : stakerReward.div(this.totalStake).mul(duration).toFixed(),
    };
  }

  private normalizeTraffic(totalBytesSent: number, totalChunksRead: number) {
    return {
      bytesSent: totalBytesSent === 0 ? new Decimal(0) : new Decimal(this.bytesSent).div(totalBytesSent),
      chunksRead: totalChunksRead === 0 ? new Decimal(0) : new Decimal(this.chunksRead).div(totalChunksRead),
    };
  }
}

// Backward-compatible alias so the existing tests keep working
export { RewardWorker as OldWorker };

// ---------------------------------------------------------------------------
// ClickHouse liveness helpers (inlined from old-rewards-calculator.ts)
// ---------------------------------------------------------------------------

function formatDateForClickHouse(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function secondDiffs(dates: number[]) {
  return dates
    .map((date, i) => {
      if (i === 0) return 0;
      return date - dates[i - 1];
    })
    .slice(1);
}

function totalOfflineSeconds(diffs: number[], workerOfflineThreshold = 600) {
  return diffs
    .filter((diff) => diff > workerOfflineThreshold)
    .reduce((sum, diff) => sum + diff, 0);
}

function networkStats(pingTimestamps: number[], epochLength: number): NetworkStatsEntry {
  const diffs = secondDiffs(pingTimestamps);
  const totalTimeOffline = totalOfflineSeconds(diffs);

  return {
    totalPings: diffs.length - 1,
    totalTimeOffline: totalTimeOffline,
    livenessFactor: 1 - totalTimeOffline / epochLength,
  };
}

export async function calculateLivenessFactor(
  clickHouseService: any,
  startTime: Date,
  endTime: Date,
): Promise<Record<string, NetworkStatsEntry>> {
  try {
    const databaseName =
      clickHouseService.configService?.get('database.clickhouse.database') ||
      'testnet';

    const query = `
      SELECT
        worker_id,
        arrayConcat(
          [toUnixTimestamp('${formatDateForClickHouse(startTime)}')],
          arraySort(groupArray(toUnixTimestamp(timestamp))),
          [toUnixTimestamp('${formatDateForClickHouse(endTime)}')]
        ) as timestamps
      FROM ${databaseName}.worker_pings_v2
      WHERE timestamp >= '${formatDateForClickHouse(startTime)}'
        AND timestamp <= '${formatDateForClickHouse(endTime)}'
      GROUP BY worker_id
    `;

    const client = clickHouseService.client;
    const pings: any[] = [];
    for await (const row of client.query(query).stream()) {
      pings.push(row);
    }

    const totalPeriodSeconds = Math.floor(
      (endTime.getTime() - startTime.getTime()) / 1000,
    );

    const res: Record<string, NetworkStatsEntry> = {};

    for (const ping of pings) {
      if (ping.worker_id && ping.timestamps) {
        const stats = networkStats(ping.timestamps, totalPeriodSeconds);
        res[ping.worker_id] = stats;
      }
    }

    return res;
  } catch (error) {
    console.error('[calculateLivenessFactor] Failed to calculate liveness factors from ClickHouse:', error);
    return {};
  }
}

function splitLogs(timestamps: number[], epochRanges: number[]) {
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

async function getPings(
  clickhouseService: any,
  from: Date,
  to: Date,
): Promise<Record<string, number[]>> {
  const databaseName =
    clickhouseService.configService?.get('database.clickhouse.database') ||
    'testnet';
  const query = `
    SELECT
      worker_id,
      arrayConcat(
        [toUnixTimestamp('${formatDateForClickHouse(from)}')],
        arraySort(groupArray(toUnixTimestamp(timestamp))),
        [toUnixTimestamp('${formatDateForClickHouse(to)}')]
      ) as timestamps
    FROM ${databaseName}.worker_pings_v2
    WHERE timestamp >= '${formatDateForClickHouse(from)}'
      AND timestamp <= '${formatDateForClickHouse(to)}'
    GROUP BY worker_id
  `;

  const client = clickhouseService.client;
  const pings: Record<string, number[]> = {};

  for await (const row of client.query(query).stream()) {
    if (row.worker_id && row.timestamps) {
      pings[row.worker_id] = row.timestamps;
    }
  }

  return pings;
}

async function historicalLiveness(
  clickhouseService: any,
  epochRanges: Date[],
): Promise<Record<string, number[]>> {
  const sortedEpochRanges = epochRanges.sort(
    (a, b) => a.getTime() - b.getTime(),
  );
  const from = sortedEpochRanges[0];
  const to = sortedEpochRanges[sortedEpochRanges.length - 1];
  const pings = await getPings(clickhouseService, from, to);
  const epochRangesTimestamps = sortedEpochRanges.map((date) =>
    dayjs(formatDateForClickHouse(date)).utc().unix(),
  );
  const splittedPings = Object.entries(pings).map(([workerId, timestamps]) => {
    return [workerId, splitLogs(timestamps, epochRangesTimestamps)] as const;
  });
  const _networkStats = splittedPings.map(
    ([workerId, splits]) =>
      [
        workerId,
        splits.map((split, i) => {
          return networkStats(
            split,
            epochRangesTimestamps[i + 1] - epochRangesTimestamps[i],
          ).livenessFactor;
        }),
      ] as const,
  );
  return Object.fromEntries(_networkStats);
}

// ---------------------------------------------------------------------------
// Multicall helpers
// ---------------------------------------------------------------------------

interface MulticallResult<T> {
  status: 'success' | 'failure';
  error: string | null;
  result?: T;
}

function mapMulticallResult<S, T>(
  multicallResult: any[],
  mapper: (v: S) => T,
): MulticallResult<T>[] {
  return multicallResult.map((item) => {
    if (item?.status === 'success' && item.result !== undefined) {
      return { status: 'success' as const, error: null, result: mapper(item.result) };
    }
    return {
      status: 'failure' as const,
      error: item?.error || 'Unknown error',
      result: undefined,
    };
  });
}

function parseMulticallResult<
  TKey extends keyof RewardWorker,
  TValue extends RewardWorker[TKey],
>(
  workers: Record<string, RewardWorker>,
  key: TKey,
  multicallResult: MulticallResult<TValue>[],
  workerPeerIds: string[],
) {
  for (let i = 0; i < workerPeerIds.length; i++) {
    const peerId = workerPeerIds[i];
    const worker = workers[peerId];
    if (
      worker &&
      multicallResult[i] &&
      multicallResult[i].status === 'success'
    ) {
      (worker as any)[key] = multicallResult[i].result!;
    }
  }
}

// ---------------------------------------------------------------------------
// bigint conversion helper
// ---------------------------------------------------------------------------

function toBigInt(value: { toString(): string }): bigint {
  if (value && typeof (value as any).toFixed === 'function') {
    return BigInt((value as any).toFixed(0));
  }

  const strValue = value.toString();

  if (strValue.includes('e') || strValue.includes('E')) {
    const num = Number(strValue);
    const fixedStr = num.toFixed(0);
    return BigInt(fixedStr);
  }

  const dotIndex = strValue.indexOf('.');
  if (dotIndex === -1) {
    return BigInt(strValue);
  }
  return BigInt(strValue.substring(0, dotIndex));
}

function decimalToBigInt(decimal: Decimal): bigint {
  return BigInt(decimal.floor().toString());
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class RewardsCalculatorService {
  constructor(
    private configService: ConfigService,
    private clickHouseService: ClickHouseService,
    private contractService: ContractService,
    private metricsLoggerService: MetricsLoggerService,
  ) {}

  /**
   * Thin wrapper kept for backward compatibility.
   * Returns only the WorkerReward[] array.
   */
  async calculateEpochRewards(
    ctx: Context,
    fromBlock: number,
    toBlock: number,
    skipSignatureValidation?: boolean,
    batchNumberOverride?: number,
    totalBatchesOverride?: number,
  ): Promise<WorkerReward[]> {
    const result = await this.calculateRewards(
      ctx,
      fromBlock,
      toBlock,
      skipSignatureValidation,
      batchNumberOverride,
      totalBatchesOverride,
    );
    return result.workers;
  }

  /**
   * Thin wrapper kept for backward compatibility.
   * Identical to calculateRewards().
   */
  async calculateRewardsDetailed(
    ctx: Context,
    fromBlock: number,
    toBlock: number,
    skipSignatureValidation?: boolean,
    batchNumberOverride?: number,
    totalBatchesOverride?: number,
  ): Promise<RewardCalculationResult> {
    return this.calculateRewards(
      ctx,
      fromBlock,
      toBlock,
      skipSignatureValidation,
      batchNumberOverride,
      totalBatchesOverride,
    );
  }

  /**
   * Thin wrapper kept for backward compatibility.
   * Returns formatted reward data with APR, traffic, liveness details.
   */
  async calculateRewardsFormatted(
    ctx: Context,
    fromBlock: number,
    toBlock: number,
    skipSignatureValidation?: boolean,
    batchNumberOverride?: number,
    totalBatchesOverride?: number,
  ): Promise<FormattedRewardResult> {
    return this.calculateRewardsFormattedInternal(
      ctx,
      fromBlock,
      toBlock,
      skipSignatureValidation,
      batchNumberOverride,
      totalBatchesOverride,
    );
  }

  // -------------------------------------------------------------------------
  // Core calculation
  // -------------------------------------------------------------------------

  async calculateRewards(
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

    const startTime = await this.contractService.getBlockTimestamp(ctx, fromBlock);
    const endTime = await this.contractService.getBlockTimestamp(ctx, toBlock);

    const epochLengthInBlocks = await this.contractService.getEpochLength(ctx);
    const totalBatches =
      totalBatchesOverride ?? this.configService.get('rewards.totalBatches');

    let adjustedFromBlock = fromBlock;
    let adjustedStartTime = startTime;

    if (totalBatches !== undefined && totalBatches > 1) {
      adjustedFromBlock = toBlock - epochLengthInBlocks * totalBatches + 1;
      if (adjustedFromBlock < 0) {
        adjustedFromBlock = 0;
      }

      try {
        adjustedStartTime = await this.contractService.getBlockTimestamp(
          ctx,
          adjustedFromBlock,
        );
      } catch {
        const blockDiff = fromBlock - adjustedFromBlock;
        adjustedStartTime = new Date(
          startTime.getTime() - blockDiff * 12 * 1000,
        );
      }

      ctx.logger.info(
        `Batch filtering enabled: blocks ${adjustedFromBlock}-${toBlock} (${totalBatches} epochs)`,
      );
    }

    // --- Build worker collection ---
    const workers: Record<string, RewardWorker> = {};

    const activeWorkerData = await this.clickHouseService.getActiveWorkers(
      ctx,
      adjustedStartTime,
      endTime,
      shouldSkipValidation,
    );

    if (activeWorkerData.length === 0) {
      ctx.logger.warn('No workers found in ClickHouse data');
      return this.createEmptyResult(fromBlock, toBlock, startTime, endTime);
    }

    for (const wd of activeWorkerData) {
      if (!workers[wd.worker_id]) {
        workers[wd.worker_id] = new RewardWorker(wd.worker_id);
      }
      const w = workers[wd.worker_id];
      await w.processQuery(
        {
          output_size: Number(wd.output_size),
          num_read_chunks: Number(wd.num_read_chunks),
        },
        shouldSkipValidation,
      );
      w.totalRequests = Number(wd.totalRequests);
      if (shouldSkipValidation) {
        w.requestsProcessed = Number(wd.totalRequests);
      }
    }

    // Filter by contract registration
    const workerIdMapping = await this.contractService.preloadWorkerIds(
      ctx,
      activeWorkerData.map((w) => w.worker_id),
    );
    for (const peerId of Object.keys(workers)) {
      if (!workerIdMapping[peerId] || workerIdMapping[peerId] === 0n) {
        delete workers[peerId];
      } else {
        workers[peerId].setContractId(workerIdMapping[peerId]);
      }
    }

    if (Object.keys(workers).length === 0) {
      ctx.logger.warn('No known workers found in contract mapping');
      return this.createEmptyResult(fromBlock, toBlock, startTime, endTime);
    }

    // Pin all contract reads to epoch end block for deterministic results
    const epochEndBlockBigInt = BigInt(toBlock);

    // Stakes
    const workerPeerIds = Object.keys(workers);
    const [capedStakes, totalStakes] =
      await this.contractService.getStakes(workerPeerIds, epochEndBlockBigInt);

    parseMulticallResult(
      workers,
      'stake',
      mapMulticallResult(capedStakes, (v: bigint) => new Decimal(v.toString())),
      workerPeerIds,
    );
    parseMulticallResult(
      workers,
      'totalStake',
      mapMulticallResult(totalStakes, (v: bigint) => new Decimal(v.toString())),
      workerPeerIds,
    );

    // Traffic weight (T)
    const totalBytesSent = Object.values(workers).reduce((s, w) => s + w.bytesSent, 0);
    const totalChunksRead = Object.values(workers).reduce((s, w) => s + w.chunksRead, 0);
    for (const w of Object.values(workers)) {
      await w.calculateT(totalBytesSent, totalChunksRead);
    }

    // Bond
    const bondAmount = await this.contractService.getBondAmount(ctx, epochEndBlockBigInt);
    const bondDecimal = new Decimal(bondAmount.toString());
    for (const w of Object.values(workers)) {
      w.bond = bondDecimal;
    }

    // dTraffic
    const workerList = Object.values(workers);
    const stakeSum = workerList.reduce((s, w) => s.add(w.stake), new Decimal(0));
    const totalSupply = bondDecimal.mul(workerList.length).add(stakeSum);
    const dTrafficAlpha = new Decimal(0.1);
    for (const w of workerList) {
      await w.calculateDTraffic(totalSupply, dTrafficAlpha);
    }

    // Liveness
    const livenessData = await calculateLivenessFactor(
      this.clickHouseService,
      adjustedStartTime,
      endTime,
    );
    for (const w of workerList) {
      await w.calculateLiveness(livenessData[w.peerId]);
    }

    // dTenure
    const TENURE_EPOCH_COUNT = this.configService.get(
      'rewards.tenureEpochCount',
      10,
    );
    const tenureStartBlock =
      adjustedFromBlock - epochLengthInBlocks * TENURE_EPOCH_COUNT;
    const epochStartBlockNumbers = [...new Array(TENURE_EPOCH_COUNT + 1)].map(
      (_, i) => tenureStartBlock + i * epochLengthInBlocks,
    );

    const epochStartTimestamps = await Promise.all(
      epochStartBlockNumbers.map(async (blockNumber) => {
        try {
          return await this.contractService.getBlockTimestamp(ctx, blockNumber);
        } catch {
          return new Date(
            adjustedStartTime.getTime() -
              (adjustedFromBlock - blockNumber) * 12 * 1000,
          );
        }
      }),
    );

    const historicalLivenessData = await historicalLiveness(
      this.clickHouseService,
      epochStartTimestamps,
    );
    for (const w of workerList) {
      await w.calculateDTenure(historicalLivenessData[w.peerId] ?? []);
    }

    // Calculate rewards
    const baseApr = await this.getAPRFromContracts(ctx, epochEndBlockBigInt);
    const duration = dayjs(endTime).diff(dayjs(adjustedStartTime), 'second');
    const rMax = new Decimal(baseApr).mul(duration).div(YEAR).div(10_000);
    for (const w of workerList) {
      await w.getRewards(rMax);
    }

    // Batch filtering
    let filteredPeerIds = workerPeerIds;
    let batchNumber =
      batchNumberOverride ?? this.configService.get('rewards.batchNumber');

    if (batchNumber === undefined && totalBatches !== undefined) {
      const epochNumber = Math.ceil(toBlock / epochLengthInBlocks);
      batchNumber = epochNumber % totalBatches;
    }

    if (batchNumber !== undefined && totalBatches !== undefined) {
      if (totalBatches > 64) {
        throw new Error('Total batches must be <= 64');
      }
      filteredPeerIds = workerPeerIds.filter((peerId) => {
        const peerIdBuffer = new Uint8Array(bs58.decode(peerId));
        const group = peerIdBuffer[peerIdBuffer.length - 1] % totalBatches;
        return batchNumber === group;
      });
      ctx.logger.debug(
        `Batch filtering: ${filteredPeerIds.length} workers for batch ${batchNumber}/${totalBatches}`,
      );
    }

    // Build result
    const resultWorkers: WorkerReward[] = [];

    for (const peerId of filteredPeerIds) {
      const w = workers[peerId];
      const workerId = await w.getId();
      const workerIndex = workerPeerIds.indexOf(peerId);
      const capedStake =
        workerIndex >= 0 && capedStakes[workerIndex]?.status === 'success'
          ? BigInt(capedStakes[workerIndex].result || 0)
          : 0n;
      const workerTotalStake =
        workerIndex >= 0 && totalStakes[workerIndex]?.status === 'success'
          ? BigInt(totalStakes[workerIndex].result || 0)
          : 0n;

      resultWorkers.push({
        workerId,
        id: workerId,
        workerReward: decimalToBigInt(w.workerReward),
        stakerReward: decimalToBigInt(w.stakerReward),
        stake: capedStake,
        totalStake: workerTotalStake,
        calculationTime: (endTime.getTime() - startTime.getTime()) / 1000,
      });
    }

    const totalRewards = resultWorkers.reduce((sum, w) => sum + w.workerReward, 0n);

    ctx.logger.debug(
      `Calculated rewards for ${resultWorkers.length} workers, total: ${Number(totalRewards) / 1e18} SQD`,
    );

    return {
      workers: resultWorkers,
      totalRewards,
      calculationTime: (endTime.getTime() - startTime.getTime()) / 1000,
      epochMetadata: {
        adjustedStartTime: startTime,
        endTime,
        fromBlock,
        toBlock,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Formatted output (kept for backward compatibility with reporting callers)
  // -------------------------------------------------------------------------

  private async calculateRewardsFormattedInternal(
    ctx: Context,
    fromBlock: number,
    toBlock: number,
    skipSignatureValidation?: boolean,
    batchNumberOverride?: number,
    totalBatchesOverride?: number,
  ): Promise<FormattedRewardResult> {
    const shouldSkipValidation: boolean =
      skipSignatureValidation ??
      this.configService.get('rewards.skipSignatureValidation', true);

    const epochLengthInBlocks = await this.contractService.getEpochLength(ctx);
    const totalBatches =
      totalBatchesOverride ?? this.configService.get('rewards.totalBatches');

    let adjustedFromBlock = fromBlock;
    let adjustedStartTime = await this.contractService.getBlockTimestamp(
      ctx,
      fromBlock,
    );
    const endTime = await this.contractService.getBlockTimestamp(ctx, toBlock);

    if (totalBatches !== undefined && totalBatches > 1) {
      adjustedFromBlock = toBlock - epochLengthInBlocks * totalBatches + 1;
      if (adjustedFromBlock < 0) {
        adjustedFromBlock = 0;
      }

      try {
        adjustedStartTime = await this.contractService.getBlockTimestamp(
          ctx,
          adjustedFromBlock,
        );
      } catch {
        const blockDiff = fromBlock - adjustedFromBlock;
        adjustedStartTime = new Date(
          adjustedStartTime.getTime() - blockDiff * 12 * 1000,
        );
      }
    }

    // --- Build worker collection ---
    const workers: Record<string, RewardWorker> = {};

    const activeWorkerData = await this.clickHouseService.getActiveWorkers(
      ctx,
      adjustedStartTime,
      endTime,
      shouldSkipValidation,
    );

    if (activeWorkerData.length === 0) {
      ctx.logger.warn('No workers found in ClickHouse data');
      return { totalRewards: { worker: '0', staker: '0' }, workers: [] };
    }

    for (const wd of activeWorkerData) {
      if (!workers[wd.worker_id]) {
        workers[wd.worker_id] = new RewardWorker(wd.worker_id);
      }
      const w = workers[wd.worker_id];
      await w.processQuery(
        {
          output_size: Number(wd.output_size),
          num_read_chunks: Number(wd.num_read_chunks),
        },
        shouldSkipValidation,
      );
      w.totalRequests = Number(wd.totalRequests);
      if (shouldSkipValidation) {
        w.requestsProcessed = Number(wd.totalRequests);
      }
    }

    // Filter by contract registration
    const workerIdMapping = await this.contractService.preloadWorkerIds(
      ctx,
      activeWorkerData.map((wd) => wd.worker_id),
    );
    for (const peerId of Object.keys(workers)) {
      if (!workerIdMapping[peerId] || workerIdMapping[peerId] === 0n) {
        delete workers[peerId];
      } else {
        workers[peerId].setContractId(workerIdMapping[peerId]);
      }
    }

    if (Object.keys(workers).length === 0) {
      ctx.logger.warn('No known workers found in contract mapping');
      return { totalRewards: { worker: '0', staker: '0' }, workers: [] };
    }

    // Pin all contract reads to epoch end block for deterministic results
    const epochEndBlockBigInt = BigInt(toBlock);

    // Stakes
    const workerPeerIds = Object.keys(workers);
    const [capedStakes, totalStakes] =
      await this.contractService.getStakes(workerPeerIds, epochEndBlockBigInt);

    parseMulticallResult(
      workers,
      'stake',
      mapMulticallResult(capedStakes, (v: bigint) => new Decimal(v.toString())),
      workerPeerIds,
    );
    parseMulticallResult(
      workers,
      'totalStake',
      mapMulticallResult(totalStakes, (v: bigint) => new Decimal(v.toString())),
      workerPeerIds,
    );

    // Traffic weight
    const totalBytesSent = Object.values(workers).reduce((s, w) => s + w.bytesSent, 0);
    const totalChunksRead = Object.values(workers).reduce((s, w) => s + w.chunksRead, 0);
    for (const w of Object.values(workers)) {
      await w.calculateT(totalBytesSent, totalChunksRead);
    }

    // Bond
    const bondAmount = await this.contractService.getBondAmount(ctx, epochEndBlockBigInt);
    const bondDecimal = new Decimal(bondAmount.toString());
    for (const w of Object.values(workers)) {
      w.bond = bondDecimal;
    }

    // dTraffic
    const workerList = Object.values(workers);
    const stakeSum = workerList.reduce((s, w) => s.add(w.stake), new Decimal(0));
    const totalSupply = bondDecimal.mul(workerList.length).add(stakeSum);
    for (const w of workerList) {
      await w.calculateDTraffic(totalSupply, new Decimal(0.1));
    }

    // Liveness
    const livenessData = await calculateLivenessFactor(
      this.clickHouseService,
      adjustedStartTime,
      endTime,
    );
    for (const w of workerList) {
      await w.calculateLiveness(livenessData[w.peerId]);
    }

    // dTenure
    const TENURE_EPOCH_COUNT = this.configService.get(
      'rewards.tenureEpochCount',
      10,
    );
    const tenureStartBlock =
      adjustedFromBlock - epochLengthInBlocks * TENURE_EPOCH_COUNT;
    const epochStartBlockNumbers = [...new Array(TENURE_EPOCH_COUNT + 1)].map(
      (_, i) => tenureStartBlock + i * epochLengthInBlocks,
    );

    const epochStartTimestamps = await Promise.all(
      epochStartBlockNumbers.map(async (blockNumber) => {
        try {
          return await this.contractService.getBlockTimestamp(ctx, blockNumber);
        } catch {
          return new Date(
            adjustedStartTime.getTime() -
              (adjustedFromBlock - blockNumber) * 12 * 1000,
          );
        }
      }),
    );

    const historicalLivenessData = await historicalLiveness(
      this.clickHouseService,
      epochStartTimestamps,
    );
    for (const w of workerList) {
      await w.calculateDTenure(historicalLivenessData[w.peerId] ?? []);
    }

    // Calculate rewards
    const baseApr = await this.getAPRFromContracts(ctx, epochEndBlockBigInt);
    const durationSec = dayjs(endTime).diff(dayjs(adjustedStartTime), 'second');
    const rMax = new Decimal(baseApr).mul(durationSec).div(YEAR).div(10_000);
    for (const w of workerList) {
      await w.getRewards(rMax);
    }

    // Batch filtering
    let filteredPeerIds = workerPeerIds;
    let batchNumber =
      batchNumberOverride ?? this.configService.get('rewards.batchNumber');

    if (batchNumber === undefined && totalBatches !== undefined) {
      const epochNumber = Math.ceil(toBlock / epochLengthInBlocks);
      batchNumber = epochNumber % totalBatches;
    }

    if (batchNumber !== undefined && totalBatches !== undefined) {
      if (totalBatches > 64) {
        throw new Error('Total batches must be <= 64');
      }
      filteredPeerIds = workerPeerIds.filter((peerId) => {
        const peerIdBuffer = new Uint8Array(bs58.decode(peerId));
        const group = peerIdBuffer[peerIdBuffer.length - 1] % totalBatches;
        return batchNumber === group;
      });
    }

    // Build formatted result
    const duration = Math.floor(
      (endTime.getTime() - adjustedStartTime.getTime()) / 1000,
    );

    const workerStats = filteredPeerIds.map((peerId) => {
      const w = workers[peerId];
      const aprData = w.apr(duration, YEAR);

      return {
        id: w.peerId,
        workerReward: toBigInt(w.workerReward).toString(),
        stakerReward: toBigInt(w.stakerReward).toString(),
        apr: {
          worker_apr: aprData.worker_apr,
          delegator_apr: aprData.delegator_apr,
        },
        traffic: {
          bytesSent: w.bytesSent,
          chunksRead: w.chunksRead,
          trafficWeight: w.trafficWeight.toNumber(),
          dTraffic: w.dTraffic.toNumber(),
          validRequests: w.requestsProcessed,
          totalRequests: w.totalRequests,
          requestErrorRate:
            w.totalRequests > 0
              ? 1 - w.requestsProcessed / w.totalRequests
              : 0,
        },
        delegation: {
          totalDelegated: toBigInt(w.totalStake).toString(),
          effectiveStake: toBigInt(w.stake).toString(),
        },
        liveness: {
          livenessCoefficient: w.livenessCoefficient.toNumber(),
          tenure: w.dTenure.toNumber(),
        },
      };
    });

    const totalWorkerReward = workerStats
      .map((ws) => BigInt(ws.workerReward))
      .reduce((a, b) => a + b, 0n);
    const totalStakerReward = workerStats
      .map((ws) => BigInt(ws.stakerReward))
      .reduce((a, b) => a + b, 0n);

    return {
      totalRewards: {
        worker: totalWorkerReward.toString(),
        staker: totalStakerReward.toString(),
      },
      workers: workerStats,
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

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
      epochMetadata: {
        adjustedStartTime: startTime,
        endTime,
        fromBlock,
        toBlock,
      },
    };
  }

  private async getAPRFromContracts(ctx: Context, epochEndBlock?: bigint): Promise<number> {
    try {
      const currentBlock = epochEndBlock ?? await this.contractService.getLatestL2Block();

      try {
        const tvl = await this.contractService.getEffectiveTVL(
          ctx,
          currentBlock,
        );

        if (tvl === 0n) {
          ctx.logger.debug('TVL is 0, returning 20% APR');
          return 0.2;
        }

        const initialRewardPoolSize =
          await this.contractService.getInitialRewardPoolSize(
            ctx,
            currentBlock,
          );

        const yearlyRewardCapCoefficient =
          await this.contractService.getYearlyRewardCapCoefficient(
            ctx,
            currentBlock,
          );

        const apyCap =
          (yearlyRewardCapCoefficient * initialRewardPoolSize) / tvl;

        const finalApyBasisPoints = apyCap < 2000n ? apyCap : 2000n;
        const finalApr = Number(finalApyBasisPoints);

        ctx.logger.debug(
          `Contract-based APR: ${(finalApr / 100).toFixed(2)}% (${finalApyBasisPoints} basis points)`,
        );
        return finalApr;
      } catch (contractError) {
        ctx.logger.warn(
          { error: contractError },
          `Contract APR calculation failed, using 20% fallback`,
        );
        return 2000;
      }
    } catch (error) {
      ctx.logger.error({ error }, `Failed to get APR from contracts`);
      return 2000;
    }
  }
}
