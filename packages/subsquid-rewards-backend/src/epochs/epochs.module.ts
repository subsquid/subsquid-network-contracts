import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { BlockSchedulerService } from './block-scheduler.service';
import { EpochProcessorService } from './epoch-processor.service';
import { StartupRecoveryService } from './startup-recovery.service';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { RewardsModule } from '../rewards/rewards.module';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [ScheduleModule.forRoot(), BlockchainModule, RewardsModule, CommonModule],
  providers: [
    BlockSchedulerService,
    EpochProcessorService,
    StartupRecoveryService,
  ],
  exports: [
    BlockSchedulerService,
    EpochProcessorService,
    StartupRecoveryService,
  ],
})
export class EpochsModule {}
