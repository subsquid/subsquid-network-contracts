import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface RewardsReport {
  time: string;
  epoch_start: string;
  epoch_end: string;
  type: 'rewards_report';
  bot_id: string;
  bot_wallet: string;
  is_commit_success: boolean;
  commit_tx_hash: string;
  commit_error_message: string;
  target_capacity: number;
  current_capacity: number;
  active_workers_count: number;
  base_apr: string;
  stake_factor: string;
  r_apr: string;
  total_reward: string;
}

export interface WorkerReport {
  time: string;
  type: 'worker_report';
  worker_id: string;
  bot_id: string;
  bot_wallet: string;
  t_i: string;
  s_i: string;
  r_i: string;
  worker_apr: string;
  delegator_apr: string;
  worker_reward: string;
  staker_reward: string;
  stake: string;
  bytes_sent: number;
  chunks_read: number;
}

@Injectable()
export class MetricsLoggerService {
  private readonly logger = new Logger(MetricsLoggerService.name);
  private readonly botId: string;
  private readonly botWallet: string;

  constructor(private configService: ConfigService) {
    this.botId = this.configService.get('blockchain.network.networkName') || 'nestjs-backend';
    this.botWallet = this.configService.get('blockchain.distributor.address') || '0x0000000000000000000000000000000000000000';
  }

  /**
   * Log rewards distribution completion in the expected format
   */
  logRewardsReport(params: {
    epochStart: Date;
    epochEnd: Date;
    isCommitSuccess: boolean;
    commitTxHash?: string;
    commitErrorMessage?: string;
    targetCapacity: number;
    currentCapacity: number;
    activeWorkersCount: number;
    baseApr: number;
    stakeFactor: number;
    finalApr: number;
    totalReward: bigint;
  }): void {
    const report: RewardsReport = {
      time: new Date().toISOString(),
      epoch_start: params.epochStart.toISOString(),
      epoch_end: params.epochEnd.toISOString(),
      type: 'rewards_report',
      bot_id: this.botId,
      bot_wallet: this.botWallet,
      is_commit_success: params.isCommitSuccess,
      commit_tx_hash: params.commitTxHash || '',
      commit_error_message: params.commitErrorMessage || '',
      target_capacity: params.targetCapacity,
      current_capacity: params.currentCapacity,
      active_workers_count: params.activeWorkersCount,
      base_apr: params.baseApr.toString(),
      stake_factor: params.stakeFactor.toString(),
      r_apr: params.finalApr.toString(),
      total_reward: params.totalReward.toString(),
    };

    // Output as structured JSON log that the parser can consume
    this.logger.log(JSON.stringify(report));
  }

  /**
   * Log individual worker rewards in the expected format
   */
  logWorkerReport(params: {
    workerId: string;
    trafficWeight: number;
    stakeWeight: number;
    rewardWeight: number;
    workerApr: number;
    delegatorApr: number;
    workerReward: bigint;
    stakerReward: bigint;
    stake: bigint;
    bytesSent: number;
    chunksRead: number;
  }): void {
    const report: WorkerReport = {
      time: new Date().toISOString(),
      type: 'worker_report',
      worker_id: params.workerId,
      bot_id: this.botId,
      bot_wallet: this.botWallet,
      t_i: params.trafficWeight.toString(),
      s_i: params.stakeWeight.toString(),
      r_i: params.rewardWeight.toString(),
      worker_apr: params.workerApr.toString(),
      delegator_apr: params.delegatorApr.toString(),
      worker_reward: params.workerReward.toString(),
      staker_reward: params.stakerReward.toString(),
      stake: params.stake.toString(),
      bytes_sent: params.bytesSent,
      chunks_read: params.chunksRead,
    };

    // Output as structured JSON log that the parser can consume
    this.logger.log(JSON.stringify(report));
  }

  /**
   * Log multiple worker reports efficiently
   */
  logWorkerReports(workers: Array<{
    workerId: string;
    trafficWeight: number;
    stakeWeight: number;
    rewardWeight: number;
    workerApr: number;
    delegatorApr: number;
    workerReward: bigint;
    stakerReward: bigint;
    stake: bigint;
    bytesSent: number;
    chunksRead: number;
  }>): void {
    workers.forEach(worker => this.logWorkerReport(worker));
  }
} 