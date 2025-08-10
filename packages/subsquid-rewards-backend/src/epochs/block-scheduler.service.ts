import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { ContractService } from '../blockchain/contract.service';
import { DistributionRecoveryService } from '../rewards/distribution/distribution-recovery.service';
import { StartupRecoveryService } from './startup-recovery.service';
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
    private distributionRecovery: DistributionRecoveryService,
    private startupRecovery: StartupRecoveryService,
    private statelessCoordinator: StatelessCoordinatorService,
  ) {
    const rawFlag = this.configService.get('rewards.enableAutoDistribution');
    this.enableAutoDistribution = rawFlag === true || (typeof rawFlag === 'string' && ['true','1','yes','on'].includes(rawFlag.toLowerCase()));
    
    const ctx = new TaskContext('block-scheduler-init');
    ctx.logger.info(`🔄 Block Scheduler (Separated) initialized:`);
    ctx.logger.info(`   - Auto distribution: ${this.enableAutoDistribution ? '✅ ENABLED' : '❌ DISABLED'}`);
    ctx.logger.info(`   - Approval phase: Every 2 minutes`);
    ctx.logger.info(`   - Distribution phase: Every 1 minute (normal flow)`);
    ctx.logger.info(`   - Recovery phase: Every 5 minutes (100+ blocks past approved commitment)`);
    
    // log round robin configuration
    const roundRobinWindow = this.configService.get('rewards.roundRobinWindow', 130);
    const safetyBuffer = this.configService.get('rewards.commitSafetyBuffer', 3);
    const distributionInterval = this.configService.get('rewards.distributionBlockInterval', 520);
    const windowsPerCycle = Math.floor(distributionInterval / roundRobinWindow);
    
    ctx.logger.info(`🎯 Round Robin Configuration:`);
    ctx.logger.info(`   - Distribution interval: ${distributionInterval} blocks (~${Math.round(distributionInterval * 12 / 60)} minutes)`);
    ctx.logger.info(`   - Round robin window: ${roundRobinWindow} blocks (~${Math.round(roundRobinWindow * 12 / 60)} minutes)`);
    ctx.logger.info(`   - Windows per cycle: ${windowsPerCycle}`);
    ctx.logger.info(`   - Commit safety buffer: ${safetyBuffer} blocks (~${safetyBuffer * 12} seconds)`);
  }

  async onModuleInit() {
    if (this.enableAutoDistribution) {
      const ctx = new TaskContext('block-scheduler:init');
      ctx.logger.info('🚀 Auto distribution enabled, initializing...');    
      ctx.logger.info('✅ Startup recovery service initialized');

      setTimeout(() => this.checkApprovalInterval(), 5000);
      setTimeout(() => this.checkDistributionInterval(), 7000);
    }
  }

  @Cron('*/2 * * * *') // Every 2 minutes
  async checkApprovalInterval() {
    if (!this.enableAutoDistribution || this.isApprovalProcessing) {
      return;
    }

    const ctx = new TaskContext('block-scheduler:approval');
    
    try {
      this.isApprovalProcessing = true;
      
      ctx.logger.info('👀 Checking for commitments that need approval');
      
      const success = await this.epochProcessor.processExistingApprovals();
      
      if (success) {
        ctx.logger.info('✅ Approval check completed');
      } else {
        ctx.logger.debug('⚪ No approvals needed');
      }
      
    } catch (error) {
      ctx.logger.error({ error }, 'Approval interval check failed');
    } finally {
      this.isApprovalProcessing = false;
    }
  }

  @Cron('*/1 * * * *') // Every 1 minute
  async checkDistributionInterval() {
    if (!this.enableAutoDistribution || this.isDistributionProcessing) {
      return;
    }
    const ctx = new TaskContext('block-scheduler:distribution');
    
    try {
      this.isDistributionProcessing = true;
      
      const distributionCheck = await this.contractService.isNextDistributionReady(ctx);
      if (distributionCheck.blocksUntilReady > 0) {
        ctx.logger.debug(`⏳ Next distribution in ${distributionCheck.blocksUntilReady} blocks`);
        return;
      }

      if (distributionCheck.needsConfirmation) {
        ctx.logger.info(`⏳ waiting ${distributionCheck.confirmationBlocksNeeded} confirmation blocks before distributing ${distributionCheck.nextFromBlock}-${distributionCheck.nextToBlock}`);
        return;
      }
      
      const committerCheck = await this.statelessCoordinator.isCurrentCommitter();
      
      if (committerCheck.isCommitter) {
        ctx.logger.info(`🎯 I'm committer - checking commitment and approval status`);
        
        const commitmentStatus = await this.epochProcessor.checkCommitmentStatus();
        
        if (!commitmentStatus.exists) {
          ctx.logger.info('📝 No commitment exists - creating new commit');
          await this.epochProcessor.processNewCommitment();
        } else {
          // Commitment exists - check approval count vs required
          const required = commitmentStatus.requiredApprovals;
          const current = commitmentStatus.currentApprovals;
          
          if (current >= required) {
            const committerCheck = await this.statelessCoordinator.isCurrentCommitter();
            
            if (committerCheck.isCommitter) {
              ctx.logger.info(`✅ Enough approvals (${current}/${required}) + canCommit=true - STARTING DISTRIBUTION`);
              await this.epochProcessor.processDistribution();
            } else {
              ctx.logger.info(`⏳ Enough approvals (${current}/${required}) but canCommit=false - waiting for committer eligibility`);
            }
          } else {
            ctx.logger.info(`⏳ Waiting for approvals: ${current}/${required} (need ${required - current} more)`);
          }
        }
        
      }
      
      ctx.logger.info('✅ Distribution interval completed');
      
    } catch (error) {
      ctx.logger.error({ error }, 'Distribution interval check failed');
    } finally {
      this.isDistributionProcessing = false;
    }
  }

  @Cron('*/5 * * * *') // Every 5 minutes 
  async checkRecoveryInterval() {
    if (!this.enableAutoDistribution || this.isDistributionProcessing) {
      return;
    }

    const ctx = new TaskContext('block-scheduler:recovery');
    
    try {
      this.isDistributionProcessing = true;
      
      const shouldSkipRecovery = await this.statelessCoordinator.shouldSkipRecovery();
      if (shouldSkipRecovery) {
        ctx.logger.debug('🚫 Skipping recovery - conditions not met or another bot is active');
        return;
      }
      
      ctx.logger.info('🔧 Recovery conditions met - attempting recovery distribution');
      
      // attempt recovery distribution
      const success = await this.epochProcessor.processDistribution();
      
      if (success) {
        ctx.logger.info('✅ Recovery distribution completed');
      }
      
    } catch (error) {
      ctx.logger.error({ error }, 'Recovery interval check failed');
    } finally {
      this.isDistributionProcessing = false;
    }
  }

  async triggerManualApprovalCheck(): Promise<boolean> {
    const ctx = new TaskContext('block-scheduler:manual-approval-trigger');
    try {
      ctx.logger.info('🔄 Manual approval check triggered');
      await this.checkApprovalInterval();
      return true;
    } catch (error) {
      ctx.logger.error({ error }, 'Manual approval trigger failed');
      return false;
    }
  }

  async triggerManualDistributionCheck(): Promise<boolean> {
    const ctx = new TaskContext('block-scheduler:manual-distribution-trigger');
    try {
      ctx.logger.info('🔄 Manual distribution check triggered');
      await this.checkDistributionInterval();
      return true;
    } catch (error) {
      ctx.logger.error({ error }, 'Manual distribution trigger failed');
      return false;
    }
  }

  async triggerManualRecoveryCheck(): Promise<boolean> {
    const ctx = new TaskContext('block-scheduler:manual-recovery-trigger');
    try {
      ctx.logger.info('🔄 Manual recovery check triggered');
      await this.checkRecoveryInterval();
      return true;
    } catch (error) {
      ctx.logger.error({ error }, 'Manual recovery trigger failed');
      return false;
    }
  }

  async forceCommit(fromBlock: number, toBlock: number): Promise<boolean> {
    const ctx = new TaskContext(`block-scheduler:force-commit:${fromBlock}-${toBlock}`);
    try {
      ctx.logger.info(`🔧 Force commit initiated for ${fromBlock}-${toBlock}`);
      const success = await this.epochProcessor.processApproval();
      return success;
    } catch (error) {
      ctx.logger.error({ error }, 'Force commit failed');
      return false;
    }
  }

  async forceDistribution(fromBlock: number, toBlock: number): Promise<boolean> {
    const ctx = new TaskContext(`block-scheduler:force-distribution:${fromBlock}-${toBlock}`);
    try {
      ctx.logger.info(`🔧 Force distribution initiated for ${fromBlock}-${toBlock}`);
      const success = await this.epochProcessor.processDistribution();
      return success;
    } catch (error) {
      ctx.logger.error({ error }, 'Force distribution failed');
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