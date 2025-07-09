import Decimal from 'decimal.js';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { Logger } from '@nestjs/common';

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

  public async processQuery(query: QueryLog) {
    this.totalRequests++;
    this.bytesSent += query.output_size;
    this.chunksRead += query.num_read_chunks;
    this.requestsProcessed++;
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

  public async calculateDTraffic(totalSupply: Decimal) {
    const supplyRatio = this.stake.add(this.bond).div(totalSupply);
    const dTrafficAlpha = new Decimal(0.1);
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
}

export class OldWorkers {
  private workers: Record<string, OldWorker> = {};
  private bond = new Decimal(0);
  private logger = new Logger('OldWorkers');
  
  baseApr = new Decimal(0);
  stakeFactor = new Decimal(0);
  rAPR = new Decimal(0);

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

    this.logger.log(`🔄 Filtered batch ${batchNumber}/${totalBatches}: ${Object.keys(newWorkers).length} workers`);
    
    return filteredWorkers;
  }

  private base58Decode(input: string): Uint8Array {
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const base = alphabet.length;
    
    let result: number[] = [];
    let multi = 1;
    let s = input;
    
    while (s.length > 0) {
      const digit = alphabet.indexOf(s[s.length - 1]);
      if (digit < 0) throw new Error('Invalid base58 character');
      
      let carry = digit * multi;
      let i = 0;
      while (carry > 0 || i < result.length) {
        carry += (result[i] || 0);
        result[i] = carry % 256;
        carry = Math.floor(carry / 256);
        i++;
      }
      
      multi *= base;
      s = s.slice(0, -1);
    }
    
    let leadingZeros = 0;
    for (let i = 0; i < input.length && input[i] === '1'; i++) {
      leadingZeros++;
    }
    
    const leadingZeroBytes: number[] = new Array(leadingZeros).fill(0);
    
    return new Uint8Array([...leadingZeroBytes, ...result.reverse()]);
  }

  public async fetchCurrentBond(bondAmount: bigint) {
    this.bond = new Decimal(bondAmount.toString());
    this.map((worker) => {
      worker.bond = this.bond;
    });
    return this.bond;
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

  public async setStakes(capedStakes: any[], totalStakes: any[], workerPeerIds: string[]) {
    for (let i = 0; i < workerPeerIds.length; i++) {
      const peerId = workerPeerIds[i];
      const worker = this.workers[peerId];
      if (worker) {
        const capedStake = capedStakes[i]?.status === 'success' && capedStakes[i].result !== undefined 
          ? capedStakes[i].result! : 0n;
        const totalStake = totalStakes[i]?.status === 'success' && totalStakes[i].result !== undefined 
          ? totalStakes[i].result! : 0n;
        
        worker.stake = new Decimal(capedStake.toString());
        worker.totalStake = new Decimal(totalStake.toString());
      }
    }
  }

  public getT() {
    const totalBytesSent = this.totalBytesSent();
    const totalChunksRead = this.totalChunksRead();
    this.map((worker) => worker.calculateT(totalBytesSent, totalChunksRead));
  }

  public getDTraffic() {
    const totalSupply_ = this.totalSupply();
    this.map((worker) => worker.calculateDTraffic(totalSupply_));
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

    const rMax = this.rAPR.mul(duration).div(YEAR).div(10_000);
    this.map((worker) => worker.getRewards(rMax));
  }

  private totalBytesSent() {
    return this.map(({ bytesSent }) => bytesSent).reduce((sum, bytes) => sum + bytes, 0);
  }

  private totalChunksRead() {
    return this.map(({ chunksRead }) => chunksRead).reduce((sum, chunks) => sum + chunks, 0);
  }

  private totalSupply() {
    const stakeSum = this.map(({ stake }) => stake).reduce((sum, stake) => sum.add(stake), new Decimal(0));
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

  private decimalToBigInt(decimal: Decimal): bigint {
    return BigInt(decimal.floor().toString());
  }

  public logDebugInfo() {
    this.logger.log(`=== Old Backend Calculation Debug ===`);
    this.logger.log(`Total workers: ${this.count()}`);
    this.logger.log(`Bond amount: ${this.bond.toString()}`);
    this.logger.log(`Base APR: ${this.baseApr.toString()}`);
    this.logger.log(`Total bytes sent: ${this.totalBytesSent()}`);
    this.logger.log(`Total chunks read: ${this.totalChunksRead()}`);
    this.logger.log(`Total supply: ${this.totalSupply().toString()}`);

    const workerArray = Object.values(this.workers);
    for (let i = 0; i < Math.min(3, workerArray.length); i++) {
      const worker = workerArray[i];
      this.logger.log(`\n--- Worker ${i + 1}: ${worker.peerId.slice(0, 20)}... ---`);
      this.logger.log(`  Traffic weight: ${worker.trafficWeight.toString()}`);
      this.logger.log(`  dTraffic: ${worker.dTraffic.toString()}`);
      this.logger.log(`  Liveness: ${worker.livenessCoefficient.toString()}`);
      this.logger.log(`  dTenure: ${worker.dTenure.toString()}`);
      this.logger.log(`  Actual yield: ${worker.actualYield.toString()}`);
      this.logger.log(`  Worker reward: ${worker.workerReward.toString()} (${worker.workerReward.div(1e18).toString()} SQD)`);
      this.logger.log(`  Staker reward: ${worker.stakerReward.toString()} (${worker.stakerReward.div(1e18).toString()} SQD)`);
    }
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
    const networkName = 'mainnet';
    const query = `
      SELECT
        worker_id,
        arrayConcat(
          [toUnixTimestamp('${formatDateForClickHouse(startTime)}')],
          arraySort(groupArray(toUnixTimestamp(timestamp))),
          [toUnixTimestamp('${formatDateForClickHouse(endTime)}')]
        ) as timestamps 
      FROM ${networkName}.worker_pings 
      WHERE timestamp >= '${formatDateForClickHouse(startTime)}' 
        AND timestamp <= '${formatDateForClickHouse(endTime)}' 
      GROUP BY worker_id
    `;

    const client = (clickHouseService as any).client;
    const resultSet = await client.query({ query, format: 'JSONEachRow' });
    const results = await resultSet.json();
    const pings = Array.isArray(results) ? results : [results];

    const totalPeriodSeconds = Math.floor((endTime.getTime() - startTime.getTime()) / 1000);
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

export async function getHistoricalLiveness(
  clickHouseService: any,
  epochRanges: Date[],
): Promise<Record<string, number[]>> {
  try {
    return {};
  } catch (error) {
    console.warn(`Failed to get historical liveness: ${error.message}`);
    return {};
  }
}

function formatDateForClickHouse(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
} 