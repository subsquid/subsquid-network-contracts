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

export class RewardWorker {
  constructor(private walletClient: WalletClient) {}
  public startWorker() {
    this.commitIfPossible();
    this.watchCommits();
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
    setTimeout(() => this.commitIfPossible(), 300 * 1000);
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

  private async watchCommits() {
    try {
      const t = (
        await publicClient.getLogs({
          address: addresses.rewardsDistribution,
          event: parseAbiItem(
            `event NewCommitment(address indexed who,uint256 fromBlock,uint256 toBlock,uint256[] recipients,uint256[] workerRewards,uint256[] stakerRewards)`,
          ),
          fromBlock: 1n,
        })
      ).map(({ args }) => args);
      if (t.length > 0) {
        const latestCommit = t.sort(
          ({ toBlock: a }, { toBlock: b }) => Number(b) - Number(a),
        )[0];
        const latestDistributionBlock = Number(
          await contracts.rewardsDistribution.read.lastBlockRewarded(),
        );
        if (latestDistributionBlock < Number(latestCommit.toBlock)) {
          if (!latestCommit.fromBlock) return;
          const rewards = await epochStats(
            await getBlockTimestamp(Number(latestCommit.fromBlock)),
            await getBlockTimestamp(Number(latestCommit.toBlock)),
          );
          await approveRewards(
            Number(latestCommit.fromBlock),
            Number(latestCommit.toBlock),
            rewards,
            this.walletClient,
          );
        }
      }
    } catch (e) {
      logger.error(e);
    }
    setTimeout(() => this.watchCommits(), 300 * 1000);
  }
}
