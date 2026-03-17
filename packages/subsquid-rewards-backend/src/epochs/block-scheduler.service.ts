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
  private readonly enableAutoDistribution: boolean;

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
  }

  async onModuleInit() {
    if (this.enableAutoDistribution) {
      const ctx = new TaskContext('block-scheduler:init');
      ctx.logger.info('Auto distribution enabled');
    }
  }

  @Cron('*/2 * * * *')
  async checkApprovalInterval() {
    if (!this.enableAutoDistribution || this.isApprovalProcessing) return;
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

  @Cron('*/5 * * * *')
  async checkDistributionInterval() {
    if (!this.enableAutoDistribution || this.isDistributionProcessing) return;
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
        ctx.logger.info(
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

      ctx.logger.info('Current committer - checking commitment and approval status');

      const commitmentStatus =
        await this.epochProcessor.checkCommitmentStatus();

      if (!commitmentStatus.exists) {
        ctx.logger.info('No commitment exists - creating new commit');
        await this.epochProcessor.processNewCommitment();
      } else {
        const required = commitmentStatus.requiredApprovals;
        const current = commitmentStatus.currentApprovals;

        if (current >= required) {
          ctx.logger.info(
            `Enough approvals (${current}/${required}) - starting distribution`,
          );
          await this.epochProcessor.processDistribution();
        } else {
          ctx.logger.info(
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

  @Cron('*/17 * * * *')
  async checkRecoveryInterval() {
    if (!this.enableAutoDistribution || this.isDistributionProcessing) return;
    this.isDistributionProcessing = true;
    try {
      const ctx = new TaskContext('block-scheduler:recovery');

      const shouldSkipRecovery =
        await this.statelessCoordinator.shouldSkipRecovery();
      if (shouldSkipRecovery) {
        ctx.logger.debug('Skipping recovery - conditions not met or another bot is active');
        return;
      }

      ctx.logger.info('Recovery conditions met - attempting recovery distribution');
      await this.epochProcessor.processDistribution();
    } catch (error) {
      new TaskContext('block-scheduler:recovery').logger.error(
        { error },
        'Recovery interval check failed, will retry next cycle',
      );
    } finally {
      this.isDistributionProcessing = false;
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

  async forceCommit(fromBlock: number, toBlock: number): Promise<boolean> {
    try {
      return await this.epochProcessor.processApproval();
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
      return await this.epochProcessor.processDistribution();
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
      isApprovalProcessing: this.isApprovalProcessing,
      isDistributionProcessing: this.isDistributionProcessing,
    };
  }
}
