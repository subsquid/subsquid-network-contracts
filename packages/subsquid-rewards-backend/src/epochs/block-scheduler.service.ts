import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { ContractService } from '../blockchain/contract.service';
import { DistributionRecoveryService } from '../rewards/distribution/distribution-recovery.service';
import { StartupRecoveryService } from './startup-recovery.service';
import { EpochProcessorService } from './epoch-processor.service';
import { TaskContext } from '../common';

@Injectable()
export class BlockSchedulerService implements OnModuleInit {
  private isProcessing = false;
  private readonly enableAutoDistribution: boolean;

  constructor(
    private configService: ConfigService,
    private contractService: ContractService,
    private epochProcessor: EpochProcessorService,
    private distributionRecovery: DistributionRecoveryService,
    private startupRecovery: StartupRecoveryService,
  ) {
    this.enableAutoDistribution = this.configService.get('rewards.enableAutoDistribution') === true;
    
    const ctx = new TaskContext('block-scheduler-init');
    ctx.logger.info(`🔄 Block Scheduler (Optimized) initialized:`);
    ctx.logger.info(`   - Auto distribution: ${this.enableAutoDistribution ? '✅ ENABLED' : '❌ DISABLED'}`);
  }

  async onModuleInit() {
    if (this.enableAutoDistribution) {
      const ctx = new TaskContext('block-scheduler:init');
      ctx.logger.info('🚀 Auto distribution enabled, initializing...');
      
      ctx.logger.info('✅ Startup recovery service initialized');

      setTimeout(() => this.checkBlockInterval(), 5000);
    }
  }

  @Cron('*/2 * * * *') // Every 2 minutes
  async checkBlockInterval() {
    if (!this.enableAutoDistribution || this.isProcessing) {
      return;
    }

    const ctx = new TaskContext('block-scheduler:check');
    
    try {
      this.isProcessing = true;
      

      const distributionCheck = await this.contractService.isNextDistributionReady(ctx);
      
      // only log when close to distribution (within 50 blocks)
      if (distributionCheck.blocksUntilReady > 50) {
        ctx.logger.debug(
          `⏳ Next distribution in ${distributionCheck.blocksUntilReady} blocks`
        );
        return;
      }
      
      // log approaching distribution
      if (distributionCheck.blocksUntilReady > 0) {
        ctx.logger.info('🔄 Approaching distribution window');
        ctx.logger.info(`📊 Blocks remaining: ${distributionCheck.blocksUntilReady}`);
      }
      
      if (distributionCheck.needsConfirmation) {
        ctx.logger.info(
          `⏳ Waiting for ${distributionCheck.confirmationBlocksNeeded} confirmation blocks`
        );
        return;
      }
      
      if (distributionCheck.isReady) {
        ctx.logger.info(
          `🚀 Processing new distribution for blocks ${distributionCheck.nextFromBlock}-${distributionCheck.nextToBlock}`
        );
        
        const success = await this.epochProcessor.processEpoch();
        
        if (success) {
          ctx.logger.info(
            `✅ Distribution completed successfully for ${distributionCheck.nextFromBlock}-${distributionCheck.nextToBlock}`
          );
        }
      }
      
    } catch (error) {
      ctx.logger.error({ error }, 'Block interval check failed');
    } finally {
      this.isProcessing = false;
    }
  }

  async triggerManualCheck(): Promise<boolean> {
    const ctx = new TaskContext('block-scheduler:manual-trigger');
    try {
      ctx.logger.info('🔄 Manual check triggered');
      await this.checkBlockInterval();
      return true;
    } catch (error) {
      ctx.logger.error({ error }, 'Manual trigger failed');
      return false;
    }
  }

  async forceCommit(fromBlock: number, toBlock: number): Promise<boolean> {
    const ctx = new TaskContext(`block-scheduler:force-commit:${fromBlock}-${toBlock}`);
    try {
      ctx.logger.info(`🔧 Force commit initiated for ${fromBlock}-${toBlock}`);
      const success = await this.epochProcessor.processEpoch();
      return success;
    } catch (error) {
      ctx.logger.error({ error }, 'Force commit failed');
      return false;
    }
  }

  async forceDistribution(fromBlock: number, toBlock: number): Promise<boolean> {
    return this.forceCommit(fromBlock, toBlock);
  }

  getStatus() {
    return {
      enabled: this.enableAutoDistribution,
      isProcessing: this.isProcessing,
    };
  }
}