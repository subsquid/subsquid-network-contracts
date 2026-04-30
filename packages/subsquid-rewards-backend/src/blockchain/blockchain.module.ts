import { Module } from '@nestjs/common';
import { Web3Service } from './web3.service';
import { ContractService } from './contract.service';
import { BlockchainService } from './blockchain.service';
import { FordefiService } from './fordefi/fordefi.service';
import { ErrorDecoderService } from './error-decoder.service';
import { DatabaseModule } from '../database/database.module';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [DatabaseModule, CommonModule],
  providers: [
    BlockchainService,
    Web3Service,
    ContractService,
    FordefiService,
    ErrorDecoderService,
    {
      provide: 'USE_UNIFIED_BLOCKCHAIN',
      useValue: process.env.USE_UNIFIED_BLOCKCHAIN === 'true',
    },
  ],
  exports: [
    BlockchainService,
    Web3Service,
    ContractService,
    FordefiService,
    ErrorDecoderService,
  ],
})
export class BlockchainModule {}
