import { Module, forwardRef } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { BlockSchedulerService } from './block-scheduler.service';
import { EpochProcessorService } from './epoch-processor.service';
import { StartupRecoveryService } from './startup-recovery.service';
import { EpochMetricsService } from './services/epoch-metrics.service';
import { RewardsReporterService } from './services/rewards-reporter.service';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { RewardsModule } from '../rewards/rewards.module';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [
    ScheduleModule.forRoot(), 
    BlockchainModule, 
    forwardRef(() => RewardsModule), 
    CommonModule
  ],
  providers: [
    BlockSchedulerService,
    EpochProcessorService,
    StartupRecoveryService,
    EpochMetricsService,
    RewardsReporterService,
  ],
  exports: [
    BlockSchedulerService,
    EpochProcessorService,
    StartupRecoveryService,
    EpochMetricsService,
    RewardsReporterService,
  ],
})
export class EpochsModule {}
