import {
  approveRewards,
  canCommit,
  commitRewards,
  epochLength,
  getBlockNumber,
  getBlockTimestamp,
  getRegistrations,
  lastRewardedBlock,
  Registrations,
} from "./chain.js";
import { epochStats } from "./reward.js";
import { logger } from "./logger.js";
import { hasNewerPings } from "./clickhouseClient.js";
import { publicClient } from "./client.js";
import { addresses, contracts } from "./config.js";
import { parseAbiItem, WalletClient } from "viem";

async function firstRegistrationBlock(registrations: Registrations) {
  return Math.min(
    ...registrations.map(({ registeredAt }) => Number(registeredAt)),
  );
}

function getEpochStart(blockNumber: number, epochLength: number) {
  return Math.floor(blockNumber / epochLength) * epochLength;
}

const WORK_TIMEOUT_MS = 300 * 1000;

export class RewardWorker {
  constructor(private walletClient: WalletClient) {}
  public startWorker() {
    this.commitIfPossible();
    this.approveIfNecessary();
  }

  private async commitIfPossible() {
    try {
      if (await canCommit(this.walletClient)) {
        logger.log("Can commit", this.walletClient.account.address);
        const { fromBlock, toBlock } = await this.commitRange();
        if (
          fromBlock < toBlock &&
          (await hasNewerPings(await getBlockTimestamp(toBlock + 1)))
        ) {
          const rewards = await epochStats(
            await getBlockTimestamp(fromBlock),
            await getBlockTimestamp(toBlock),
          );
          await commitRewards(fromBlock, toBlock, rewards, this.walletClient);
        }
      }
    } catch (e) {
      logger.error(e);
    }
    setTimeout(() => this.commitIfPossible(), WORK_TIMEOUT_MS);
  }

  private async approveIfNecessary() {
    try {
      const ranges = await approveRanges();
      if (ranges.shouldApprove) {
        const rewards = await epochStats(
          await getBlockTimestamp(ranges.fromBlock),
          await getBlockTimestamp(ranges.toBlock),
        );
        await approveRewards(
          ranges.fromBlock,
          ranges.toBlock,
          rewards,
          this.walletClient,
        );
      }
    } catch (e) {
      logger.error(e);
    }
    setTimeout(() => this.approveIfNecessary(), WORK_TIMEOUT_MS);
  }

  private async commitRange() {
    const epochLen = await epochLength();
    const maxCommitBlocksCovered = epochLen * 1_000;
    let _lastRewardedBlock = await lastRewardedBlock();
    if (_lastRewardedBlock === 0) {
      _lastRewardedBlock = await firstRegistrationBlock(
        await getRegistrations(),
      );
    }
    let currentEpochStart = getEpochStart(await getBlockNumber(), epochLen);
    if (currentEpochStart - _lastRewardedBlock > maxCommitBlocksCovered) {
      currentEpochStart = _lastRewardedBlock + maxCommitBlocksCovered;
    }
    const fromBlock = _lastRewardedBlock + 1;
    const toBlock = currentEpochStart - 1;
    return { fromBlock, toBlock };
  }
}

async function approveRanges(): Promise<
  | {
      shouldApprove: false;
    }
  | {
      shouldApprove: true;
      fromBlock: number;
      toBlock: number;
    }
> {
  const blocks = (
    await publicClient.getLogs({
      address: addresses.rewardsDistribution,
      event: parseAbiItem(
        `event NewCommitment(address indexed who,uint256 fromBlock,uint256 toBlock,uint256[] recipients,uint256[] workerRewards,uint256[] stakerRewards)`,
      ),
      fromBlock: 1n,
    })
  ).map(({ args: { fromBlock, toBlock } }) => ({
    fromBlock: Number(fromBlock),
    toBlock: Number(toBlock),
  }));

  if (blocks.length === 0) {
    return { shouldApprove: false };
  }

  const latestCommit = blocks.sort(
    ({ toBlock: a }, { toBlock: b }) => Number(b) - Number(a),
  )[0];
  const latestDistributionBlock = Number(
    await contracts.rewardsDistribution.read.lastBlockRewarded(),
  );

  if (latestDistributionBlock >= Number(latestCommit.toBlock)) {
    return { shouldApprove: false };
  }
  if (!latestCommit.fromBlock) return { shouldApprove: false };
  return {
    shouldApprove: true,
    ...latestCommit,
  };
}
