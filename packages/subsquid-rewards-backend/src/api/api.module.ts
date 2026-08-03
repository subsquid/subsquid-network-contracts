import { Module } from '@nestjs/common';
import { AdminController } from './admin/admin.controller';
import { S3Controller } from './admin/s3.controller';
import { PublicController } from './public/public.controller';
import { EpochsModule } from '../epochs/epochs.module';
import { RewardsModule } from '../rewards/rewards.module';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { DatabaseModule } from '../database/database.module';
import { S3Module } from '../s3/s3.module';

@Module({
  imports: [
    EpochsModule,
    RewardsModule,
    BlockchainModule,
    DatabaseModule,
    S3Module,
  ],
  controllers: [AdminController, S3Controller, PublicController],
})
export class ApiModule {}
