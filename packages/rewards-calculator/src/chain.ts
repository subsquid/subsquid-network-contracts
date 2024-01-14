import {
  addresses,
  config,
  contract,
  contracts,
  l1Client,
  publicClient,
} from "./config";
import {
  ContractFunctionConfig,
  isAddressEqual,
  parseAbiItem,
  WalletClient,
} from "viem";
import { logger } from "./logger";
import { fromBase58 } from "./utils";
import { Rewards } from "./reward";
import { Workers } from "./workers";

export async function getRegistrations() {
  return (
    await publicClient.getLogs({
      address: addresses.workerRegistration,
      event: parseAbiItem(
        `event WorkerRegistered(uint256 indexed workerId, bytes peerId, address indexed registrar, uint256 registeredAt, string metadata)`,
      ),
      fromBlock: 1n,
    })
  ).map(({ args }) => args);
}

export type Registrations = Awaited<ReturnType<typeof getRegistrations>>;

// TODO add block tags to read calls
export async function currentApy() {
  return Number(
    await contracts.rewardCalculation.read.currentApy([
      config.targetCapacityGB,
    ]),
  );
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

export async function isCommitted(from: number, to: number) {
  return (
    (await contracts.rewardsDistribution.read.commitments([
      BigInt(from),
      BigInt(to),
    ])) !== "0x0000000000000000000000000000000000000000000000000000000000000000"
  );
}

export async function preloadWorkerIds(workers: string[]) {
  const workerIds = {} as Record<string, bigint>;
  const results = await publicClient.multicall({
    contracts: workers.map((workerId) => ({
      address: addresses.workerRegistration,
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

function rewardsToTxArgs(rewards: Rewards) {
  const workerPeerIds = Object.keys(rewards ?? {});
  const workerIds = workerPeerIds.map((id) => rewards[id].id);
  const rewardAmounts = workerPeerIds.map((id) => rewards[id].workerReward);
  const stakedAmounts = workerPeerIds.map((id) => rewards[id].stakerReward);
  const computationUnitsUsed = workerPeerIds.map(
    (id) => rewards[id].computationUnitsUsed ?? 0n,
  );
  return { workerIds, rewardAmounts, stakedAmounts, computationUnitsUsed };
}

export async function commitRewards(
  fromBlock: number,
  toBlock: number,
  rewards: Rewards,
  walletClient: WalletClient,
) {
  const { workerIds, rewardAmounts, stakedAmounts, computationUnitsUsed } =
    rewardsToTxArgs(rewards);
  if (!(await canCommit(walletClient))) {
    return;
  }
  const tx = await contract("rewardsDistribution", walletClient).write.commit(
    [
      BigInt(fromBlock),
      BigInt(toBlock),
      workerIds,
      rewardAmounts,
      stakedAmounts,
      computationUnitsUsed,
    ],
    {},
  );
  logger.log("Commit rewards", tx);
}

export async function approveRewards(
  fromBlock: number,
  toBlock: number,
  rewards: Rewards,
  walletClient: WalletClient,
) {
  const { workerIds, rewardAmounts, stakedAmounts, computationUnitsUsed } =
    rewardsToTxArgs(rewards);
  if (
    !(await contracts.rewardsDistribution.read.canApprove([
      walletClient.account.address,
      BigInt(fromBlock),
      BigInt(toBlock),
      workerIds,
      rewardAmounts,
      stakedAmounts,
      computationUnitsUsed,
    ]))
  ) {
    logger.log("Cannot approve rewards", walletClient.account.address);
    return;
  }
  const tx = await contract("rewardsDistribution", walletClient).write.approve(
    [
      BigInt(fromBlock),
      BigInt(toBlock),
      workerIds,
      rewardAmounts,
      stakedAmounts,
      computationUnitsUsed,
    ],
    {
      gas: config.network.gasLimit,
    },
  );
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
