import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TaskContext, CommitmentKeyService } from '../../common';
import { Web3Service } from '../../blockchain/web3.service';
import { MerkleTreeService, MerkleTreeResult, MerkleLeaf } from './merkle-tree.service';
import {
  RewardsCalculatorService,
  WorkerReward,
} from '../calculation/rewards-calculator.service';
import { DistributionRecoveryService } from './distribution-recovery.service';
import { ErrorDecoderService } from '../../blockchain/error-decoder.service';
import { RewardsReporterService } from '../../epochs/services/rewards-reporter.service';
import { EpochMetricsService } from '../../epochs/services/epoch-metrics.service';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseAbiItem,
  getContract,
  Address,
  encodeFunctionData,
  BaseError,
} from 'viem';
import { arbitrum, foundry } from 'viem/chains';
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
  }

  async distributeEpochRewards(
    fromBlock: number,
    toBlock: number,
    batchSize: number = 50,
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
      
      // check for interrupted distribution
      const recoveryStatus = await this.recoveryService.checkInterruptedDistribution(
        startCtx,
        fromBlock,
        toBlock,
      );

      if (recoveryStatus.interrupted && recoveryStatus.commitment) {
        sessionCtx.logger.info(
          `🔄 Recovering interrupted distribution: ${recoveryStatus.commitment.processedBatches}/${recoveryStatus.commitment.totalBatches} batches already processed`,
        );

        // recover merkle tree and verify it matches
        const recoveredTree = await this.recoveryService.recoverMerkleTree(
          startCtx,
          fromBlock,
          toBlock,
          batchSize,
        );
        
        calculationResult = await this.rewardsCalculatorService.calculateRewardsDetailed(
          startCtx,
          fromBlock,
          toBlock,
          true,
        );

        const formattedCalculationResult =
          await this.rewardsCalculatorService.calculateRewardsFormatted(
            startCtx,
            fromBlock,
            toBlock,
            true,
          );

        // check which batches need processing
        const { remainingBatchIndices } = this.recoveryService.getProcessedAndRemainingBatches(
          recoveredTree.processedLeaves,
        );

        if (remainingBatchIndices.length === 0) {
          sessionCtx.logger.info('✅ All batches already processed, nothing to do');
          status.status = 'completed';
          status.totalBatches = recoveredTree.totalBatches;
          status.processedBatches = recoveredTree.totalBatches;
          status.completedAt = new Date();
          return status;
        }

        // skip to distribution phase with remaining batches
        sessionCtx.logger.info(
          `📦 Resuming distribution with ${remainingBatchIndices.length} remaining batches`,
        );

        status.status = 'distributing';
        status.totalBatches = recoveredTree.totalBatches;
        status.processedBatches = recoveredTree.totalBatches - remainingBatchIndices.length;

        // We need the full merkle tree to distribute remaining batches with correct proofs
        const fullMerkleTree: MerkleTreeResult = {
          root: recoveredTree.merkleRoot,
          leaves: recoveredTree.leaves,
          proofs: [], // These will be generated during distribution
          totalBatches: recoveredTree.totalBatches,
        };

        // Distribute only the remaining batches
        const distributionLogs = await this.distributeRemainingBatches(
          fromBlock,
          toBlock,
          fullMerkleTree,
          remainingBatchIndices,
          sessionId,
        );
        transactionLogs.push(...distributionLogs);

        status.processedBatches = recoveredTree.totalBatches;
        status.status = 'completed';
        status.completedAt = new Date();
        
        const sessionDuration = Date.now() - sessionStartTime;
        sessionCtx.logger.info(
          `✅ Resumed distribution completed successfully in ${(sessionDuration / 1000).toFixed(2)}s!`,
        );
        
        // generate structured rewards report for recovery path
        try {
          const summaryCtx = new TaskContext(`distribution:recovery-report-${sessionId}`);
          const startTime = new Date(sessionStartTime);
          const endTime = status.completedAt!;
          
          const networkMetrics = await this.epochMetricsService.collectNetworkMetrics(summaryCtx);
          
          const rewardMetrics = this.epochMetricsService.extractRewardMetrics(formattedCalculationResult);
          
          const commitTxHash = transactionLogs.find(log => log.type === 'commit')?.hash || '';
          
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
          sessionCtx.logger.warn({ error: reportError }, 'Failed to generate recovery rewards report');
        }
        
        return status;
      }

      // normal flow for new distribution
      startCtx.logger.debug(`🚀 Starting new distribution for epoch ${epochId}`);

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

      status.status = 'calculating';
      calculationResult =
        await this.rewardsCalculatorService.calculateRewardsDetailed(
          startCtx,
          fromBlock,
          toBlock,
          true,
        );

      const formattedCalculationResult =
        await this.rewardsCalculatorService.calculateRewardsFormatted(
          startCtx,
          fromBlock,
          toBlock,
          true,
        );

      startCtx.logger.debug(
        `✅ Calculated rewards for ${calculationResult.workers.length} workers from ClickHouse`,
      );

      const workerRewards = calculationResult.workers;

      status.totalWorkers = workerRewards.length;
      status.totalRewards = workerRewards.reduce(
        (sum, w) => sum + w.workerReward,
        0n,
      );

      startCtx.logger.debug(
        `✅ Mapped to ${status.totalWorkers} registered workers, total: ${formatAmount(status.totalRewards)}`,
      );

      status.status = 'generating_tree';
      let optimizedBatchSize = batchSize;
      let totalGasSimulations = 0;

      if (this.gasSimulationConfig.enablePreflightSimulation) {
        startCtx.logger.debug(`🔧 Optimizing batch size for gas efficiency...`);

        const optimizationResult = await this.optimizeBatchSize(
          fromBlock,
          toBlock,
          workerRewards,
          batchSize,
        );

        optimizedBatchSize = optimizationResult.optimizedBatchSize;
        totalGasSimulations = optimizationResult.gasSimulations;

        if (optimizedBatchSize !== batchSize) {
          startCtx.logger.warn(
            `⚠️ Batch size adjusted from ${batchSize} to ${optimizedBatchSize} based on gas simulation`,
          );
        } else {
          startCtx.logger.debug(
            `✅ Original batch size ${batchSize} is optimal`,
          );
        }
      } else {
        startCtx.logger.debug(
          `⚠️ Gas simulation disabled, using original batch size ${batchSize}`,
        );
      }

      status.gasOptimizations = {
        originalBatchSize: batchSize,
        finalBatchSize: optimizedBatchSize,
        batchesAdjusted: optimizedBatchSize !== batchSize ? 1 : 0,
        totalGasSimulations,
      };

      const merkleTree = await this.merkleTreeService.generateMerkleTree(
        workerRewards,
        optimizedBatchSize,
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
      );
      if (commitLog) {
        transactionLogs.push(commitLog);
      }

      startCtx.logger.debug(`✅ Committed Merkle root to contract`);

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
        const endTime = status.completedAt!;
        
        const networkMetrics = await this.epochMetricsService.collectNetworkMetrics(summaryCtx);
        
        const rewardMetrics = this.epochMetricsService.extractRewardMetrics(formattedCalculationResult);
        
        const commitTxHash = transactionLogs.find(log => log.type === 'commit')?.hash || '';
        
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
        summaryCtx.logger.warn({ error: reportError }, 'Failed to generate rewards report');
      }

      return status;
    } catch (error) {
      const sessionDuration = Date.now() - sessionStartTime;
      
      let errorMessage: string;
      if (error instanceof BaseError) {
        errorMessage = this.errorDecoder.formatError(error, sessionCtx);
        const errorContext = this.errorDecoder.getErrorContext(error, sessionCtx);
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
        const endTime = status.completedAt!;
        
        await this.rewardsReporterService.logFailedRewardsReport(
          sessionCtx,
          startTime,
          endTime,
          '',
          error
        );
      } catch (reportError) {
        sessionCtx.logger.warn({ error: reportError }, 'Failed to generate failed rewards report');
      }
      
      return status;
    }
  }

  private async commitMerkleRoot(
    fromBlock: number,
    toBlock: number,
    merkleRoot: string,
    totalBatches: number,
    sessionId: string,
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
      const ipfsLink = `ipfs://rewards-${fromBlock}-${toBlock}`;

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
          ipfsLink,
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
              errorContext.expectedFromBlock = (Number(lastBlockRewarded) + 1).toString();
            } catch (e) {
              commitCtx.logger.debug('Could not fetch lastBlockRewarded for additional context');
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

        const batchStartTime = Date.now();
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
          
          if (this.errorDecoder.isSpecificError(error, 'BatchAlreadyProcessed')) {
            batchCtx.logger.warn(
              `⚠️ [${sessionId}] Batch ${batchNumber} already processed - skipping`,
            );
            continue; 
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
    const chunkSize = Math.max(
      1,
      Math.floor(originalLeaf.recipients.length / 2),
    );
    const chunkCtx = new TaskContext(`distribution:chunks-${sessionId}`);

    chunkCtx.logger.info(
      `📦 [${sessionId}] Splitting batch ${batchNumber} into chunks of ${chunkSize} workers each`,
    );

    const chunkLogs: TransactionLog[] = [];

    for (
      let chunkStart = 0;
      chunkStart < originalLeaf.recipients.length;
      chunkStart += chunkSize
    ) {
      const chunkEnd = Math.min(
        chunkStart + chunkSize,
        originalLeaf.recipients.length,
      );

      const chunkRecipients = originalLeaf.recipients.slice(
        chunkStart,
        chunkEnd,
      );
      const chunkWorkerRewards = originalLeaf.workerRewards.slice(
        chunkStart,
        chunkEnd,
      );
      const chunkStakerRewards = originalLeaf.stakerRewards.slice(
        chunkStart,
        chunkEnd,
      );

      const chunkIndex = Math.floor(chunkStart / chunkSize) + 1;
      const totalChunks = Math.ceil(originalLeaf.recipients.length / chunkSize);

      chunkCtx.logger.info(
        `📦 [${sessionId}] Processing chunk ${chunkIndex}/${totalChunks} of batch ${batchNumber} with ${chunkRecipients.length} workers`,
      );

      try {
        const chunkSimulation = await this.simulateDistribution(
          fromBlock,
          toBlock,
          chunkRecipients,
          chunkWorkerRewards,
          chunkStakerRewards,
          originalProof,
        );

        if (!chunkSimulation.success) {
          chunkCtx.logger.error(
            `❌ [${sessionId}] Chunk ${chunkIndex} simulation failed: ${chunkSimulation.error}`,
          );

          if (chunkRecipients.length === 1) {
            chunkCtx.logger.error(
              `❌ [${sessionId}] Single worker chunk failed - skipping worker ${chunkRecipients[0].toString()}`,
            );

            const failedLog: TransactionLog = {
              type: 'distribute',
              hash: 'failed',
              blockNumber: 0,
              gasUsed: 0n,
              gasPrice: 0n,
              batchNumber,
              workerCount: 1,
              duration: 0,
              status: 'failed',
              error: chunkSimulation.error,
            };
            chunkLogs.push(failedLog);
            continue;
          } else {
            const recursiveLogs = await this.distributeBatchInChunks(
              fromBlock,
              toBlock,
              {
                recipients: chunkRecipients,
                workerRewards: chunkWorkerRewards,
                stakerRewards: chunkStakerRewards,
              },
              originalProof,
              batchNumber,
              sessionId,
            );
            chunkLogs.push(...recursiveLogs);
            continue;
          }
        }

        const chunkStartTime = Date.now();
        const { request } = await this.publicClient.simulateContract({
          account: this.walletClient.account,
          address: this.contractAddress,
          abi: this.contractAbi,
          functionName: 'distribute',
          args: [
            [BigInt(fromBlock), BigInt(toBlock)],
            chunkRecipients,
            chunkWorkerRewards,
            chunkStakerRewards,
            originalProof as `0x${string}`[],
          ],
        });

        const hash = await this.walletClient.writeContract(request);

        chunkCtx.logger.info(
          `📤 [${sessionId}] Chunk ${chunkIndex} TX submitted: ${hash}`,
        );

        const receipt = await this.publicClient.waitForTransactionReceipt({
          hash,
        });

        const duration = Date.now() - chunkStartTime;

        chunkCtx.logger.info(
          `✅ [${sessionId}] Chunk ${chunkIndex}/${totalChunks} of batch ${batchNumber} distributed! Block: ${receipt.blockNumber.toString()}, Gas: ${receipt.gasUsed.toString()}, Duration: ${duration}ms`,
        );

        const log: TransactionLog = {
          type: 'distribute',
          hash: receipt.transactionHash,
          blockNumber: Number(receipt.blockNumber),
          gasUsed: receipt.gasUsed,
          gasPrice: receipt.effectiveGasPrice || 0n,
          batchNumber,
          workerCount: chunkRecipients.length,
          duration,
          status: 'success',
        };
        chunkLogs.push(log);
      } catch (error) {
        const errorStr = String(error?.message || error);
        chunkCtx.logger.error(
          `❌ [${sessionId}] Failed to distribute chunk ${chunkIndex} of batch ${batchNumber}: ${errorStr}`,
        );

        const failedLog: TransactionLog = {
          type: 'distribute',
          hash: 'failed',
          blockNumber: 0,
          gasUsed: 0n,
          gasPrice: 0n,
          batchNumber,
          workerCount: chunkRecipients.length,
          duration: 0,
          status: 'failed',
          error: errorStr,
        };
        chunkLogs.push(failedLog);
        throw error;
      }
    }

    return chunkLogs;
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
    batchSize: number = 50,
  ): Promise<MerkleTreeResult> {
    const ctx = new TaskContext('distribution:generate-merkle-only');
    ctx.logger.info(`🌳 Generating Merkle tree for ${workers.length} workers (approval phase)`);

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
  ): Promise<boolean> {
    const ctx = new TaskContext(`distribution:commit-root-only:${fromBlock}-${toBlock}`);
    
    try {
      ctx.logger.info(`🔐 Committing Merkle root for blocks ${fromBlock}-${toBlock}`);
      ctx.logger.info(`   Root: ${merkleRoot}`);
      ctx.logger.info(`   Batches: ${totalBatches}`);

      // Generate session ID for this commit operation
      const sessionId = generateSessionId();
      
      // Use the existing commitMerkleRoot method
      const transactionLog = await this.commitMerkleRoot(fromBlock, toBlock, merkleRoot, totalBatches, sessionId);
      
      if (transactionLog && transactionLog.status === 'success') {
        ctx.logger.info(`✅ Merkle root committed successfully: ${transactionLog.hash}`);
        return true;
      } else {
        ctx.logger.error('Failed to commit Merkle root');
        return false;
      }
    } catch (error) {
      ctx.logger.error(`❌ Failed to commit root: ${error.message}`);
      return false;
    }
  }

  /**
   * Get approved epochs ready for distribution
   */
  async getApprovedEpochsForDistribution(): Promise<Array<{
    fromBlock: number;
    toBlock: number;
    merkleRoot: string;
    totalBatches: number;
    processedBatches: number;
  }>> {
    const ctx = new TaskContext('distribution:get-approved-epochs');
    
    try {
      ctx.logger.debug('Checking for approved epochs ready for distribution');
      
      // Get commitments that are ACTIVE (status=1) and approved but not fully distributed
      const rewardsDistributionAddress = this.configService.get(
        'blockchain.contracts.rewardsDistribution',
      ) as Address;

      // Get all commitment events
      const commitmentLogs = await this.web3Service.client.getLogs({
        address: rewardsDistributionAddress,
        event: parseAbiItem(
          `event NewCommitment(address indexed committer, uint256 fromBlock, uint256 toBlock, bytes32 merkleRoot)`,
        ),
        fromBlock: 1n,
      });

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
      
      for (const log of commitmentLogs) {
        if (!log.args?.fromBlock || !log.args?.toBlock) continue;

        const { fromBlock, toBlock, merkleRoot } = log.args;
        const commitmentKey = this.commitmentKeyService.generateKeyFromBigInt(fromBlock, toBlock);

        try {
          const commitment = await contract.read.commitments([commitmentKey]);
          
          // Destructure tuple: [status, fromBlock, toBlock, merkleRoot, totalBatches, processedBatches, approvalCount, ipfsLink]
          const [status, , , , totalBatches, processedBatches, approvalCount] = commitment;
          
          // Check if commitment is ACTIVE (1), approved (approvalCount > 0), and not fully distributed
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
              `Found approved epoch ${fromBlock}-${toBlock}: ` +
              `${processedBatches}/${totalBatches} batches processed`
            );
          }
        } catch (error) {
          ctx.logger.debug(`failed to get commitment info for ${fromBlock}-${toBlock}: ${error.message}`);
        }
      }

      if (approvedEpochs.length > 0) {
        ctx.logger.info(`📊 Found ${approvedEpochs.length} approved epochs ready for distribution`);
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
    const ctx = new TaskContext(`distribution:distribute-approved:${fromBlock}-${toBlock}`);
    
    try {
      ctx.logger.info(`🚀 Distributing approved epoch ${fromBlock}-${toBlock}`);
      ctx.logger.info(`   Using Merkle root: ${merkleRoot}`);

      // Recalculate rewards to get the same Merkle tree structure
      const result = await this.rewardsCalculatorService.calculateRewardsDetailed(
        ctx,
        fromBlock,
        toBlock,
        true, // skip signature validation
      );

      if (result.workers.length === 0) {
        ctx.logger.warn('No workers found for approved epoch distribution');
        return true;
      }

      // Generate the same Merkle tree
      const merkleTree = await this.merkleTreeService.generateMerkleTree(result.workers, 50);
      
      // Verify the root matches
      if (merkleTree.root !== merkleRoot) {
        ctx.logger.error(`Merkle root mismatch! Expected: ${merkleRoot}, Got: ${merkleTree.root}`);
        return false;
      }

      // Distribute all batches
      const sessionId = generateSessionId();
      const distributionLogs = await this.distributeBatches(fromBlock, toBlock, merkleTree, sessionId);
      
      const allSuccessful = distributionLogs.every(log => log.status === 'success');
      
      if (allSuccessful) {
        ctx.logger.info(`✅ Successfully distributed all ${merkleTree.totalBatches} batches`);
        return true;
      } else {
        const failedBatches = distributionLogs.filter(log => log.status === 'failed').length;
        ctx.logger.error(`❌ Failed to distribute ${failedBatches} out of ${merkleTree.totalBatches} batches`);
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
    const batchCtx = new TaskContext(`distribution:remaining-batches-${sessionId}`);

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
}
