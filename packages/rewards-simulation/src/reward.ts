import {
  clickhouseBytesSent,
  livenessFactor,
  NetworkStats,
  Workers,
} from "./logs.js";
import {
  bond,
  clearUnknownWorkers,
  currentApy,
  getStakes,
  preloadWorkerIds,
  Stakes,
} from "./chain.js";
import { parseEther } from "viem";
import { bigSum, formatSqd, keysToFixed, sum } from "./utils.js";
import { logger } from "./logger.js";
import dayjs from "dayjs";

const YEAR = 365 * 24 * 60 * 60;
const PRECISION = 100_000_000;
const nPRECISION = 100_000_000n;

function normalize(workers: Workers): Workers {
  const totalBytesSent = sum(
    Object.values(workers).map(({ bytesSent }) => bytesSent),
  );
  const totalChunksRead = sum(
    Object.values(workers).map(({ chunksRead }) => chunksRead),
  );
  return Object.fromEntries(
    Object.entries(workers).map(([id, { bytesSent, chunksRead }]) => [
      id,
      {
        bytesSent: bytesSent / totalBytesSent,
        chunksRead: chunksRead / totalChunksRead,
      },
    ]),
  );
}

function getT(workers: Workers) {
  const normalized = normalize(workers);
  for (let w in workers) {
    workers[w].t = Math.sqrt(
      normalized[w].bytesSent * normalized[w].chunksRead,
    );
  }
  return workers;
}

async function dTraffic(workers: Workers, stakes: Stakes, bond: bigint) {
  const ALPHA = 0.1;
  const totalStake =
    bigSum(Object.values(stakes)) + bond * BigInt(Object.keys(stakes).length);
  const T = sum(Object.values(workers).map(({ t }) => t));
  const dT: { [key in string]: number } = {};
  for (const workersKey in workers) {
    const s =
      Number(((stakes[workersKey] + bond) * nPRECISION) / totalStake) /
      PRECISION;
    dT[workersKey] = Math.min(1, (workers[workersKey].t / T / s) ** ALPHA);
  }
  return dT;
}

async function dLiveness(networkStats: NetworkStats) {
  const dL: Record<string, number> = {};
  for (const [worker, { livenessFactor }] of Object.entries(networkStats)) {
    if (livenessFactor < 0.8) dL[worker] = 0;
    else if (livenessFactor < 0.9) dL[worker] = 9 * livenessFactor - 7.2;
    else if (livenessFactor < 0.95) dL[worker] = 2 * livenessFactor - 0.9;
    else dL[worker] = 1;
  }
  return dL;
}

async function rMax(length: number) {
  return ((await currentApy()) * length) / YEAR / 10_000;
}

async function rUnlocked(stakes: Stakes, timeLength: number) {
  const totalStaked =
    (await bond()) * BigInt(Object.keys(stakes).length) +
    bigSum(Object.values(stakes));
  return (
    (BigInt((await currentApy()) * 10) * totalStaked * BigInt(timeLength)) /
    BigInt(YEAR) /
    10n
  );
}

function printPercentageUnlocked(totalReward: bigint, totalUnlocked: bigint) {
  if (!totalUnlocked) logger.log("Percentage unlocked 0 %");
  else
    logger.log(
      "Percentage unlocked",
      Number((totalReward * 10000n) / totalUnlocked) / 100,
      "%",
    );
}

export type Rewards = {
  [key in string]: { workerReward: bigint; stakerReward: bigint };
};

export async function epochStats(from: Date, to: Date) {
  const _epochLength = dayjs(to).diff(dayjs(from), "second");
  logger.log(from, "-", to);
  let workers = await clickhouseBytesSent(from, to);
  const _bond = await bond();
  await preloadWorkerIds(Object.keys(workers));
  workers = clearUnknownWorkers(workers);
  const stakes = await getStakes(workers);
  const t = getT(workers);
  const dT = await dTraffic(t, stakes, _bond);
  const lf = await livenessFactor(from, to);
  const dL = await dLiveness(lf);
  const rm = await rMax(_epochLength);
  const stats: any = {};
  const rewards: Rewards = {};
  for (const workersKey in dL) {
    const r = rm * dL[workersKey] * dT[workersKey] || 0;
    const stake = stakes[workersKey] ?? 0n;
    const workerReward =
      (BigInt(Math.floor(r * PRECISION)) * (_bond + stake / 2n)) / nPRECISION;
    const stakerReward =
      (BigInt(Math.floor(r * PRECISION)) * stake) / 2n / nPRECISION;
    stats[workersKey] = keysToFixed({
      t: t[workersKey]?.t,
      dTraffic: dT[workersKey],
      livenessFactor: lf[workersKey].livenessFactor,
      dLiveness: dL[workersKey],
      workerReward: formatSqd(workerReward),
      stakerReward: formatSqd(stakerReward),
    });
    rewards[workersKey] = {
      workerReward,
      stakerReward,
    };
  }
  if (Object.keys(stats).length === 0) return;
  logger.table(stats);
  const totalUnlocked = await rUnlocked(stakes, _epochLength);
  const totalReward = bigSum(
    Object.values(stats).map(
      ({ workerReward, stakerReward }) =>
        parseEther(workerReward) + parseEther(stakerReward),
    ),
  );
  logger.log("Total unlocked:", formatSqd(totalUnlocked));
  logger.log("Total reward:", formatSqd(totalReward));
  printPercentageUnlocked(totalReward, totalUnlocked);
  return rewards;
}
