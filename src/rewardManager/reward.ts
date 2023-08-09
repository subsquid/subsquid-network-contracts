import {bytesSent, livenessFactor, NetworkStats, Workers} from "./logs";
import {bond, epochLength} from "./chain";
import {formatEther, parseEther} from "viem";

const FIXED_R_APR = 0.8
const YEAR = 365 * 24 * 60 * 60

function normalize(workers: Workers): Workers {
  const totalBytesSent = Object.values(workers).reduce((acc, {bytesSent}) => acc + bytesSent, 0);
  const totalChunksRead = Object.values(workers).reduce((acc, {chunksRead}) => acc + chunksRead, 0);
  return Object.fromEntries(Object.entries(workers).map(([id, {bytesSent, chunksRead}]) => [id, {
    bytesSent: bytesSent / totalBytesSent,
    chunksRead: chunksRead / totalChunksRead,
  }]))
}

function getT(workers: Workers) {
  const normalized = normalize(workers);
  for (let w in workers) {
    workers[w].t = 10 * normalized[w].bytesSent + normalized[w].chunksRead;
  }
  return workers
}

async function dTraffic(workers: Workers) {
  const ALPHA = 0.1
  const s = 1 / Object.keys(workers).length;
  const T = Object.values(workers).reduce((acc, {t}) => acc + t, 0);
  const dT: { [key in string]: number } = {}
  for (const workersKey in workers) {
    dT[workersKey] = Math.min(1, (workers[workersKey].t / T / s) ** ALPHA);
  }
  return dT
}

async function dLiveness(networkStats: NetworkStats) {
  const dL: Record<string, number> = {}
  for (const [worker, {livenessFactor}] of Object.entries(networkStats)) {
    if (livenessFactor < 0.8) dL[worker] = 0
    else if (livenessFactor < 0.9) dL[worker] = 9 * livenessFactor - 7.2
    else if (livenessFactor < 0.95) dL[worker] = 2 * livenessFactor - 0.9
    else dL[worker] = 1
  }
  return dL
}

async function rMax() {
  return FIXED_R_APR * await epochLength() / YEAR
}

async function rUnlocked(workersCount: number) {
  const totalStaked = await bond() * BigInt(workersCount)
  return BigInt(FIXED_R_APR * 10) * totalStaked * BigInt(await epochLength()) / BigInt(YEAR) / 10n
}

function keysToFixed(object: Object) {
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, typeof value === 'number' ? value.toFixed(2) : value]))
}

export async function epochStats(from: Date, to: Date) {
  const workers = await bytesSent(from, to)
  const t = getT(workers)
  const dT = await dTraffic(t)
  const lf = await livenessFactor(from, to)
  const dL = await dLiveness(lf)
  const rm = await rMax()
  const _bond = await bond()
  console.log(from, '-', to)
  const stats: any = {}
  for (const workersKey in dL) {
    const r = rm * dL[workersKey] * dT[workersKey] || 0
    const reward = BigInt(Math.floor(r * 100_000_000)) * _bond / 100_000_000n
    stats[workersKey] = keysToFixed({
      t: t[workersKey]?.t,
      dTraffic: dT[workersKey],
      livenessFactor: lf[workersKey].livenessFactor,
      dLiveness: dL[workersKey],
      reward: formatEther(reward)
    })
  }
  if (Object.keys(stats).length === 0) return
  console.table(stats)
  const totalUnlocked = await rUnlocked(Object.keys(stats).length)
  const totalReward: bigint = Object.values(stats).reduce<bigint>((acc, {reward}) => acc + parseEther(reward), 0n)
  console.log('Total unlocked:', formatEther(totalUnlocked))
  console.log('Total reward:', formatEther(totalReward))
  console.log('Percentage unlocked', Number(totalReward * 10000n / totalUnlocked) / 100, '%')
}
