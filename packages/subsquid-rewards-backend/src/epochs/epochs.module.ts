import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { EpochProcessorService } from './epoch-processor.service';
import { BlockSchedulerService } from './block-scheduler.service';
import { RewardsModule } from '../rewards/rewards.module';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    RewardsModule,
    BlockchainModule,
    CommonModule,
  ],
  providers: [EpochProcessorService, BlockSchedulerService],
  exports: [EpochProcessorService, BlockSchedulerService],
})
export class EpochsModule {}
