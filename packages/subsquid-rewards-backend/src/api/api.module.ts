import { Module } from '@nestjs/common';
import { AdminController } from './admin/admin.controller';
import { AdminApiKeyGuard } from './admin/admin-api-key.guard';
import { PublicController } from './public/public.controller';
import { EpochsModule } from '../epochs/epochs.module';
import { RewardsModule } from '../rewards/rewards.module';
import { BlockchainModule } from '../blockchain/blockchain.module';

@Module({
  imports: [
    EpochsModule,
    RewardsModule,
    BlockchainModule,
  ],
  controllers: [AdminController, PublicController],
  providers: [AdminApiKeyGuard],
})
export class ApiModule {}
