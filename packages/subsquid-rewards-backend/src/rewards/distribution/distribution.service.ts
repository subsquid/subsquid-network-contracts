import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TaskContext, CommitmentKeyService } from '../../common';
import { Web3Service } from '../../blockchain/web3.service';
import { MerkleTreeService, MerkleTreeResult } from './merkle-tree.service';
import {
  RewardsCalculatorService,
  WorkerReward,
} from '../calculation/rewards-calculator.service';
import { DistributionRecoveryService } from './distribution-recovery.service';
import { ErrorDecoderService } from '../../blockchain/error-decoder.service';
import { RewardsReporterService } from '../../epochs/services/rewards-reporter.service';
import { EpochMetricsService } from '../../epochs/services/epoch-metrics.service';
import { S3Service, EpochRewardsData } from '../../s3/s3.service';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  getContract,
  Address,
  BaseError,
} from 'viem';
import { arbitrum } from 'viem/chains';
import { defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DistributedRewardsDistributionABI } from '../../blockchain/contracts/abis';

export interface DistributionStatus {
  epochId: string;
  fromBlock: number;
  toBlock: number;
  status:
    | 'calculating'
    | 'generating_tree'
    | 'committing'
    | 'distributing'
    | 'recovering'
    | 'completed'
    | 'failed';
  totalWorkers: number;
  totalBatches: number;
  processedBatches: number;
  merkleRoot?: string;
  totalRewards: bigint;
  error?: string;
  startedAt: Date;
  completedAt?: Date;
  gasOptimizations?: {
    originalBatchSize: number;
    finalBatchSize: number;
    batchesAdjusted: number;
    totalGasSimulations: number;
  };
  sessionId?: string;
  transactionLogs?: TransactionLog[];
}

export interface TransactionLog {
  type: 'commit' | 'distribute';
  hash: string;
  blockNumber: number;
  gasUsed: bigint;
  gasPrice: bigint;
  batchNumber?: number;
  workerCount?: number;
  retryAttempt?: number;
  duration: number;
  status: 'success' | 'failed';
  error?: string;
}

export interface CommitResult {
  success: boolean;
  txHash?: string;
  blockNumber?: number;
  gasUsed?: bigint;
  gasPrice?: bigint;
  sessionId?: string;
}

export interface GasSimulationResult {
  success: boolean;
  estimatedGas?: bigint;
  error?: string;
  suggestedBatchSize?: number;
}

function formatAmount(amount: bigint): string {
  const amountStr = amount.toString();
  const sqdAmount = (Number(amount) / 1e18).toFixed(6);
  return `${amountStr} wei (${sqdAmount} SQD)`;
}

function generateSessionId(): string {
  return (
    Math.random().toString(36).substring(2, 15) +
    Math.random().toString(36).substring(2, 15)
  );
}

@Injectable()
export class DistributionService {
  private readonly publicClient;
  private readonly walletClient;
  private readonly contractAddress: Address;

  private readonly distributionBatchSize = parseInt(
    process.env.DISTRIBUTION_BATCH_SIZE || '50',
  );

  private readonly gasSimulationConfig = {
    enablePreflightSimulation: process.env.ENABLE_GAS_SIMULATION !== 'false',
    maxOptimizationAttempts: parseInt(
      process.env.MAX_GAS_OPTIMIZATION_ATTEMPTS || '10',
    ),
    minBatchSize: parseInt(process.env.MIN_BATCH_SIZE || '1'),
    gasReductionFactor: parseFloat(process.env.GAS_REDUCTION_FACTOR || '0.8'),
  };

  private readonly contractAbi = parseAbi([
    'function commitRoot(uint256[2] calldata blockRange, bytes32 root, uint16 totalBatches, string calldata ipfs) external',
    'function approveRoot(uint256[2] calldata blockRange) external',
    'function distribute(uint256[2] calldata blockRange, uint256[] calldata recipients, uint256[] calldata workerRewards, uint256[] calldata stakerRewards, bytes32[] calldata merkleProof) external',
    'function commitments(bytes32 key) external view returns (bool exists, bytes32 merkleRoot, uint16 totalBatches, uint16 processedBatches, uint256 approvalCount, string memory ipfsLink)',
    'function canCommit(address who) external view returns (bool)',
    'function requiredApproves() external view returns (uint256)',
    'function lastBlockRewarded() external view returns (uint256)',
  ]);

  constructor(
    private configService: ConfigService,
    private web3Service: Web3Service,
    private merkleTreeService: MerkleTreeService,
    private rewardsCalculatorService: RewardsCalculatorService,
    private recoveryService: DistributionRecoveryService,
    private errorDecoder: ErrorDecoderService,
    private rewardsReporterService: RewardsReporterService,
    private epochMetricsService: EpochMetricsService,
    private commitmentKeyService: CommitmentKeyService,
    private s3Service: S3Service,
  ) {
    const rpcUrl = this.configService.get(
      'blockchain.network.l2RpcUrl',
      'http://localhost:8545',
    );

    const privateKey =
      process.env.DISTRIBUTOR_PRIVATE_KEY ||
      this.configService.get('blockchain.distributor.privateKey');

    if (!privateKey) {
      throw new Error(
        'DISTRIBUTOR_PRIVATE_KEY environment variable is required',
      );
    }

    if (!privateKey.startsWith('0x') || privateKey.length !== 66) {
      throw new Error(
        'Invalid private key format. Must be 64 hex characters prefixed with 0x',
      );
    }

    const contractAddress =
      process.env.REWARDS_DISTRIBUTION_ADDRESS ||
      this.configService.get(
        'blockchain.contracts.rewardsDistribution',
        '0x0E5AE852a0DaF14E53376c86625d2BE24E6dAa3D',
      );

    this.contractAddress = contractAddress as Address;

    let chain;
    if (rpcUrl.includes('localhost') || rpcUrl.includes('127.0.0.1')) {
      chain = defineChain({
        id: 42161,
        name: 'Anvil Local',
        network: 'anvil',
        nativeCurrency: {
          decimals: 18,
          name: 'Ether',
          symbol: 'ETH',
        },
        rpcUrls: {
          default: {
            http: [rpcUrl],
          },
          public: {
            http: [rpcUrl],
          },
        },
      });
    } else {
      chain = arbitrum;
    }

    this.publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    });

    const account = privateKeyToAccount(privateKey as `0x${string}`);
    this.walletClient = createWalletClient({
      account,
      chain,
      transport: http(rpcUrl),
    });

    new TaskContext('distribution:init').logger.debug(
      `Distribution service initialized with contract: ${this.contractAddress}`,
    );
    new TaskContext('distribution:config').logger.debug(
      `Using distributor address: ${account.address}`,
    );
    new TaskContext('distribution:config').logger.debug(`RPC URL: ${rpcUrl}`);
    new TaskContext('distribution:config').logger.debug(
      `Gas simulation configuration:`,
    );
    new TaskContext('distribution:config').logger.debug(
      `  - Enabled: ${this.gasSimulationConfig.enablePreflightSimulation}`,
    );
    new TaskContext('distribution:config').logger.debug(
      `  - Max optimization attempts: ${this.gasSimulationConfig.maxOptimizationAttempts}`,
    );
    new TaskContext('distribution:config').logger.debug(
      `  - Min batch size: ${this.gasSimulationConfig.minBatchSize}`,
    );
    new TaskContext('distribution:config').logger.debug(
      `  - Gas reduction factor: ${this.gasSimulationConfig.gasReductionFactor}`,
    );
    new TaskContext('distribution:config').logger.debug(
      `Distribution batch size: ${this.distributionBatchSize}`,
    );
  }

  async distributeEpochRewards(
    fromBlock: number,
    toBlock: number,
    batchSize: number = this.distributionBatchSize,
    batchNumber?: number,
    totalBatches?: number,
  ): Promise<DistributionStatus> {
    const epochId = `${fromBlock}-${toBlock}`;
    const sessionId = generateSessionId();
    const transactionLogs: TransactionLog[] = [];
    const status: DistributionStatus = {
      epochId,
      fromBlock,
      toBlock,
      status: 'calculating',
      totalWorkers: 0,
      totalBatches: 0,
      processedBatches: 0,
      totalRewards: 0n,
      startedAt: new Date(),
      sessionId,
      transactionLogs,
    };

    const sessionStartTime = Date.now();
    const sessionCtx = new TaskContext(`distribution:session-${sessionId}`);
    let calculationResult: any = null; // Store calculation result for later reporting

    try {
      sessionCtx.logger.info(
        `🎯 Starting distribution session ${sessionId} for epoch ${epochId}`,
      );

      const startCtx = new TaskContext(`distribution:epoch-${epochId}`);

      let existingCommitment: {
        exists: boolean;
        merkleRoot: string;
        totalBatches: number;
      } | null = null;
      let shouldRecalculate = true;
      const commitmentKey = this.generateCommitmentKey(fromBlock, toBlock);

      try {
        const commitment = await this.publicClient.readContract({
          address: this.contractAddress,
          abi: this.contractAbi,
          functionName: 'commitments',
          args: [commitmentKey],
        });

        if (commitment && commitment[0]) {
          existingCommitment = {
            exists: true,
            merkleRoot: commitment[1] as string,
            totalBatches: Number(commitment[2]),
          };
          shouldRecalculate = false;
          startCtx.logger.info(
            `📋 Found existing commitment for epoch ${epochId}: root=${existingCommitment.merkleRoot}, batches=${existingCommitment.totalBatches}`,
          );
          startCtx.logger.info(
            `🔄 Will use existing commitment data for recovery distribution`,
          );
        }
      } catch (error) {
        startCtx.logger.debug(`No existing commitment found: ${error.message}`);
      }

      // normal flow for new distribution
      startCtx.logger.debug(
        `🚀 ${shouldRecalculate ? 'Starting new' : 'Recovering'} distribution for epoch ${epochId}`,
      );

      try {
        const bondAmount = await this.web3Service.getBondAmount(startCtx);
        const activeWorkerCount =
          await this.web3Service.getActiveWorkerCount(startCtx);
        startCtx.logger.debug(`📋 Pre-distribution checks:`);
        startCtx.logger.debug(`   - Bond amount: ${formatAmount(bondAmount)}`);
        startCtx.logger.debug(
          `   - Active workers in contract: ${activeWorkerCount.toString()}`,
        );
      } catch (error) {
        startCtx.logger.warn(`Failed to get contract state: ${error.message}`);
      }

      let workerRewards;
      let merkleTree;
      let finalBatchSize = batchSize;
      let formattedCalculationResult;

      if (shouldRecalculate) {
        status.status = 'calculating';
        calculationResult =
          await this.rewardsCalculatorService.calculateRewardsDetailed(
            startCtx,
            fromBlock,
            toBlock,
            true,
            batchNumber,
            totalBatches,
          );

        formattedCalculationResult =
          await this.rewardsCalculatorService.calculateRewardsFormatted(
            startCtx,
            fromBlock,
            toBlock,
            true,
            batchNumber,
            totalBatches,
          );

        startCtx.logger.debug(
          `✅ Calculated rewards for ${calculationResult.workers.length} workers from ClickHouse`,
        );

        workerRewards = calculationResult.workers;

        status.totalWorkers = workerRewards.length;
        status.totalRewards = workerRewards.reduce(
          (sum, w) => sum + w.workerReward,
          0n,
        );

        startCtx.logger.debug(
          `✅ Mapped to ${status.totalWorkers} registered workers, total: ${formatAmount(status.totalRewards)}`,
        );

        status.status = 'generating_tree';
        let totalGasSimulations = 0;

        if (this.gasSimulationConfig.enablePreflightSimulation) {
          const { optimizedBatchSize, gasSimulations } =
            await this.optimizeBatchSize(
              fromBlock,
              toBlock,
              workerRewards.map((w) => ({
                workerId: w.workerId,
                workerReward: w.workerReward,
                stakerReward: w.stakerReward,
              })),
              batchSize,
            );
          finalBatchSize = optimizedBatchSize;
          totalGasSimulations = gasSimulations;
        }

        startCtx.logger.debug(
          `🔒 using batch size ${finalBatchSize} for merkle tree`,
        );

        status.gasOptimizations = {
          originalBatchSize: batchSize,
          finalBatchSize: finalBatchSize,
          batchesAdjusted: finalBatchSize === batchSize ? 0 : 1,
          totalGasSimulations,
        };

        merkleTree = await this.merkleTreeService.generateMerkleTree(
          workerRewards,
          finalBatchSize,
        );

        status.totalBatches = merkleTree.totalBatches;
        status.merkleRoot = merkleTree.root;

        startCtx.logger.debug(
          `✅ Generated optimized Merkle tree: root=${merkleTree.root}, batches=${merkleTree.totalBatches} (gas simulations: ${totalGasSimulations})`,
        );

        status.status = 'committing';
        const commitLog = await this.commitMerkleRoot(
          fromBlock,
          toBlock,
          merkleTree.root,
          merkleTree.totalBatches,
          sessionId,
          workerRewards,
          merkleTree,
          finalBatchSize,
        );
        if (commitLog) {
          transactionLogs.push(commitLog);
        }

        startCtx.logger.debug(`✅ Committed Merkle root to contract`);
      } else {
        // Recovery flow - use existing commitment data
        startCtx.logger.info(
          `🔄 Recovery mode: Using existing commitment data`,
        );

        // We need to recalculate just to get the worker data for distribution
        // but we'll use the existing merkle root
        status.status = 'recovering';
        calculationResult =
          await this.rewardsCalculatorService.calculateRewardsDetailed(
            startCtx,
            fromBlock,
            toBlock,
            true,
            batchNumber,
            totalBatches,
          );

        formattedCalculationResult =
          await this.rewardsCalculatorService.calculateRewardsFormatted(
            startCtx,
            fromBlock,
            toBlock,
            true,
            batchNumber,
            totalBatches,
          );

        workerRewards = calculationResult.workers;

        startCtx.logger.info(
          `📊 Attempting to reconstruct Merkle tree to match existing commitment`,
        );

        const inferredBatchSize = Math.ceil(
          workerRewards.length / existingCommitment!.totalBatches,
        );
        finalBatchSize = inferredBatchSize;

        startCtx.logger.debug(
          `🔍 Inferred batch size: ${inferredBatchSize} (${workerRewards.length} workers / ${existingCommitment!.totalBatches} batches)`,
        );

        merkleTree = await this.merkleTreeService.generateMerkleTree(
          workerRewards,
          inferredBatchSize,
        );

        if (merkleTree.root !== existingCommitment!.merkleRoot) {
          startCtx.logger.warn(
            `⚠️ Reconstructed Merkle root (${merkleTree.root}) does not match committed root (${existingCommitment!.merkleRoot})`,
          );
          startCtx.logger.info(
            `📥 Attempting to fetch original epoch data from S3 for recovery...`,
          );

          if (this.s3Service.isEnabled()) {
            try {
              const s3Key = this.s3Service.generateS3Key(
                this.configService.get('blockchain.networkName', 'arbitrum'),
                fromBlock,
                toBlock,
              );

              startCtx.logger.info(`📥 Attempting S3 recovery from path: ${s3Key}`);
              const s3Data = await this.s3Service.downloadJson(s3Key);

              if (s3Data && s3Data.merkleTree) {
                startCtx.logger.info(
                  `✅ Found original epoch data in S3, reconstructing exact Merkle tree`,
                );

                let s3Workers: WorkerReward[] = [];

                if (s3Data.workersData && Array.isArray(s3Data.workersData)) {
                  s3Workers = s3Data.workersData.map((w: any) => ({
                    workerId: BigInt(w.workerId),
                    workerReward: BigInt(w.workerReward),
                    stakerReward: BigInt(w.stakerReward),
                    id: w.id,
                    stake: w.stake ? BigInt(w.stake) : undefined,
                  }));
                } else if (s3Data.rawData?.workers) {
                  s3Workers = s3Data.rawData.workers.map((w: any) => ({
                    workerId: BigInt(w.workerId),
                    workerReward: BigInt(w.workerReward),
                    stakerReward: BigInt(w.stakerReward),
                    id: w.peerId,
                    stake: w.stake ? BigInt(w.stake) : undefined,
                  }));
                }

                if (s3Workers.length > 0) {
                  const s3BatchSize =
                    s3Data.batchSize ||
                    s3Data.merkleTree?.batchSize ||
                    inferredBatchSize;
                  const s3MerkleTree =
                    await this.merkleTreeService.generateMerkleTree(
                      s3Workers,
                      s3BatchSize,
                    );

                  if (s3MerkleTree.root === existingCommitment!.merkleRoot) {
                    startCtx.logger.info(
                      `✅ Successfully reconstructed exact Merkle tree from S3 data`,
                    );
                    merkleTree = s3MerkleTree;
                    workerRewards = s3Workers;
                    finalBatchSize = s3BatchSize;
                  } else {
                    startCtx.logger.error(
                      `❌ S3 reconstructed root (${s3MerkleTree.root}) still doesn't match committed root (${existingCommitment!.merkleRoot})`,
                    );

                    if (
                      s3Data.merkleTree.root === existingCommitment!.merkleRoot
                    ) {
                      startCtx.logger.info(
                        `✅ Using pre-built Merkle tree from S3 with matching root`,
                      );
                      merkleTree = s3Data.merkleTree;
                      workerRewards = s3Workers;
                      finalBatchSize = s3BatchSize;
                    } else {
                      startCtx.logger.warn(
                        `⚠️ Will use committed root for distribution but proofs may fail`,
                      );
                      merkleTree.root = existingCommitment!.merkleRoot;
                    }
                  }
                } else {
                  startCtx.logger.warn(
                    `⚠️ No worker data found in S3 response`,
                  );
                  startCtx.logger.warn(
                    `⚠️ Will use committed root for distribution but proofs may fail`,
                  );
                  merkleTree.root = existingCommitment!.merkleRoot;
                }
              } else {
                startCtx.logger.warn(`⚠️ No S3 data found or invalid format`);
                startCtx.logger.warn(
                  `⚠️ Will use committed root for distribution but proofs may fail`,
                );
                merkleTree.root = existingCommitment!.merkleRoot;
              }
            } catch (s3Error) {
              startCtx.logger.error(
                { error: s3Error },
                `❌ Failed to fetch from S3: ${s3Error.message}`,
              );
              startCtx.logger.warn(
                `⚠️ Will use committed root for distribution but proofs may fail`,
              );
              merkleTree.root = existingCommitment!.merkleRoot;
            }
          } else {
            startCtx.logger.warn(
              `⚠️ S3 is disabled, cannot fetch original data`,
            );
            startCtx.logger.warn(
              `⚠️ Will use committed root for distribution but proofs may fail`,
            );
            merkleTree.root = existingCommitment!.merkleRoot;
          }
        } else {
          startCtx.logger.info(
            `✅ Reconstructed Merkle tree matches existing commitment`,
          );
        }

        status.totalBatches = existingCommitment!.totalBatches;
        status.merkleRoot = existingCommitment!.merkleRoot;
        status.totalWorkers = workerRewards.length;
        status.totalRewards = workerRewards.reduce(
          (sum, w) => sum + w.workerReward,
          0n,
        );

        startCtx.logger.info(
          `📋 Recovery summary: ${status.totalWorkers} workers, ${status.totalBatches} batches, root=${status.merkleRoot}`,
        );
      }

      // Always upload to S3 after successful commit
      if (this.s3Service.isEnabled()) {
        try {
          const s3Result = await this.prepareAndUploadToS3(
            fromBlock,
            toBlock,
            merkleTree.root,
            merkleTree.totalBatches,
            workerRewards,
            merkleTree,
            sessionStartTime,
            sessionId,
            finalBatchSize,
          );
          startCtx.logger.info(`✅ Epoch rewards uploaded to S3: ${s3Result}`);
        } catch (s3Error) {
          startCtx.logger.error(
            { error: s3Error },
            `❌ S3 upload failed (continuing distribution): ${s3Error.message}`,
          );
          // Continue with distribution even if S3 fails
        }
      }

      status.status = 'distributing';
      const distributionLogs = await this.distributeBatches(
        fromBlock,
        toBlock,
        merkleTree,
        sessionId,
      );
      transactionLogs.push(...distributionLogs);

      status.processedBatches = merkleTree.totalBatches;
      status.status = 'completed';
      status.completedAt = new Date();

      const sessionDuration = Date.now() - sessionStartTime;
      const totalWorkerRewards = workerRewards.reduce(
        (sum, w) => sum + w.workerReward,
        0n,
      );
      const totalStakerRewards = workerRewards.reduce(
        (sum, w) => sum + w.stakerReward,
        0n,
      );
      const totalRewards = totalWorkerRewards + totalStakerRewards;
      const totalGasUsed = transactionLogs.reduce(
        (sum, log) => sum + log.gasUsed,
        0n,
      );
      const totalGasCost = transactionLogs.reduce(
        (sum, log) => sum + log.gasUsed * log.gasPrice,
        0n,
      );

      sessionCtx.logger.info(
        `🎉 Distribution session ${sessionId} completed successfully!`,
      );

      const summaryCtx = new TaskContext(`distribution:summary-${sessionId}`);
      summaryCtx.logger.info(`📊 === DISTRIBUTION SUMMARY ===`);
      summaryCtx.logger.info(`🎯 Session ID: ${sessionId}`);
      summaryCtx.logger.info(`📅 Block Range: ${fromBlock} → ${toBlock}`);
      summaryCtx.logger.info(
        `👥 Total Workers: ${status.totalWorkers.toString()}`,
      );
      summaryCtx.logger.info(
        `📦 Total Batches: ${status.totalBatches.toString()}`,
      );
      summaryCtx.logger.info(
        `⏱️ Duration: ${(sessionDuration / 1000).toFixed(2)}s`,
      );
      summaryCtx.logger.info(
        `💰 Worker Rewards: ${formatAmount(totalWorkerRewards)}`,
      );
      summaryCtx.logger.info(
        `🏦 Staker Rewards: ${formatAmount(totalStakerRewards)}`,
      );
      summaryCtx.logger.info(`💎 Total Rewards: ${formatAmount(totalRewards)}`);
      summaryCtx.logger.info(`⛽ Total Gas Used: ${totalGasUsed.toString()}`);
      summaryCtx.logger.info(
        `💸 Total Gas Cost: ${formatAmount(totalGasCost)}`,
      );
      summaryCtx.logger.info(
        `🏆 Successful Transactions: ${transactionLogs.filter((t) => t.status === 'success').length}`,
      );
      summaryCtx.logger.info(
        `❌ Failed Transactions: ${transactionLogs.filter((t) => t.status === 'failed').length}`,
      );

      if (status.gasOptimizations) {
        this.logGasOptimizationSummary(status.gasOptimizations);
      }

      // generate structured rewards report
      try {
        const startTime = new Date(sessionStartTime);
        const endTime = status.completedAt;

        const networkMetrics =
          await this.epochMetricsService.collectNetworkMetrics(summaryCtx);

        const rewardMetrics = this.epochMetricsService.extractRewardMetrics(
          formattedCalculationResult,
        );

        const commitTxHash =
          transactionLogs.find((log) => log.type === 'commit')?.hash || '';

        await this.rewardsReporterService.logSuccessfulRewardsReport({
          epochStart: startTime,
          epochEnd: endTime,
          isCommitSuccess: true,
          commitTxHash,
          networkMetrics,
          rewardMetrics,
          workerRewards: formattedCalculationResult.workers, // use formatted workers with traffic data
        });
      } catch (reportError) {
        summaryCtx.logger.warn(
          { error: reportError },
          'Failed to generate rewards report',
        );
      }

      return status;
    } catch (error) {
      const sessionDuration = Date.now() - sessionStartTime;

      let errorMessage: string;
      if (error instanceof BaseError) {
        errorMessage = this.errorDecoder.formatError(error, sessionCtx);
        const errorContext = this.errorDecoder.getErrorContext(
          error,
          sessionCtx,
        );
        sessionCtx.logger.error(
          { errorContext },
          `❌ Distribution session ${sessionId} failed after ${(sessionDuration / 1000).toFixed(2)}s: ${errorMessage}`,
        );
      } else {
        errorMessage = error?.message || String(error);
        sessionCtx.logger.error(
          `❌ Distribution session ${sessionId} failed after ${(sessionDuration / 1000).toFixed(2)}s: ${errorMessage}`,
        );
      }

      status.status = 'failed';
      status.error = errorMessage;
      status.completedAt = new Date();

      // log failed distribution
      try {
        const startTime = new Date(sessionStartTime);
        const endTime = status.completedAt;

        await this.rewardsReporterService.logFailedRewardsReport(
          sessionCtx,
          startTime,
          endTime,
          '',
          error,
        );
      } catch (reportError) {
        sessionCtx.logger.warn(
          { error: reportError },
          'Failed to generate failed rewards report',
        );
      }

      return status;
    }
  }

  /**
   * Prepare and upload epoch rewards data to S3
   */
  private async prepareAndUploadToS3(
    fromBlock: number,
    toBlock: number,
    merkleRoot: string,
    totalBatches: number,
    workersData: WorkerReward[],
    merkleTree: any, // MerkleTreeResult
    sessionStartTime: number,
    sessionId: string,
    explicitBatchSize?: number,
  ): Promise<string> {
    const ctx = new TaskContext(`s3:upload:${sessionId}`);

    try {
      if (!this.s3Service.isEnabled()) {
        ctx.logger.warn('S3 service disabled, using placeholder link');
        return `s3://rewards-${fromBlock}-${toBlock}.json`;
      }

      ctx.logger.info(`📤 Preparing epoch rewards data for S3 upload`);

      const networkName = this.configService.get(
        'blockchain.network.name',
        'arbitrum',
      );

      const startTime = await this.web3Service.getBlockTimestamp(
        ctx,
        fromBlock,
      );
      const endTime = await this.web3Service.getBlockTimestamp(ctx, toBlock);
      const epochDuration = (endTime.getTime() - startTime.getTime()) / 1000;

      const totalRequests = workersData.reduce(
        (sum, w) => sum + ((w as any).totalRequests || 0),
        0,
      );
      const totalBytesServed = workersData.reduce(
        (sum, w) => sum + ((w as any).bytesSent || 0),
        0,
      );
      const totalChunksRead = workersData.reduce(
        (sum, w) => sum + ((w as any).chunksRead || 0),
        0,
      );

      const totalWorkerRewards = workersData.reduce(
        (sum, w) => sum + w.workerReward,
        0n,
      );
      const totalStakerRewards = workersData.reduce(
        (sum, w) => sum + w.stakerReward,
        0n,
      );
      const totalRewards = totalWorkerRewards + totalStakerRewards;

      const formattedWorkers = workersData.map((worker) => {
        const workerAny = worker as any;
        return {
          workerId: worker.workerId.toString(),
          peerId: worker.id?.toString() || `worker-${worker.workerId}`,
          workerReward: worker.workerReward.toString(),
          stakerReward: worker.stakerReward.toString(),
          totalReward: (worker.workerReward + worker.stakerReward).toString(),
          stake: worker.stake?.toString() || '0',
          performance: {
            bytesServed: workerAny.bytesSent || 0,
            chunksRead: workerAny.chunksRead || 0,
            requestsProcessed: workerAny.totalRequests || 0,
            requestErrorRate: 0,
            livenessCoefficient: 1.0,
          },
        };
      });

      const formattedLeaves = merkleTree.leaves.map(
        (leaf: any, index: number) => ({
          batchIndex: index,
          leafHash: leaf.leafHash,
          recipients: leaf.recipients.map((r: bigint) => r.toString()),
          workerRewards: leaf.workerRewards.map((r: bigint) => r.toString()),
          stakerRewards: leaf.stakerRewards.map((r: bigint) => r.toString()),
        }),
      );

      const epochRewardsData: EpochRewardsData = {
        epochInfo: {
          fromBlock,
          toBlock,
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          epochDuration,
          timestamp: new Date().toISOString(),
          network: networkName,
        },
        merkleTree: {
          root: merkleRoot,
          totalBatches,
          batchSize:
            explicitBatchSize ?? Math.ceil(workersData.length / totalBatches),
          leaves: formattedLeaves,
        },
        rawData: {
          totalWorkers: workersData.length,
          workers: formattedWorkers,
        },
        workersData: workersData.map((w) => ({
          workerId: w.workerId.toString(),
          workerReward: w.workerReward.toString(),
          stakerReward: w.stakerReward.toString(),
          id: w.id?.toString(),
          stake: w.stake?.toString(),
        })),
        batchSize:
          explicitBatchSize ?? Math.ceil(workersData.length / totalBatches),
        networkMetrics: {
          totalRequests,
          totalBytesServed,
          totalChunksRead,
        },
        rewardSummary: {
          totalWorkerRewards: totalWorkerRewards.toString(),
          totalStakerRewards: totalStakerRewards.toString(),
          totalRewards: totalRewards.toString(),
          currency: 'SQD',
        },
        distribution: {
          uploadedAt: new Date().toISOString(),
        },
        verification: {
          dataHash: '',
          version: '1.0.0',
        },
      };

      const result = await this.s3Service.uploadEpochRewards(epochRewardsData);

      ctx.logger.info(`✅ Epoch rewards uploaded to S3: ${result.key}`);
      ctx.logger.info(`📎 S3 URL: ${result.url}`);
      ctx.logger.info(`📊 Size: ${result.size} bytes, ETag: ${result.etag}`);

      return result.url;
    } catch (error) {
      if (error.message?.includes('S3 service is disabled')) {
        ctx.logger.info('S3 service disabled, using placeholder link');
        return `s3://rewards-${fromBlock}-${toBlock}.json`;
      }

      ctx.logger.error('❌ S3 upload failed', error);
      ctx.logger.error(`Error details: ${error.message}`);

      if (process.env.NODE_ENV === 'production') {
        throw new Error(`Critical: S3 upload failed - ${error.message}`);
      }

      // In development, continue with placeholder
      return `s3://rewards-${fromBlock}-${toBlock}.json`;
    }
  }

  private async commitMerkleRoot(
    fromBlock: number,
    toBlock: number,
    merkleRoot: string,
    totalBatches: number,
    sessionId: string,
    workersData?: WorkerReward[],
    merkleTree?: any,
    explicitBatchSize?: number,
  ): Promise<TransactionLog | null> {
    const startTime = Date.now();
    const commitCtx = new TaskContext(`distribution:commit-${sessionId}`);

    commitCtx.logger.info(
      `🚀 [${sessionId}] Starting merkle root commit for blocks [${fromBlock}, ${toBlock}]`,
    );

    let commitSuccess = false;
    let retryCount = 0;
    const MAX_RETRIES = 3;
    let transactionLog: TransactionLog | null = null;

    while (!commitSuccess && retryCount < MAX_RETRIES) {
      const attemptStartTime = Date.now();

      // S3 upload has been moved to distributeEpochRewards to ensure it happens for both normal and recovery flows
      const s3Link = `s3://rewards-${fromBlock}-${toBlock}.json`;

      try {
        commitCtx.logger.info(
          `🔄 [${sessionId}] Commit attempt ${retryCount + 1}/${MAX_RETRIES}`,
        );

        const canCommit = await this.publicClient.readContract({
          address: this.contractAddress,
          abi: this.contractAbi,
          functionName: 'canCommit',
          args: [this.walletClient.account.address],
        });

        if (!canCommit) {
          throw new Error('Account is not authorized to commit distributions');
        }

        const commitmentKey = this.generateCommitmentKey(fromBlock, toBlock);

        try {
          const commitment = await this.publicClient.readContract({
            address: this.contractAddress,
            abi: this.contractAbi,
            functionName: 'commitments',
            args: [commitmentKey],
          });

          if (commitment && commitment[0]) {
            const existingMerkleRoot = commitment[1];
            const existingTotalBatches = commitment[2];

            const isMatchingCommitment =
              existingMerkleRoot === merkleRoot &&
              Number(existingTotalBatches) === totalBatches;

            if (isMatchingCommitment) {
              commitCtx.logger.info(
                `✅ [${sessionId}] Block range already committed with matching parameters - skipping`,
              );

              commitSuccess = true;
              break;
            } else {
              throw new Error(
                `Block range already committed with different parameters`,
              );
            }
          }
        } catch (commitmentCheckError) {
          commitCtx.logger.warn(
            `⚠️ [${sessionId}] Could not check commitment status: ${commitmentCheckError.message}`,
          );
        }

        const contractArgs = [
          [BigInt(fromBlock), BigInt(toBlock)],
          merkleRoot as `0x${string}`,
          totalBatches,
          s3Link,
        ];

        const { request } = await this.publicClient.simulateContract({
          account: this.walletClient.account,
          address: this.contractAddress,
          abi: this.contractAbi,
          functionName: 'commitRoot',
          args: contractArgs,
        });

        const hash = await this.walletClient.writeContract(request);

        commitCtx.logger.info(`📤 [${sessionId}] Commit TX submitted: ${hash}`);

        const receipt = await this.publicClient.waitForTransactionReceipt({
          hash,
        });

        const duration = Date.now() - attemptStartTime;

        commitCtx.logger.info(
          `🎉 [${sessionId}] Commit successful! Block: ${receipt.blockNumber.toString()}, Gas: ${receipt.gasUsed.toString()}, Duration: ${duration}ms`,
        );

        transactionLog = {
          type: 'commit',
          hash: receipt.transactionHash,
          blockNumber: Number(receipt.blockNumber),
          gasUsed: receipt.gasUsed,
          gasPrice: receipt.effectiveGasPrice || 0n,
          retryAttempt: retryCount + 1,
          duration,
          status: 'success',
        };

        // Log rewards_commited event for compatibility with old backend
        if (workersData && workersData.length > 0) {
          const totalStake = workersData.reduce((sum, w) => sum + (w.totalStake || 0n), 0n);
          const capedStake = workersData.reduce((sum, w) => sum + (w.stake || 0n), 0n);
          console.log(
            JSON.stringify({
              time: new Date(),
              type: 'rewards_commited', // Match old backend typo for compatibility
              bot_wallet: this.walletClient.account.address,
              tx_hash: receipt.transactionHash,
              from_block: fromBlock,
              to_block: toBlock,
              totalStake: totalStake.toString(),
              capedStake: capedStake.toString(),
              workers_count: workersData.length,
            }),
          );
        }

        commitSuccess = true;
      } catch (error) {
        const duration = Date.now() - attemptStartTime;

        let errorMessage: string;
        let errorContext: Record<string, any> = {};

        if (error instanceof BaseError) {
          errorMessage = this.errorDecoder.formatError(error, commitCtx);
          errorContext = this.errorDecoder.getErrorContext(error, commitCtx);

          if (this.errorDecoder.isSpecificError(error, 'NotAllBlocksCovered')) {
            try {
              const lastBlockRewarded = await this.publicClient.readContract({
                address: this.contractAddress,
                abi: this.contractAbi,
                functionName: 'lastBlockRewarded',
              });

              commitCtx.logger.error(
                `❌ [${sessionId}] Block continuity error: lastBlockRewarded=${lastBlockRewarded}, trying to commit fromBlock=${fromBlock}`,
              );
              errorContext.lastBlockRewarded = lastBlockRewarded.toString();
              errorContext.expectedFromBlock = (
                Number(lastBlockRewarded) + 1
              ).toString();
            } catch (e) {
              commitCtx.logger.debug(
                'Could not fetch lastBlockRewarded for additional context',
              );
            }
          }
        } else {
          errorMessage = String(error?.message || error);
        }

        commitCtx.logger.error(
          { errorContext },
          `❌ [${sessionId}] Commit attempt ${retryCount + 1}/${MAX_RETRIES} failed (${duration}ms): ${errorMessage}`,
        );

        if (retryCount === MAX_RETRIES - 1) {
          transactionLog = {
            type: 'commit',
            hash: 'failed',
            blockNumber: 0,
            gasUsed: 0n,
            gasPrice: 0n,
            retryAttempt: retryCount + 1,
            duration,
            status: 'failed',
            error: errorMessage,
          };

          throw new Error(
            `Failed to commit Merkle root after ${MAX_RETRIES} attempts: ${errorMessage}`,
          );
        } else {
          const retryDelay = 2000 + retryCount * 1000;
          commitCtx.logger.warn(
            `🔄 [${sessionId}] Retrying commit in ${retryDelay}ms`,
          );

          retryCount++;
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
        }
      }
    }

    return transactionLog;
  }

  private async simulateDistribution(
    fromBlock: number,
    toBlock: number,
    recipients: bigint[],
    workerRewards: bigint[],
    stakerRewards: bigint[],
    proof: string[],
  ): Promise<GasSimulationResult> {
    const gasCtx = new TaskContext(`distribution:gas-simulation`);

    try {
      gasCtx.logger.debug(
        `🧪 Simulating distribution for ${recipients.length} workers...`,
      );

      const simulation = await this.publicClient.simulateContract({
        account: this.walletClient.account,
        address: this.contractAddress,
        abi: this.contractAbi,
        functionName: 'distribute',
        args: [
          [BigInt(fromBlock), BigInt(toBlock)],
          recipients,
          workerRewards,
          stakerRewards,
          proof as `0x${string}`[],
        ],
      });

      const gasEstimate = await this.publicClient.estimateContractGas({
        account: this.walletClient.account,
        address: this.contractAddress,
        abi: this.contractAbi,
        functionName: 'distribute',
        args: [
          [BigInt(fromBlock), BigInt(toBlock)],
          recipients,
          workerRewards,
          stakerRewards,
          proof as `0x${string}`[],
        ],
      });

      gasCtx.logger.debug(
        `✅ Gas simulation successful: ${gasEstimate.toString()} gas for ${recipients.length} workers`,
      );

      return {
        success: true,
        estimatedGas: gasEstimate,
      };
    } catch (error) {
      const errorMessage = error?.message || String(error);
      gasCtx.logger.warn(
        `❌ Gas simulation failed for ${recipients.length} workers: ${errorMessage}`,
      );

      let suggestedBatchSize = recipients.length;

      if (errorMessage.includes('gas') || errorMessage.includes('Gas')) {
        suggestedBatchSize = Math.max(1, Math.floor(recipients.length * 0.5));
      } else if (
        errorMessage.includes('revert') ||
        errorMessage.includes('execution reverted')
      ) {
        suggestedBatchSize = Math.max(1, Math.floor(recipients.length * 0.7));
      } else {
        suggestedBatchSize = Math.max(1, Math.floor(recipients.length * 0.8));
      }

      return {
        success: false,
        error: errorMessage,
        suggestedBatchSize,
      };
    }
  }

  private async optimizeBatchSize(
    fromBlock: number,
    toBlock: number,
    workers: Array<{
      workerId: bigint;
      workerReward: bigint;
      stakerReward: bigint;
    }>,
    initialBatchSize: number,
  ): Promise<{ optimizedBatchSize: number; gasSimulations: number }> {
    const gasCtx = new TaskContext(`distribution:gas-optimization`);

    gasCtx.logger.debug(
      `🔧 Optimizing batch size starting with ${initialBatchSize} workers per batch...`,
    );

    let testBatchSize = initialBatchSize;
    let gasSimulations = 0;
    const maxAttempts = this.gasSimulationConfig.maxOptimizationAttempts;

    while (gasSimulations < maxAttempts) {
      const testBatch = workers.slice(
        0,
        Math.min(testBatchSize, workers.length),
      );

      if (
        testBatch.length === 0 ||
        testBatchSize < this.gasSimulationConfig.minBatchSize
      ) {
        gasCtx.logger.warn(
          `⚠️ Test batch size reduced below minimum (${this.gasSimulationConfig.minBatchSize}), using minimum size`,
        );
        return {
          optimizedBatchSize: this.gasSimulationConfig.minBatchSize,
          gasSimulations,
        };
      }

      const testMerkleTree = await this.merkleTreeService.generateMerkleTree(
        testBatch,
        testBatchSize,
      );

      if (testMerkleTree.leaves.length === 0) {
        gasCtx.logger.warn('⚠️ No leaves generated for test batch');
        return { optimizedBatchSize: 1, gasSimulations };
      }

      const testLeaf = testMerkleTree.leaves[0];
      const testProof = testMerkleTree.proofs[0];

      gasSimulations++;

      const simulationResult = await this.simulateDistribution(
        fromBlock,
        toBlock,
        testLeaf.recipients,
        testLeaf.workerRewards,
        testLeaf.stakerRewards,
        testProof,
      );

      if (simulationResult.success) {
        gasCtx.logger.debug(
          `✅ Optimal batch size found: ${testBatchSize} workers (${gasSimulations} simulations)`,
        );
        return { optimizedBatchSize: testBatchSize, gasSimulations };
      } else {
        gasCtx.logger.warn(
          `❌ Batch size ${testBatchSize} failed simulation: ${simulationResult.error}`,
        );

        if (
          simulationResult.suggestedBatchSize &&
          simulationResult.suggestedBatchSize < testBatchSize
        ) {
          testBatchSize = simulationResult.suggestedBatchSize;
        } else {
          testBatchSize = Math.max(
            this.gasSimulationConfig.minBatchSize,
            Math.floor(
              testBatchSize * this.gasSimulationConfig.gasReductionFactor,
            ),
          );
        }

        gasCtx.logger.debug(
          `🔄 Retrying with reduced batch size: ${testBatchSize}`,
        );
      }
    }

    gasCtx.logger.warn(
      `⚠️ Could not find optimal batch size after ${maxAttempts} attempts, defaulting to minimum size ${this.gasSimulationConfig.minBatchSize}`,
    );
    return {
      optimizedBatchSize: this.gasSimulationConfig.minBatchSize,
      gasSimulations,
    };
  }

  private async distributeBatches(
    fromBlock: number,
    toBlock: number,
    merkleTree: MerkleTreeResult,
    sessionId: string,
  ): Promise<TransactionLog[]> {
    const batchCtx = new TaskContext(`distribution:batches-${sessionId}`);

    batchCtx.logger.info(
      `📦 [${sessionId}] Starting distribution of ${merkleTree.totalBatches} batches`,
    );

    const transactionLogs: TransactionLog[] = [];

    for (let i = 0; i < merkleTree.leaves.length; i++) {
      const leaf = merkleTree.leaves[i];
      const proof = merkleTree.proofs[i];
      const batchNumber = i + 1;

      const batchStartTime = Date.now();
      try {
        batchCtx.logger.info(
          `📤 [${sessionId}] Processing batch ${batchNumber}/${merkleTree.totalBatches} with ${leaf.recipients.length} workers`,
        );

        if (this.gasSimulationConfig.enablePreflightSimulation) {
          const gasSimulation = await this.simulateDistribution(
            fromBlock,
            toBlock,
            leaf.recipients,
            leaf.workerRewards,
            leaf.stakerRewards,
            proof,
          );

          if (!gasSimulation.success) {
            batchCtx.logger.error(
              `❌ [${sessionId}] Pre-flight simulation failed for batch ${batchNumber}: ${gasSimulation.error}`,
            );

            if (leaf.recipients.length > 1) {
              batchCtx.logger.warn(
                `🔄 [${sessionId}] Attempting to split failing batch ${batchNumber} into smaller chunks...`,
              );
              const chunkLogs = await this.distributeBatchInChunks(
                fromBlock,
                toBlock,
                leaf,
                proof,
                batchNumber,
                sessionId,
              );
              transactionLogs.push(...chunkLogs);
              continue;
            } else {
              const failedLog: TransactionLog = {
                type: 'distribute',
                hash: 'failed',
                blockNumber: 0,
                gasUsed: 0n,
                gasPrice: 0n,
                batchNumber,
                workerCount: leaf.recipients.length,
                duration: 0,
                status: 'failed',
                error: gasSimulation.error,
              };
              transactionLogs.push(failedLog);
              throw new Error(
                `Single worker batch failed simulation: ${gasSimulation.error}`,
              );
            }
          }
        }

        const { request } = await this.publicClient.simulateContract({
          account: this.walletClient.account,
          address: this.contractAddress,
          abi: this.contractAbi,
          functionName: 'distribute',
          args: [
            [BigInt(fromBlock), BigInt(toBlock)],
            leaf.recipients,
            leaf.workerRewards,
            leaf.stakerRewards,
            proof as `0x${string}`[],
          ],
        });

        const hash = await this.walletClient.writeContract(request);

        batchCtx.logger.info(
          `📤 [${sessionId}] Batch ${batchNumber} TX submitted: ${hash}`,
        );

        const receipt = await this.publicClient.waitForTransactionReceipt({
          hash,
        });

        const duration = Date.now() - batchStartTime;

        batchCtx.logger.info(
          `✅ [${sessionId}] Batch ${batchNumber}/${merkleTree.totalBatches} distributed successfully! Block: ${receipt.blockNumber.toString()}, Gas: ${receipt.gasUsed.toString()}, Duration: ${duration}ms`,
        );

        const log: TransactionLog = {
          type: 'distribute',
          hash: receipt.transactionHash,
          blockNumber: Number(receipt.blockNumber),
          gasUsed: receipt.gasUsed,
          gasPrice: receipt.effectiveGasPrice || 0n,
          batchNumber,
          workerCount: leaf.recipients.length,
          duration,
          status: 'success',
        };
        transactionLogs.push(log);
      } catch (error) {
        let errorMessage: string;
        let errorContext: Record<string, any> = {};

        if (error instanceof BaseError) {
          errorMessage = this.errorDecoder.formatError(error, batchCtx);
          errorContext = this.errorDecoder.getErrorContext(error, batchCtx);

          if (
            this.errorDecoder.isSpecificError(error, 'BatchAlreadyProcessed')
          ) {
            batchCtx.logger.warn(
              `⚠️ [${sessionId}] Batch ${batchNumber} already processed - skipping`,
            );
            continue;
          }

          if (this.errorDecoder.isSpecificError(error, 'InvalidMerkleProof')) {
            batchCtx.logger.warn(
              `⚠️ [${sessionId}] invalid merkle proof detected, attempting recovery from s3 and retry`,
            );
            const recovered = await this.recoverMerkleTreeFromS3(
              batchCtx,
              fromBlock,
              toBlock,
            );
            if (recovered && recovered.root === merkleTree.root) {
              const retryLeaf = recovered.leaves[i];
              const retryProof = recovered.proofs[i];
              try {
                const { request } = await this.publicClient.simulateContract({
                  account: this.walletClient.account,
                  address: this.contractAddress,
                  abi: this.contractAbi,
                  functionName: 'distribute',
                  args: [
                    [BigInt(fromBlock), BigInt(toBlock)],
                    retryLeaf.recipients,
                    retryLeaf.workerRewards,
                    retryLeaf.stakerRewards,
                    retryProof as `0x${string}`[],
                  ],
                });
                const hash = await this.walletClient.writeContract(request);
                const receipt =
                  await this.publicClient.waitForTransactionReceipt({ hash });
                const duration = Date.now() - batchStartTime;
                const log: TransactionLog = {
                  type: 'distribute',
                  hash: receipt.transactionHash,
                  blockNumber: Number(receipt.blockNumber),
                  gasUsed: receipt.gasUsed,
                  gasPrice: receipt.effectiveGasPrice || 0n,
                  batchNumber,
                  workerCount: retryLeaf.recipients.length,
                  duration,
                  status: 'success',
                };
                transactionLogs.push(log);
                continue;
              } catch (retryErr) {
                // fall through to normal failure handling
                errorMessage = this.errorDecoder.formatError(
                  retryErr as BaseError,
                  batchCtx,
                );
              }
            }
          }
        } else {
          errorMessage = String(error?.message || error);
        }

        batchCtx.logger.error(
          { errorContext },
          `❌ [${sessionId}] Failed to distribute batch ${batchNumber}/${merkleTree.totalBatches}: ${errorMessage}`,
        );

        const failedLog: TransactionLog = {
          type: 'distribute',
          hash: 'failed',
          blockNumber: 0,
          gasUsed: 0n,
          gasPrice: 0n,
          batchNumber,
          workerCount: leaf.recipients.length,
          duration: 0,
          status: 'failed',
          error: errorMessage,
        };
        transactionLogs.push(failedLog);
        throw error;
      }
    }

    batchCtx.logger.info(
      `🎉 [${sessionId}] All ${merkleTree.totalBatches} batches distributed successfully`,
    );

    return transactionLogs;
  }

  private async distributeBatchInChunks(
    fromBlock: number,
    toBlock: number,
    originalLeaf: {
      recipients: bigint[];
      workerRewards: bigint[];
      stakerRewards: bigint[];
    },
    originalProof: string[],
    batchNumber: number,
    sessionId: string,
  ): Promise<TransactionLog[]> {
    // do not split a committed leaf -> proofs are for the full leaf
    const chunkCtxPre = new TaskContext(`distribution:chunks-${sessionId}`);
    chunkCtxPre.logger.warn(
      `⚠️ [${sessionId}] refusing to split batch ${batchNumber} as it invalidates merkle proofs; falling back to direct attempt`,
    );
    throw new Error(
      'cannot split committed leaf without rebuilding merkle tree',
    );
    // unreachable
  }

  async getDistributionStatus(
    fromBlock: number,
    toBlock: number,
  ): Promise<any> {
    const statusCtx = new TaskContext('distribution:status');

    try {
      const key = this.generateCommitmentKey(fromBlock, toBlock);

      const commitment = await this.publicClient.readContract({
        address: this.contractAddress,
        abi: this.contractAbi,
        functionName: 'commitments',
        args: [key],
      });

      return {
        exists: commitment[0],
        merkleRoot: commitment[1],
        totalBatches: commitment[2],
        processedBatches: commitment[3],
        approvalCount: commitment[4],
        ipfsLink: commitment[5],
      };
    } catch (error) {
      statusCtx.logger.error(
        `Failed to get distribution status: ${error.message}`,
      );
      throw error;
    }
  }

  private generateCommitmentKey(
    fromBlock: number,
    toBlock: number,
  ): `0x${string}` {
    return this.commitmentKeyService.generateKey(fromBlock, toBlock);
  }

  private logGasOptimizationSummary(gasOptimizations: {
    originalBatchSize: number;
    finalBatchSize: number;
    batchesAdjusted: number;
    totalGasSimulations: number;
  }): void {
    const gasCtx = new TaskContext('distribution:gas-summary');

    gasCtx.logger.debug(`📊 Gas Optimization Summary:`);
    gasCtx.logger.debug(
      `   - Original batch size: ${gasOptimizations.originalBatchSize} workers`,
    );
    gasCtx.logger.debug(
      `   - Final batch size: ${gasOptimizations.finalBatchSize} workers`,
    );
    gasCtx.logger.debug(
      `   - Batches adjusted: ${gasOptimizations.batchesAdjusted}`,
    );
    gasCtx.logger.debug(
      `   - Total gas simulations: ${gasOptimizations.totalGasSimulations}`,
    );

    if (
      gasOptimizations.originalBatchSize !== gasOptimizations.finalBatchSize
    ) {
      const reduction = (
        ((gasOptimizations.originalBatchSize -
          gasOptimizations.finalBatchSize) /
          gasOptimizations.originalBatchSize) *
        100
      ).toFixed(1);
      gasCtx.logger.debug(`   - Batch size reduction: ${reduction}%`);
    }
  }

  async getClaimableRewards(workerAddress: Address): Promise<bigint> {
    return 0n;
  }

  /**
   * Generate Merkle tree only (for approval phase)
   */
  async generateMerkleTreeOnly(
    workers: Array<{
      workerId: bigint;
      workerReward: bigint;
      stakerReward: bigint;
    }>,
    batchSize: number = this.distributionBatchSize,
  ): Promise<MerkleTreeResult> {
    const ctx = new TaskContext('distribution:generate-merkle-only');
    ctx.logger.info(
      `🌳 Generating Merkle tree for ${workers.length} workers (approval phase)`,
    );

    return await this.merkleTreeService.generateMerkleTree(workers, batchSize);
  }

  /**
   * Commit root only (for approval phase)
   */
  async commitRootOnly(
    fromBlock: number,
    toBlock: number,
    merkleRoot: string,
    totalBatches: number,
    ipfsLink: string = '',
    workersData?: WorkerReward[],
    merkleTree?: any,
    explicitBatchSize?: number,
  ): Promise<CommitResult> {
    const ctx = new TaskContext(
      `distribution:commit-root-only:${fromBlock}-${toBlock}`,
    );
    const sessionStartTime = Date.now();

    try {
      ctx.logger.info(
        `🔐 Committing Merkle root for blocks ${fromBlock}-${toBlock}`,
      );
      ctx.logger.info(`   Root: ${merkleRoot}`);
      ctx.logger.info(`   Batches: ${totalBatches}`);

      // Generate session ID for this commit operation
      const sessionId = generateSessionId();

      // Use the existing commitMerkleRoot method (this uploads to S3 when workers/merkle are provided)
      const transactionLog = await this.commitMerkleRoot(
        fromBlock,
        toBlock,
        merkleRoot,
        totalBatches,
        sessionId,
        workersData,
        merkleTree,
        explicitBatchSize,
      );

      if (transactionLog && transactionLog.status === 'success') {
        ctx.logger.info(
          `✅ Merkle root committed successfully: ${transactionLog.hash}`,
        );
        return {
          success: true,
          txHash: transactionLog.hash,
          blockNumber: transactionLog.blockNumber,
          gasUsed: transactionLog.gasUsed,
          gasPrice: transactionLog.gasPrice,
          sessionId,
        };
      } else {
        ctx.logger.error('Failed to commit Merkle root');
        return { success: false, sessionId };
      }
    } catch (error) {
      ctx.logger.error(`❌ Failed to commit root: ${error.message}`);
      return { success: false };
    }
  }

  async uploadEpochDataToS3(
    fromBlock: number,
    toBlock: number,
    merkleRoot: string,
    totalBatches: number,
    workersData: WorkerReward[],
    merkleTree: any,
    explicitBatchSize?: number,
  ): Promise<string> {
    const sessionId = generateSessionId();
    const sessionStartTime = Date.now();
    return this.prepareAndUploadToS3(
      fromBlock,
      toBlock,
      merkleRoot,
      totalBatches,
      workersData,
      merkleTree,
      sessionStartTime,
      sessionId,
      explicitBatchSize,
    );
  }

  /**
   * Get approved epochs ready for distribution
   */
  async getApprovedEpochsForDistribution(): Promise<
    Array<{
      fromBlock: number;
      toBlock: number;
      merkleRoot: string;
      totalBatches: number;
      processedBatches: number;
    }>
  > {
    const ctx = new TaskContext('distribution:get-approved-epochs');

    try {
      ctx.logger.debug('Checking for approved epochs ready for distribution');

      const rewardsDistributionAddress = this.configService.get(
        'blockchain.contracts.rewardsDistribution',
      ) as Address;

      const contract = getContract({
        address: rewardsDistributionAddress,
        abi: DistributedRewardsDistributionABI,
        client: this.web3Service.client,
      });

      const approvedEpochs: Array<{
        fromBlock: number;
        toBlock: number;
        merkleRoot: string;
        totalBatches: number;
        processedBatches: number;
      }> = [];

      const lastCommitmentKey = await contract.read.lastCommitmentKey();

      if (
        !lastCommitmentKey ||
        lastCommitmentKey ===
          '0x0000000000000000000000000000000000000000000000000000000000000000'
      ) {
        ctx.logger.debug('No commitments found in contract');
        return [];
      }

      try {
        const commitment = await contract.read.commitments([lastCommitmentKey]);

        const [
          status,
          fromBlock,
          toBlock,
          merkleRoot,
          totalBatches,
          processedBatches,
          approvalCount,
          ipfsLink,
        ] = commitment;

        ctx.logger.debug(
          `Latest commitment ${fromBlock}-${toBlock}: status=${status}, approvals=${approvalCount}, batches=${processedBatches}/${totalBatches}`,
        );

        if (
          status === 1 && // ACTIVE status
          approvalCount > 0n && // has approvals
          processedBatches < totalBatches // not fully distributed
        ) {
          approvedEpochs.push({
            fromBlock: Number(fromBlock),
            toBlock: Number(toBlock),
            merkleRoot: merkleRoot as string,
            totalBatches: Number(totalBatches),
            processedBatches: Number(processedBatches),
          });

          ctx.logger.debug(
            `✅ Found approved epoch ready for distribution: ${fromBlock}-${toBlock} ` +
              `(${processedBatches}/${totalBatches} batches processed)`,
          );
        } else {
          ctx.logger.debug(
            `❌ Latest commitment not ready for distribution: status=${status}, approvals=${approvalCount}, fully_distributed=${processedBatches >= totalBatches}`,
          );
        }
      } catch (error) {
        ctx.logger.warn(`Failed to check latest commitment: ${error.message}`);
      }

      if (approvedEpochs.length > 0) {
        ctx.logger.info(
          `📊 Found ${approvedEpochs.length} approved epochs ready for distribution`,
        );
      } else {
        ctx.logger.debug('No approved epochs ready for distribution');
      }

      return approvedEpochs;
    } catch (error) {
      ctx.logger.error(`Failed to get approved epochs: ${error.message}`);
      return [];
    }
  }

  /**
   * Distribute an already approved epoch using its Merkle root
   */
  async distributeApprovedEpoch(
    fromBlock: number,
    toBlock: number,
    merkleRoot: string,
  ): Promise<boolean> {
    const ctx = new TaskContext(
      `distribution:distribute-approved:${fromBlock}-${toBlock}`,
    );
    const sessionStartTime = Date.now();

    try {
      ctx.logger.info(`🚀 Distributing approved epoch ${fromBlock}-${toBlock}`);
      ctx.logger.info(`   Using Merkle root: ${merkleRoot}`);

      // Recalculate rewards to get the same Merkle tree structure
      const result =
        await this.rewardsCalculatorService.calculateRewardsDetailed(
          ctx,
          fromBlock,
          toBlock,
          true, // skip signature validation
        );

      if (result.workers.length === 0) {
        ctx.logger.warn('No workers found for approved epoch distribution');
        return true;
      }

      const merkleTree = await this.merkleTreeService.generateMerkleTree(
        result.workers,
        this.distributionBatchSize,
      );

      // Prepare formatted calculation result for S3 upload
      let formattedCalculationResult;
      try {
        formattedCalculationResult =
          await this.rewardsCalculatorService.calculateRewardsFormatted(
            ctx,
            fromBlock,
            toBlock,
            true,
          );
      } catch (formatError) {
        ctx.logger.warn(
          `Failed to format calculation result: ${formatError.message}`,
        );
      }

      if (merkleTree.root !== merkleRoot) {
        ctx.logger.error(
          `Merkle root mismatch! Expected: ${merkleRoot}, Got: ${merkleTree.root}`,
        );

        ctx.logger.info('🔄 Attempting to recover Merkle tree from S3...');
        const recoveredTree = await this.recoverMerkleTreeFromS3(
          ctx,
          fromBlock,
          toBlock,
        );

        if (recoveredTree && recoveredTree.root === merkleRoot) {
          ctx.logger.info('✅ Successfully recovered Merkle tree from S3');

          const sessionId = generateSessionId();
          const distributionLogs = await this.distributeBatches(
            fromBlock,
            toBlock,
            recoveredTree,
            sessionId,
          );

          ctx.logger.info(
            `✅ Distribution completed using recovered Merkle tree from S3`,
          );
          ctx.logger.info(
            `   Total batches distributed: ${distributionLogs.length}`,
          );

          return true;
        } else {
          ctx.logger.error('❌ Failed to recover valid Merkle tree from S3');
          return false;
        }
      }

      const sessionId = generateSessionId();
      const distributionLogs = await this.distributeBatches(
        fromBlock,
        toBlock,
        merkleTree,
        sessionId,
      );

      const allSuccessful = distributionLogs.every(
        (log) => log.status === 'success',
      );

      if (allSuccessful) {
        ctx.logger.info(
          `✅ Successfully distributed all ${merkleTree.totalBatches} batches`,
        );

        try {
          const formattedCalculationResult =
            await this.rewardsCalculatorService.calculateRewardsFormatted(
              ctx,
              fromBlock,
              toBlock,
              true,
            );

          const startTime = new Date(sessionStartTime);
          const endTime = new Date();
          const networkMetrics =
            await this.epochMetricsService.collectNetworkMetrics(ctx);
          const rewardMetrics = this.epochMetricsService.extractRewardMetrics(
            formattedCalculationResult,
          );
          const commitTxHash = '';

          await this.rewardsReporterService.logSuccessfulRewardsReport({
            epochStart: startTime,
            epochEnd: endTime,
            isCommitSuccess: true,
            commitTxHash,
            networkMetrics,
            rewardMetrics,
            workerRewards: formattedCalculationResult.workers,
          });
        } catch (reportError) {
          ctx.logger.warn(
            { error: reportError },
            'failed to generate rewards report for approved epoch',
          );
        }

        return true;
      } else {
        const failedBatches = distributionLogs.filter(
          (log) => log.status === 'failed',
        ).length;
        ctx.logger.error(
          `❌ Failed to distribute ${failedBatches} out of ${merkleTree.totalBatches} batches`,
        );
        return false;
      }
    } catch (error) {
      ctx.logger.error(`Failed to distribute approved epoch: ${error.message}`);
      return false;
    }
  }

  /**
   * Distribute only the remaining batches during recovery
   */
  private async distributeRemainingBatches(
    fromBlock: number,
    toBlock: number,
    merkleTree: MerkleTreeResult,
    remainingBatchIndices: number[],
    sessionId: string,
  ): Promise<TransactionLog[]> {
    const batchCtx = new TaskContext(
      `distribution:remaining-batches-${sessionId}`,
    );

    batchCtx.logger.info(
      `📦 [${sessionId}] Distributing ${remainingBatchIndices.length} remaining batches`,
    );

    const transactionLogs: TransactionLog[] = [];

    // Generate proofs for all leaves first
    const leafHashes = merkleTree.leaves.map((leaf) => leaf.leafHash);
    const { proofs } = this.merkleTreeService['buildMerkleTree'](leafHashes);

    for (const batchIndex of remainingBatchIndices) {
      const leaf = merkleTree.leaves[batchIndex];
      const proof = proofs[batchIndex];
      const batchNumber = batchIndex + 1;
      const batchStartTime = Date.now();

      try {
        batchCtx.logger.info(
          `📋 [${sessionId}] Processing batch ${batchNumber}/${merkleTree.totalBatches} (index ${batchIndex})`,
        );

        // Get rewards sums for this batch
        const totalWorkerRewards = leaf.workerRewards.reduce(
          (sum, reward) => sum + reward,
          0n,
        );
        const totalStakerRewards = leaf.stakerRewards.reduce(
          (sum, reward) => sum + reward,
          0n,
        );

        batchCtx.logger.debug(
          `💰 [${sessionId}] Batch ${batchNumber}: ${leaf.recipients.length} workers, ${formatAmount(totalWorkerRewards)} worker rewards, ${formatAmount(totalStakerRewards)} staker rewards`,
        );

        // Gas simulation
        if (this.gasSimulationConfig.enablePreflightSimulation) {
          const simulation = await this.simulateDistribution(
            fromBlock,
            toBlock,
            leaf.recipients,
            leaf.workerRewards,
            leaf.stakerRewards,
            proof as `0x${string}`[],
          );

          if (!simulation.success) {
            batchCtx.logger.error(
              `❌ [${sessionId}] Batch ${batchNumber} simulation failed: ${simulation.error}`,
            );
            throw new Error(`Gas simulation failed: ${simulation.error}`);
          }

          batchCtx.logger.debug(
            `⛽ [${sessionId}] Batch ${batchNumber} gas estimate: ${simulation.estimatedGas}`,
          );
        }

        // Execute distribution
        const request = {
          account: this.walletClient.account,
          address: this.contractAddress,
          abi: this.contractAbi,
          functionName: 'distribute',
          args: [
            [BigInt(fromBlock), BigInt(toBlock)],
            leaf.recipients,
            leaf.workerRewards,
            leaf.stakerRewards,
            proof as `0x${string}`[],
          ],
        };

        const hash = await this.walletClient.writeContract(request);

        batchCtx.logger.info(
          `📤 [${sessionId}] Batch ${batchNumber} TX submitted: ${hash}`,
        );

        const receipt = await this.publicClient.waitForTransactionReceipt({
          hash,
        });

        const duration = Date.now() - batchStartTime;

        batchCtx.logger.info(
          `✅ [${sessionId}] Batch ${batchNumber}/${merkleTree.totalBatches} distributed successfully! Block: ${receipt.blockNumber.toString()}, Gas: ${receipt.gasUsed.toString()}, Duration: ${duration}ms`,
        );

        const log: TransactionLog = {
          type: 'distribute',
          hash,
          blockNumber: Number(receipt.blockNumber),
          gasUsed: receipt.gasUsed,
          gasPrice: receipt.effectiveGasPrice || 0n,
          batchNumber,
          workerCount: leaf.recipients.length,
          duration,
          status: 'success',
        };
        transactionLogs.push(log);
      } catch (error) {
        const errorStr = String(error?.message || error);
        batchCtx.logger.error(
          `❌ [${sessionId}] Failed to distribute batch ${batchNumber}/${merkleTree.totalBatches}: ${errorStr}`,
        );

        const failedLog: TransactionLog = {
          type: 'distribute',
          hash: 'failed',
          blockNumber: 0,
          gasUsed: 0n,
          gasPrice: 0n,
          batchNumber,
          workerCount: leaf.recipients.length,
          duration: Date.now() - batchStartTime,
          status: 'failed',
          error: errorStr,
        };
        transactionLogs.push(failedLog);

        // Don't continue with remaining batches if one fails
        throw error;
      }
    }

    return transactionLogs;
  }

  private async recoverMerkleTreeFromS3(
    ctx: TaskContext,
    fromBlock: number,
    toBlock: number,
  ): Promise<any | null> {
    try {
      const networkName = this.configService.get(
        'blockchain.network.name',
        'arbitrum',
      );
      let s3Key = this.s3Service.generateS3Key(networkName, fromBlock, toBlock);
      ctx.logger.info(`📥 Attempting to download epoch data from S3: ${s3Key}`);

      if (!this.s3Service) {
        ctx.logger.warn('S3 service not configured, cannot recover from S3');
        return null;
      }

      // try primary key
      let epochRewardsData = await this.s3Service.downloadJson(s3Key);
      // fallback: try alternate local naming if not found
      if (
        !epochRewardsData &&
        (networkName === 'localhost' || networkName === 'local')
      ) {
        const altNetwork = networkName === 'localhost' ? 'local' : 'localhost';
        const altKey = this.s3Service.generateS3Key(
          altNetwork,
          fromBlock,
          toBlock,
        );
        const exists = await this.s3Service.checkFileExists(altKey);
        if (exists) {
          ctx.logger.warn(
            `⚠️ primary key not found, trying alternate network key: ${altKey}`,
          );
          s3Key = altKey;
          epochRewardsData = await this.s3Service.downloadJson(altKey);
        }
      }

      if (!epochRewardsData) {
        ctx.logger.warn('No epoch rewards data found in S3');
        return null;
      }

      if (
        !epochRewardsData.rawData ||
        !epochRewardsData.rawData.workers ||
        !epochRewardsData.merkleTree
      ) {
        ctx.logger.error(
          'Invalid epoch rewards data structure in S3 - missing worker data or merkle tree info',
        );
        return null;
      }

      if (!epochRewardsData.merkleTree.batchSize) {
        ctx.logger.error('Missing batchSize in stored merkle tree data');
        return null;
      }

      ctx.logger.info(
        `🔧 Recreating Merkle tree from ${epochRewardsData.rawData.workers.length} workers`,
      );
      ctx.logger.info(
        `   Using batch size: ${epochRewardsData.merkleTree.batchSize}`,
      );

      const workers = epochRewardsData.rawData.workers.map((w: any) => ({
        workerId: BigInt(w.workerId),
        workerReward: BigInt(w.workerReward),
        stakerReward: BigInt(w.stakerReward),
      }));

      const recreatedTree = await this.merkleTreeService.generateMerkleTree(
        workers,
        epochRewardsData.merkleTree.batchSize,
      );

      ctx.logger.info(`✅ Successfully recreated Merkle tree from S3 data`);
      ctx.logger.info(`   Recreated root: ${recreatedTree.root}`);
      ctx.logger.info(`   Expected root: ${epochRewardsData.merkleTree.root}`);
      ctx.logger.info(`   Total batches: ${recreatedTree.totalBatches}`);
      ctx.logger.info(`   Leaves: ${recreatedTree.leaves.length}`);

      if (recreatedTree.root !== epochRewardsData.merkleTree.root) {
        ctx.logger.error(
          '❌ Recreated Merkle tree root does not match stored root',
        );
        ctx.logger.error(
          `   This indicates data corruption or calculation inconsistency`,
        );
        return null;
      }

      ctx.logger.info(`✅ Merkle tree verification successful - roots match`);

      return recreatedTree;
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to recover Merkle tree from S3');

      ctx.logger.info(
        '🔄 Attempting to recover from contract commitment data...',
      );

      try {
        const commitmentKey = this.commitmentKeyService.generateKey(
          fromBlock,
          toBlock,
        );
        const commitment = await this.publicClient.readContract({
          address: this.contractAddress,
          abi: this.contractAbi,
          functionName: 'commitments',
          args: [commitmentKey],
        });

        if (commitment && commitment[5]) {
          // ipfsLink is at index 5
          const ipfsLink = commitment[5] as string;
          ctx.logger.info(`📥 Found IPFS link in commitment: ${ipfsLink}`);

          ctx.logger.warn(
            'IPFS recovery not yet implemented, but link available for manual recovery',
          );
        }
      } catch (ipfsError) {
        ctx.logger.debug('No IPFS link available in commitment');
      }

      return null;
    }
  }

  private generateBatchProof(
    merkleTree: any,
    batchLeaves: any[],
  ): {
    recipients: number[];
    workerRewards: bigint[];
    stakerRewards: bigint[];
    merkleProof: `0x${string}`[];
  } {
    const recipients: number[] = [];
    const workerRewards: bigint[] = [];
    const stakerRewards: bigint[] = [];
    const merkleProofs: `0x${string}`[] = [];

    // Extract data from batch leaves
    for (const leaf of batchLeaves) {
      recipients.push(...leaf.recipients);
      workerRewards.push(...leaf.workerRewards);
      stakerRewards.push(...leaf.stakerRewards);

      const leafIndex = merkleTree.leaves.findIndex(
        (l: any) =>
          l.hash === leaf.hash || JSON.stringify(l) === JSON.stringify(leaf),
      );

      if (leafIndex >= 0 && merkleTree.proofs && merkleTree.proofs[leafIndex]) {
        merkleProofs.push(...merkleTree.proofs[leafIndex]);
      }
    }

    return {
      recipients,
      workerRewards,
      stakerRewards,
      merkleProof: merkleProofs,
    };
  }
}
