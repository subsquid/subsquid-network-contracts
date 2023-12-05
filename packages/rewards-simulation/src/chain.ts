import { contract, contracts } from "./config.js";
import { l1Client, publicClient } from "./client.js";
import {
  ContractFunctionConfig,
  isAddressEqual,
  parseAbiItem,
  WalletClient,
} from "viem";
import { logger } from "./logger.js";
import { fromBase58 } from "./utils.js";
import { Rewards } from "./reward.js";
import { Workers } from "./workers";

export async function getRegistrations() {
  return (
    await publicClient.getLogs({
      address: "0xA7E47a7aE0FB29BeF4485f6CAb2ee1b85c1D38aB", // addresses.workerRegistration,
      event: parseAbiItem(
        "event WorkerRegistered(uint256 indexed workerId, bytes indexed peerId, address indexed registrar, uint256 registeredAt)",
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

export async function getBlockNumber() {
  return Number(await l1Client.getBlockNumber());
}

export async function lastRewardedBlock() {
  return Number(await contracts.rewardsDistribution.read.lastBlockRewarded());
}

export async function preloadWorkerIds(workers: string[]) {
  const workerIds = {} as Record<string, bigint>;
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

export async function getWorkerId(peerId: string) {
  return contracts.workerRegistration.read.workerIds([fromBase58(peerId)]);
}

export async function getBlockTimestamp(blockNumber: number) {
  return new Date(
    Number(
      (
        await l1Client.getBlock({
          blockNumber: BigInt(blockNumber),
        })
      ).timestamp,
    ) * 1000,
  );
}

export async function canCommit(walletClient: WalletClient) {
  return isAddressEqual(
    await contracts.rewardsDistribution.read.currentDistributor(),
    walletClient.account.address,
  );
}

export async function commitRewards(
  fromBlock: number,
  toBlock: number,
  rewards: Rewards,
  walletClient: WalletClient,
) {
  if (!rewards) {
    logger.log("No rewards to distribute");
    return;
  }
  const workerPeerIds = Object.keys(rewards ?? {});
  const workerIds = await Promise.all(
    workerPeerIds.map((peerId) => getWorkerId(peerId)),
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
      {},
    )
    .catch(logger.log);
  logger.log("Commit rewards", tx);
}

export async function approveRewards(
  fromBlock: number,
  toBlock: number,
  rewards: Rewards,
  walletClient: WalletClient,
) {
  const workerPeerIds = Object.keys(rewards ?? {});
  const workerIds = await Promise.all(
    workerPeerIds.map((peerId) => getWorkerId(peerId)),
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
      },
    )
    .catch(logger.log);
  logger.log("Approve rewards", tx);
}

export async function getStakes(workers: Workers) {
  const calls = await Promise.all(
    workers.map(async (worker) => ({
      address: contracts.staking.address,
      abi: contracts.staking.abi,
      functionName: "activeStake" as "activeStake",
      args: [[await worker.getId()]] as const,
    })),
  );
  return publicClient.multicall<
    ContractFunctionConfig<typeof contracts.staking.abi, "activeStake">[]
  >({
    contracts: calls,
  });
}

export type MulticallResult<T> =
  | {
      error: Error;
      result?: undefined;
      status: "failure";
    }
  | {
      error?: undefined;
      result: T;
      status: "success";
    };
