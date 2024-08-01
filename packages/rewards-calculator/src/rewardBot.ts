import {
  approveRewards,
  canCommit,
  commitRewards,
  epochLength,
  getBlockNumber,
  getLastRewardedBlock,
  getRegistrations,
  isCommitted,
  Registrations,
} from './chain';
import { epochStats } from './reward';
import { addresses, config, contracts, publicClient } from './config';
import { Hex, parseAbiItem } from 'viem';
import ms from 'ms';
import type { Workers } from './workers';
import { Context } from './logger';
import { decimalSum } from './utils';


async function firstRegistrationBlock(registrations: Registrations) {
  return Math.min(
    ...registrations.map(({registeredAt}) => Number(registeredAt)),
  );
}

export class RewardBot {

  constructor(
    private address: Hex,
    private index: number,
  ) {


  }

  startBot() {
    const ctx = new Context({
      address: this.address,
    });

    void this.commitIfPossible(ctx.child({
      operation: 'commit_rewards'
    }));
    void this.approveIfNecessary(ctx.child({
      operation: 'approve_rewards'
    }));
  }

  private async commitIfPossible(baseCtx: Context) {
    try {
      const {fromBlock, toBlock, epochReadyToCommit, lastConfirmedBlock, lastRewardedBlock} = await this.commitRange();

      const ctx = baseCtx.child({
        from_block: fromBlock,
        to_block: toBlock,
        operation: 'commit_rewards'
      });

      if (epochReadyToCommit && await this.canCommit(fromBlock, toBlock)) {
        ctx.logger.info(`can commit ${fromBlock}—${toBlock}, last confirmed ${lastConfirmedBlock}, last reward block ${lastRewardedBlock}`);

        const workers = await epochStats(ctx, fromBlock, toBlock);
        await this.tryToCommit(ctx, fromBlock, toBlock, workers);
      } else {
        ctx.logger.debug(`nothing to commit ${fromBlock} — ${toBlock}, last confirmed ${lastConfirmedBlock}, last reward block ${lastRewardedBlock}`);
      }
    } catch (e) {
      baseCtx.logger.error({
        message: `error while trying to commit rewards`,
        error: e,
      });
    }

    baseCtx.logger.debug(`sleep for ${ms(config.workTimeout)}...`)
    setTimeout(() => this.commitIfPossible(baseCtx), config.workTimeout);
  }

  private async canCommit(fromBlock: number, toBlock: number) {
    if (fromBlock >= toBlock) return false;

    const addressIsAllowedToCommit = await canCommit(this.address);
    if (!addressIsAllowedToCommit) return false;

    const isAlreadyCommited = await isCommitted(fromBlock, toBlock);
    return !isAlreadyCommited;
  }

  private async tryToCommit(
    ctx: Context,
    fromBlock: number,
    toBlock: number,
    workers: Workers,
  ) {
    try {
      ctx.logger.debug(`commiting rewards...`)

      const tx = await commitRewards(
        ctx,
        fromBlock,
        toBlock,
        workers,
        this.address,
        this.index,
      );

      if (!tx) {
        ctx.logger.debug(`commit was unsuccessful, tx hash is missing`)
        return;
      }

      ctx.logger.info(
        {
          message: 'rewards commited successfully',
          time: new Date(),
          type: 'rewards_commited',
          bot_wallet: this.address,
          tx_hash: tx,
          from_block: fromBlock,
          to_block: toBlock,
          totalStake: decimalSum(
            workers.map(({totalStake}) => totalStake),
          ).toFixed(),
          capedStake: decimalSum(workers.map(({stake}) => stake)).toFixed(),
        }
      );
    } catch (e: any) {
      if (e.message?.includes('Already approved')) {
        ctx.logger.debug({
          message: `failed to commit due to it's been already approved`
        });
        return;
      }

      if (e.message?.toLowerCase().includes('not all blocks covered')) {
        ctx.logger.debug({
          message: `failed to commit due to ${e.message}`
        });
        return;
      }

      ctx.logger.error({
        message: 'failed to commit rewards',
        err: e
      });
    }
  }

  private async approveIfNecessary(baseCtx: Context) {
    try {
      const ranges = await approveRanges(baseCtx);

      if (ranges.shouldApprove) {
        const ctx = baseCtx.child({
          from_block: ranges.fromBlock,
          to_block: ranges.toBlock,
        })

        const workers = await epochStats(ctx, ranges.fromBlock, ranges.toBlock);
        const tx = await approveRewards(
          ctx,
          ranges.fromBlock,
          ranges.toBlock,
          workers,
          this.address,
          this.index,
          ranges.commitment,
        );

        if (!tx) {
          ctx.logger.debug(`approve was unsuccessful, tx hash is missing`)
        }
        else {
          ctx.logger.info(
            {
              time: new Date(),
              type: 'rewards_approved',
              bot_wallet: this.address,
              tx_hash: tx,
              from_block: ranges.fromBlock,
              to_block: ranges.toBlock,
            }
          );
        }
      }
    } catch (e) {
      baseCtx.logger.error({
        message: 'failed to approve rewards',
        err: e
      });
    }

    baseCtx.logger.debug(`sleep for ${ms(config.workTimeout)}...`)
    setTimeout(() => this.approveIfNecessary(baseCtx), config.workTimeout);
  }

  private async commitRange() {
    const epochLen = await epochLength();
    const maxCommitBlocksCovered = epochLen * config.maxEpochsPerCommit;

    let lastRewardedBlock = await getLastRewardedBlock();
    if (lastRewardedBlock === 0) {
      lastRewardedBlock = await firstRegistrationBlock(
        await getRegistrations(),
      );
    }

    const currentBlock = await getBlockNumber();
    const lastConfirmedBlock = currentBlock - config.epochConfirmationBlocks;
    const fromBlock = lastRewardedBlock + 1;
    const toBlock = Math.min(
      lastRewardedBlock + maxCommitBlocksCovered,
      lastConfirmedBlock,
    );

    /**
     * If the last confirmed block is less than the last rewarded block + epoch length,
     * then we can't commit the epoch yet.
     */
    if (lastConfirmedBlock - lastRewardedBlock < epochLen) {
      return {epochReadyToCommit: false, fromBlock, toBlock, lastConfirmedBlock, lastRewardedBlock};
    }

    return {epochReadyToCommit: true, fromBlock, toBlock, lastConfirmedBlock, lastRewardedBlock};
  }
}

async function approveRanges(ctx: Context): Promise<
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
  ).map(({args: {fromBlock, toBlock, commitment}, blockNumber}) => ({
    fromBlock: Number(fromBlock),
    toBlock: Number(toBlock),
    blockNumber: Number(blockNumber),
    commitment,
  }));

  if (commitmentBlocks.length === 0) {
    ctx.logger.debug(`no commitments found`)
    return { shouldApprove: false };
  }

  const latestCommit = commitmentBlocks.sort(
    ({blockNumber: a}, {blockNumber: b}) => Number(b) - Number(a),
  )[0];
  const latestDistributionBlock = Number(
    await contracts.rewardsDistribution.read.lastBlockRewarded(),
  );

  if (latestDistributionBlock >= Number(latestCommit.toBlock)) {
    ctx.logger.debug({
      message: `latest distribution block ${latestDistributionBlock} >= the latest commit ${latestCommit.toBlock}`
    })
    return {shouldApprove: false};
  }

  if (!latestCommit.fromBlock) {
    return {shouldApprove: false};
  }

  return {
    shouldApprove: true,
    ...latestCommit,
  };
}
