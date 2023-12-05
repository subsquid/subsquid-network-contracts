import {
  bond,
  currentApy,
  getStakes,
  getWorkerId,
  MulticallResult,
  preloadWorkerIds,
} from "./chain.js";
import { bigSum, formatSqd, keysToFixed, sum } from "./utils.js";
import {
  ClickhouseClient,
  livenessFactor,
  NetworkStatsEntry,
} from "./clickhouseClient.js";
import { logger } from "./logger.js";
import { parseEther } from "viem";
import dayjs from "dayjs";

const PRECISION = 1_000_000_000n;
const YEAR = 365 * 24 * 60 * 60;

class Worker {
  private contractId: bigint | undefined;
  public networkStats: NetworkStatsEntry;
  public bytesSent = 0;
  public chunksRead = 0;
  public t = 0;
  public dTraffic = 0;
  public stake = 0n;
  public livenessCoefficient = 0;
  public bond = 0n;
  public workerReward: bigint;
  public stakerReward: bigint;

  constructor(public id: string) {}

  public setContractId(contractId: bigint) {
    this.contractId = contractId;
  }

  public async getId() {
    if (this.contractId) {
      return this.contractId;
    }
    this.contractId = await getWorkerId(this.id);
    return this.contractId;
  }

  public async calculateT(totalBytesSent: number, totalChunksRead: number) {
    const { bytesSent, chunksRead } = this.normalizeTraffic(
      totalBytesSent,
      totalChunksRead,
    );
    this.t = Math.sqrt(bytesSent * chunksRead);
  }

  public async calculateTTraffic(totalSupply: bigint, totalT: number) {
    const ALPHA = 0.1;

    const supplyRatio =
      Number(((this.stake + this.bond) * PRECISION) / totalSupply) /
      Number(PRECISION);
    this.dTraffic = Math.min(1, (this.t / totalT / supplyRatio) ** ALPHA);
  }

  public async calculateLiveness(networkStats: NetworkStatsEntry) {
    this.networkStats = networkStats;
    if (!networkStats) return;
    const { livenessFactor } = networkStats;
    if (livenessFactor < 0.8) {
      this.livenessCoefficient = 0;
    } else if (livenessFactor < 0.9) {
      this.livenessCoefficient = 9 * livenessFactor - 7.2;
    } else if (livenessFactor < 0.95) {
      this.livenessCoefficient = 2 * livenessFactor - 0.9;
    } else {
      this.livenessCoefficient = 1;
    }
  }

  public async getRewards(rMax: number) {
    const actualYield = rMax * this.livenessCoefficient * this.dTraffic;
    const preciseR = BigInt(Math.floor(actualYield * Number(PRECISION)));
    this.workerReward = (preciseR * (this.bond + this.stake / 2n)) / PRECISION;
    this.stakerReward = (preciseR * this.stake) / 2n / PRECISION;
  }

  private normalizeTraffic(totalBytesSent: number, totalChunksRead: number) {
    return {
      bytesSent: this.bytesSent / totalBytesSent,
      chunksRead: this.chunksRead / totalChunksRead,
    };
  }
}

export class Workers {
  private workers: Record<string, Worker> = {};
  private bond = 0n;

  constructor(private clickhouseClient: ClickhouseClient) {}

  public add(workerId: string) {
    this.workers[workerId] = new Worker(workerId);
    return this.workers[workerId];
  }

  public map<T>(fn: (worker: Worker, index?: number) => T) {
    return Object.values(this.workers).map(fn);
  }

  public count() {
    return Object.keys(this.workers).length;
  }

  public async fetchCurrentBond() {
    this.bond = await bond();
    this.map((worker) => {
      worker.bond = this.bond;
    });
    return this.bond;
  }

  public async clearUnknownWorkers() {
    const workerIds = await preloadWorkerIds(Object.keys(this.workers));
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
    const stakes = await getStakes(this);
    this.parseMulticallResult("stake", stakes);
  }

  public getT() {
    const totalBytesSent = this.totalBytesSent();
    const totalChunksRead = this.totalChunksRead();
    this.map((worker) => worker.calculateT(totalBytesSent, totalChunksRead));
  }

  public getTTrraffic() {
    const totalT = sum(this.map(({ t }) => t));
    this.map((worker) => worker.calculateTTraffic(this.totalSupply(), totalT));
  }

  public async getLiveness() {
    const networkStats = await livenessFactor(this.clickhouseClient);
    this.map((worker) => worker.calculateLiveness(networkStats[worker.id]));
  }

  private parseMulticallResult<
    TKey extends keyof Worker,
    TValue extends Worker[TKey],
  >(key: TKey, multicallResult: MulticallResult<TValue>[]) {
    this.map((worker, i) => {
      worker[key] = multicallResult[i].result;
    });
  }

  private totalBytesSent() {
    return sum(this.map(({ bytesSent }) => bytesSent));
  }

  private totalChunksRead() {
    return sum(this.map(({ chunksRead }) => chunksRead));
  }

  public async calculateRewards() {
    const rMax = ((await currentApy()) * this.count()) / YEAR / 10_000;
    this.map((worker) => worker.getRewards(rMax));
  }

  private totalSupply() {
    return (
      this.bond * BigInt(this.count()) + bigSum(this.map(({ stake }) => stake))
    );
  }

  private async rUnlocked() {
    const duration = dayjs(this.clickhouseClient.to).diff(
      dayjs(this.clickhouseClient.from),
      "second",
    );

    return (
      (BigInt((await currentApy()) * 10) *
        this.totalSupply() *
        BigInt(duration)) /
      BigInt(YEAR) /
      10n
    );
  }

  public async logStats() {
    const stats = this.map((worker) =>
      keysToFixed({
        t: worker.t,
        dTraffic: worker.dTraffic,
        livenessFactor: worker.networkStats.livenessFactor,
        dLiveness: worker.livenessCoefficient,
        workerReward: formatSqd(worker.workerReward),
        stakerReward: formatSqd(worker.stakerReward),
      }),
    );
    const totalUnlocked = await this.rUnlocked();
    const totalReward = bigSum(
      Object.values(stats).map(
        ({ workerReward, stakerReward }) =>
          parseEther(workerReward) + parseEther(stakerReward),
      ),
    );
    logger.table(stats);
    logger.log("Total unlocked:", formatSqd(totalUnlocked));
    logger.log("Total reward:", formatSqd(totalReward));
    this.logPercentageUnlocked(totalReward, totalUnlocked);
  }

  private logPercentageUnlocked(totalReward: bigint, totalUnlocked: bigint) {
    if (!totalUnlocked) logger.log("Percentage unlocked 0 %");
    else
      logger.log(
        "Percentage unlocked",
        Number((totalReward * 10000n) / totalUnlocked) / 100,
        "%",
      );
  }

  public rewards() {
    return Object.fromEntries(
      this.map(({ id, workerReward, stakerReward }) => [
        id,
        { workerReward, stakerReward },
      ]),
    );
  }
}
