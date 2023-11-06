import { addresses, contract, contracts } from "./config";
import { l1Client, publicClient } from "./client";
import { isAddressEqual, parseAbiItem, WalletClient } from "viem";
import { logger } from "./logger";
import { fromBase58 } from "./utils";
import { Rewards } from "./reward";
import { Work, Workers } from "./logs";

export async function getRegistrations() {
  return (
    await publicClient.getLogs({
      address: "0xA7E47a7aE0FB29BeF4485f6CAb2ee1b85c1D38aB", // addresses.workerRegistration,
      event: parseAbiItem(
        "event WorkerRegistered(uint256 indexed workerId, bytes indexed peerId, address indexed registrar, uint256 registeredAt)"
      ),
      fromBlock: 1n,
    })
  ).map(({ args }) => args);
}

export type Registrations = Awaited<ReturnType<typeof getRegistrations>>;

const TARGET_GB = 30_000n;

export async function currentApy() {
  return Number(await contracts.rewardCalculation.read.currentApy([TARGET_GB]));
}

export async function epochLength() {
  return Number(await contracts.workerRegistration.read.epochLength());
}

export async function bond() {
  return contracts.workerRegistration.read.bondAmount();
}

export async function nextEpochStart() {
  return contracts.workerRegistration.read.nextEpoch();
}

export async function getBlockNumber() {
  return Number(await l1Client.getBlockNumber());
}

export async function lastRewardedBlock() {
  return Number(await contracts.rewardsDistribution.read.lastBlockRewarded());
}

const workerIds: { [key: string]: bigint } = {};

export async function preloadWorkerIds(workers: string[]) {
  const results = await publicClient.multicall({
    contracts: workers.map((workerId) => ({
      address: contracts.workerRegistration.address,
      abi: contracts.workerRegistration.abi,
      functionName: "workerIds",
      args: [fromBase58(workerId)],
    })),
  });
  workers.forEach((workerId, i) => {
    workerIds[workerId] = results[i].result;
  });
  return workerIds;
}

export function clearUnknownWorkers(workers: Record<string, Work>) {
  for (const workersKey in workers) {
    if (workerIds[workersKey] === 0n) {
      delete workers[workersKey];
    }
  }
  return workers;
}

export async function getWorkerId(peerId: string) {
  if (workerIds[peerId]) {
    return workerIds[peerId];
  }
  const workerId = await contracts.workerRegistration.read.workerIds([
    fromBase58(peerId),
  ]);
  workerIds[peerId] = workerId;
  return workerId;
}

export async function getBlockTimestamp(blockNumber: number) {
  return new Date(
    Number(
      (
        await l1Client.getBlock({
          blockNumber: BigInt(blockNumber),
        })
      ).timestamp
    ) * 1000
  );
}

export async function canCommit(walletClient: WalletClient) {
  return isAddressEqual(
    await contracts.rewardsDistribution.read.currentDistributor(),
    walletClient.account.address
  );
}

export async function alreadyCommitted(fromBlock: bigint, toBlock: bigint) {
  return (
    (await contracts.rewardsDistribution.read.commitments([
      fromBlock,
      toBlock,
    ])) !== "0x0000000000000000000000000000000000000000000000000000000000000000"
  );
}

export async function commitRewards(
  fromBlock: number,
  toBlock: number,
  rewards: Rewards,
  walletClient: WalletClient
) {
  if (!rewards) {
    logger.log("No rewards to distribute");
    return;
  }
  const workerPeerIds = Object.keys(rewards ?? {});
  const workerIds = await Promise.all(
    workerPeerIds.map((peerId) => getWorkerId(peerId))
  );
  const rewardAmounts = workerPeerIds.map((id) => rewards[id].workerReward);
  const stakedAmounts = workerPeerIds.map((id) => rewards[id].stakerReward);
  if (!(await canCommit(walletClient))) {
    return;
  }
  const tx = await contract("rewardsDistribution", walletClient)
    .write.commit(
      [
        BigInt(fromBlock),
        BigInt(toBlock),
        workerIds,
        rewardAmounts,
        stakedAmounts,
      ],
      {}
    )
    .catch(logger.log);
  logger.log("Commit rewards", tx);
}

export async function approveRewards(
  fromBlock: number,
  toBlock: number,
  rewards: Rewards,
  walletClient: WalletClient
) {
  const workerPeerIds = Object.keys(rewards ?? {});
  const workerIds = await Promise.all(
    workerPeerIds.map((peerId) => getWorkerId(peerId))
  );
  const rewardAmounts = workerPeerIds.map((id) => rewards[id].workerReward);
  const stakedAmounts = workerPeerIds.map((id) => rewards[id].stakerReward);
  if (
    !(await contracts.rewardsDistribution.read.canApprove([
      walletClient.account.address,
      BigInt(fromBlock),
      BigInt(toBlock),
      workerIds,
      rewardAmounts,
      stakedAmounts,
    ]))
  ) {
    logger.log("Cannot approve rewards", walletClient.account.address);
    return;
  }
  const tx = await contract("rewardsDistribution", walletClient)
    .write.approve(
      [
        BigInt(fromBlock),
        BigInt(toBlock),
        workerIds,
        rewardAmounts,
        stakedAmounts,
      ],
      {
        gasLimit: 10_000_000,
      }
    )
    .catch(logger.log);
  logger.log("Approve rewards", tx);
}

export async function watchCommits(onLogs: (logs: any) => void) {
  try {
    const t = (
      await publicClient.getLogs({
        address: addresses.rewardsDistribution,
        event: parseAbiItem(
          `event NewCommitment(address indexed who,uint256 fromBlock,uint256 toBlock,uint256[] recipients,uint256[] workerRewards,uint256[] stakerRewards)`
        ),
        fromBlock: 1n,
      })
    ).map(({ args }) => args);
    if (t.length > 0) {
      const latestCommit = t.sort(
        ({ toBlock: a }, { toBlock: b }) => Number(b) - Number(a)
      )[0];
      const latestDistributionBlock = Number(
        await contracts.rewardsDistribution.read.lastBlockRewarded()
      );
      if (latestDistributionBlock < Number(latestCommit.toBlock)) {
        await onLogs(latestCommit);
      }
    }
  } catch (e) {
    console.error(e);
  }
  setTimeout(() => watchCommits(onLogs), 300 * 1000);
}

export async function getStakes(workers: Workers) {
  const results = await publicClient.multicall({
    contracts: await Promise.all(
      Object.keys(workers).map(async (workerId) => ({
        address: contracts.staking.address,
        abi: contracts.staking.abi,
        functionName: "activeStake",
        args: [[await getWorkerId(workerId)]],
      }))
    ),
  });
  return Object.fromEntries(
    results.map(
      (result, i) =>
        [Object.keys(workers)[i], result.result] as [string, bigint]
    )
  );
}

export type Stakes = Awaited<ReturnType<typeof getStakes>>;
