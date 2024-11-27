import { addresses, config, contracts, l1Client, publicClient } from "./config";
import {
  ContractFunctionConfig,
  decodeEventLog,
  encodeFunctionData,
  formatEther,
  Hex,
  isAddressEqual,
  parseAbiItem,
} from "viem";
import { logger } from "./logger";
import { bigSum, cachedFunction, fromBase58 } from "./utils";
import { Rewards } from "./reward";
import { Workers } from "./workers";
import { fordefiRequest } from "./fordefi/request";
import { sendFordefiTransaction } from "./fordefi/sendTransaction";
import assert from "assert";

function getNitroGenesisBlock(chainId: number) {
  // all networks except Arbitrum One started off with Nitro
  if (chainId === 42161) {
    return 15447158n
  }

  return 0n
}

let lastKnowBlockPair: {l1Block: bigint, l2Block: bigint} | undefined = undefined

// ref https://github.com/OffchainLabs/arbitrum-sdk/blob/5ef44308d3c89fd956c9dfdc59b6776b88afd251/src/lib/utils/lib.ts#L90
export async function getFirstBlockForL1Block(targetL1Block: number | bigint | undefined): Promise<bigint> {
  targetL1Block = targetL1Block == null ? await l1Client.getBlockNumber() : BigInt(targetL1Block)

  let start: bigint
  if (lastKnowBlockPair == null || lastKnowBlockPair.l1Block > targetL1Block) {
    const chainId = await publicClient.getChainId();
    start = getNitroGenesisBlock(chainId)

    if (targetL1Block < start) {
      throw new Error(`Target L1 block ${targetL1Block} is before the Nitro genesis block ${start}`)
    }
  } else if (lastKnowBlockPair.l1Block < targetL1Block) {
    start = lastKnowBlockPair.l2Block
  } else {
    return lastKnowBlockPair.l2Block
  }

  let end = await publicClient.getBlockNumber()

  let targetL2Block: bigint | undefined
  while (start <= end) {
    // Calculate the midpoint of the current range.
    const mid = start + (end - start) / 2n

    const l1Block = await publicClient.getBlock({blockNumber: mid}).then(block => BigInt((block as any).l1BlockNumber))

    // If the midpoint matches the target, we've found a match.
    // Adjust the range to search for the first occurrence.
    if (l1Block === targetL1Block) {
      end = mid - 1n
    } else if (l1Block < targetL1Block) {
      start = mid + 1n
    } else {
      end = mid - 1n
    }

    // Stores last valid Arbitrum block corresponding to the current, or greater, L1 block.
    if (l1Block === targetL1Block) {
      targetL2Block = mid
    }
  }

  if (targetL2Block == null) {
    throw new Error(`Unable to find l2 block for l1 block ${targetL1Block}`)
  }

  lastKnowBlockPair = {
    l1Block: targetL1Block,
    l2Block: targetL2Block
  }

  return targetL2Block
}

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

export async function getLatestDistributionBlock() {
  const toBlock = await publicClient.getBlockNumber();
  let offset = 1000n;
  while (offset <= toBlock) {
    const distributionBlocks = (
      await publicClient.getLogs({
        address: addresses.rewardsDistribution,
        event: parseAbiItem(
          `event Distributed(uint256 fromBlock, uint256 toBlock, uint256[] recipients, uint256[] workerRewards, uint256[] stakerRewards)`,
        ),
        fromBlock: toBlock - offset,
      })
    ).map(({ blockNumber }) => Number(blockNumber));
    console.log(distributionBlocks);
    if (distributionBlocks.length > 0) {
      const maxBlock = Math.max(...distributionBlocks);
      return BigInt(maxBlock);
    }
    offset *= 2n;
  }
}

export const currentApy = cachedFunction(_currentApy)

async function _currentApy(l1BlockNumber: number | bigint) {
  assert (l1BlockNumber < 1000000000n, `${l1BlockNumber} should fit into number` )
    
  const l2blockNumber = await getFirstBlockForL1Block(l1BlockNumber)
  
  const tvl = await contracts.rewardCalculation.read.effectiveTVL({ blockNumber: l2blockNumber });
  logger.log(`TVL: ${tvl.toString()}`);
  if (tvl === 0n) {
    return 2000n;
  }

  const initialRewardPoolsSize = await contracts.rewardCalculation.read.INITIAL_REWARD_POOL_SIZE({ blockNumber: l2blockNumber });
  logger.log(`Initial Reward Pool Size: ${initialRewardPoolsSize.toString()}`);

  const yearlyRewardCapCoefficient = await contracts.networkController.read.yearlyRewardCapCoefficient({ blockNumber: l2blockNumber });
  logger.log(`Yearly Reward Cap Coefficient: ${yearlyRewardCapCoefficient.toString()}`);

  const apyCap = (BigInt(10000) * yearlyRewardCapCoefficient * initialRewardPoolsSize) / tvl;
  logger.log(`APY Cap: ${apyCap.toString()}`);

  return 2000n > apyCap ? apyCap : 2000n;
}


export async function epochLength(blockNumber?: bigint) {
  if (config.rewardEpochLength) {
    return config.rewardEpochLength;
  }
  return Number(
    await contracts.workerRegistration.read.epochLength({ blockNumber }),
  );
}

export async function nextEpoch(blockNumber?: bigint) {
  return Number(
    await contracts.networkController.read.nextEpoch({ blockNumber }),
  );
}

export async function bond(blockNumber?: bigint) {
  return contracts.workerRegistration.read.bondAmount({ blockNumber });
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

export async function preloadWorkerIds(
  workers: string[],
  blockNumber?: bigint,
) {
  const workerIds = {} as Record<string, bigint>;
  const results = await publicClient.multicall({
    contracts: workers.map((workerId) => ({
      address: addresses.workerRegistration,
      abi: contracts.workerRegistration.abi,
      functionName: "workerIds",
      args: [fromBase58(workerId)],
    })),
    blockNumber,
    batchSize: 2 ** 16,
  });
  workers.forEach((workerId, i) => {
    workerIds[workerId] = results[i].result!;
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

export async function canCommit(address: Hex) {
  return contracts.rewardsDistribution.read.canCommit([address]);
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

async function sendCommitRequest(
  fromBlock: bigint,
  toBlock: bigint,
  workerIds: bigint[],
  rewardAmounts: bigint[],
  stakedAmounts: bigint[],
) {
  const data = encodeFunctionData({
    abi: contracts.rewardsDistribution.abi,
    functionName: "commit",
    args: [fromBlock, toBlock, workerIds, rewardAmounts, stakedAmounts],
  });
  const totalWorkers = workerIds.length;
  const totalWorkerReward = formatEther(bigSum(rewardAmounts));
  const totalStarkerReward = formatEther(bigSum(stakedAmounts));
  const request = fordefiRequest(
    contracts.rewardsDistribution.address,
    data,
    `Reward commit, blocks ${fromBlock} - ${toBlock}\n${totalWorkers} workers rewarded.
Worker reward: ${totalWorkerReward} SQD;\nStaker reward: ${totalStarkerReward} SQD`,
  );
  return sendFordefiTransaction(request);
}

async function logIfSuccessfulDistribution(
  txHash: Hex,
  workers: Workers,
  address: string,
  index: number,
) {
  const transaction = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    timeout: 20000,
  });

  if (
    transaction.logs
      .filter((log) =>
        isAddressEqual(log.address, contracts.rewardsDistribution.address),
      )
      .map((log) =>
        decodeEventLog({
          abi: contracts.rewardsDistribution.abi,
          data: log.data,
          topics: log.topics,
        }),
      )
      .some((event) => event.eventName === "Distributed")
  ) {
    workers.noteSuccessfulCommit(txHash);
    await workers.printLogs({
      walletAddress: address,
      index,
    });
  }
}

export async function commitRewards(
  fromBlock: number,
  toBlock: number,
  workers: Workers,
  address: Hex,
  index: number,
) {
  const rewards = await workers.rewards();
  const { workerIds, rewardAmounts, stakedAmounts } = rewardsToTxArgs(rewards);

  if (!(await canCommit(address))) {
    console.log("Cannot commit", address);
    return;
  }
  const tx = await sendCommitRequest(
    BigInt(fromBlock),
    BigInt(toBlock),
    workerIds,
    rewardAmounts,
    stakedAmounts,
  );

  if (!tx) {
    return;
  }
  await logIfSuccessfulDistribution(tx, workers, address, index);

  logger.log("Commit rewards", tx);
  return tx;
}

async function sendApproveRequest(
  fromBlock: bigint,
  toBlock: bigint,
  workerIds: bigint[],
  rewardAmounts: bigint[],
  stakedAmounts: bigint[],
) {
  const data = encodeFunctionData({
    abi: contracts.rewardsDistribution.abi,
    functionName: "approve",

    args: [fromBlock, toBlock, workerIds, rewardAmounts, stakedAmounts],
  });
  const request = fordefiRequest(
    contracts.rewardsDistribution.address,
    data,
    "Reward approve",
  );
  return sendFordefiTransaction(request);
}

async function tryToRecommit(
  fromBlock: number,
  toBlock: number,
  rewards: Rewards,
  address: Hex,
  commitment?: Hex,
) {
  if (!commitment) return;
  if (!(await canCommit(address))) {
    return;
  }
  if (
    await contracts.rewardsDistribution.read.alreadyApproved([
      commitment,
      address,
    ])
  ) {
    return;
  }
  const { workerIds, rewardAmounts, stakedAmounts } = rewardsToTxArgs(rewards);
  const tx = await sendCommitRequest(
    BigInt(fromBlock),
    BigInt(toBlock),
    workerIds,
    rewardAmounts,
    stakedAmounts,
  );
  logger.log("Recommit rewards", tx);
  return tx;
}

export async function approveRewards(
  fromBlock: number,
  toBlock: number,
  workers: Workers,
  address: Hex,
  index: number,
  commitment?: Hex,
) {
  const rewards = await workers.rewards();
  const { workerIds, rewardAmounts, stakedAmounts } = rewardsToTxArgs(rewards);
  if (
    !(await contracts.rewardsDistribution.read.canApprove([
      address,
      BigInt(fromBlock),
      BigInt(toBlock),
      workerIds,
      rewardAmounts,
      stakedAmounts,
    ]))
  ) {
    const tx = await tryToRecommit(
      fromBlock,
      toBlock,
      rewards,
      address,
      commitment,
    );
    if (!tx) logger.log("Cannot approve rewards", address);
    if (tx) await logIfSuccessfulDistribution(tx, workers, address, index);
    return;
  }

  const tx = await sendApproveRequest(
    BigInt(fromBlock),
    BigInt(toBlock),
    workerIds,
    rewardAmounts,
    stakedAmounts,
  );
  if (!tx) return;
  await logIfSuccessfulDistribution(tx, workers, address, index);
  logger.log("Approve rewards", tx);
  return tx;
}

export async function getStakes(workers: Workers, blockNumber?: bigint) {
  const capedStakeCalls = await Promise.all(
    workers.map(async (worker) => ({
      address: contracts.capedStaking.address,
      abi: contracts.capedStaking.abi,
      functionName: "capedStake" as "capedStake",
      args: [await worker.getId()] as const,
    })),
  );
  const totalStakeCalls = await Promise.all(
    workers.map(async (worker) => ({
      address: contracts.staking.address,
      abi: contracts.staking.abi,
      functionName: "delegated" as "delegated",
      args: [await worker.getId()] as const,
    })),
  );
  return [
    await publicClient.multicall<
      ContractFunctionConfig<typeof contracts.capedStaking.abi, "capedStake">[]
    >({
      contracts: capedStakeCalls,
      blockNumber,
      batchSize: 2 ** 16,
    }),
    await publicClient.multicall<
      ContractFunctionConfig<typeof contracts.staking.abi, "delegated">[]
    >({
      contracts: totalStakeCalls,
      blockNumber,
      batchSize: 2 ** 16,
    }),
  ];
}

export async function targetCapacity(blockNumber?: bigint) {
  return Number(
    await contracts.networkController.read.targetCapacityGb({ blockNumber }),
  );
}

export async function storagePerWorkerInGb(blockNumber?: bigint) {
  return Number(
    await contracts.networkController.read.storagePerWorkerInGb({
      blockNumber,
    }),
  );
}

export async function registeredWorkersCount(blockNumber?: bigint) {
  return Number(
    await contracts.workerRegistration.read.getActiveWorkerCount({
      blockNumber,
    }),
  );
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


