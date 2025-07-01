import { Module } from '@nestjs/common';
import { Web3Service } from './web3.service';
import { ContractService } from './contract.service';
import { FordefiService } from './fordefi/fordefi.service';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [DatabaseModule],
  providers: [Web3Service, ContractService, FordefiService],
  exports: [Web3Service, ContractService, FordefiService],
})
export class BlockchainModule {}
