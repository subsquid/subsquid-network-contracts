import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { ContractService } from '../blockchain/contract.service';
import { EpochProcessorService } from './epoch-processor.service';
import { StatelessCoordinatorService } from './stateless-coordinator.service';
import { TaskContext } from '../common';

@Injectable()
export class BlockSchedulerService implements OnModuleInit {
  private isApprovalProcessing = false;
  private isDistributionProcessing = false;
  // Serialize the actual distribution execution across normal and recovery
  // cron paths. The cron checks themselves may run independently, but only
  // one call into `processDistribution*()` may be active at a time.
  private isDistributionExecutionProcessing = false;
  // RWD-H-009: recovery gets its own lock so a long-running distribution
  // cycle cannot perpetually starve the recovery cron. Previously both
  // distribution and recovery shared `isDistributionProcessing`; on busy
  // deployments the */17 recovery tick could repeatedly skip when it
  // happened to align with an in-flight */5 distribution.
  private isRecoveryProcessing = false;
  private readonly enableAutoDistribution: boolean;
  private readonly isPrimaryScheduler: boolean;
  private readonly schedulerIdentity: string;

  constructor(
    private configService: ConfigService,
    private contractService: ContractService,
    private epochProcessor: EpochProcessorService,
    private statelessCoordinator: StatelessCoordinatorService,
  ) {
    const rawFlag = this.configService.get('rewards.enableAutoDistribution');
    this.enableAutoDistribution =
      rawFlag === true ||
      (typeof rawFlag === 'string' &&
        ['true', '1', 'yes', 'on'].includes(rawFlag.toLowerCase()));
    this.schedulerIdentity =
      process.env.HOSTNAME || process.env.BOT_NAME || 'local';
    this.isPrimaryScheduler = this.resolvePrimaryScheduler();
  }

  async onModuleInit() {
    const ctx = new TaskContext('block-scheduler:init');
    if (this.enableAutoDistribution) {
      if (this.isPrimaryScheduler) {
        ctx.logger.info(
          {
            schedulerIdentity: this.schedulerIdentity,
          },
          'Auto distribution enabled on primary scheduler instance',
        );
      } else {
        ctx.logger.warn(
          {
            schedulerIdentity: this.schedulerIdentity,
          },
          'Auto distribution is enabled, but this replica is follower-only and will skip cron work',
        );
      }
    } else {
      ctx.logger.info('Auto distribution disabled');
    }
  }

  @Cron(process.env.APPROVAL_CRON_SCHEDULE || '*/2 * * * *')
  async checkApprovalInterval() {
    if (
      !this.enableAutoDistribution ||
      !this.isPrimaryScheduler ||
      this.isApprovalProcessing
    ) {
      return;
    }
    this.isApprovalProcessing = true;
    try {
      const ctx = new TaskContext('block-scheduler:approval');
      ctx.logger.debug('Checking for commitments that need approval');
      await this.epochProcessor.processExistingApprovals();
    } catch (error) {
      new TaskContext('block-scheduler:approval').logger.error(
        { error },
        'Approval interval check failed, will retry next cycle',
      );
    } finally {
      this.isApprovalProcessing = false;
    }
  }

  @Cron(process.env.DISTRIBUTION_CRON_SCHEDULE || '*/5 * * * *')
  async checkDistributionInterval() {
    if (
      !this.enableAutoDistribution ||
      !this.isPrimaryScheduler ||
      this.isDistributionProcessing
    ) {
      return;
    }
    this.isDistributionProcessing = true;
    try {
      const ctx = new TaskContext('block-scheduler:distribution');

      const distributionCheck =
        await this.contractService.isNextDistributionReady(ctx);
      if (distributionCheck.blocksUntilReady > 0) {
        ctx.logger.debug(
          `Next distribution in ${distributionCheck.blocksUntilReady} blocks`,
        );
        return;
      }

      if (distributionCheck.needsConfirmation) {
        ctx.logger.debug(
          `Waiting ${distributionCheck.confirmationBlocksNeeded} more blocks for ${distributionCheck.nextFromBlock}-${distributionCheck.nextToBlock} to have 150 confirmations`,
        );
        return;
      }

      const committerCheck =
        await this.statelessCoordinator.isCurrentCommitter();

      if (!committerCheck.isCommitter) {
        ctx.logger.debug('Not current committer - skipping distribution check');
        return;
      }

      ctx.logger.debug('Current committer - checking commitment and approval status');

      const commitmentStatus =
        await this.epochProcessor.checkCommitmentStatus();

      if (!commitmentStatus.exists) {
        ctx.logger.debug('No commitment exists - creating new commit');
        await this.epochProcessor.processNewCommitment();
      } else {
        const required = commitmentStatus.requiredApprovals;
        const current = commitmentStatus.currentApprovals;

        if (current >= required) {
          ctx.logger.debug(
            `Enough approvals (${current}/${required}) - starting distribution`,
          );
          await this.runExclusiveDistributionExecution(
            'block-scheduler:distribution',
            () => this.epochProcessor.processDistribution(),
          );
        } else {
          ctx.logger.debug(
            `Waiting for approvals: ${current}/${required}`,
          );
        }
      }
    } catch (error) {
      new TaskContext('block-scheduler:distribution').logger.error(
        { error },
        'Distribution interval check failed, will retry next cycle',
      );
    } finally {
      this.isDistributionProcessing = false;
    }
  }

  @Cron(process.env.RECOVERY_CRON_SCHEDULE || '*/17 * * * *')
  async checkRecoveryInterval() {
    // RWD-H-009: recovery has its own lock (`isRecoveryProcessing`) so it is
    // not starved by an in-flight distribution cycle. It still skips if
    // another recovery cycle is already running.
    if (
      !this.enableAutoDistribution ||
      !this.isPrimaryScheduler ||
      this.isRecoveryProcessing
    ) {
      return;
    }
    this.isRecoveryProcessing = true;
    try {
      const ctx = new TaskContext('block-scheduler:recovery');

      const shouldSkipRecovery =
        await this.statelessCoordinator.shouldSkipRecovery();
      if (shouldSkipRecovery) {
        ctx.logger.debug('Skipping recovery - conditions not met or another bot is active');
        return;
      }

      ctx.logger.debug('Recovery conditions met - attempting recovery distribution');
      await this.runExclusiveDistributionExecution(
        'block-scheduler:recovery',
        () => this.epochProcessor.processDistribution(),
      );
    } catch (error) {
      new TaskContext('block-scheduler:recovery').logger.error(
        { error },
        'Recovery interval check failed, will retry next cycle',
      );
    } finally {
      this.isRecoveryProcessing = false;
    }
  }

  async triggerManualApprovalCheck(): Promise<boolean> {
    try {
      await this.checkApprovalInterval();
      return true;
    } catch (error) {
      new TaskContext('block-scheduler:manual-approval').logger.error(
        { error },
        'Manual approval check failed',
      );
      return false;
    }
  }

  async triggerManualDistributionCheck(): Promise<boolean> {
    try {
      await this.checkDistributionInterval();
      return true;
    } catch (error) {
      new TaskContext('block-scheduler:manual-distribution').logger.error(
        { error },
        'Manual distribution check failed',
      );
      return false;
    }
  }

  async triggerManualRecoveryCheck(): Promise<boolean> {
    try {
      await this.checkRecoveryInterval();
      return true;
    } catch (error) {
      new TaskContext('block-scheduler:manual-recovery').logger.error(
        { error },
        'Manual recovery check failed',
      );
      return false;
    }
  }

  /**
   * RWD-H-005: validate the supplied range against the next schedulable
   * epoch before acting. Previously this method logged the range and then
   * silently triggered the next-scheduled epoch — an operator trap during
   * incident response, because the HTTP response would imply the supplied
   * range was used. Refuse with a descriptive error if the request does
   * not match what the scheduler would actually do.
   */
  private async assertRangeMatchesNextSchedulable(
    fromBlock: number,
    toBlock: number,
    ctxLabel: string,
  ): Promise<{ ok: boolean; nextFromBlock: number; nextToBlock: number }> {
    const ctx = new TaskContext(ctxLabel);
    const status = await this.contractService.getDistributionStatus(ctx);
    if (
      status.nextFromBlock !== fromBlock ||
      status.nextToBlock !== toBlock
    ) {
      ctx.logger.error(
        {
          requested: { fromBlock, toBlock },
          nextSchedulable: {
            fromBlock: status.nextFromBlock,
            toBlock: status.nextToBlock,
          },
        },
        'RWD-H-005: refused — supplied range does not match the next schedulable epoch. Retry with the exact range the scheduler would act on next.',
      );
      return {
        ok: false,
        nextFromBlock: status.nextFromBlock,
        nextToBlock: status.nextToBlock,
      };
    }
    return {
      ok: true,
      nextFromBlock: status.nextFromBlock,
      nextToBlock: status.nextToBlock,
    };
  }

  async forceCommit(fromBlock: number, toBlock: number): Promise<boolean> {
    try {
      const guard = await this.assertRangeMatchesNextSchedulable(
        fromBlock,
        toBlock,
        'block-scheduler:force-commit',
      );
      if (!guard.ok) return false;
      return await this.epochProcessor.processApprovalForRange(
        fromBlock,
        toBlock,
      );
    } catch (error) {
      new TaskContext('block-scheduler:force-commit').logger.error(
        { error, fromBlock, toBlock },
        'Force commit failed',
      );
      return false;
    }
  }

  async forceDistribution(
    fromBlock: number,
    toBlock: number,
  ): Promise<boolean> {
    try {
      const guard = await this.assertRangeMatchesNextSchedulable(
        fromBlock,
        toBlock,
        'block-scheduler:force-distribution',
      );
      if (!guard.ok) return false;
      return await this.runExclusiveDistributionExecution(
        'block-scheduler:force-distribution',
        () =>
          this.epochProcessor.processDistributionForRange(
            fromBlock,
            toBlock,
          ),
      );
    } catch (error) {
      new TaskContext('block-scheduler:force-distribution').logger.error(
        { error, fromBlock, toBlock },
        'Force distribution failed',
      );
      return false;
    }
  }

  getStatus() {
    return {
      enabled: this.enableAutoDistribution,
      isPrimaryScheduler: this.isPrimaryScheduler,
      schedulerIdentity: this.schedulerIdentity,
      isApprovalProcessing: this.isApprovalProcessing,
      isDistributionProcessing: this.isDistributionProcessing,
      isDistributionExecutionProcessing: this.isDistributionExecutionProcessing,
      isRecoveryProcessing: this.isRecoveryProcessing,
    };
  }

  private async runExclusiveDistributionExecution<T>(
    ctxLabel: string,
    fn: () => Promise<T>,
  ): Promise<T | false> {
    if (this.isDistributionExecutionProcessing) {
      new TaskContext(ctxLabel).logger.debug(
        'Skipping distribution execution - another distribution is already in flight',
      );
      return false;
    }

    this.isDistributionExecutionProcessing = true;
    try {
      return await fn();
    } finally {
      this.isDistributionExecutionProcessing = false;
    }
  }

  private resolvePrimaryScheduler(): boolean {
    const override = process.env.SCHEDULER_PRIMARY;
    if (override != null) {
      return ['true', '1', 'yes', 'on'].includes(override.toLowerCase());
    }

    const hostname = process.env.HOSTNAME;
    if (hostname) {
      const statefulSetOrdinal = hostname.match(/-(\d+)$/);
      if (statefulSetOrdinal) {
        return statefulSetOrdinal[1] === '0';
      }
    }

    return true;
  }
}
