import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TaskContext, CommitmentKeyService } from '../../common';
import { ContractService } from '../../blockchain/contract.service';
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

function formatAmount(amount: bigint): string {
  const sqdAmount = (Number(amount) / 1e18).toFixed(6);
  return `${amount.toString()} wei (${sqdAmount} SQD)`;
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

  readonly distributionBatchSize = parseInt(
    process.env.DISTRIBUTION_BATCH_SIZE || '75',
  );

  constructor(
    private configService: ConfigService,
    private contractService: ContractService,
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

    const initCtx = new TaskContext('distribution:init');
    initCtx.logger.debug(
      `Distribution service initialized with contract: ${this.contractAddress}`,
    );
    initCtx.logger.debug(`Using distributor address: ${account.address}`);
    initCtx.logger.debug(`RPC URL: ${rpcUrl}`);
    initCtx.logger.debug(
      `Distribution batch size: ${this.distributionBatchSize}`,
    );
  }

  // ────────────────────────────────────────────────────────────
  // Main entry point — dispatches to executeDistribution or resumeDistribution
  // ────────────────────────────────────────────────────────────

  async distributeEpochRewards(
    fromBlock: number,
    toBlock: number,
    batchSize: number = this.distributionBatchSize,
    batchNumber?: number,
    totalBatches?: number,
  ): Promise<DistributionStatus> {
    const epochId = `${fromBlock}-${toBlock}`;
    const sessionId = generateSessionId();
    const sessionStartTime = Date.now();
    const sessionCtx = new TaskContext(`distribution:session-${sessionId}`);

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
      transactionLogs: [],
    };

    try {
      sessionCtx.logger.info(
        `Starting distribution session ${sessionId} for epoch ${epochId}`,
      );

      // Check for existing commitment (8-field V2 ABI)
      const commitmentKey = this.generateCommitmentKey(fromBlock, toBlock);
      let existingCommitment: {
        merkleRoot: string;
        totalBatches: number;
        processedBatches: number;
        approvalCount: bigint;
      } | null = null;

      try {
        const commitment = await this.publicClient.readContract({
          address: this.contractAddress,
          abi: DistributedRewardsDistributionABI,
          functionName: 'commitments',
          args: [commitmentKey],
        });

        // V2 8-field: [status, fromBlock, toBlock, merkleRoot, totalBatches, processedBatches, approvalCount, ipfsLink]
        const cStatus = Number(commitment[0]);
        if (cStatus !== 0) {
          existingCommitment = {
            merkleRoot: commitment[3] as string,
            totalBatches: Number(commitment[4]),
            processedBatches: Number(commitment[5]),
            approvalCount: commitment[6] as bigint,
          };
          sessionCtx.logger.info(
            `Found existing commitment for epoch ${epochId}: root=${existingCommitment.merkleRoot}, batches=${existingCommitment.processedBatches}/${existingCommitment.totalBatches}`,
          );
        }
      } catch (error) {
        sessionCtx.logger.debug(
          `No existing commitment found: ${(error as Error).message}`,
        );
      }

      let result: DistributionStatus;
      if (existingCommitment) {
        result = await this.resumeDistribution(
          fromBlock,
          toBlock,
          batchSize,
          existingCommitment,
          sessionId,
          sessionStartTime,
          status,
          batchNumber,
          totalBatches,
        );
      } else {
        result = await this.executeDistribution(
          fromBlock,
          toBlock,
          batchSize,
          sessionId,
          sessionStartTime,
          status,
          batchNumber,
          totalBatches,
        );
      }

      return result;
    } catch (error) {
      const sessionDuration = Date.now() - sessionStartTime;

      let errorMessage: string;
      if (error instanceof BaseError) {
        errorMessage = this.errorDecoder.formatError(error, sessionCtx);
      } else {
        errorMessage = (error as Error)?.message || String(error);
      }

      sessionCtx.logger.error(
        `Distribution session ${sessionId} failed after ${(sessionDuration / 1000).toFixed(2)}s: ${errorMessage}`,
      );

      status.status = 'failed';
      status.error = errorMessage;
      status.completedAt = new Date();

      try {
        await this.rewardsReporterService.logFailedRewardsReport(
          sessionCtx,
          new Date(sessionStartTime),
          status.completedAt,
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

  // ────────────────────────────────────────────────────────────
  // Normal flow — fresh distribution
  // ────────────────────────────────────────────────────────────

  private async executeDistribution(
    fromBlock: number,
    toBlock: number,
    batchSize: number,
    sessionId: string,
    sessionStartTime: number,
    status: DistributionStatus,
    batchNumber?: number,
    totalBatches?: number,
  ): Promise<DistributionStatus> {
    const ctx = new TaskContext(`distribution:execute-${sessionId}`);
    const transactionLogs: TransactionLog[] = [];
    status.transactionLogs = transactionLogs;

    // 1. Calculate rewards (ONCE)
    status.status = 'calculating';
    const calculationResult =
      await this.rewardsCalculatorService.calculateRewardsDetailed(
        ctx,
        fromBlock,
        toBlock,
        true,
        batchNumber,
        totalBatches,
      );

    const workerRewards = calculationResult.workers;
    ctx.logger.info(
      `Calculated rewards for ${workerRewards.length} workers`,
    );

    status.totalWorkers = workerRewards.length;
    status.totalRewards = workerRewards.reduce(
      (sum, w) => sum + w.workerReward,
      0n,
    );

    // 2. Generate Merkle tree
    status.status = 'generating_tree';
    const merkleTree = await this.merkleTreeService.generateMerkleTree(
      workerRewards,
      batchSize,
    );

    status.totalBatches = merkleTree.totalBatches;
    status.merkleRoot = merkleTree.root;

    ctx.logger.info(
      `Generated Merkle tree: root=${merkleTree.root}, batches=${merkleTree.totalBatches}`,
    );

    // 3. Generate real S3 key for the commit
    const networkName = this.configService.get(
      'blockchain.network.name',
      'arbitrum',
    );
    const s3Key = this.s3Service.isEnabled()
      ? this.s3Service.generateS3Key(networkName, fromBlock, toBlock)
      : `s3://rewards-${fromBlock}-${toBlock}.json`;

    // 4. Commit root with real S3 key
    status.status = 'committing';
    const commitLog = await this.commitMerkleRoot(
      fromBlock,
      toBlock,
      merkleTree.root,
      merkleTree.totalBatches,
      sessionId,
      s3Key,
      workerRewards,
    );
    if (commitLog) {
      transactionLogs.push(commitLog);
    }

    ctx.logger.info(`Committed Merkle root to contract`);

    // 5. Upload to S3 (non-blocking, continue on failure)
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
          batchSize,
        );
        ctx.logger.info(`Epoch rewards uploaded to S3: ${s3Result}`);
      } catch (s3Error) {
        ctx.logger.error(
          { error: s3Error },
          `S3 upload failed (continuing distribution): ${(s3Error as Error).message}`,
        );
      }
    }

    // 6. Distribute all batches
    status.status = 'distributing';
    const distributionLogs = await this.distributeBatches(
      fromBlock,
      toBlock,
      merkleTree,
      sessionId,
    );
    transactionLogs.push(...distributionLogs);

    // 7. Complete
    status.processedBatches = merkleTree.totalBatches;
    status.status = 'completed';
    status.completedAt = new Date();

    this.logDistributionSummary(
      sessionId,
      fromBlock,
      toBlock,
      status,
      workerRewards,
      transactionLogs,
      sessionStartTime,
    );

    // Generate rewards report (wrapped in try/catch)
    try {
      const formattedResult =
        await this.rewardsCalculatorService.calculateRewardsFormatted(
          ctx,
          fromBlock,
          toBlock,
          true,
          batchNumber,
          totalBatches,
        );
      await this.generateRewardsReport(
        ctx,
        fromBlock,
        toBlock,
        formattedResult,
        transactionLogs,
      );
    } catch (reportError) {
      ctx.logger.warn(
        { error: reportError },
        'Failed to generate rewards report',
      );
    }

    return status;
  }

  // ────────────────────────────────────────────────────────────
  // Recovery flow — resume interrupted distribution
  // ────────────────────────────────────────────────────────────

  private async resumeDistribution(
    fromBlock: number,
    toBlock: number,
    batchSize: number,
    existingCommitment: {
      merkleRoot: string;
      totalBatches: number;
      processedBatches: number;
      approvalCount: bigint;
    },
    sessionId: string,
    sessionStartTime: number,
    status: DistributionStatus,
    batchNumber?: number,
    totalBatches?: number,
  ): Promise<DistributionStatus> {
    const ctx = new TaskContext(`distribution:resume-${sessionId}`);
    const transactionLogs: TransactionLog[] = [];
    status.transactionLogs = transactionLogs;

    ctx.logger.info(
      `Recovery mode: resuming distribution for ${fromBlock}-${toBlock}`,
    );

    status.status = 'recovering';

    // 1. Recalculate rewards
    const calculationResult =
      await this.rewardsCalculatorService.calculateRewardsDetailed(
        ctx,
        fromBlock,
        toBlock,
        true,
        batchNumber,
        totalBatches,
      );

    let workerRewards = calculationResult.workers;

    // 2. Generate Merkle tree with the configured batch size first (must match commit path)
    let merkleTree = await this.merkleTreeService.generateMerkleTree(
      workerRewards,
      batchSize,
    );

    // 3. Check if root matches
    if (merkleTree.root !== existingCommitment.merkleRoot) {
      ctx.logger.warn(
        `Reconstructed Merkle root (${merkleTree.root}) does not match committed root (${existingCommitment.merkleRoot})`,
      );

      // 4. Try S3 fallback
      ctx.logger.info(`Attempting S3 recovery...`);
      const recovered = await this.recoverMerkleTreeFromS3(
        ctx,
        fromBlock,
        toBlock,
      );

      if (recovered && recovered.root === existingCommitment.merkleRoot) {
        ctx.logger.info(
          `Successfully recovered Merkle tree from S3`,
        );
        merkleTree = recovered;
      } else {
        // 5. FAIL FAST -- never overwrite root
        throw new Error(
          'Cannot recover: merkle root mismatch and S3 recovery failed',
        );
      }
    } else {
      ctx.logger.info(
        `Reconstructed Merkle tree matches existing commitment`,
      );
    }

    status.totalBatches = existingCommitment.totalBatches;
    status.merkleRoot = existingCommitment.merkleRoot;
    status.totalWorkers = workerRewards.length;
    status.totalRewards = workerRewards.reduce(
      (sum, w) => sum + w.workerReward,
      0n,
    );

    // Upload to S3 if not already there
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
          batchSize,
        );
        ctx.logger.info(`Epoch rewards uploaded to S3: ${s3Result}`);
      } catch (s3Error) {
        ctx.logger.error(
          { error: s3Error },
          `S3 upload failed (continuing distribution): ${(s3Error as Error).message}`,
        );
      }
    }

    // Distribute all batches (distributeBatches skips BatchAlreadyProcessed)
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

    this.logDistributionSummary(
      sessionId,
      fromBlock,
      toBlock,
      status,
      workerRewards,
      transactionLogs,
      sessionStartTime,
    );

    // Generate rewards report (wrapped in try/catch)
    try {
      const formattedResult =
        await this.rewardsCalculatorService.calculateRewardsFormatted(
          ctx,
          fromBlock,
          toBlock,
          true,
          batchNumber,
          totalBatches,
        );
      await this.generateRewardsReport(
        ctx,
        fromBlock,
        toBlock,
        formattedResult,
        transactionLogs,
      );
    } catch (reportError) {
      ctx.logger.warn(
        { error: reportError },
        'Failed to generate rewards report',
      );
    }

    return status;
  }

  // ────────────────────────────────────────────────────────────
  // S3 upload
  // ────────────────────────────────────────────────────────────

  private async prepareAndUploadToS3(
    fromBlock: number,
    toBlock: number,
    merkleRoot: string,
    totalBatches: number,
    workersData: WorkerReward[],
    merkleTree: MerkleTreeResult,
    sessionStartTime: number,
    sessionId: string,
    explicitBatchSize?: number,
  ): Promise<string> {
    const ctx = new TaskContext(`s3:upload:${sessionId}`);

    if (!this.s3Service.isEnabled()) {
      ctx.logger.warn('S3 service disabled, using placeholder link');
      return `s3://rewards-${fromBlock}-${toBlock}.json`;
    }

    ctx.logger.info(`Preparing epoch rewards data for S3 upload`);

    const networkName = this.configService.get(
      'blockchain.network.name',
      'arbitrum',
    );

    const startTime = await this.contractService.getBlockTimestamp(ctx, fromBlock);
    const endTime = await this.contractService.getBlockTimestamp(ctx, toBlock);
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

    const batchSize =
      explicitBatchSize ?? Math.ceil(workersData.length / totalBatches);

    const formattedLeaves = merkleTree.leaves.map((leaf, index) => ({
      batchIndex: index,
      leafHash: leaf.leafHash,
      recipients: leaf.recipients.map((r: bigint) => r.toString()),
      workerRewards: leaf.workerRewards.map((r: bigint) => r.toString()),
      stakerRewards: leaf.stakerRewards.map((r: bigint) => r.toString()),
    }));

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
        batchSize,
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
      batchSize,
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

    ctx.logger.info(`Epoch rewards uploaded to S3: ${result.key}`);
    ctx.logger.info(`S3 URL: ${result.url}`);

    return result.url;
  }

  // ────────────────────────────────────────────────────────────
  // Commit Merkle root (3 retries with backoff)
  // ────────────────────────────────────────────────────────────

  private async commitMerkleRoot(
    fromBlock: number,
    toBlock: number,
    merkleRoot: string,
    totalBatches: number,
    sessionId: string,
    s3Link: string,
    workersData?: WorkerReward[],
  ): Promise<TransactionLog | null> {
    const startTime = Date.now();
    const commitCtx = new TaskContext(`distribution:commit-${sessionId}`);

    commitCtx.logger.info(
      `[${sessionId}] Starting merkle root commit for blocks [${fromBlock}, ${toBlock}]`,
    );

    let commitSuccess = false;
    let retryCount = 0;
    const MAX_RETRIES = 3;
    let transactionLog: TransactionLog | null = null;

    while (!commitSuccess && retryCount < MAX_RETRIES) {
      const attemptStartTime = Date.now();

      try {
        commitCtx.logger.info(
          `[${sessionId}] Commit attempt ${retryCount + 1}/${MAX_RETRIES}`,
        );

        const canCommit = await this.publicClient.readContract({
          address: this.contractAddress,
          abi: DistributedRewardsDistributionABI,
          functionName: 'canCommit',
          args: [this.walletClient.account.address],
        });

        if (!canCommit) {
          throw new Error('Account is not authorized to commit distributions');
        }

        // Check existing commitment using 8-field V2 ABI
        const commitmentKey = this.generateCommitmentKey(fromBlock, toBlock);
        try {
          const commitment = await this.publicClient.readContract({
            address: this.contractAddress,
            abi: DistributedRewardsDistributionABI,
            functionName: 'commitments',
            args: [commitmentKey],
          });

          // V2: [status, fromBlock, toBlock, merkleRoot, totalBatches, processedBatches, approvalCount, ipfsLink]
          const cStatus = Number(commitment[0]);
          if (cStatus !== 0) {
            const existingMerkleRoot = commitment[3];
            const existingTotalBatches = commitment[4];

            const isMatchingCommitment =
              existingMerkleRoot === merkleRoot &&
              Number(existingTotalBatches) === totalBatches;

            if (isMatchingCommitment) {
              commitCtx.logger.info(
                `[${sessionId}] Block range already committed with matching parameters - skipping`,
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
          if (
            (commitmentCheckError as Error).message?.includes(
              'already committed',
            )
          ) {
            throw commitmentCheckError;
          }
          commitCtx.logger.warn(
            `[${sessionId}] Could not check commitment status: ${(commitmentCheckError as Error).message}`,
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
          abi: DistributedRewardsDistributionABI,
          functionName: 'commitRoot',
          args: contractArgs,
        });

        const hash = await this.walletClient.writeContract(request);

        commitCtx.logger.info(`[${sessionId}] Commit TX submitted: ${hash}`);

        const receipt = await this.publicClient.waitForTransactionReceipt({
          hash,
        });

        const duration = Date.now() - attemptStartTime;

        commitCtx.logger.info(
          `[${sessionId}] Commit successful! Block: ${receipt.blockNumber.toString()}, Gas: ${receipt.gasUsed.toString()}, Duration: ${duration}ms`,
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
          const totalStake = workersData.reduce(
            (sum, w) => sum + (w.totalStake || 0n),
            0n,
          );
          const capedStake = workersData.reduce(
            (sum, w) => sum + (w.stake || 0n),
            0n,
          );
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
                abi: DistributedRewardsDistributionABI,
                functionName: 'lastBlockRewarded',
              });

              commitCtx.logger.error(
                `[${sessionId}] Block continuity error: lastBlockRewarded=${lastBlockRewarded}, trying to commit fromBlock=${fromBlock}`,
              );
            } catch (_e) {
              commitCtx.logger.debug(
                'Could not fetch lastBlockRewarded for additional context',
              );
            }
          }
        } else {
          errorMessage = String((error as Error)?.message || error);
        }

        commitCtx.logger.error(
          { errorContext },
          `[${sessionId}] Commit attempt ${retryCount + 1}/${MAX_RETRIES} failed (${duration}ms): ${errorMessage}`,
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
            `[${sessionId}] Retrying commit in ${retryDelay}ms`,
          );

          retryCount++;
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
        }
      }
    }

    return transactionLog;
  }

  // ────────────────────────────────────────────────────────────
  // Distribute batches (with BatchAlreadyProcessed skip + InvalidMerkleProof S3 retry)
  // ────────────────────────────────────────────────────────────

  private async distributeBatches(
    fromBlock: number,
    toBlock: number,
    merkleTree: MerkleTreeResult,
    sessionId: string,
  ): Promise<TransactionLog[]> {
    const batchCtx = new TaskContext(`distribution:batches-${sessionId}`);

    batchCtx.logger.info(
      `[${sessionId}] Starting distribution of ${merkleTree.totalBatches} batches`,
    );

    const transactionLogs: TransactionLog[] = [];

    for (let i = 0; i < merkleTree.leaves.length; i++) {
      const leaf = merkleTree.leaves[i];
      const proof = merkleTree.proofs[i];
      const batchNumber = i + 1;

      const batchStartTime = Date.now();
      try {
        batchCtx.logger.info(
          `[${sessionId}] Processing batch ${batchNumber}/${merkleTree.totalBatches} with ${leaf.recipients.length} workers`,
        );

        const { request } = await this.publicClient.simulateContract({
          account: this.walletClient.account,
          address: this.contractAddress,
          abi: DistributedRewardsDistributionABI,
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
          `[${sessionId}] Batch ${batchNumber} TX submitted: ${hash}`,
        );

        const receipt = await this.publicClient.waitForTransactionReceipt({
          hash,
        });

        const duration = Date.now() - batchStartTime;

        batchCtx.logger.info(
          `[${sessionId}] Batch ${batchNumber}/${merkleTree.totalBatches} distributed successfully! Block: ${receipt.blockNumber.toString()}, Gas: ${receipt.gasUsed.toString()}, Duration: ${duration}ms`,
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

          // Skip already-processed batches (recovery scenario)
          if (
            this.errorDecoder.isSpecificError(error, 'BatchAlreadyProcessed')
          ) {
            batchCtx.logger.warn(
              `[${sessionId}] Batch ${batchNumber} already processed - skipping`,
            );
            continue;
          }

          // InvalidMerkleProof: attempt S3 recovery retry
          if (this.errorDecoder.isSpecificError(error, 'InvalidMerkleProof')) {
            batchCtx.logger.warn(
              `[${sessionId}] invalid merkle proof detected, attempting recovery from s3 and retry`,
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
                  abi: DistributedRewardsDistributionABI,
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
          errorMessage = String((error as Error)?.message || error);
        }

        batchCtx.logger.error(
          { errorContext },
          `[${sessionId}] Failed to distribute batch ${batchNumber}/${merkleTree.totalBatches}: ${errorMessage}`,
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
      `[${sessionId}] All ${merkleTree.totalBatches} batches distributed successfully`,
    );

    return transactionLogs;
  }

  // ────────────────────────────────────────────────────────────
  // S3 Merkle tree recovery
  // ────────────────────────────────────────────────────────────

  private async recoverMerkleTreeFromS3(
    ctx: TaskContext,
    fromBlock: number,
    toBlock: number,
  ): Promise<MerkleTreeResult | null> {
    try {
      const networkName = this.configService.get(
        'blockchain.network.name',
        'arbitrum',
      );
      let s3Key = this.s3Service.generateS3Key(networkName, fromBlock, toBlock);
      ctx.logger.info(`Attempting to download epoch data from S3: ${s3Key}`);

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
            `primary key not found, trying alternate network key: ${altKey}`,
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
        `Recreating Merkle tree from ${epochRewardsData.rawData.workers.length} workers`,
      );
      ctx.logger.info(
        `Using batch size: ${epochRewardsData.merkleTree.batchSize}`,
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

      ctx.logger.info(`Recreated root: ${recreatedTree.root}`);
      ctx.logger.info(`Expected root: ${epochRewardsData.merkleTree.root}`);

      if (recreatedTree.root !== epochRewardsData.merkleTree.root) {
        ctx.logger.error(
          'Recreated Merkle tree root does not match stored root',
        );
        return null;
      }

      ctx.logger.info(`Merkle tree verification successful - roots match`);

      return recreatedTree;
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to recover Merkle tree from S3');
      return null;
    }
  }

  // ────────────────────────────────────────────────────────────
  // Distribution status (uses canonical V2 ABI)
  // ────────────────────────────────────────────────────────────

  async getDistributionStatus(
    fromBlock: number,
    toBlock: number,
  ): Promise<any> {
    const statusCtx = new TaskContext('distribution:status');

    try {
      const key = this.generateCommitmentKey(fromBlock, toBlock);

      const commitment = await this.publicClient.readContract({
        address: this.contractAddress,
        abi: DistributedRewardsDistributionABI,
        functionName: 'commitments',
        args: [key],
      });

      // V2 8-field: [status, fromBlock, toBlock, merkleRoot, totalBatches, processedBatches, approvalCount, ipfsLink]
      // Convert bigints to numbers/strings for JSON serialization safety
      return {
        status: Number(commitment[0]),
        fromBlock: Number(commitment[1]),
        toBlock: Number(commitment[2]),
        merkleRoot: commitment[3],
        totalBatches: Number(commitment[4]),
        processedBatches: Number(commitment[5]),
        approvalCount: commitment[6].toString(),
        ipfsLink: commitment[7],
      };
    } catch (error) {
      statusCtx.logger.error(
        `Failed to get distribution status: ${(error as Error).message}`,
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

  // ────────────────────────────────────────────────────────────
  // Public methods called by epoch-processor
  // ────────────────────────────────────────────────────────────

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
      `Generating Merkle tree for ${workers.length} workers (approval phase)`,
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

    try {
      ctx.logger.info(
        `Committing Merkle root for blocks ${fromBlock}-${toBlock}`,
      );
      ctx.logger.info(`   Root: ${merkleRoot}`);
      ctx.logger.info(`   Batches: ${totalBatches}`);

      const sessionId = generateSessionId();

      // Generate real S3 key if possible
      const networkName = this.configService.get(
        'blockchain.network.name',
        'arbitrum',
      );
      const s3Link =
        ipfsLink ||
        (this.s3Service.isEnabled()
          ? this.s3Service.generateS3Key(networkName, fromBlock, toBlock)
          : `s3://rewards-${fromBlock}-${toBlock}.json`);

      const transactionLog = await this.commitMerkleRoot(
        fromBlock,
        toBlock,
        merkleRoot,
        totalBatches,
        sessionId,
        s3Link,
        workersData,
      );

      if (transactionLog && transactionLog.status === 'success') {
        ctx.logger.info(
          `Merkle root committed successfully: ${transactionLog.hash}`,
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
      ctx.logger.error(
        `Failed to commit root: ${(error as Error).message}`,
      );
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
        client: this.contractService.client,
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

        // V2 8-field: [status, fromBlock, toBlock, merkleRoot, totalBatches, processedBatches, approvalCount, ipfsLink]
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

        // Read requiredApproves from the contract
        const requiredApproves = await contract.read.requiredApproves();

        if (
          status === 1 && // ACTIVE status
          approvalCount >= requiredApproves && // has sufficient approvals
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
            `Found approved epoch ready for distribution: ${fromBlock}-${toBlock} ` +
              `(${processedBatches}/${totalBatches} batches processed)`,
          );
        } else {
          ctx.logger.debug(
            `Latest commitment not ready for distribution: status=${status}, approvals=${approvalCount}/${requiredApproves}, fully_distributed=${processedBatches >= totalBatches}`,
          );
        }
      } catch (error) {
        ctx.logger.warn(
          `Failed to check latest commitment: ${(error as Error).message}`,
        );
      }

      if (approvedEpochs.length > 0) {
        ctx.logger.info(
          `Found ${approvedEpochs.length} approved epochs ready for distribution`,
        );
      } else {
        ctx.logger.debug('No approved epochs ready for distribution');
      }

      return approvedEpochs;
    } catch (error) {
      ctx.logger.error(
        `Failed to get approved epochs: ${(error as Error).message}`,
      );
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

    try {
      ctx.logger.info(`Distributing approved epoch ${fromBlock}-${toBlock}`);
      ctx.logger.info(`   Using Merkle root: ${merkleRoot}`);

      // Calculate rewards (ONCE)
      const result =
        await this.rewardsCalculatorService.calculateRewardsDetailed(
          ctx,
          fromBlock,
          toBlock,
          true,
        );

      if (result.workers.length === 0) {
        ctx.logger.warn('No workers found for approved epoch distribution');
        return true;
      }

      const merkleTree = await this.merkleTreeService.generateMerkleTree(
        result.workers,
        this.distributionBatchSize,
      );

      if (merkleTree.root !== merkleRoot) {
        ctx.logger.error(
          `Merkle root mismatch! Expected: ${merkleRoot}, Got: ${merkleTree.root}`,
        );

        ctx.logger.info('Attempting to recover Merkle tree from S3...');
        const recoveredTree = await this.recoverMerkleTreeFromS3(
          ctx,
          fromBlock,
          toBlock,
        );

        if (recoveredTree && recoveredTree.root === merkleRoot) {
          ctx.logger.info('Successfully recovered Merkle tree from S3');
          return await this.distributeAndReport(
            ctx,
            fromBlock,
            toBlock,
            recoveredTree,
          );
        } else {
          ctx.logger.error('Failed to recover valid Merkle tree from S3');
          return false;
        }
      }

      return await this.distributeAndReport(
        ctx,
        fromBlock,
        toBlock,
        merkleTree,
      );
    } catch (error) {
      ctx.logger.error(
        `Failed to distribute approved epoch: ${(error as Error).message}`,
      );
      return false;
    }
  }

  // ────────────────────────────────────────────────────────────
  // Internal helpers
  // ────────────────────────────────────────────────────────────

  private async distributeAndReport(
    ctx: TaskContext,
    fromBlock: number,
    toBlock: number,
    merkleTree: MerkleTreeResult,
  ): Promise<boolean> {
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
        `Successfully distributed all ${merkleTree.totalBatches} batches`,
      );

      try {
        const formattedResult =
          await this.rewardsCalculatorService.calculateRewardsFormatted(
            ctx,
            fromBlock,
            toBlock,
            true,
          );
        await this.generateRewardsReport(
          ctx,
          fromBlock,
          toBlock,
          formattedResult,
          distributionLogs,
        );
      } catch (reportError) {
        ctx.logger.warn(
          { error: reportError },
          'Failed to generate rewards report for approved epoch',
        );
      }

      return true;
    } else {
      const failedBatches = distributionLogs.filter(
        (log) => log.status === 'failed',
      ).length;
      ctx.logger.error(
        `Failed to distribute ${failedBatches} out of ${merkleTree.totalBatches} batches`,
      );
      return false;
    }
  }

  private async generateRewardsReport(
    ctx: TaskContext,
    fromBlock: number,
    toBlock: number,
    formattedResult: any,
    transactionLogs: TransactionLog[],
  ): Promise<void> {
    const epochStartTime = await this.contractService.getBlockTimestamp(
      ctx,
      fromBlock,
    );
    const epochEndTime = await this.contractService.getBlockTimestamp(ctx, toBlock);
    const networkMetrics =
      await this.epochMetricsService.collectNetworkMetrics(ctx);
    const rewardMetrics =
      this.epochMetricsService.extractRewardMetrics(formattedResult);

    const commitTxHash =
      transactionLogs.find((log) => log.type === 'commit')?.hash || '';

    await this.rewardsReporterService.logSuccessfulRewardsReport({
      epochStart: epochStartTime,
      epochEnd: epochEndTime,
      isCommitSuccess: true,
      commitTxHash,
      networkMetrics,
      rewardMetrics,
      workerRewards: formattedResult.workers,
    });

    ctx.logger.info(
      `Rewards report generated successfully for epoch ${fromBlock}-${toBlock}`,
    );
  }

  private logDistributionSummary(
    sessionId: string,
    fromBlock: number,
    toBlock: number,
    status: DistributionStatus,
    workerRewards: WorkerReward[],
    transactionLogs: TransactionLog[],
    sessionStartTime: number,
  ): void {
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

    const summaryCtx = new TaskContext(`distribution:summary-${sessionId}`);
    summaryCtx.logger.info(`=== DISTRIBUTION SUMMARY ===`);
    summaryCtx.logger.info(`Session ID: ${sessionId}`);
    summaryCtx.logger.info(`Block Range: ${fromBlock} -> ${toBlock}`);
    summaryCtx.logger.info(`Total Workers: ${status.totalWorkers}`);
    summaryCtx.logger.info(`Total Batches: ${status.totalBatches}`);
    summaryCtx.logger.info(
      `Duration: ${(sessionDuration / 1000).toFixed(2)}s`,
    );
    summaryCtx.logger.info(`Total Rewards: ${formatAmount(totalRewards)}`);
    summaryCtx.logger.info(`Total Gas Used: ${totalGasUsed.toString()}`);
    summaryCtx.logger.info(
      `Successful TXs: ${transactionLogs.filter((t) => t.status === 'success').length}`,
    );
    summaryCtx.logger.info(
      `Failed TXs: ${transactionLogs.filter((t) => t.status === 'failed').length}`,
    );
  }
}
