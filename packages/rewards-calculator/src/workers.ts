import {
  bond,
  currentApy,
  epochLength,
  getBlockTimestamp,
  getLatestDistributionBlock,
  getStakes,
  MulticallResult,
  preloadWorkerIds,
  storagePerWorkerInGb,
  targetCapacity as getTargetCapacity,
} from "./chain";
import {
  bigIntToDecimal,
  decimalSum,
  decimalToBigInt,
  formatSqd,
  keysToFixed,
  sum,
} from "./utils";
import {
  ClickhouseClient,
  historicalLiveness,
  livenessFactor,
} from "./clickhouseClient";
import { logger } from "./logger";
import { Worker } from "./worker";
import dayjs from "dayjs";
import { config } from "./config";
import { Rewards } from "./reward";

import Decimal from "decimal.js";
Decimal.set({ precision: 18, minE: -9 });

const YEAR = 365 * 24 * 60 * 60;

export class Workers {
  private workers: Record<string, Worker> = {};
  private bond = new Decimal(0);
  private nextDistributionStartBlockNumber: bigint;

  baseApr = new Decimal(0);
  stakeFactor = new Decimal(0);
  rAPR = new Decimal(0);

  constructor(private clickhouseClient: ClickhouseClient) {}

  public add(workerId: string) {
    if (this.workers[workerId]) {
      return this.workers[workerId];
    }
    this.workers[workerId] = new Worker(workerId);
    return this.workers[workerId];
  }

  public map<T>(fn: (worker: Worker, index?: number) => T) {
    return Object.values(this.workers).map(fn);
  }

  public count() {
    return Object.keys(this.workers).length;
  }

  public async getNextDistributionStartBlockNumber() {
    const latestDistributionBlock = await getLatestDistributionBlock();
    if (latestDistributionBlock) {
      this.nextDistributionStartBlockNumber = latestDistributionBlock + 1n;
    }
  }

  public async fetchCurrentBond() {
    const bondRaw = await bond(this.nextDistributionStartBlockNumber);
    this.bond = new Decimal(bondRaw.toString());

    this.map((worker) => {
      worker.bond = this.bond;
    });
    return this.bond;
  }

  public async clearUnknownWorkers() {
    const workerIds = await preloadWorkerIds(
      Object.keys(this.workers),
      this.nextDistributionStartBlockNumber,
    );
    for (const workersKey in this.workers) {
      if (workerIds[workersKey] === 0n) {
        delete this.workers[workersKey];
      } else {
        this.workers[workersKey].setContractId(workerIds[workersKey]);
      }
    }
    return this.workers;
  }

  public async getStakes() {
    const [capedStakes, totalStakes] = await getStakes(
      this,
      this.nextDistributionStartBlockNumber,
    );
    this.parseMulticallResult(
      "stake",
      this.mapMulticallResult(capedStakes, bigIntToDecimal),
    );
    this.parseMulticallResult(
      "totalStake",
      this.mapMulticallResult(totalStakes, bigIntToDecimal),
    );
  }

  public getT() {
    const totalBytesSent = this.totalBytesSent();
    const totalChunksRead = this.totalChunksRead();
    this.map((worker) => worker.calculateT(totalBytesSent, totalChunksRead));
  }

  public getDTrraffic() {
    const totalTraffic = decimalSum(
      this.map(({ trafficWeight }) => trafficWeight),
    );
    this.map((worker) =>
      worker.calculateDTraffic(this.totalSupply(), totalTraffic),
    );
  }

  public async getLiveness() {
    const networkStats = await livenessFactor(this.clickhouseClient);
    this.map((worker) => worker.calculateLiveness(networkStats[worker.peerId]));
  }

  public async getDTenure(epochStartBlockNumber: number) {
    const epochLengthInBlocks = await epochLength();
    const tenureStart =
      epochStartBlockNumber - epochLengthInBlocks * config.tenureEpochCount;
    const epochStartBlocks = [...new Array(config.tenureEpochCount + 1)].map(
      (_, i) => tenureStart + i * epochLengthInBlocks,
    );
    const epochStartTimestamps = await Promise.all(
      epochStartBlocks.map(getBlockTimestamp),
    );
    const _historicalLiveness = await historicalLiveness(
      this.clickhouseClient,
      epochStartTimestamps,
    );
    this.map((worker) => {
      worker.calculateDTenure(_historicalLiveness[worker.peerId] ?? []);
    });
  }

  public async calculateRewards() {
    const duration = dayjs(this.clickhouseClient.to).diff(
      dayjs(this.clickhouseClient.from),
      "second",
    );
    const baseApr = await currentApy(this.nextDistributionStartBlockNumber);
    this.baseApr = new Decimal(baseApr.toString());

    this.stakeFactor = this.calculateStakeFactor();

    this.rAPR = this.baseApr;

    const rMax = this.rAPR.mul(duration).div(YEAR).div(10_000);
    this.map((worker) => worker.getRewards(rMax));
  }

  public async calcluateLogs() {
    const target_capacity = await getTargetCapacity(
      this.nextDistributionStartBlockNumber,
    );
    const active_workers_count = this.count();
    const storagePerWorker = await storagePerWorkerInGb(
      this.nextDistributionStartBlockNumber,
    );
    const current_capacity = active_workers_count * storagePerWorker;

    const stakeSum = decimalSum(this.map(({ stake }) => stake));

    const duration = dayjs(this.clickhouseClient.to).diff(
      dayjs(this.clickhouseClient.from),
      "second",
    );

    console.log(
      JSON.stringify({
        time: new Date(),
        type: "rewards_report",
        target_capacity,
        current_capacity,
        active_workers_count,
        base_apr: this.baseApr.toFixed(),
        stake_factor: this.stakeFactor.toFixed(),
        r_apr: this.rAPR.toFixed(),
      }),
    ),
      this.map((worker) =>
        console.log(
          JSON.stringify({
            time: new Date(),
            type: "worker_report",
            worker_id: worker.peerId,
            t_i: worker.trafficWeight.toFixed(),
            s_i: worker.stakeWeight(stakeSum).toFixed(),
            r_i: worker.actualYield.toFixed(),
            ...worker.apr(duration, YEAR),
          }),
        ),
      );
  }

  private parseMulticallResult<
    TKey extends keyof Worker,
    TValue extends Worker[TKey],
  >(key: TKey, multicallResult: MulticallResult<TValue>[]) {
    this.map((worker, i) => {
      worker[key] = multicallResult[i].result;
    });
  }

  private mapMulticallResult<S, T>(
    multicallResult: MulticallResult<S>[],
    mapper: (v: S) => T,
  ): MulticallResult<T>[] {
    return multicallResult.map(({ status, error, result }) =>
      status === "success"
        ? { status, error, result: mapper(result) }
        : { status, error, result },
    );
  }

  private totalBytesSent() {
    return sum(this.map(({ bytesSent }) => bytesSent));
  }

  private totalChunksRead() {
    return sum(this.map(({ chunksRead }) => chunksRead));
  }

  private totalSupply() {
    return this.bond
      .mul(this.count())
      .add(decimalSum(this.map(({ stake }) => stake)));
  }

  private async rUnlocked() {
    const duration = dayjs(this.clickhouseClient.to).diff(
      dayjs(this.clickhouseClient.from),
      "second",
    );
    const apy = bigIntToDecimal(
      await currentApy(this.nextDistributionStartBlockNumber),
    );
    return apy.mul(this.totalSupply()).mul(duration).div(YEAR).div(10_000);
  }

  private calculateStakeFactor() {
    return new Decimal(1);
  }

  public async logStats() {
    const stats = Object.fromEntries(
      this.map((worker) => [
        worker.peerId,
        keysToFixed({
          t: worker.trafficWeight.mul(100),
          dTraffic: worker.dTraffic.mul(100),
          livenessFactor: (worker.networkStats?.livenessFactor ?? 0) * 100,
          dLiveness: worker.livenessCoefficient.mul(100),
          dTenure: worker.dTenure.mul(100),
          workerReward: formatSqd(worker.workerReward),
          stakerReward: formatSqd(worker.stakerReward),
        }),
      ]),
    );
    const totalUnlocked = await this.rUnlocked();
    const totalReward = decimalSum(
      this.map(({ workerReward, stakerReward }) =>
        workerReward.add(stakerReward),
      ),
    );
    logger.table(stats);
    logger.log("Max unlocked:", formatSqd(totalUnlocked));
    logger.log("Total reward:", formatSqd(totalReward));
    this.logPercentageUnlocked(totalReward, totalUnlocked);
  }

  private logPercentageUnlocked(totalReward: Decimal, totalUnlocked: Decimal) {
    if (!totalUnlocked) logger.log("Percentage unlocked 0 %");
    else
      logger.log(
        "Percentage of max unlocked",
        totalReward.mul(10000).div(totalUnlocked).div(100).toFixed(2),
        "%",
      );
  }

  public async rewards(): Promise<Rewards> {
    return Object.fromEntries(
      await Promise.all(
        this.map(
          async (worker) =>
            [
              worker.peerId,
              {
                workerReward: decimalToBigInt(worker.workerReward),
                stakerReward: decimalToBigInt(worker.stakerReward),
                computationUnitsUsed:
                  worker.requestsProcessed * config.requestPrice,
                id: await worker.getId(),
              },
            ] as const,
        ),
      ),
    );
  }
}
