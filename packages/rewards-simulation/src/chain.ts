import {contracts} from "./config";
import {l1Client, publicClient} from "./client";
import {parseAbiItem} from "viem";
import {fromBase58} from "./utils";
import {logger} from "./logger";

export async function getRegistrations() {
  return (await publicClient.getLogs({
    address: '0xA7E47a7aE0FB29BeF4485f6CAb2ee1b85c1D38aB',
    event: parseAbiItem('event WorkerRegistered(uint256 indexed workerId, bytes indexed peerId, address indexed registrar, uint256 registeredAt)'),
    fromBlock: 1n,
  })).map(({args}) => args)
}

export type Registrations = Awaited<ReturnType<typeof getRegistrations>>

export async function epochLength() {
  return Number(await contracts.workerRegistration.read.epochLength())
}

export async function bond() {
  return contracts.workerRegistration.read.BOND_AMOUNT()
}

export async function nextEpochStart() {
  return contracts.rewardsDistribution.read.nextEpochStartBlock()
}

export async function getBlockNumber() {
  return Number(await l1Client.getBlockNumber())
}

export async function getBlockTimestamp(blockNumber: number) {
  return new Date(Number((await l1Client.getBlock({
    blockNumber: BigInt(blockNumber),
  })).timestamp) * 1000)
}

export async function distributeRewards(nextEpochStart: number, rewards: {[key: string]: bigint}) {
  if (!rewards) {
    logger.log('No rewards to distribute')
    return
  }
  const allWorkers = await contracts.workerRegistration.read.getActiveWorkers()
  const workerIds = Object.keys(rewards)
  const workerAddresses = workerIds.map(id => allWorkers.find(({peerId}) => peerId === fromBase58(id)).creator)
  const rewardAmounts = workerIds.map(id => rewards[id])
  const tx = await contracts.rewardsDistribution.write.distribute([BigInt(nextEpochStart), workerAddresses, rewardAmounts], {})
  logger.log('Distribute rewards', tx)
}
