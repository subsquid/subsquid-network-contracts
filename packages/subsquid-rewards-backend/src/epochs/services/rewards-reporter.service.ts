import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Web3Service } from '../../blockchain/web3.service';
import { ContractService } from '../../blockchain/contract.service';
import { Context } from '../../common';
import { NetworkMetrics, RewardMetrics } from './epoch-metrics.service';

export interface RewardsReportParams {
  epochStart: Date;
  epochEnd: Date;
  isCommitSuccess: boolean;
  commitTxHash: string;
  commitErrorMessage?: string;
  networkMetrics: NetworkMetrics;
  rewardMetrics: RewardMetrics;
  workerRewards?: Array<any>; 
}

@Injectable()
export class RewardsReporterService {
  constructor(
    private configService: ConfigService,
    private web3Service: Web3Service,
    private contractService: ContractService,
  ) {}

  async logSuccessfulRewardsReport(params: RewardsReportParams): Promise<void> {
    const stakeFactor = 1; // same as old backend - always 1
    
    // log the rewards report in old backend format (exact same as original)
    console.log(
      JSON.stringify({
        time: new Date(),
        epoch_start: params.epochStart,
        epoch_end: params.epochEnd,
        type: "rewards_report",
        bot_id: process.env.BOT_NAME || this.configService.get('blockchain.network.networkName'),
        bot_wallet: this.configService.get('blockchain.distributor.address')?.toLowerCase() || '0x0',
        is_commit_success: params.isCommitSuccess,
        commit_tx_hash: params.commitTxHash,
        commit_error_message: params.commitErrorMessage || '',
        target_capacity: Math.round(params.networkMetrics.targetCapacity),
        current_capacity: Math.round(params.networkMetrics.currentCapacity),
        active_workers_count: params.networkMetrics.activeWorkerCount,
        base_apr: params.networkMetrics.baseAprBasisPoints.toFixed(),
        stake_factor: stakeFactor.toFixed(),
        r_apr: params.networkMetrics.baseAprBasisPoints.toFixed(), // same as base_apr (matches old backend)
        total_reward: params.rewardMetrics.totalReward.toString(),
        total_chunks_read: params.rewardMetrics.totalChunksRead,
        total_bytes_sent: params.rewardMetrics.totalBytesSent,
        total_requests: params.rewardMetrics.totalRequests,
        valid_requests: params.rewardMetrics.validRequests,
      })
    );
    
    if (params.isCommitSuccess && params.workerRewards && params.workerRewards.length > 0) {
      const botId = process.env.BOT_NAME || this.configService.get('blockchain.network.networkName');
      const botWallet = this.configService.get('blockchain.distributor.address')?.toLowerCase() || '0x0';
      
      const duration = (params.epochEnd.getTime() - params.epochStart.getTime()) / 1000; 
      const YEAR = 365 * 24 * 60 * 60;
      
      params.workerRewards.forEach(worker => {
        const workerApr = worker.stake && worker.stake > 0n 
          ? ((Number(worker.workerReward) * YEAR) / (duration * Number(worker.stake)) * 10000).toFixed(0)
          : "0";
        const delegatorApr = worker.stake && worker.stake > 0n
          ? ((Number(worker.stakerReward) * YEAR) / (duration * Number(worker.stake)) * 10000).toFixed(0)
          : "0";
        
        console.log(
          JSON.stringify({
            time: new Date(),
            type: "worker_report",
            bot_id: botId,
            bot_wallet: botWallet,
            worker_id: worker.peerId || worker.workerId?.toString() || '',
            t_i: (worker.traffic?.trafficWeight || worker.trafficWeight || 0).toFixed(),
            s_i: (worker.traffic?.dTraffic || worker.stakeWeight || 0).toFixed(),
            r_i: (worker.traffic?.dTraffic || worker.actualYield || 0).toFixed(),
            worker_apr: workerApr,
            delegator_apr: delegatorApr,
            worker_reward: (worker.workerReward || 0n).toString(),
            staker_reward: (worker.stakerReward || 0n).toString(),
            stake: (worker.stake || 0n).toString(),
            bytes_sent: worker.traffic?.bytesSent || worker.bytesSent || 0,
            chunks_read: worker.traffic?.chunksRead || worker.chunksRead || 0,
            requests: worker.traffic?.totalRequests || worker.totalRequests || 0,
            valid_requests: worker.traffic?.validRequests || worker.requestsProcessed || 0,
          })
        );
      });
    }
  }

  async logFailedRewardsReport(
    ctx: Context,
    epochStart: Date,
    epochEnd: Date,
    commitTxHash: string,
    error: Error,
  ): Promise<void> {
    // log failed distribution in old backend format (exact same logic as original)
    try {
      const activeWorkerCount = await this.web3Service.getActiveWorkerCount(ctx);
      const networkCapacity = await this.contractService.getTargetCapacity();
      
      let storagePerWorker = 200;
      try {
        storagePerWorker = await this.contractService.getStoragePerWorkerInGb();
      } catch (storageError) {
        // use default if fetch fails
      }
      
      const currentCapacity = Number(activeWorkerCount) * storagePerWorker;
      const targetCapacity = Number(networkCapacity) / 1e9;
      
      // try to get APR even for failed case
      let baseAprBasisPoints = 2000;
      try {
        const contractApr = await this.contractService.getCurrentApy(ctx);
        baseAprBasisPoints = Number(contractApr);
      } catch (aprError) {
        // use default if APR fetch fails
      }

      console.log(
        JSON.stringify({
          time: new Date(),
          epoch_start: epochStart,
          epoch_end: epochEnd,
          type: "rewards_report",
          bot_id: process.env.BOT_NAME || this.configService.get('blockchain.network.networkName') || 'nestjs-backend-0-0',
          bot_wallet: this.configService.get('blockchain.distributor.address')?.toLowerCase() || '0x0',
          is_commit_success: false,
          commit_tx_hash: commitTxHash || '',
          commit_error_message: error.message,
          target_capacity: Math.round(targetCapacity),
          current_capacity: Math.round(currentCapacity),
          active_workers_count: Number(activeWorkerCount),
          base_apr: baseAprBasisPoints.toFixed(),
          stake_factor: "1", // matches old backend
          r_apr: baseAprBasisPoints.toFixed(),
          total_reward: "0",
          total_chunks_read: 0,
          total_bytes_sent: 0,
          total_requests: 0,
          valid_requests: 0,
        })
      );
    } catch (logError) {
      ctx.logger.error({ error: logError }, `Failed to log error metrics`);
    }
  }
} 