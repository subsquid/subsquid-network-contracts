import { Module, forwardRef } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { BlockSchedulerService } from './block-scheduler.service';
import { EpochProcessorService } from './epoch-processor.service';
import { StatelessCoordinatorService } from './stateless-coordinator.service';
import { EpochMetricsService } from './services/epoch-metrics.service';
import { RewardsReporterService } from './services/rewards-reporter.service';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { RewardsModule } from '../rewards/rewards.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    BlockchainModule,
    forwardRef(() => RewardsModule),
  ],
  providers: [
    BlockSchedulerService,
    EpochProcessorService,
    StatelessCoordinatorService,
    EpochMetricsService,
    RewardsReporterService,
  ],
  exports: [
    BlockSchedulerService,
    EpochProcessorService,
    StatelessCoordinatorService,
    EpochMetricsService,
    RewardsReporterService,
  ],
})
export class EpochsModule {}
