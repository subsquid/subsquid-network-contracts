import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Web3Service } from '../../blockchain/web3.service';
import { ContractService } from '../../blockchain/contract.service';
import { Context } from '../../common';

export interface NetworkMetrics {
  activeWorkerCount: number;
  storagePerWorker: number;
  currentCapacity: number;
  targetCapacity: number;
  baseAprBasisPoints: number;
}

export interface RewardMetrics {
  totalReward: bigint;
  totalBytesSent: number;
  totalChunksRead: number;
  totalRequests: number;
  validRequests: number;
}

@Injectable()
export class EpochMetricsService {
  constructor(
    private configService: ConfigService,
    private web3Service: Web3Service,
    private contractService: ContractService,
  ) {}

  async collectNetworkMetrics(ctx: Context): Promise<NetworkMetrics> {
    const activeWorkerCount = await this.web3Service.getActiveWorkerCount(ctx);
    const networkCapacity = await this.contractService.getTargetCapacity();
    
    // get storage per worker with fallback (exact same pattern as original)
    let storagePerWorker = 200; // default fallback
    try {
      storagePerWorker = await this.contractService.getStoragePerWorkerInGb();
      ctx.logger.debug(`Storage per worker: ${storagePerWorker} GB`);
    } catch (error) {
      ctx.logger.warn(`Failed to get storage per worker, using default: ${error.message}`);
    }
    
    const currentCapacity = Number(activeWorkerCount) * storagePerWorker;
    const targetCapacity = Number(networkCapacity) / 1e9; // convert from bytes to GB
    
    // get APR with fallback (exact same pattern as original)
    let baseAprBasisPoints = 2000; // default fallback
    try {
      const contractApr = await this.contractService.getCurrentApy(ctx);
      baseAprBasisPoints = Number(contractApr);
      ctx.logger.debug(`Using APR from rewards calculation: ${baseAprBasisPoints} basis points`);
    } catch (error) {
      ctx.logger.warn(`Failed to get APR, using default: ${error.message}`);
    }

    return {
      activeWorkerCount: Number(activeWorkerCount),
      storagePerWorker,
      currentCapacity,
      targetCapacity,
      baseAprBasisPoints,
    };
  }

  extractRewardMetrics(lastCalculatedRewards: any): RewardMetrics {
    let totalReward = 0n;
    let totalBytesSent = 0;
    let totalChunksRead = 0;
    let totalRequests = 0;
    let validRequests = 0;

    // calculate total metrics from stored rewards data (exact same logic as original)
    if (lastCalculatedRewards?.workers) {
      totalBytesSent = lastCalculatedRewards.workers.reduce(
        (sum: number, w: any) => sum + (w.traffic?.bytesSent || 0), 0
      );
      totalChunksRead = lastCalculatedRewards.workers.reduce(
        (sum: number, w: any) => sum + (w.traffic?.chunksRead || 0), 0
      );
      totalRequests = lastCalculatedRewards.workers.reduce(
        (sum: number, w: any) => sum + (w.traffic?.totalRequests || 0), 0
      );
      validRequests = lastCalculatedRewards.workers.reduce(
        (sum: number, w: any) => sum + (w.traffic?.validRequests || 0), 0
      );
      
      // extract the total rewards that were calculated
      if (lastCalculatedRewards.totalRewards) {
        const totalWorkerReward = BigInt(lastCalculatedRewards.totalRewards.worker);
        const totalStakerReward = BigInt(lastCalculatedRewards.totalRewards.staker);
        totalReward = totalWorkerReward + totalStakerReward;
      }
    }

    return {
      totalReward,
      totalBytesSent,
      totalChunksRead,
      totalRequests,
      validRequests,
    };
  }
} 