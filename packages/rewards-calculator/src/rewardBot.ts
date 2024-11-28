import {
  approveRewards,
  canCommit,
  commitRewards,
  epochLength,
  getBlockNumber,
  getFirstBlockForL1Block,
  getLatestCommitment,
  getRegistrations,
  isCommitted,
  lastRewardedBlock,
  Registrations,
} from "./chain";
import { epochStats } from "./reward";
import { addresses, config, contracts, publicClient } from "./config";
import { Account, Address, Hex, parseAbiItem } from "viem";
import type { Workers } from "./workers";
import { logger } from "./logger";
import { decimalSum } from "./utils";

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
      const { fromBlock, toBlock, epochLen, chunkType } = await this.commitRange();

      if (await this.canCommit(fromBlock, toBlock)) {
        console.log(`Can commit ${fromBlock} — ${toBlock} from ${this.address}`);

        /**
         * We need to calculate 2 epochs to get the correct period for the rewards
         * because of splitting the rewards to chunks
         */
        const workers = await epochStats(fromBlock - epochLen, toBlock, config.skipSignatureValidation);

        /**
         * We send to blockchain original epoch length due to a flaw in the contract
         */
        await this.tryToCommit(fromBlock, toBlock, workers.filterChunk(chunkType));
      } else {
        console.log(`Nothing to commit ${fromBlock} — ${toBlock}`);
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

      console.log(
        JSON.stringify({
          time: new Date(),
          type: "rewards_commited",
          bot_wallet: this.address,
          tx_hash: tx,
          from_block: fromBlock,
          to_block: toBlock,
          totalStake: decimalSum(
            workers.map(({ totalStake }) => totalStake),
          ).toFixed(),
          capedStake: decimalSum(workers.map(({ stake }) => stake)).toFixed(),
        }),
      );
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
        /**
         * We need to calculate 2 epochs to get the correct period for the rewards
         * because of splitting the rewards to chunks
         */
        const workers = await epochStats(ranges.fromBlock - ranges.epochLen, ranges.toBlock, config.skipSignatureValidation);

        /**
         * We send to blockchain original epoch length due to a flaw in the contract
         */
        const tx = await approveRewards(
          ranges.fromBlock,
          ranges.toBlock,
          workers.filterChunk(ranges.chunkType),
          this.address,
          this.index,
          ranges.commitment,
        );

        if (tx) {
          console.log(
            JSON.stringify({
              time: new Date(),
              type: "rewards_approved",
              bot_wallet: this.address,
              tx_hash: tx,
              from_block: ranges.fromBlock,
              to_block: ranges.toBlock,
            }),
          );
        }
      }
    } catch (e) {
      console.log(e);
    }
    setTimeout(() => this.approveIfNecessary(), config.workTimeout);
  }

  private async commitRange(): Promise<{ fromBlock: number, toBlock: number, epochLen: number, chunkType: 'even' | 'odd' }> {
    const epochLen = await epochLength();
    const maxCommitBlocksCovered = epochLen * config.maxEpochsPerCommit;

    let _lastRewardedBlock = await lastRewardedBlock();
    if (_lastRewardedBlock === 0) {
      logger.error(`Last reward block is 0!`)
      _lastRewardedBlock = await firstRegistrationBlock(
        await getRegistrations(),
      );
    }

    const currentBlock = await getBlockNumber();
    const lastConfirmedBlock = currentBlock - config.epochConfirmationBlocks;
    if (lastConfirmedBlock - _lastRewardedBlock < epochLen) {
      return { fromBlock: 0, toBlock: 0, epochLen, chunkType: 'even' };
    }


    const toBlock = Math.min(
      _lastRewardedBlock + maxCommitBlocksCovered,
      lastConfirmedBlock,
    );
    const fromBlock = _lastRewardedBlock + 1;

    return { fromBlock, toBlock, epochLen, chunkType: getChunkType(toBlock, epochLen) };
  }
}

function getChunkType(block: number, epochLen: number) : 'even' | 'odd' {
  return Math.ceil(block / epochLen) % 2 === 0 ? 'even' : 'odd'
}

export async function approveRanges(): Promise<
  | {
      shouldApprove: false;
    }
  | {
      shouldApprove: true;
      fromBlock: number;
      toBlock: number;
      chunkType: 'odd' | 'even';
      epochLen: number;
      commitment?: Hex;
    }
> {
  const epochLen = await epochLength();

  const latestCommit =  await getLatestCommitment()
  logger.log(`Latest commit: ${JSON.stringify(latestCommit)}`)

  if (latestCommit == null) {
    return { shouldApprove: false };
  }

  const latestDistributionBlock = Number(
    await contracts.rewardsDistribution.read.lastBlockRewarded(),
  );

  if (latestDistributionBlock >= Number(latestCommit.toBlock)) {
    logger.log(`Latest distribution block ${latestDistributionBlock} is not before the latest commit block ${latestCommit.toBlock}, no approve needed` )
    return { shouldApprove: false };
  }

  if (!latestCommit.fromBlock) {
    // FIXME can it even happen?
    logger.log(`latestCommit.fromBlock is undefined, no approve`)
    return { shouldApprove: false };
  }


  return {
    shouldApprove: true,
    ...latestCommit,
    epochLen,
    chunkType: getChunkType(latestCommit.toBlock, epochLen)
  };
}
