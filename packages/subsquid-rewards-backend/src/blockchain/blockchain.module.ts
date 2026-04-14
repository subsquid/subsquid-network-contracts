import { Module } from '@nestjs/common';
import { ContractService } from './contract.service';
import { ErrorDecoderService } from './error-decoder.service';
import { CommitmentKeyService } from '../common/commitment-key.service';

@Module({
  providers: [ContractService, ErrorDecoderService, CommitmentKeyService],
  exports: [ContractService, ErrorDecoderService, CommitmentKeyService],
})
export class BlockchainModule {}
