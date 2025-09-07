import Decimal from 'decimal.js';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { Logger } from '@nestjs/common';
import bs58 from 'bs58';

dayjs.extend(utc);
Decimal.set({ precision: 28, minE: -9 });

const YEAR = 365 * 24 * 60 * 60;

export interface NetworkStatsEntry {
  totalPings: number;
  totalTimeOffline: number;
  livenessFactor: number;
}

export interface QueryLog {
  output_size: number;
  num_read_chunks: number;
}

export interface OldRewardResult {
  workerReward: bigint;
  stakerReward: bigint;
  computationUnitsUsed: number;
  id: bigint;
}

export interface OldRewards {
  [peerId: string]: OldRewardResult;
}

export interface MulticallResult<T> {
  status: 'success' | 'failure';
  error: string | null;
  result?: T;
}

export class OldWorker {
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
    query: QueryLog,
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
    const supplyRatio = this.stake.add(this.bond).div(totalSupply);
    this.dTraffic = Decimal.min(
      new Decimal(1),
      this.trafficWeight.div(supplyRatio).pow(dTrafficAlpha),
    );
  }

  public async calculateLiveness(networkStats: NetworkStatsEntry) {
    this.networkStats = networkStats;
    if (!networkStats) return;
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

  public async getRewards(rMax: Decimal) {
    this.actualYield = rMax
      .mul(this.livenessCoefficient)
      .mul(this.dTraffic)
      .mul(this.dTenure);

    this.workerReward = this.actualYield.mul(this.bond.add(this.stake.div(2)));
    this.stakerReward = this.actualYield.mul(this.stake).div(2);
  }

  public stakeWeight(stakeSum: Decimal) {
    return stakeSum.eq(0) ? new Decimal(0) : this.stake.div(stakeSum);
  }

  private normalizeTraffic(totalBytesSent: number, totalChunksRead: number) {
    return {
      bytesSent: new Decimal(this.bytesSent).div(totalBytesSent),
      chunksRead: new Decimal(this.chunksRead).div(totalChunksRead),
    };
  }

  public apr(epochDuration: number, year: number) {
    const bond = new Decimal(this.bond.toString());
    const workerReward = new Decimal(this.workerReward.toString());
    const stakerReward = new Decimal(this.stakerReward.toString());
    const duration = new Decimal(year).div(epochDuration);

    return {
      worker_apr: workerReward.div(bond).mul(duration).toFixed(),
      delegator_apr: this.totalStake.eq(0)
        ? '0'
        : stakerReward.div(this.totalStake).mul(duration).toFixed(),
    };
  }
}

export class OldWorkers {
  private workers: Record<string, OldWorker> = {};
  private bond = new Decimal(0);
  private logger = new Logger('OldWorkers');
  private nextDistributionStartBlockNumber = 0n;

  baseApr = new Decimal(0);
  stakeFactor = new Decimal(0);
  rAPR = new Decimal(0);
  commitmentTxHash = '';
  commitmentError = '';

  constructor(
    public from: Date,
    public to: Date,
  ) {}

  public add(peerId: string) {
    if (this.workers[peerId]) {
      return this.workers[peerId];
    }
    this.workers[peerId] = new OldWorker(peerId);
    return this.workers[peerId];
  }

  public map<T>(fn: (worker: OldWorker, index: number) => T) {
    return Object.values(this.workers).map(fn);
  }

  public count() {
    return Object.keys(this.workers).length;
  }

  public getWorkerPeerIds(): string[] {
    return Object.keys(this.workers);
  }

  public filterBatch(batchNumber: number, totalBatches: number): OldWorkers {
    if (totalBatches > 64) {
      throw new Error('Total batches must be <= 64');
    }

    const newWorkers: Record<string, OldWorker> = {};

    for (const [peerId, worker] of Object.entries(this.workers)) {
      const peerIdBuffer = this.base58Decode(peerId);
      const group = peerIdBuffer[peerIdBuffer.length - 1] % totalBatches;

      if (batchNumber === group) {
        newWorkers[peerId] = worker;
      }
    }

    const filteredWorkers = new OldWorkers(this.from, this.to);
    filteredWorkers['workers'] = newWorkers;
    filteredWorkers.bond = this.bond;
    filteredWorkers.baseApr = this.baseApr;
    filteredWorkers.stakeFactor = this.stakeFactor;
    filteredWorkers.rAPR = this.rAPR;

    console.log(
      `🔄 Filtered batch ${batchNumber}/${totalBatches}: ${Object.keys(newWorkers).length} workers`,
    );

    return filteredWorkers;
  }

  private base58Decode(input: string): Uint8Array {
    return new Uint8Array(bs58.decode(input));
  }

  public async fetchCurrentBond(bondAmount: bigint) {
    this.bond = new Decimal(bondAmount.toString());
    this.map((worker) => {
      worker.bond = this.bond;
    });
    return this.bond;
  }

  public async getNextDistributionStartBlockNumber(
    latestDistributionBlock: bigint,
  ) {
    this.nextDistributionStartBlockNumber = latestDistributionBlock + 1n;
  }

  public async clearUnknownWorkers(workerIdMapping: Record<string, bigint>) {
    for (const workersKey in this.workers) {
      if (!workerIdMapping[workersKey] || workerIdMapping[workersKey] === 0n) {
        delete this.workers[workersKey];
      } else {
        this.workers[workersKey].setContractId(workerIdMapping[workersKey]);
      }
    }
    return this.workers;
  }

  public async getStakes(
    capedStakes: any[],
    totalStakes: any[],
    workerPeerIds: string[],
  ) {
    this.parseMulticallResult(
      'stake',
      this.mapMulticallResult(
        capedStakes,
        (bigIntValue: bigint) => new Decimal(bigIntValue.toString()),
      ),
      workerPeerIds,
    );
    this.parseMulticallResult(
      'totalStake',
      this.mapMulticallResult(
        totalStakes,
        (bigIntValue: bigint) => new Decimal(bigIntValue.toString()),
      ),
      workerPeerIds,
    );
  }

  private parseMulticallResult<
    TKey extends keyof OldWorker,
    TValue extends OldWorker[TKey],
  >(
    key: TKey,
    multicallResult: MulticallResult<TValue>[],
    workerPeerIds: string[],
  ) {
    for (let i = 0; i < workerPeerIds.length; i++) {
      const peerId = workerPeerIds[i];
      const worker = this.workers[peerId];
      if (
        worker &&
        multicallResult[i] &&
        multicallResult[i].status === 'success'
      ) {
        (worker as any)[key] = multicallResult[i].result!;
      }
    }
  }

  private mapMulticallResult<S, T>(
    multicallResult: any[],
    mapper: (v: S) => T,
  ): MulticallResult<T>[] {
    return multicallResult.map((item) => {
      if (item?.status === 'success' && item.result !== undefined) {
        return { status: 'success', error: null, result: mapper(item.result) };
      }
      return {
        status: 'failure',
        error: item?.error || 'Unknown error',
        result: undefined,
      };
    });
  }

  // Legacy method for backward compatibility
  public async setStakes(
    capedStakes: any[],
    totalStakes: any[],
    workerPeerIds: string[],
  ) {
    await this.getStakes(capedStakes, totalStakes, workerPeerIds);
  }

  public getT() {
    const totalBytesSent = this.totalBytesSent();
    const totalChunksRead = this.totalChunksRead();
    this.map((worker) => worker.calculateT(totalBytesSent, totalChunksRead));
  }

  public getDTraffic(dTrafficAlpha: Decimal = new Decimal(0.1)) {
    const totalSupply_ = this.totalSupply();
    this.map((worker) => worker.calculateDTraffic(totalSupply_, dTrafficAlpha));
  }

  public async getLiveness(networkStats: Record<string, NetworkStatsEntry>) {
    this.map((worker) => worker.calculateLiveness(networkStats[worker.peerId]));
  }

  public async getDTenure(historicalLiveness: Record<string, number[]>) {
    this.map((worker) => {
      worker.calculateDTenure(historicalLiveness[worker.peerId] ?? []);
    });
  }

  public async calculateRewards(baseApr: number) {
    const duration = dayjs(this.to).diff(dayjs(this.from), 'second');
    this.baseApr = new Decimal(baseApr);
    this.stakeFactor = this.calculateStakeFactor();
    this.rAPR = this.baseApr;

    console.log('--- DEBUG rMax CALCULATION ---');
    console.log(`rAPR (basis points): ${this.rAPR.toString()}`);
    console.log(`duration (seconds): ${duration}`);
    console.log(`YEAR (seconds): ${YEAR}`);

    const rMax = this.rAPR.mul(duration).div(YEAR).div(10_000);

    console.log(`Calculated rMax: ${rMax.toString()}`);
    console.log('------------------------------');

    this.map((worker) => worker.getRewards(rMax));
  }

  private totalBytesSent() {
    return this.map(({ bytesSent }) => bytesSent).reduce(
      (sum, bytes) => sum + bytes,
      0,
    );
  }

  private totalChunksRead() {
    return this.map(({ chunksRead }) => chunksRead).reduce(
      (sum, chunks) => sum + chunks,
      0,
    );
  }

  private totalSupply() {
    const stakeSum = this.map(({ stake }) => stake).reduce(
      (sum, stake) => sum.add(stake),
      new Decimal(0),
    );
    return this.bond.mul(this.count()).add(stakeSum);
  }

  private calculateStakeFactor() {
    return new Decimal(1);
  }

  public async rewards(): Promise<OldRewards> {
    const result: OldRewards = {};

    for (const worker of Object.values(this.workers)) {
      const workerId = await worker.getId();
      result[worker.peerId] = {
        workerReward: this.decimalToBigInt(worker.workerReward),
        stakerReward: this.decimalToBigInt(worker.stakerReward),
        computationUnitsUsed: worker.requestsProcessed * 1,
        id: workerId,
      };
    }

    return result;
  }

  public async logStats() {
    const statsEntries = await Promise.all(
      this.map(async (worker) => {
        const workerRewardWei = worker.workerReward;
        const stakerRewardWei = worker.stakerReward;
        const contractId = await worker.getId();
        const displayKey = `${worker.peerId} (ID: ${contractId})`;

        const baseStats = this.keysToFixed({
          t: worker.trafficWeight.mul(100),
          dTraffic: worker.dTraffic.mul(100),
          livenessFactor: (worker.networkStats?.livenessFactor ?? 0) * 100,
          dLiveness: worker.livenessCoefficient.mul(100),
          dTenure: worker.dTenure.mul(100),
        });

        return [
          displayKey,
          {
            ...baseStats,
            workerReward: workerRewardWei.eq(0)
              ? ''
              : workerRewardWei.floor().toFixed(0),
            stakerReward: stakerRewardWei.eq(0)
              ? ''
              : stakerRewardWei.floor().toFixed(0),
          },
        ];
      }),
    );

    const stats = Object.fromEntries(statsEntries);
    const totalUnlocked = await this.rUnlocked();
    const totalReward = this.decimalSum(
      this.map(({ workerReward, stakerReward }) =>
        workerReward.add(stakerReward),
      ),
    );
    console.table(stats);
    console.log('Max unlocked:', this.formatSqd(totalUnlocked));
    console.log('Total reward:', this.formatSqd(totalReward));
    this.logPercentageUnlocked(totalReward, totalUnlocked);
  }

  private async rUnlocked() {
    const duration = dayjs(this.to).diff(dayjs(this.from), 'second');
    return this.baseApr
      .mul(this.totalSupply())
      .mul(duration)
      .div(YEAR)
      .div(10_000);
  }

  private logPercentageUnlocked(totalReward: Decimal, totalUnlocked: Decimal) {
    if (!totalUnlocked) console.log('Percentage unlocked 0 %');
    else
      console.log(
        'Percentage of max unlocked',
        totalReward.mul(10000).div(totalUnlocked).div(100).toFixed(2),
        '%',
      );
  }

  private keysToFixed(
    obj: Record<string, Decimal | number>,
  ): Record<string, string> {
    return Object.fromEntries(
      Object.entries(obj).map(([key, value]) => [
        key,
        typeof value === 'number' ? value.toFixed(2) : value.toFixed(2),
      ]),
    );
  }

  private formatSqd(value: Decimal): string {
    return value.div(1e18).toFixed(2);
  }

  private decimalSum(decimals: Decimal[]): Decimal {
    return decimals.reduce((sum, d) => sum.add(d), new Decimal(0));
  }

  public noteSuccessfulCommit(txHash: string) {
    this.commitmentTxHash = txHash;
  }

  public noteFailedCommit(error: Error) {
    this.commitmentError = error.toString();
  }

  private decimalToBigInt(decimal: Decimal): bigint {
    return BigInt(decimal.floor().toString());
  }

  public async logDebugInfo() {
    console.log(`=== Old Backend Calculation Debug ===`);
    console.log(`Total workers: ${this.count()}`);
    console.log(`Bond amount: ${this.bond.toString()}`);
    console.log(`Base APR: ${this.baseApr.toString()}`);
    console.log(`Total bytes sent: ${this.totalBytesSent()}`);
    console.log(`Total chunks read: ${this.totalChunksRead()}`);
    console.log(`Total supply: ${this.totalSupply().toString()}`);

  }
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

function networkStats(pingTimestamps: number[], epochLength: number) {
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
    // Use streaming instead of toPromise() to avoid JSON parsing limits
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
        res[ping.worker_id] = networkStats(ping.timestamps, totalPeriodSeconds);
      }
    }

    return res;
  } catch (error) {
    console.warn(`Failed to get liveness factor: ${error.message}`);
    return {};
  }
}

function formatDateForClickHouse(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export async function historicalLiveness(
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

export function sum(numbers: number[]): number {
  return numbers.reduce((sum, n) => sum + n, 0);
}

export function decimalSum(decimals: Decimal[]): Decimal {
  return decimals.reduce((sum, d) => sum.add(d), new Decimal(0));
}

export function keysToFixed(
  obj: Record<string, Decimal | number>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(obj).map(([key, value]) => [
      key,
      typeof value === 'number' ? value.toFixed(2) : value.toFixed(2),
    ]),
  );
}

export function formatSqd(value: Decimal): string {
  return value.div(1e18).toFixed(2);
}

export function bigIntToDecimal(value: bigint): Decimal {
  return new Decimal(value.toString());
}

export function decimalToBigInt(decimal: Decimal): bigint {
  return BigInt(decimal.floor().toString());
}

export async function preloadWorkerIds(
  workers: string[],
  contractService: any,
  blockNumber?: bigint,
): Promise<Record<string, bigint>> {
  const workerIds = {} as Record<string, bigint>;

  // This would normally use multicall but simplified for old backend
  for (const workerId of workers) {
    try {
      const id = await contractService.getWorkerId(workerId, blockNumber);
      workerIds[workerId] = id || 0n;
    } catch (error) {
      console.warn(`Failed to get worker ID for ${workerId}:`, error);
      workerIds[workerId] = 0n;
    }
  }

  return workerIds;
}

export async function getLatestDistributionBlock(
  contractService: any,
  MAX_BLOCK_RANGE_SIZE: bigint = 10000n,
): Promise<bigint> {
  try {
    let toBlock = await contractService.getBlockNumber();

    while (toBlock >= 0) {
      let fromBlock = toBlock - MAX_BLOCK_RANGE_SIZE;
      fromBlock = fromBlock < 0 ? 0n : fromBlock;

      const distributionBlocks = await contractService.getDistributionLogs(
        fromBlock,
        toBlock,
      );

      console.log(
        `Fetched Distributed logs from ${fromBlock} to ${toBlock}: [${distributionBlocks.join(', ')}]`,
      );

      if (distributionBlocks.length > 0) {
        return distributionBlocks[distributionBlocks.length - 1];
      }

      toBlock = fromBlock - 1n;
    }

    return 0n;
  } catch (error) {
    console.warn('Failed to get latest distribution block:', error);
    return 0n;
  }
}

export async function epochStats(
  fromBlock: number,
  toBlock: number,
  clickhouseService: any,
  bondAmount: bigint,
  baseApr: number,
  workerIdMapping: Record<string, bigint>,
  capedStakes: any[],
  totalStakes: any[],
  workerPeerIds: string[],
  networkStats: Record<string, NetworkStatsEntry>,
  historicalLivenessData: Record<string, number[]>,
  shouldSkipSignatureValidation = false,
): Promise<OldWorkers> {
  const fromDate = new Date(fromBlock * 1000);
  const toDate = new Date(toBlock * 1000);

  const workers = new OldWorkers(fromDate, toDate);

  for (const peerId of workerPeerIds) {
    workers.add(peerId);
  }

  if (workers.count() === 0) {
    return workers;
  }

  await workers.getNextDistributionStartBlockNumber(BigInt(toBlock));
  await workers.clearUnknownWorkers(workerIdMapping);
  await workers.getStakes(capedStakes, totalStakes, workerPeerIds);
  workers.getT();
  await workers.fetchCurrentBond(bondAmount);
  workers.getDTraffic();
  await workers.getLiveness(networkStats);
  await workers.getDTenure(historicalLivenessData);
  await workers.calculateRewards(baseApr);
  await workers.logStats();

  return workers;
}
