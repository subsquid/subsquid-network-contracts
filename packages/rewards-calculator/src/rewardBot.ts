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
import { addresses, config, contracts, publicClient } from "./config";
import { Hex, parseAbiItem } from "viem";
import type { Workers } from "./workers";
import { logger } from "./logger";
import { bigSum } from "./utils";

async function firstRegistrationBlock(registrations: Registrations) {
  return Math.min(
    ...registrations.map(({ registeredAt }) => Number(registeredAt)),
  );
}

export class RewardBot {
  constructor(
    private address: Hex,
    private index: number,
  ) {}

  public startBot() {
    logger.workerAddress = this.address;
    this.commitIfPossible();
    this.approveIfNecessary();
  }

  private async commitIfPossible() {
    try {
      const { fromBlock, toBlock } = await this.commitRange();

      if (await this.canCommit(fromBlock, toBlock)) {
        console.log("Can commit", this.address);
        const workers = await epochStats(fromBlock, toBlock);
        await this.tryToCommit(fromBlock, toBlock, workers);
      } else {
        console.log("Nothing to commit", this.address);
      }
    } catch (e) {
      console.log(e);
    }
    setTimeout(() => this.commitIfPossible(), config.workTimeout);
  }

  private async canCommit(fromBlock: number, toBlock: number) {
    return (
      fromBlock < toBlock &&
      (await canCommit(this.address)) &&
      !(await isCommitted(fromBlock, toBlock))
    );
  }

  private async tryToCommit(
    fromBlock: number,
    toBlock: number,
    workers: Workers,
  ) {
    try {
      const tx = await commitRewards(
        fromBlock,
        toBlock,
        workers,
        this.address,
        this.index,
      );

      if (!tx) return;

      console.log({
        time: new Date(),
        type: "rewards_commited",
        bot_wallet: this.address,
        tx_hash: tx,
        from_block: fromBlock,
        to_block: toBlock,
        totalStake: bigSum(
          workers.map(({ totalStake }) => BigInt(totalStake.toFixed(0))),
        ),
        capedStake: bigSum(
          workers.map(({ stake }) => BigInt(stake.toFixed(0))),
        ),
      });
    } catch (e: any) {
      if (e.message?.includes("Already approved")) {
        return;
      }
      if (e.message?.includes("not all blocks covered")) {
        return;
      }
      console.log(e);
    }
  }

  private async approveIfNecessary() {
    try {
      const ranges = await approveRanges();
      if (ranges.shouldApprove) {
        const workers = await epochStats(ranges.fromBlock, ranges.toBlock);
        const tx = await approveRewards(
          ranges.fromBlock,
          ranges.toBlock,
          workers,
          this.address,
          this.index,
          ranges.commitment,
        );
        if (tx) {
          console.log({
            time: new Date(),
            type: "rewards_approved",
            bot_wallet: this.address,
            tx_hash: tx,
            from_block: ranges.fromBlock,
            to_block: ranges.toBlock,
          });
        }
      }
    } catch (e) {
      console.log(e);
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
    const currentBlock = await getBlockNumber();
    const lastConfirmedBlock = currentBlock - config.epochConfirmationBlocks;
    if (lastConfirmedBlock - _lastRewardedBlock < epochLen) {
      return { fromBlock: 0, toBlock: 0 };
    }
    const toBlock = Math.min(
      _lastRewardedBlock + maxCommitBlocksCovered,
      lastConfirmedBlock,
    );
    const fromBlock = _lastRewardedBlock + 1;
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
      commitment?: Hex;
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
  ).map(({ args: { fromBlock, toBlock, commitment }, blockNumber }) => ({
    fromBlock: Number(fromBlock),
    toBlock: Number(toBlock),
    blockNumber: Number(blockNumber),
    commitment,
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
