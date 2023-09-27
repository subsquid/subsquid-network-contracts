import {addresses, contracts} from "./config";
import {l1Client, publicClient, walletClient} from "./client";
import {isAddressEqual, parseAbiItem} from "viem";
import {logger} from "./logger";
import {fromBase58} from "./utils";

export async function getRegistrations() {
  return (await publicClient.getLogs({
    address: '0xA7E47a7aE0FB29BeF4485f6CAb2ee1b85c1D38aB',// addresses.workerRegistration,
    event: parseAbiItem('event WorkerRegistered(uint256 indexed workerId, bytes indexed peerId, address indexed registrar, uint256 registeredAt)'),
    fromBlock: 1n,
  })).map(({args}) => args)
}

export type Registrations = Awaited<ReturnType<typeof getRegistrations>>

export async function epochLength() {
  return Number(await contracts.workerRegistration.read.epochLength())
}

export async function bond() {
  return contracts.workerRegistration.read.bondAmount()
}

export async function nextEpochStart() {
  return contracts.workerRegistration.read.nextEpoch()
}

export async function getBlockNumber() {
  return Number(await l1Client.getBlockNumber())
}

export async function lastRewardedBlock() {
  return Number(await contracts.rewardsDistribution.read.lastBlockRewarded())
}

export function getWorkerId(peerId: string) {
  return contracts.workerRegistration.read.workerIds([fromBase58(peerId)])
}

export async function getBlockTimestamp(blockNumber: number) {
  return new Date(Number((await l1Client.getBlock({
    blockNumber: BigInt(blockNumber),
  })).timestamp) * 1000)
}

export async function canCommit() {
  return isAddressEqual(await contracts.rewardsDistribution.read.currentDistributor(), walletClient.account.address)
}

export async function commitRewards(fromBlock: number, toBlock: number, rewards: {[key: string]: bigint}) {
  if (!rewards) {
    logger.log('No rewards to distribute')
    return
  }
  const workerPeerIds = Object.keys(rewards)
  const workerIds = await Promise.all(workerPeerIds.map(peerId => getWorkerId(peerId)))
  const rewardAmounts = workerPeerIds.map(id => rewards[id])
  const stakedAmounts = workerPeerIds.map(id => 0n)
  const tx = await contracts.rewardsDistribution.write.commit([BigInt(fromBlock), BigInt(toBlock), workerIds, rewardAmounts, stakedAmounts], {})
  logger.log('Commit rewards', tx)
}

export async function approveRewards(fromBlock: number, toBlock: number, rewards: {[key: string]: bigint}) {
  if (!rewards) {
    logger.log('No rewards to distribute')
    return
  }
  const workerPeerIds = Object.keys(rewards)
  const workerIds = await Promise.all(workerPeerIds.map(peerId => getWorkerId(peerId)))
  const rewardAmounts = workerPeerIds.map(id => rewards[id])
  const stakedAmounts = workerPeerIds.map(id => 0n)
  console.log([BigInt(fromBlock), BigInt(toBlock), workerIds, rewardAmounts, stakedAmounts])
  const tx = await contracts.rewardsDistribution.write.approve([BigInt(fromBlock), BigInt(toBlock), workerIds, rewardAmounts, stakedAmounts], {})
  logger.log('Commit rewards', tx)
}

export async function watchCommits(onLogs?: (logs: any) => void) {
  const t = (await publicClient.getLogs({
    address: addresses.rewardsDistribution,// addresses.workerRegistration,
    event: parseAbiItem(`event NewCommitment(address indexed who,uint256 fromBlock,uint256 toBlock,uint256[] recipients,uint256[] workerRewards,uint256[] stakerRewards)`),
    fromBlock: 1n,
  })).map(({args}) => args)
  if (t.length > 0) {
    onLogs(t.sort(({toBlock: a}, {toBlock: b}) => Number(b) - Number(a))[0])
  }
  publicClient.watchEvent({
    address: addresses.rewardsDistribution,
    event: parseAbiItem(`event NewCommitment(address indexed who,uint256 fromBlock,uint256 toBlock,uint256[] recipients,uint256[] workerRewards,uint256[] stakerRewards)`),
    onLogs
  })
}
