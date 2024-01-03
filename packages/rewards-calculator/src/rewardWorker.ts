import {
  approveRewards,
  canCommit,
  commitRewards,
  epochLength,
  getBlockNumber,
  getBlockTimestamp,
  getRegistrations,
  isCommitted,
  lastRewardedBlock,
  Registrations,
} from "./chain";
import { epochStats } from "./reward";
import { logger } from "./logger";
import { hasNewerPings } from "./clickhouseClient";
import { publicClient } from "./client";
import { addresses, contracts } from "./config";
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
        const { fromBlock, toBlock } = await this.commitRange();
        if (
          fromBlock < toBlock &&
          !(await isCommitted(fromBlock, toBlock)) &&
          (await hasNewerPings(await getBlockTimestamp(toBlock + 1)))
        ) {
          logger.log("Can commit", this.walletClient.account.address);
          const rewards = await epochStats(fromBlock, toBlock);
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
        const rewards = await epochStats(ranges.fromBlock, ranges.toBlock);
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
    const maxCommitBlocksCovered = epochLen * 100;
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
  const commitmentBlocks = (
    await publicClient.getLogs({
      address: addresses.rewardsDistribution,
      event: parseAbiItem(
        `event NewCommitment(address indexed who,uint256 fromBlock,uint256 toBlock,uint256[] recipients,uint256[] workerRewards,uint256[] stakerRewards)`,
      ),
      fromBlock: 1n,
    })
  ).map(({ args: { fromBlock, toBlock }, blockNumber }) => ({
    fromBlock: Number(fromBlock),
    toBlock: Number(toBlock),
    blockNumber: Number(blockNumber),
  }));

  if (commitmentBlocks.length === 0) {
    return { shouldApprove: false };
  }

  const latestCommit = commitmentBlocks.sort(
    ({ blockNumber: a }, { blockNumber: b }) => Number(b) - Number(a),
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
