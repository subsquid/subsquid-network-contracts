import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TaskContext } from '../common';
import { ContractService } from '../blockchain/contract.service';
import { Web3Service } from '../blockchain/web3.service';

interface DistributionActivity {
  isActive: boolean;
  lastActivity?: Date;
  estimatedBatchesPerMinute?: number;
  currentBatch?: number;
  totalBatches?: number;
  blocksRange?: { fromBlock: number; toBlock: number };
}

@Injectable()
export class StatelessCoordinatorService {
  private readonly ACTIVITY_WINDOW_BLOCKS = 50; // check last 50 blocks
  private readonly ACTIVITY_TIMEOUT_SECONDS = 300; // 5 minutes
  private readonly RECOVERY_BLOCK_THRESHOLD = 100; // only start recovery if 100+ L1 blocks past last commitment (~20 minutes)

  constructor(
    private contractService: ContractService,
    private configService: ConfigService,
    private web3Service: Web3Service,
  ) {}

  /**
   * check if current bot is the eligible committer for this window
   */
  async isCurrentCommitter(botId?: string): Promise<{
    isCommitter: boolean;
    currentWindow: number;
    blocksLeft: number;
    reason?: string;
  }> {
    const ctx = new TaskContext('stateless-coordinator:committer-check');

    try {
      const currentBlock = await this.web3Service.getL1BlockNumber(ctx);
      const roundRobinWindow = this.configService.get(
        'rewards.roundRobinWindow',
        130,
      );

      const currentWindow = Math.floor(currentBlock / roundRobinWindow);
      const windowStart = currentWindow * roundRobinWindow;
      const windowEnd = windowStart + roundRobinWindow - 1;
      const blocksLeft = windowEnd - currentBlock;

      const botAddress = await this.getBotAddress();
      const isCommitter = await this.contractService.canCommit(botAddress);

      ctx.logger.info(
        `🎯 committer check - window: ${currentWindow} (${windowStart}-${windowEnd}), bot: ${botAddress}, isCommitter: ${isCommitter}`,
      );

      return {
        isCommitter,
        currentWindow,
        blocksLeft,
        reason: isCommitter ? 'eligible committer' : 'not current committer',
      };
    } catch (error) {
      ctx.logger.error({ error }, 'failed to check committer status');
      return {
        isCommitter: false,
        currentWindow: 0,
        blocksLeft: 0,
        reason: 'error checking committer status',
      };
    }
  }

  /**
   * Get bot address from private key
   */
  private async getBotAddress(): Promise<`0x${string}`> {
    const privateKey = this.configService.get(
      'blockchain.distributor.privateKey',
    ) as `0x${string}`;

    if (!privateKey) {
      throw new Error('Missing DISTRIBUTOR_PRIVATE_KEY environment variable');
    }

    const { privateKeyToAccount } = await import('viem/accounts');
    const account = privateKeyToAccount(privateKey);
    return account.address;
  }

  /**
   * check if bot is eligible to commit with safety buffer
   * prevents edge case where bot commits near window boundary
   */
  async checkCommitEligibility(botAddress?: string): Promise<{
    eligible: boolean;
    blocksLeft: number;
    windowInfo: {
      currentWindow: number;
      windowStart: number;
      windowEnd: number;
      nextWindowStart: number;
    };
    reason?: string;
  }> {
    const ctx = new TaskContext('stateless-coordinator:commit-eligibility');

    try {
      const currentBlock = await this.web3Service.getL1BlockNumber(ctx);
      const roundRobinWindow = this.configService.get(
        'rewards.roundRobinWindow',
        130,
      );
      const safetyBuffer = this.configService.get(
        'rewards.commitSafetyBuffer',
        3,
      );

      // calculate current window
      const currentWindow = Math.floor(currentBlock / roundRobinWindow);
      const windowStart = currentWindow * roundRobinWindow;
      const windowEnd = windowStart + roundRobinWindow - 1;
      const blocksLeft = windowEnd - currentBlock;
      const nextWindowStart = windowEnd + 1;

      ctx.logger.debug(
        `eligibility check - block: ${currentBlock}, window: ${windowStart}-${windowEnd}, blocks left: ${blocksLeft}`,
      );

      let isCommitter: boolean;

      if (botAddress) {
        isCommitter = await this.contractService.canCommit(
          botAddress as `0x${string}`,
        );
        ctx.logger.debug(
          `🔍 Checking commit eligibility for address: ${botAddress}, result: ${isCommitter}`,
        );
      } else {
        const committerCheck = await this.isCurrentCommitter();
        isCommitter = committerCheck.isCommitter;
      }

      if (!isCommitter) {
        return {
          eligible: false,
          blocksLeft,
          windowInfo: {
            currentWindow,
            windowStart,
            windowEnd,
            nextWindowStart,
          },
          reason: 'not the current committer for this window',
        };
      }

      ctx.logger.info(
        `✅ commit eligible - committer for window ${currentWindow}, ${blocksLeft} blocks left in window`,
      );

      return {
        eligible: true,
        blocksLeft,
        windowInfo: {
          currentWindow,
          windowStart,
          windowEnd,
          nextWindowStart,
        },
      };
    } catch (error) {
      ctx.logger.error(
        { error },
        'failed to check commit eligibility, defaulting to not eligible',
      );
      return {
        eligible: false,
        blocksLeft: 0,
        windowInfo: {
          currentWindow: 0,
          windowStart: 0,
          windowEnd: 0,
          nextWindowStart: 0,
        },
        reason: 'error checking eligibility',
      };
    }
  }

  /**
   * check for pending commitments that need approval (for non-committer bots)
   */
  async checkForPendingApprovals(): Promise<{
    hasApprovals: boolean;
    pendingCommitments: Array<{
      fromBlock: number;
      toBlock: number;
    }>;
  }> {
    const ctx = new TaskContext('stateless-coordinator:pending-approvals');

    try {
      const pendingCommitments =
        await this.contractService.getCommitmentsNeedingApproval();

      ctx.logger.debug(
        `found ${pendingCommitments.length} commitments needing approval from contract`,
      );

      if (pendingCommitments.length === 0) {
        return {
          hasApprovals: false,
          pendingCommitments: [],
        };
      }

      // get bot address for approval checking
      const botAddress = await this.getBotAddress();

      // filter out commitments already approved by this bot
      const notApprovedCommitments: Array<{
        fromBlock: number;
        toBlock: number;
      }> = [];

      for (const commitment of pendingCommitments) {
        try {
          const hasApproved = await this.contractService.hasApprovedCommitment(
            commitment.fromBlock,
            commitment.toBlock,
            botAddress,
          );

          if (hasApproved) {
            ctx.logger.debug(
              `✅ Bot ${botAddress} already approved commitment ${commitment.fromBlock}-${commitment.toBlock}`,
            );
          } else {
            ctx.logger.debug(
              `⏳ Bot ${botAddress} has not approved commitment ${commitment.fromBlock}-${commitment.toBlock}`,
            );
            notApprovedCommitments.push({
              fromBlock: commitment.fromBlock,
              toBlock: commitment.toBlock,
            });
          }
        } catch (error) {
          ctx.logger.warn(
            `⚠️ could not check approval status for ${commitment.fromBlock}-${commitment.toBlock}: ${error.message}, including in pending list`,
          );
          // if we can't check, include it to be safe
          notApprovedCommitments.push({
            fromBlock: commitment.fromBlock,
            toBlock: commitment.toBlock,
          });
        }
      }

      ctx.logger.debug(
        `filtered to ${notApprovedCommitments.length} commitments needing approval by this bot`,
      );

      if (notApprovedCommitments.length > 0) {
        ctx.logger.info(
          `📝 ${notApprovedCommitments.length} commitments need approval from this bot`,
        );
        for (const commitment of notApprovedCommitments) {
          ctx.logger.info(`   - ${commitment.fromBlock}-${commitment.toBlock}`);
        }
      }

      return {
        hasApprovals: notApprovedCommitments.length > 0,
        pendingCommitments: notApprovedCommitments,
      };
    } catch (error) {
      ctx.logger.error({ error }, 'failed to check pending approvals');
      return {
        hasApprovals: false,
        pendingCommitments: [],
      };
    }
  }

  /**
   * check if we're far enough past the last APPROVED commitment to start recovery
   * only activate recovery if 100+ blocks have passed since last approved but incomplete commitment
   */
  async shouldActivateRecovery(): Promise<{
    shouldActivate: boolean;
    blocksSinceCommitment?: number;
    lastCommitmentBlock?: number;
    currentBlock?: number;
    stuckCommitments?: Array<{ fromBlock: number; toBlock: number }>;
  }> {
    const ctx = new TaskContext('stateless-coordinator:recovery-check');

    try {
      // get pending (approved but incomplete) commitments
      const pendingCommitments =
        await this.contractService.getPendingCommitments();

      if (pendingCommitments.length === 0) {
        ctx.logger.debug(
          'no pending approved commitments found, recovery not needed',
        );
        return { shouldActivate: false };
      }

      const currentL1Block = await this.web3Service.getL1BlockNumber(ctx);

      const stuckCommitments: Array<{ fromBlock: number; toBlock: number }> =
        [];
      let maxBlocksSince = 0;
      let oldestCommitmentBlock = 0;

      for (const commitment of pendingCommitments) {
        const blocksSinceCommitment = currentL1Block - commitment.toBlock;

        ctx.logger.debug(
          `approved commitment ${commitment.fromBlock}-${commitment.toBlock}: ${blocksSinceCommitment} L1 blocks old (${commitment.processedBatches}/${commitment.totalBatches} batches)`,
        );

        if (blocksSinceCommitment >= this.RECOVERY_BLOCK_THRESHOLD) {
          stuckCommitments.push({
            fromBlock: commitment.fromBlock,
            toBlock: commitment.toBlock,
          });

          if (blocksSinceCommitment > maxBlocksSince) {
            maxBlocksSince = blocksSinceCommitment;
            oldestCommitmentBlock = commitment.toBlock;
          }
        }
      }

      const shouldActivate = stuckCommitments.length > 0;

      if (shouldActivate) {
        ctx.logger.info(
          `🔍 recovery threshold reached: ${stuckCommitments.length} stuck approved commitments found`,
        );
        ctx.logger.info(
          `   oldest: ${maxBlocksSince} L1 blocks since completion`,
        );
      } else {
        ctx.logger.debug(
          `⏳ no stuck commitments - all approved commitments are < ${this.RECOVERY_BLOCK_THRESHOLD} L1 blocks old`,
        );
      }

      return {
        shouldActivate,
        blocksSinceCommitment: maxBlocksSince,
        lastCommitmentBlock: oldestCommitmentBlock,
        currentBlock: currentL1Block,
        stuckCommitments,
      };
    } catch (error) {
      ctx.logger.error(
        { error },
        'failed to check recovery activation, defaulting to false',
      );
      return { shouldActivate: false };
    }
  }

  /**
   * detect if another bot is currently distributing by analyzing on-chain activity
   */
  async isAnotherBotDistributing(
    fromBlock: number,
    toBlock: number,
  ): Promise<DistributionActivity> {
    const ctx = new TaskContext(
      `stateless-coordinator:activity-check:${fromBlock}-${toBlock}`,
    );

    try {
      const recentEvents =
        await this.contractService.getRecentDistributionEvents(
          this.ACTIVITY_WINDOW_BLOCKS,
        );

      const commitmentEvents = recentEvents.filter(
        (event) => event.fromBlock === fromBlock && event.toBlock === toBlock,
      );

      if (commitmentEvents.length === 0) {
        ctx.logger.debug('no recent distribution activity found');
        return { isActive: false };
      }

      // analyze the timing and pattern of recent distributions
      const activity = this.analyzeDistributionPattern(commitmentEvents);

      if (activity.isActive) {
        ctx.logger.info(
          `🚫 another bot is actively distributing blocks ${fromBlock}-${toBlock}`,
        );
        ctx.logger.info(`   last activity: ${activity.lastActivity}`);
        ctx.logger.info(
          `   estimated rate: ${activity.estimatedBatchesPerMinute} batches/min`,
        );
      } else {
        ctx.logger.debug('distribution activity detected but appears stale');
      }

      return activity;
    } catch (error) {
      ctx.logger.error(
        { error },
        'failed to check distribution activity, assuming no activity',
      );
      return { isActive: false };
    }
  }

  /**
   * check if current bot should start distributing (not already being done by another bot)
   */
  async shouldStartDistribution(
    fromBlock: number,
    toBlock: number,
  ): Promise<boolean> {
    const activity = await this.isAnotherBotDistributing(fromBlock, toBlock);
    return !activity.isActive;
  }

  /**
   * analyze pattern of distribution events to determine if another bot is active
   */
  private analyzeDistributionPattern(events: any[]): DistributionActivity {
    if (events.length === 0) {
      return { isActive: false };
    }

    // sort events by timestamp (most recent first)
    const sortedEvents = events.sort(
      (a, b) => b.blockTimestamp - a.blockTimestamp,
    );

    const latestEvent = sortedEvents[0];
    const now = Date.now();
    const lastActivityTime = new Date(latestEvent.blockTimestamp * 1000);
    const timeSinceLastActivity = (now - lastActivityTime.getTime()) / 1000;

    // if last activity was too long ago, consider inactive
    if (timeSinceLastActivity > this.ACTIVITY_TIMEOUT_SECONDS) {
      return {
        isActive: false,
        lastActivity: lastActivityTime,
      };
    }

    // calculate distribution rate if we have multiple events
    let estimatedBatchesPerMinute: number | undefined;
    if (sortedEvents.length >= 2) {
      const timeSpan =
        (sortedEvents[0].blockTimestamp -
          sortedEvents[sortedEvents.length - 1].blockTimestamp) /
        60; // minutes
      estimatedBatchesPerMinute = sortedEvents.length / timeSpan;
    }

    // check if events show consistent progression (indicating active distribution)
    const isProgressing = this.isDistributionProgressing(sortedEvents);

    return {
      isActive:
        isProgressing && timeSinceLastActivity < this.ACTIVITY_TIMEOUT_SECONDS,
      lastActivity: lastActivityTime,
      estimatedBatchesPerMinute,
      currentBatch: latestEvent.batchIndex,
      totalBatches: latestEvent.totalBatches,
      blocksRange: {
        fromBlock: latestEvent.fromBlock,
        toBlock: latestEvent.toBlock,
      },
    };
  }

  /**
   * determine if distribution events show progression (not just repeated failures)
   */
  private isDistributionProgressing(events: any[]): boolean {
    if (events.length < 2) return true;

    // check if batch numbers are incrementing over time
    const batchProgression = events.map((e) => e.batchIndex || 0);

    // if we see increasing batch numbers, it's progressing
    for (let i = 0; i < batchProgression.length - 1; i++) {
      if (batchProgression[i] > batchProgression[i + 1]) {
        return true; // found progression
      }
    }

    // if all events are the same batch, might be stuck/retrying
    const uniqueBatches = new Set(batchProgression);
    if (uniqueBatches.size === 1) {
      // same batch being retried - could be active but stuck
      // consider recent activity as "active" to avoid interference
      return events.length <= 3; // allow few retries before considering stuck
    }

    return true; // default to active to be conservative
  }

  /**
   * check if we should skip recovery altogether
   * recovery only activates if there are stuck approved commitments (100+ blocks old) AND no other bot is active
   */
  async shouldSkipRecovery(): Promise<boolean> {
    const ctx = new TaskContext('stateless-coordinator:skip-recovery-check');

    try {
      // FIRST: Check if there are any stuck approved commitments that need recovery
      const recoveryCheck = await this.shouldActivateRecovery();

      if (!recoveryCheck.shouldActivate) {
        ctx.logger.debug(
          `⏳ recovery not needed - no stuck approved commitments found`,
        );
        return true; // skip recovery - no stuck commitments
      }

      ctx.logger.info(
        `🔍 recovery needed for ${recoveryCheck.stuckCommitments?.length} stuck commitments, checking for active distributions...`,
      );

      // SECOND: Check if another bot is actively distributing any of the stuck commitments
      for (const stuckCommitment of recoveryCheck.stuckCommitments || []) {
        const activity = await this.isAnotherBotDistributing(
          stuckCommitment.fromBlock,
          stuckCommitment.toBlock,
        );

        if (activity.isActive) {
          ctx.logger.info(
            `🚫 skipping recovery - another bot is handling stuck commitment ${stuckCommitment.fromBlock}-${stuckCommitment.toBlock}`,
          );
          return true;
        }
      }

      ctx.logger.info(
        '✅ recovery conditions met - proceeding with recovery/distribution',
      );
      return false; // don't skip recovery - we should proceed
    } catch (error) {
      ctx.logger.error(
        { error },
        'failed to check if should skip recovery, proceeding with recovery',
      );
      return false; // default to allowing recovery
    }
  }
}
