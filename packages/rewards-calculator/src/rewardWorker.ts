import {
  approveRewards,
  canCommit,
  commitRewards,
  epochLength,
  getBlockTimestamp,
  getRegistrations,
  isCommitted,
  lastRewardedBlock,
  nextEpoch,
  Registrations,
} from "./chain";
import { epochStats } from "./reward";
import { logger } from "./logger";
import { addresses, config, contracts, publicClient } from "./config";
import { parseAbiItem, WalletClient } from "viem";
import type { Workers } from "./workers";

async function firstRegistrationBlock(registrations: Registrations) {
  return Math.min(
    ...registrations.map(({ registeredAt }) => Number(registeredAt)),
  );
}

function getEpochStart(blockNumber: number, epochLength: number) {
  return Math.floor(blockNumber / epochLength) * epochLength;
}

export function isEpochConfirmed(epochEnd: Date) {
  return (
    new Date().valueOf() - epochEnd.valueOf() > config.epochConfirmationTime
  );
}

export class RewardWorker {
  constructor(
    private walletClient: WalletClient,
    private index: number,
  ) {}
  public startWorker() {
    this.commitIfPossible();
    this.approveIfNecessary();
  }

  private async commitIfPossible() {
    try {
      if (await canCommit(this.walletClient)) {
        const { fromBlock, toBlock } = await this.commitRange();
        if (await this.canCommit(fromBlock, toBlock)) {
          logger.log("Can commit", this.walletClient.account.address);
          const workers = await epochStats(fromBlock, toBlock);
          await this.tryToCommit(fromBlock, toBlock, workers);
        }
      }
    } catch (e) {
      logger.error(e);
    }
    setTimeout(() => this.commitIfPossible(), config.workTimeout);
  }

  private async canCommit(fromBlock: number, toBlock: number) {
    return (
      fromBlock < toBlock &&
      isEpochConfirmed(await getBlockTimestamp(toBlock)) &&
      !(await isCommitted(fromBlock, toBlock))
    );
  }

  private async tryToCommit(
    fromBlock: number,
    toBlock: number,
    workers: Workers,
  ) {
    const rewards = await workers.rewards();
    try {
      const tx = await commitRewards(
        fromBlock,
        toBlock,
        rewards,
        this.walletClient,
      );
      workers.noteSuccessfulCommit(tx);
    } catch (e) {
      if (e.message?.includes("Already approved")) {
        return;
      }
      workers.noteFailedCommit(e);
      logger.error(e);
    }

    await workers.printLogs({
      walletAddress: this.walletClient.account.address,
      index: this.index,
    });
  }

  private async approveIfNecessary() {
    try {
      const ranges = await approveRanges();
      if (ranges.shouldApprove) {
        const workers = await epochStats(ranges.fromBlock, ranges.toBlock);
        const rewards = await workers.rewards();
        const tx = await approveRewards(
          ranges.fromBlock,
          ranges.toBlock,
          rewards,
          this.walletClient,
        );
        console.log(
          JSON.stringify({
            time: new Date(),
            type: "rewards_approved",
            bot_wallet: this.walletClient.account.address,
            tx_hash: tx,
            from_block: ranges.fromBlock,
            to_block: ranges.toBlock,
          }),
        );
      }
    } catch (e) {
      logger.error(e);
    }
    setTimeout(() => this.approveIfNecessary(), config.workTimeout);
  }

  private async commitRange() {
    const epochLen = await epochLength();
    const maxCommitBlocksCovered = epochLen * config.maxEpochsPerCommit;
    let _lastRewardedBlock = await lastRewardedBlock();
    if (_lastRewardedBlock === 0) {
      _lastRewardedBlock = await firstRegistrationBlock(
        await getRegistrations(),
      );
    }
    let currentEpochStart = (await nextEpoch()) - epochLen;
    if (currentEpochStart - _lastRewardedBlock - 1 > maxCommitBlocksCovered) {
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
        `event NewCommitment(address indexed who, uint256 fromBlock, uint256 toBlock, bytes32 commitment)`,
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
