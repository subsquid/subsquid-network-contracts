import { Module } from '@nestjs/common';
import { AdminController } from './admin/admin.controller';
import { EpochsModule } from '../epochs/epochs.module';
import { RewardsModule } from '../rewards/rewards.module';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [EpochsModule, RewardsModule, BlockchainModule, DatabaseModule],
  controllers: [AdminController],
})
export class ApiModule {}
