import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { EpochProcessorService } from './epoch-processor.service';
import { RewardsModule } from '../rewards/rewards.module';
import { BlockchainModule } from '../blockchain/blockchain.module';

@Module({
  imports: [ScheduleModule.forRoot(), RewardsModule, BlockchainModule],
  providers: [EpochProcessorService],
  exports: [EpochProcessorService],
})
export class EpochsModule {} 