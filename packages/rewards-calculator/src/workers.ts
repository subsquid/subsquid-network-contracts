import {
  bond,
  currentApy,
  epochLength,
  getBlockTimestamp,
  getStakes,
  MulticallResult,
  preloadWorkerIds,
} from "./chain";
import { bigSum, formatSqd, keysToFixed, sum } from "./utils";
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

const YEAR = 365 * 24 * 60 * 60;
export class Workers {
  private workers: Record<string, Worker> = {};
  private bond = 0n;

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

  public getDTrraffic() {
    const totalTraffic = sum(this.map(({ trafficWeight }) => trafficWeight));
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
    const rMax = ((await currentApy()) * this.count()) / YEAR / 10_000;
    this.map((worker) => worker.getRewards(rMax));
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
      (BigInt(await currentApy()) * this.totalSupply() * BigInt(duration)) /
      BigInt(YEAR) /
      10_000n
    );
  }

  public async logStats() {
    const stats = Object.fromEntries(
      this.map((worker) => [
        worker.peerId,
        keysToFixed({
          t: worker.trafficWeight,
          dTraffic: worker.dTraffic,
          livenessFactor: worker.networkStats.livenessFactor,
          dLiveness: worker.livenessCoefficient,
          dTenure: worker.dTenure,
          workerReward: formatSqd(worker.workerReward),
          stakerReward: formatSqd(worker.stakerReward),
        }),
      ]),
    );
    const totalUnlocked = await this.rUnlocked();
    const totalReward = bigSum(
      this.map(({ workerReward, stakerReward }) => workerReward + stakerReward),
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

  public async rewards(): Promise<Rewards> {
    return Object.fromEntries(
      await Promise.all(
        this.map(
          async (worker) =>
            [
              worker.peerId,
              {
                workerReward: worker.workerReward,
                stakerReward: worker.stakerReward,
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
