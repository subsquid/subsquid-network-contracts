import { Module, forwardRef } from '@nestjs/common';
import { RewardsCalculatorService } from './calculation/rewards-calculator.service';
import { MerkleTreeService } from './distribution/merkle-tree.service';
import { DistributionService } from './distribution/distribution.service';
import { DistributionRecoveryService } from './distribution/distribution-recovery.service';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { EpochsModule } from '../epochs/epochs.module';
import { ClickHouseService } from '../database/clickhouse.service';
import { S3Service } from '../s3/s3.service';
import { MetricsLoggerService } from '../common/metrics-logger.service';

@Module({
  imports: [
    BlockchainModule,
    forwardRef(() => EpochsModule),
  ],
  providers: [
    ClickHouseService,
    S3Service,
    MetricsLoggerService,
    RewardsCalculatorService,
    MerkleTreeService,
    DistributionService,
    DistributionRecoveryService,
  ],
  exports: [
    ClickHouseService,
    S3Service,
    MetricsLoggerService,
    RewardsCalculatorService,
    MerkleTreeService,
    DistributionService,
    DistributionRecoveryService,
  ],
})
export class RewardsModule {}
