import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { BlockchainModule } from './blockchain/blockchain.module';
import { RewardsModule } from './rewards/rewards.module';
import { EpochsModule } from './epochs/epochs.module';
import { ApiModule } from './api/api.module';
import { CommonModule } from './common/common.module';

@Module({
  imports: [
    AppConfigModule,
    CommonModule,
    DatabaseModule,
    BlockchainModule,
    RewardsModule,
    EpochsModule,
    ApiModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
