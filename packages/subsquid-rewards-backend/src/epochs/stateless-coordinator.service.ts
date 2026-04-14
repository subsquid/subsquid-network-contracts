import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TaskContext } from '../common';
import { ContractService } from '../blockchain/contract.service';

@Injectable()
export class StatelessCoordinatorService {
  private readonly ACTIVITY_WINDOW_BLOCKS = 50;
  private readonly ACTIVITY_TIMEOUT_SECONDS = 300; // 5 minutes
  private readonly RECOVERY_BLOCK_THRESHOLD = 100; // ~20 minutes of L1 blocks

  constructor(
    private contractService: ContractService,
    private configService: ConfigService,
  ) {}

  /**
   * Check if current bot is the eligible committer for this window.
   * Calls the contract's canCommit() with round-robin window tracking.
   */
  async isCurrentCommitter(): Promise<{
    isCommitter: boolean;
    currentWindow: number;
    blocksLeft: number;
    reason?: string;
  }> {
    const ctx = new TaskContext('stateless-coordinator:committer-check');

    try {
      const currentBlock = await this.contractService.getL1BlockNumber(ctx);
      const roundRobinWindow = this.configService.get(
        'rewards.roundRobinWindow',
        130,
      );

      const currentWindow = Math.floor(currentBlock / roundRobinWindow);
      const windowEnd = (currentWindow + 1) * roundRobinWindow - 1;
      const blocksLeft = windowEnd - currentBlock;

      const botAddress = await this.getBotAddress();
      const isCommitter = await this.contractService.canCommit(botAddress);

      ctx.logger.debug(
        `Committer check: window=${currentWindow}, isCommitter=${isCommitter}, blocksLeft=${blocksLeft}`,
      );

      return {
        isCommitter,
        currentWindow,
        blocksLeft,
        reason: isCommitter ? 'eligible committer' : 'not current committer',
      };
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to check committer status');
      return {
        isCommitter: false,
        currentWindow: 0,
        blocksLeft: 0,
        reason: 'error checking committer status',
      };
    }
  }

  /**
   * Check commit eligibility with safety buffer to prevent
   * commits near window boundaries.
   */
  async checkCommitEligibility(): Promise<{
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
      const currentBlock = await this.contractService.getL1BlockNumber(ctx);
      const roundRobinWindow = this.configService.get(
        'rewards.roundRobinWindow',
        130,
      );

      const currentWindow = Math.floor(currentBlock / roundRobinWindow);
      const windowStart = currentWindow * roundRobinWindow;
      const windowEnd = windowStart + roundRobinWindow - 1;
      const blocksLeft = windowEnd - currentBlock;
      const nextWindowStart = windowEnd + 1;

      const committerCheck = await this.isCurrentCommitter();

      if (!committerCheck.isCommitter) {
        return {
          eligible: false,
          blocksLeft,
          windowInfo: { currentWindow, windowStart, windowEnd, nextWindowStart },
          reason: 'not the current committer for this window',
        };
      }

      return {
        eligible: true,
        blocksLeft,
        windowInfo: { currentWindow, windowStart, windowEnd, nextWindowStart },
      };
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to check commit eligibility');
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
   * Check for pending commitments that need approval (for non-committer bots).
   */
  async checkForPendingApprovals(): Promise<{
    hasApprovals: boolean;
    pendingCommitments: Array<{ fromBlock: number; toBlock: number }>;
  }> {
    const ctx = new TaskContext('stateless-coordinator:pending-approvals');

    try {
      const pendingCommitments =
        await this.contractService.getCommitmentsNeedingApproval();

      if (pendingCommitments.length === 0) {
        return { hasApprovals: false, pendingCommitments: [] };
      }

      const botAddress = await this.getBotAddress();
      const notApproved: Array<{ fromBlock: number; toBlock: number }> = [];

      for (const commitment of pendingCommitments) {
        try {
          const hasApproved = await this.contractService.hasApprovedCommitment(
            commitment.fromBlock,
            commitment.toBlock,
            botAddress,
          );
          if (!hasApproved) {
            notApproved.push({
              fromBlock: commitment.fromBlock,
              toBlock: commitment.toBlock,
            });
          }
        } catch (error) {
          // If we can't check, include it to be safe
          notApproved.push({
            fromBlock: commitment.fromBlock,
            toBlock: commitment.toBlock,
          });
        }
      }

      if (notApproved.length > 0) {
        ctx.logger.debug(
          `${notApproved.length} commitments need approval from this bot`,
        );
      }

      return {
        hasApprovals: notApproved.length > 0,
        pendingCommitments: notApproved,
      };
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to check pending approvals');
      return { hasApprovals: false, pendingCommitments: [] };
    }
  }

  /**
   * Detect stuck commitments that are 100+ L1 blocks old (approved but incomplete).
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
      const pendingCommitments =
        await this.contractService.getPendingCommitments();

      if (pendingCommitments.length === 0) {
        return { shouldActivate: false };
      }

      const currentL1Block = await this.contractService.getL1BlockNumber(ctx);
      const stuckCommitments: Array<{ fromBlock: number; toBlock: number }> = [];
      let maxBlocksSince = 0;
      let oldestCommitmentBlock = 0;

      for (const commitment of pendingCommitments) {
        const blocksSince = currentL1Block - commitment.toBlock;
        if (blocksSince >= this.RECOVERY_BLOCK_THRESHOLD) {
          stuckCommitments.push({
            fromBlock: commitment.fromBlock,
            toBlock: commitment.toBlock,
          });
          if (blocksSince > maxBlocksSince) {
            maxBlocksSince = blocksSince;
            oldestCommitmentBlock = commitment.toBlock;
          }
        }
      }

      if (stuckCommitments.length > 0) {
        ctx.logger.debug(
          `Recovery: ${stuckCommitments.length} stuck commitments, oldest ${maxBlocksSince} blocks`,
        );
      }

      return {
        shouldActivate: stuckCommitments.length > 0,
        blocksSinceCommitment: maxBlocksSince,
        lastCommitmentBlock: oldestCommitmentBlock,
        currentBlock: currentL1Block,
        stuckCommitments,
      };
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to check recovery activation');
      return { shouldActivate: false };
    }
  }

  /**
   * Check if another bot is currently distributing by analyzing on-chain events.
   */
  async isAnotherBotDistributing(
    fromBlock: number,
    toBlock: number,
  ): Promise<{ isActive: boolean }> {
    const ctx = new TaskContext('stateless-coordinator:activity-check');

    try {
      const recentEvents =
        await this.contractService.getRecentDistributionEvents(
          this.ACTIVITY_WINDOW_BLOCKS,
        );

      const commitmentEvents = recentEvents.filter(
        (event) => event.fromBlock === fromBlock && event.toBlock === toBlock,
      );

      if (commitmentEvents.length === 0) {
        return { isActive: false };
      }

      // Check if most recent activity is within timeout window
      const sortedEvents = commitmentEvents.sort(
        (a, b) => b.blockTimestamp - a.blockTimestamp,
      );
      const latestEvent = sortedEvents[0];
      const timeSinceLastActivity =
        (Date.now() - latestEvent.blockTimestamp * 1000) / 1000;

      const isActive = timeSinceLastActivity < this.ACTIVITY_TIMEOUT_SECONDS;

      if (isActive) {
        ctx.logger.debug(
          `Another bot is actively distributing blocks ${fromBlock}-${toBlock}`,
        );
      }

      return { isActive };
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to check distribution activity');
      return { isActive: false };
    }
  }

  /**
   * Check if current bot should start distributing (not already being done by another bot).
   */
  async shouldStartDistribution(
    fromBlock: number,
    toBlock: number,
  ): Promise<boolean> {
    const activity = await this.isAnotherBotDistributing(fromBlock, toBlock);
    return !activity.isActive;
  }

  /**
   * Combines recovery detection + activity detection.
   * Returns true if recovery should be SKIPPED.
   */
  async shouldSkipRecovery(): Promise<boolean> {
    const ctx = new TaskContext('stateless-coordinator:skip-recovery-check');

    try {
      const recoveryCheck = await this.shouldActivateRecovery();

      if (!recoveryCheck.shouldActivate) {
        ctx.logger.debug('Recovery not needed - no stuck commitments');
        return true;
      }

      // Check if another bot is handling the stuck commitments
      for (const stuckCommitment of recoveryCheck.stuckCommitments || []) {
        const activity = await this.isAnotherBotDistributing(
          stuckCommitment.fromBlock,
          stuckCommitment.toBlock,
        );

        if (activity.isActive) {
          ctx.logger.debug(
            `Skipping recovery - another bot is handling ${stuckCommitment.fromBlock}-${stuckCommitment.toBlock}`,
          );
          return true;
        }
      }

      ctx.logger.debug('Recovery conditions met - proceeding');
      return false;
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to check skip-recovery, allowing recovery');
      return false;
    }
  }

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
}
