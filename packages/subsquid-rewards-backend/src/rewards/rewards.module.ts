import { Module } from '@nestjs/common';
import { RewardsCalculatorService } from './calculation/rewards-calculator.service';
import { MerkleTreeService } from './distribution/merkle-tree.service';
import { DistributionService } from './distribution/distribution.service';
import { DistributionRecoveryService } from './distribution/distribution-recovery.service';
import { DatabaseModule } from '../database/database.module';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [DatabaseModule, BlockchainModule, CommonModule],
  providers: [
    RewardsCalculatorService,
    MerkleTreeService,
    DistributionService,
    DistributionRecoveryService,
  ],
  exports: [
    RewardsCalculatorService,
    MerkleTreeService,
    DistributionService,
    DistributionRecoveryService,
  ],
})
export class RewardsModule {}
