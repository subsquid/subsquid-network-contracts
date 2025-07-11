import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TaskContext } from '../../common/task-context';
import { Web3Service } from '../../blockchain/web3.service';
import { MerkleTreeService, MerkleTreeResult } from './merkle-tree.service';
import {
  RewardsCalculatorService,
  WorkerReward,
} from '../calculation/rewards-calculator.service';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  Address,
  encodePacked,
  keccak256,
} from 'viem';
import { arbitrum, foundry } from 'viem/chains';
import { defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

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
}

export interface GasSimulationResult {
  success: boolean;
  estimatedGas?: bigint;
  error?: string;
  suggestedBatchSize?: number;
}

@Injectable()
export class DistributionService {
  private readonly publicClient;
  private readonly walletClient;
  private readonly contractAddress: Address;

  // Gas simulation configuration
  private readonly gasSimulationConfig = {
    enablePreflightSimulation: process.env.ENABLE_GAS_SIMULATION !== 'false', // enabled by default
    maxOptimizationAttempts: parseInt(
      process.env.MAX_GAS_OPTIMIZATION_ATTEMPTS || '10',
    ),
    minBatchSize: parseInt(process.env.MIN_BATCH_SIZE || '1'),
    gasReductionFactor: parseFloat(process.env.GAS_REDUCTION_FACTOR || '0.8'),
  };

  // contract ABI for the essential functions
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
  ) {
    // read from environment variables via config service
    const rpcUrl = this.configService.get(
      'blockchain.network.l2RpcUrl',
      'http://localhost:8545',
    );

    // get private key from environment variable with validation
    const privateKey =
      process.env.DISTRIBUTOR_PRIVATE_KEY ||
      this.configService.get('blockchain.distributor.privateKey');

    if (!privateKey) {
      throw new Error(
        'DISTRIBUTOR_PRIVATE_KEY environment variable is required',
      );
    }

    // validate private key format
    if (!privateKey.startsWith('0x') || privateKey.length !== 66) {
      throw new Error(
        'Invalid private key format. Must be 64 hex characters prefixed with 0x',
      );
    }

    // get contract address from environment variable (use NEW deployed contract)
    const contractAddress =
      process.env.REWARDS_DISTRIBUTION_ADDRESS ||
      this.configService.get(
        'blockchain.contracts.rewardsDistribution',
        '0x36fE2E7a1c19F7Be268272540E9A4aB306686506',
      );

    this.contractAddress = contractAddress as Address;

    // determine chain based on RPC URL
    let chain;
    if (rpcUrl.includes('localhost') || rpcUrl.includes('127.0.0.1')) {
      // create custom chain for localhost that matches anvil's configuration
      chain = defineChain({
        id: 42161, // use the actual chain ID from anvil
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

  // execute complete distribution flow for an epoch
  async distributeEpochRewards(
    fromBlock: number,
    toBlock: number,
    batchSize: number = 50,
  ): Promise<DistributionStatus> {
    const epochId = `${fromBlock}-${toBlock}`;
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
    };

    try {
      const startCtx = new TaskContext(`distribution:start-epoch-${epochId}`);
      startCtx.logger.debug(`🚀 Starting distribution for epoch ${epochId}`);

      // check bond amount and contract state
      try {
        const bondAmount = await this.web3Service.getBondAmount(startCtx);
        const activeWorkerCount =
          await this.web3Service.getActiveWorkerCount(startCtx);
        new TaskContext('distribution:pre-checks').logger.debug(
          `📋 Pre-distribution checks:`,
        );
        new TaskContext('distribution:pre-checks').logger.debug(
          `   - Bond amount: ${Number(bondAmount) / 1e18} SQD`,
        );
        new TaskContext('distribution:pre-checks').logger.debug(
          `   - Active workers in contract: ${activeWorkerCount}`,
        );
      } catch (error) {
        new TaskContext('distribution:warning').logger.warn(
          `Failed to get contract state: ${error.message}`,
        );
      }

      // calc rewards for all workers from ClickHouse
      status.status = 'calculating';
      const calculationResult =
        await this.rewardsCalculatorService.calculateRewardsDetailed(
          startCtx,
          fromBlock,
          toBlock,
          true, // skip signature validation for development
        );

      new TaskContext('distribution:calculation-results').logger.debug(
        `✅ Calculated rewards for ${calculationResult.workers.length} workers from ClickHouse`,
      );

      // The rewards calculator service already handles contract worker ID mapping
      // and filters out unregistered workers, so we can use the results directly
      const workerRewards = calculationResult.workers;

      status.totalWorkers = workerRewards.length;
      status.totalRewards = workerRewards.reduce(
        (sum, w) => sum + w.workerReward,
        0n,
      );

      new TaskContext('method-call').logger.debug(
        `✅ Mapped to ${status.totalWorkers} registered workers, total: ${Number(status.totalRewards) / 1e18} SQD`,
      );

      // optimize batch size with gas simulation (if enabled)
      status.status = 'generating_tree';
      let optimizedBatchSize = batchSize;
      let totalGasSimulations = 0;

      if (this.gasSimulationConfig.enablePreflightSimulation) {
        new TaskContext('method-call').logger.debug(
          `🔧 Optimizing batch size for gas efficiency...`,
        );

        const optimizationResult = await this.optimizeBatchSize(
          fromBlock,
          toBlock,
          workerRewards,
          batchSize,
        );

        optimizedBatchSize = optimizationResult.optimizedBatchSize;
        totalGasSimulations = optimizationResult.gasSimulations;

        if (optimizedBatchSize !== batchSize) {
          new TaskContext('warning').logger.warn(
            `⚠️ Batch size adjusted from ${batchSize} to ${optimizedBatchSize} based on gas simulation`,
          );
        } else {
          new TaskContext('method-call').logger.debug(
            `✅ Original batch size ${batchSize} is optimal`,
          );
        }
      } else {
        new TaskContext('method-call').logger.debug(
          `⚠️ Gas simulation disabled, using original batch size ${batchSize}`,
        );
      }

      // track gas optimization metrics
      status.gasOptimizations = {
        originalBatchSize: batchSize,
        finalBatchSize: optimizedBatchSize,
        batchesAdjusted: optimizedBatchSize !== batchSize ? 1 : 0,
        totalGasSimulations,
      };

      // generate Merkle tree with optimized batch size
      const merkleTree = await this.merkleTreeService.generateMerkleTree(
        workerRewards,
        optimizedBatchSize,
      );

      status.totalBatches = merkleTree.totalBatches;
      status.merkleRoot = merkleTree.root;

      new TaskContext('method-call').logger.debug(
        `✅ Generated optimized Merkle tree: root=${merkleTree.root}, batches=${merkleTree.totalBatches} (gas simulations: ${totalGasSimulations})`,
      );

      // commit root to contract
      status.status = 'committing';
      await this.commitMerkleRoot(
        fromBlock,
        toBlock,
        merkleTree.root,
        merkleTree.totalBatches,
      );

      new TaskContext('method-call').logger.debug(
        `✅ Committed Merkle root to contract`,
      );

      // distribute in batches
      status.status = 'distributing';
      await this.distributeBatches(fromBlock, toBlock, merkleTree);

      status.processedBatches = merkleTree.totalBatches;
      status.status = 'completed';
      status.completedAt = new Date();

      new TaskContext('method-call').logger.debug(
        `🎉 Distribution completed for epoch ${epochId}`,
      );

      // log gas optimization summary
      if (status.gasOptimizations) {
        this.logGasOptimizationSummary(status.gasOptimizations);
      }

      return status;
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `❌ Distribution failed for epoch ${epochId}: ${error.message}`,
      );
      status.status = 'failed';
      status.error = error.message;
      status.completedAt = new Date();
      return status;
    }
  }

  // commit Merkle root to the contract
  private async commitMerkleRoot(
    fromBlock: number,
    toBlock: number,
    merkleRoot: string,
    totalBatches: number,
  ): Promise<void> {
    const startTime = Date.now();
    new TaskContext('method-call').logger.info(
      `🚀 Starting merkle root commit process for blocks [${fromBlock}, ${toBlock}]`,
      {
        merkleRoot,
        totalBatches,
        walletAddress: this.walletClient.account.address,
        contractAddress: this.contractAddress,
      },
    );

    let commitSuccess = false;
    let retryCount = 0;
    const MAX_RETRIES = 3;
    
    while (!commitSuccess && retryCount < MAX_RETRIES) {
      const attemptStartTime = Date.now();
      const ipfsLink = `ipfs://rewards-${fromBlock}-${toBlock}`;
      
      try {
        new TaskContext('method-call').logger.debug(
          `🔍 Commit attempt ${retryCount + 1}/${MAX_RETRIES} for block range [${fromBlock}, ${toBlock}]`,
          {
            attemptNumber: retryCount + 1,
            maxRetries: MAX_RETRIES,
            blockRange: [fromBlock, toBlock],
            ipfsLink,
          },
        );

        new TaskContext('method-call').logger.debug(
          `🔐 Checking commit authorization for account: ${this.walletClient.account.address}`,
        );
        
        const canCommit = await this.publicClient.readContract({
          address: this.contractAddress,
          abi: this.contractAbi,
          functionName: 'canCommit',
          args: [this.walletClient.account.address],
        });

        new TaskContext('method-call').logger.debug(
          `🔐 Authorization check result: ${canCommit ? 'AUTHORIZED' : 'UNAUTHORIZED'}`,
          { canCommit, account: this.walletClient.account.address },
        );

        if (!canCommit) {
          throw new Error('Account is not authorized to commit distributions');
        }

        const commitmentKey = this.generateCommitmentKey(fromBlock, toBlock);
        
        new TaskContext('method-call').logger.debug(
          `🔑 Checking commitment status for key: ${commitmentKey}`,
          { commitmentKey, fromBlock, toBlock },
        );

        try {
          const commitment = await this.publicClient.readContract({
            address: this.contractAddress,
            abi: this.contractAbi,
            functionName: 'commitments',
            args: [commitmentKey],
          });

          new TaskContext('method-call').logger.debug(
            `🔍 Commitment status check result:`,
            { 
              commitmentExists: !!(commitment && commitment[0]),
              commitment: commitment ? {
                exists: commitment[0],
                merkleRoot: commitment[1],
                totalBatches: commitment[2],
                ipfsHash: commitment[3],
              } : null,
            },
          );

          if (commitment && commitment[0]) {
            const existingMerkleRoot = commitment[1];
            const existingTotalBatches = commitment[2];
            const existingIpfsHash = commitment[3];
            
            const isMatchingCommitment = 
              existingMerkleRoot === merkleRoot && 
              Number(existingTotalBatches) === totalBatches;

            if (isMatchingCommitment) {
              new TaskContext('method-call').logger.info(
                `✅ Block range [${fromBlock}, ${toBlock}] already committed with matching parameters - skipping`,
                {
                  existingCommitment: {
                    merkleRoot: existingMerkleRoot,
                    totalBatches: Number(existingTotalBatches),
                    ipfsHash: existingIpfsHash,
                  },
                  ourParameters: {
                    merkleRoot,
                    totalBatches,
                    ipfsLink,
                  },
                },
              );
              
              commitSuccess = true;
              break;
            } else {
              new TaskContext('error-handling').logger.error(
                `❌ Block range [${fromBlock}, ${toBlock}] already committed but with different parameters`,
                {
                  existingCommitment: {
                    merkleRoot: existingMerkleRoot,
                    totalBatches: Number(existingTotalBatches),
                    ipfsHash: existingIpfsHash,
                  },
                  ourParameters: {
                    merkleRoot,
                    totalBatches,
                    ipfsLink,
                  },
                  mismatch: {
                    merkleRoot: existingMerkleRoot !== merkleRoot,
                    totalBatches: Number(existingTotalBatches) !== totalBatches,
                  },
                },
              );
              
              throw new Error(
                `Block range [${fromBlock}, ${toBlock}] already committed with different parameters. ` +
                `Existing: merkleRoot=${existingMerkleRoot}, totalBatches=${existingTotalBatches}. ` +
                `Ours: merkleRoot=${merkleRoot}, totalBatches=${totalBatches}`
              );
            }
          }
        } catch (commitmentCheckError) {
          new TaskContext('warning').logger.warn(
            `⚠️ Could not check commitment status: ${commitmentCheckError.message}`,
            { error: commitmentCheckError, commitmentKey },
          );
        }

        const contractArgs = [
          [BigInt(fromBlock), BigInt(toBlock)],
          merkleRoot as `0x${string}`,
          totalBatches,
          ipfsLink,
        ];

        new TaskContext('method-call').logger.debug(
          `📋 Preparing commit transaction with arguments:`,
          {
            blockRange: [fromBlock, toBlock],
            merkleRoot,
            totalBatches,
            ipfsLink,
            contractArgs: contractArgs.map(arg => 
              Array.isArray(arg) ? `[${arg.join(', ')}]` : String(arg)
            ),
          },
        );

        // simulate transaction
        new TaskContext('method-call').logger.debug(
          `🧪 Simulating commit transaction...`,
        );
        
        const simulationStart = Date.now();
        const { request } = await this.publicClient.simulateContract({
          account: this.walletClient.account,
          address: this.contractAddress,
          abi: this.contractAbi,
          functionName: 'commitRoot',
          args: contractArgs,
        });

        const simulationTime = Date.now() - simulationStart;
        new TaskContext('method-call').logger.debug(
          `✅ Transaction simulation successful (${simulationTime}ms)`,
          {
            simulationTimeMs: simulationTime,
            gasEstimate: request.gas ? Number(request.gas) : 'unknown',
            gasPrice: request.gasPrice ? Number(request.gasPrice) : 'unknown',
          },
        );

        new TaskContext('method-call').logger.debug(
          `📝 Executing commit transaction...`,
        );
        
        const txStart = Date.now();
        const hash = await this.walletClient.writeContract(request);
        const txSubmissionTime = Date.now() - txStart;

        new TaskContext('method-call').logger.info(
          `📤 Transaction submitted successfully (${txSubmissionTime}ms)`,
          {
            transactionHash: hash,
            submissionTimeMs: txSubmissionTime,
            blockRange: [fromBlock, toBlock],
          },
        );

        new TaskContext('method-call').logger.debug(
          `⏳ Waiting for transaction confirmation...`,
          { transactionHash: hash },
        );
        
        const confirmationStart = Date.now();
        const receipt = await this.publicClient.waitForTransactionReceipt({
          hash,
        });
        const confirmationTime = Date.now() - confirmationStart;

        const totalAttemptTime = Date.now() - attemptStartTime;
        const totalProcessTime = Date.now() - startTime;

        new TaskContext('method-call').logger.info(
          `🎉 Merkle root committed successfully!`,
          {
            transactionHash: receipt.transactionHash,
            blockNumber: Number(receipt.blockNumber),
            gasUsed: Number(receipt.gasUsed),
            effectiveGasPrice: receipt.effectiveGasPrice ? Number(receipt.effectiveGasPrice) : 'unknown',
            status: receipt.status,
            blockRange: [fromBlock, toBlock],
            confirmationTimeMs: confirmationTime,
            attemptTimeMs: totalAttemptTime,
            totalProcessTimeMs: totalProcessTime,
            attemptsUsed: retryCount + 1,
          },
        );

        commitSuccess = true;
        
      } catch (error) {
        const attemptTime = Date.now() - attemptStartTime;
        const errorStr = String(error?.message || error);
        
        new TaskContext('error-handling').logger.error(
          `❌ Commit attempt ${retryCount + 1}/${MAX_RETRIES} failed (${attemptTime}ms)`,
          {
            attemptNumber: retryCount + 1,
            maxRetries: MAX_RETRIES,
            error: errorStr,
            blockRange: [fromBlock, toBlock],
            attemptTimeMs: attemptTime,
            errorType: error?.constructor?.name || 'unknown',
          },
        );

        if (
          errorStr.includes('ALREADY_COMMITTED') ||
          errorStr.includes('MerkleRootAlreadyCommitted')
        ) {
          new TaskContext('error-handling').logger.error(
            `💥 Cannot commit - range [${fromBlock}, ${toBlock}] already committed`,
            {
              blockRange: [fromBlock, toBlock],
              error: errorStr,
            },
          );
          
          throw new Error(
            `Block range [${fromBlock}, ${toBlock}] already committed: ${errorStr}`
          );
          
        } else if (retryCount === MAX_RETRIES - 1) {
          const totalFailureTime = Date.now() - startTime;
          new TaskContext('error-handling').logger.error(
            `💥 Final commit attempt failed after ${MAX_RETRIES} attempts (${totalFailureTime}ms total)`,
            {
              totalAttempts: MAX_RETRIES,
              totalTimeMs: totalFailureTime,
              finalError: errorStr,
              blockRange: [fromBlock, toBlock],
            },
          );
          
          throw new Error(
            `Failed to commit Merkle root after ${MAX_RETRIES} attempts: ${errorStr}`,
          );
        } else {
          const retryDelay = 2000 + (retryCount * 1000); // Exponential backoff
          new TaskContext('error-handling').logger.warn(
            `🔄 Retrying commit in ${retryDelay}ms (attempt ${retryCount + 2}/${MAX_RETRIES})`,
            {
              retryDelayMs: retryDelay,
              nextAttempt: retryCount + 2,
              maxRetries: MAX_RETRIES,
              errorStr,
            },
          );
          
          retryCount++;
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
        }
      }
    }

    if (!commitSuccess) {
      const totalFailureTime = Date.now() - startTime;
      new TaskContext('error-handling').logger.error(
        `💥 Failed to commit merkle root after ${MAX_RETRIES} attempts (${totalFailureTime}ms total)`,
        {
          totalAttempts: MAX_RETRIES,
          totalTimeMs: totalFailureTime,
          blockRange: [fromBlock, toBlock],
        },
      );
      
      throw new Error(
        `Failed to commit Merkle root for blocks [${fromBlock}, ${toBlock}] after ${MAX_RETRIES} attempts`,
      );
    }

    const totalSuccessTime = Date.now() - startTime;
    new TaskContext('method-call').logger.info(
      `✅ Merkle root commit process completed successfully (${totalSuccessTime}ms total)`,
      {
        totalTimeMs: totalSuccessTime,
        blockRange: [fromBlock, toBlock],
        totalAttempts: retryCount + 1,
      },
    );
  }

  /**
   * Simulate a distribution call to estimate gas usage and detect potential failures
   */
  private async simulateDistribution(
    fromBlock: number,
    toBlock: number,
    recipients: bigint[],
    workerRewards: bigint[],
    stakerRewards: bigint[],
    proof: string[],
  ): Promise<GasSimulationResult> {
    try {
      new TaskContext('method-call').logger.debug(
        `🧪 Simulating distribution for ${recipients.length} workers...`,
      );

      // use simulateContract to check if the transaction would succeed
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

      // If simulation succeeds, estimate gas
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

      new TaskContext('method-call').logger.debug(
        `✅ Gas simulation successful: ${gasEstimate} gas for ${recipients.length} workers`,
      );

      return {
        success: true,
        estimatedGas: gasEstimate,
      };
    } catch (error) {
      const errorMessage = error?.message || String(error);
      new TaskContext('warning').logger.warn(
        `❌ Gas simulation failed for ${recipients.length} workers: ${errorMessage}`,
      );

      // analyze error to suggest optimal batch size
      let suggestedBatchSize = recipients.length;

      if (errorMessage.includes('gas') || errorMessage.includes('Gas')) {
        // if it's a gas-related error, reduce batch size significantly
        suggestedBatchSize = Math.max(1, Math.floor(recipients.length * 0.5));
      } else if (
        errorMessage.includes('revert') ||
        errorMessage.includes('execution reverted')
      ) {
        // if it's a revert, try smaller batch size
        suggestedBatchSize = Math.max(1, Math.floor(recipients.length * 0.7));
      } else {
        // For other errors, try moderate reduction
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
    new TaskContext('method-call').logger.debug(
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
        new TaskContext('warning').logger.warn(
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
        new TaskContext('warning').logger.warn(
          '⚠️ No leaves generated for test batch',
        );
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
        new TaskContext('method-call').logger.debug(
          `✅ Optimal batch size found: ${testBatchSize} workers (${gasSimulations} simulations)`,
        );
        return { optimizedBatchSize: testBatchSize, gasSimulations };
      } else {
        new TaskContext('warning').logger.warn(
          `❌ Batch size ${testBatchSize} failed simulation: ${simulationResult.error}`,
        );

        if (
          simulationResult.suggestedBatchSize &&
          simulationResult.suggestedBatchSize < testBatchSize
        ) {
          testBatchSize = simulationResult.suggestedBatchSize;
        } else {
          // fallback: reduce by configured factor
          testBatchSize = Math.max(
            this.gasSimulationConfig.minBatchSize,
            Math.floor(
              testBatchSize * this.gasSimulationConfig.gasReductionFactor,
            ),
          );
        }

        new TaskContext('method-call').logger.debug(
          `🔄 Retrying with reduced batch size: ${testBatchSize}`,
        );
      }
    }

    new TaskContext('warning').logger.warn(
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
  ): Promise<void> {
    new TaskContext('method-call').logger.debug(
      `Distributing ${merkleTree.totalBatches} batches with gas simulation...`,
    );

    for (let i = 0; i < merkleTree.leaves.length; i++) {
      const leaf = merkleTree.leaves[i];
      const proof = merkleTree.proofs[i];

      try {
        new TaskContext('method-call').logger.debug(
          `📦 Processing batch ${i + 1}/${merkleTree.totalBatches} with ${leaf.recipients.length} workers`,
        );

        // ppre-flight gas simulation (if enabled)
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
            new TaskContext('error-handling').logger.error(
              `❌ Pre-flight simulation failed for batch ${i + 1}: ${gasSimulation.error}`,
            );

            if (leaf.recipients.length > 1) {
              new TaskContext('warning').logger.warn(
                `🔄 Attempting to split failing batch ${i + 1} into smaller chunks...`,
              );
              await this.distributeBatchInChunks(
                fromBlock,
                toBlock,
                leaf,
                proof,
                i + 1,
              );
              continue;
            } else {
              // up to single worker
              throw new Error(
                `Single worker batch failed simulation: ${gasSimulation.error}`,
              );
            }
          }

          new TaskContext('method-call').logger.debug(
            `🧪 Pre-flight simulation passed for batch ${i + 1}, estimated gas: ${gasSimulation.estimatedGas}`,
          );
        }

        // proceed with actual distribution
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
        const receipt = await this.publicClient.waitForTransactionReceipt({
          hash,
        });

        new TaskContext('method-call').logger.debug(
          `✅ Batch ${i + 1} distributed successfully: tx=${receipt.transactionHash}, gas used: ${receipt.gasUsed}`,
        );
      } catch (error) {
        new TaskContext('error-handling').logger.error(
          `❌ Failed to distribute batch ${i + 1}: ${error.message}`,
        );
        throw error;
      }
    }

    new TaskContext('method-call').logger.debug(
      `🎉 All ${merkleTree.totalBatches} batches distributed successfully`,
    );
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
  ): Promise<void> {
    const chunkSize = Math.max(
      1,
      Math.floor(originalLeaf.recipients.length / 2),
    );
    new TaskContext('method-call').logger.debug(
      `📦 Splitting batch ${batchNumber} into chunks of ${chunkSize} workers each`,
    );

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

      new TaskContext('method-call').logger.debug(
        `📦 Processing chunk ${chunkIndex}/${totalChunks} of batch ${batchNumber} with ${chunkRecipients.length} workers`,
      );

      try {
        // Simulate this chunk
        const chunkSimulation = await this.simulateDistribution(
          fromBlock,
          toBlock,
          chunkRecipients,
          chunkWorkerRewards,
          chunkStakerRewards,
          originalProof,
        );

        if (!chunkSimulation.success) {
          new TaskContext('error-handling').logger.error(
            `❌ Chunk ${chunkIndex} simulation failed: ${chunkSimulation.error}`,
          );

          if (chunkRecipients.length === 1) {
            new TaskContext('error-handling').logger.error(
              `❌ Single worker chunk failed - skipping worker ${chunkRecipients[0]}`,
            );
            continue;
          } else {
            // Recursively split further
            await this.distributeBatchInChunks(
              fromBlock,
              toBlock,
              {
                recipients: chunkRecipients,
                workerRewards: chunkWorkerRewards,
                stakerRewards: chunkStakerRewards,
              },
              originalProof,
              batchNumber,
            );
            continue;
          }
        }

        new TaskContext('method-call').logger.debug(
          `🧪 Chunk ${chunkIndex} simulation passed, estimated gas: ${chunkSimulation.estimatedGas}`,
        );

        // Execute the chunk
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
        const receipt = await this.publicClient.waitForTransactionReceipt({
          hash,
        });

        new TaskContext('method-call').logger.debug(
          `✅ Chunk ${chunkIndex}/${totalChunks} of batch ${batchNumber} distributed: tx=${receipt.transactionHash}, gas used: ${receipt.gasUsed}`,
        );
      } catch (error) {
        new TaskContext('error-handling').logger.error(
          `❌ Failed to distribute chunk ${chunkIndex} of batch ${batchNumber}: ${error.message}`,
        );
        throw error;
      }
    }
  }

  /**
   * Get distribution status from contract
   */
  async getDistributionStatus(
    fromBlock: number,
    toBlock: number,
  ): Promise<any> {
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
      new TaskContext('error-handling').logger.error(
        `Failed to get distribution status: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Generate commitment key as the contract does
   */
  private generateCommitmentKey(
    fromBlock: number,
    toBlock: number,
  ): `0x${string}` {
    const encoded = encodePacked(
      ['uint256', 'uint256'],
      [BigInt(fromBlock), BigInt(toBlock)],
    );
    return keccak256(encoded);
  }

  // log gas optimization summary
  private logGasOptimizationSummary(gasOptimizations: {
    originalBatchSize: number;
    finalBatchSize: number;
    batchesAdjusted: number;
    totalGasSimulations: number;
  }): void {
    new TaskContext('method-call').logger.debug(`📊 Gas Optimization Summary:`);
    new TaskContext('method-call').logger.debug(
      `   - Original batch size: ${gasOptimizations.originalBatchSize} workers`,
    );
    new TaskContext('method-call').logger.debug(
      `   - Final batch size: ${gasOptimizations.finalBatchSize} workers`,
    );
    new TaskContext('method-call').logger.debug(
      `   - Batches adjusted: ${gasOptimizations.batchesAdjusted}`,
    );
    new TaskContext('method-call').logger.debug(
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
      new TaskContext('method-call').logger.debug(
        `   - Batch size reduction: ${reduction}%`,
      );
    }
  }

  /**
   * Check if rewards can be claimed for a worker
   */
  async getClaimableRewards(workerAddress: Address): Promise<bigint> {
    // This would need to be implemented based on the contract's claimable function
    // For now, return 0 as placeholder
    return 0n;
  }
}
