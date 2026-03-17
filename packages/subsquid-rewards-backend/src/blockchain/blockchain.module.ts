import { Module } from '@nestjs/common';
import { ContractService } from './contract.service';
import { FordefiService } from './fordefi/fordefi.service';
import { ErrorDecoderService } from './error-decoder.service';
import { CommitmentKeyService } from '../common/commitment-key.service';

@Module({
  providers: [
    ContractService,
    FordefiService,
    ErrorDecoderService,
    CommitmentKeyService,
  ],
  exports: [
    ContractService,
    FordefiService,
    ErrorDecoderService,
    CommitmentKeyService,
  ],
})
export class BlockchainModule {}
