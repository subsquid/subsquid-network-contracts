import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
  private readonly logger = new Logger(DistributionService.name);
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

    this.logger.log(
      `Distribution service initialized with contract: ${this.contractAddress}`,
    );
    this.logger.log(`Using distributor address: ${account.address}`);
    this.logger.log(`RPC URL: ${rpcUrl}`);
    this.logger.log(`Gas simulation configuration:`);
    this.logger.log(
      `  - Enabled: ${this.gasSimulationConfig.enablePreflightSimulation}`,
    );
    this.logger.log(
      `  - Max optimization attempts: ${this.gasSimulationConfig.maxOptimizationAttempts}`,
    );
    this.logger.log(
      `  - Min batch size: ${this.gasSimulationConfig.minBatchSize}`,
    );
    this.logger.log(
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
      this.logger.log(`🚀 Starting distribution for epoch ${epochId}`);

      // check bond amount and contract state
      try {
        const bondAmount = await this.web3Service.getBondAmount();
        const activeWorkerCount = await this.web3Service.getActiveWorkerCount();
        this.logger.log(`📋 Pre-distribution checks:`);
        this.logger.log(`   - Bond amount: ${Number(bondAmount) / 1e18} SQD`);
        this.logger.log(
          `   - Active workers in contract: ${activeWorkerCount}`,
        );
      } catch (error) {
        this.logger.warn(`Failed to get contract state: ${error.message}`);
      }

      // calc rewards for all workers from ClickHouse
      status.status = 'calculating';
      const calculationResult =
        await this.rewardsCalculatorService.calculateRewardsDetailed(
          fromBlock,
          toBlock,
          true, // skip signature validation for development
        );

      this.logger.log(
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

      this.logger.log(
        `✅ Mapped to ${status.totalWorkers} registered workers, total: ${Number(status.totalRewards) / 1e18} SQD`,
      );

      // optimize batch size with gas simulation (if enabled)
      status.status = 'generating_tree';
      let optimizedBatchSize = batchSize;
      let totalGasSimulations = 0;

      if (this.gasSimulationConfig.enablePreflightSimulation) {
        this.logger.log(`🔧 Optimizing batch size for gas efficiency...`);

        const optimizationResult = await this.optimizeBatchSize(
          fromBlock,
          toBlock,
          workerRewards,
          batchSize,
        );

        optimizedBatchSize = optimizationResult.optimizedBatchSize;
        totalGasSimulations = optimizationResult.gasSimulations;

        if (optimizedBatchSize !== batchSize) {
          this.logger.warn(
            `⚠️ Batch size adjusted from ${batchSize} to ${optimizedBatchSize} based on gas simulation`,
          );
        } else {
          this.logger.log(`✅ Original batch size ${batchSize} is optimal`);
        }
      } else {
        this.logger.log(
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

      this.logger.log(
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

      this.logger.log(`✅ Committed Merkle root to contract`);

      // distribute in batches
      status.status = 'distributing';
      await this.distributeBatches(fromBlock, toBlock, merkleTree);

      status.processedBatches = merkleTree.totalBatches;
      status.status = 'completed';
      status.completedAt = new Date();

      this.logger.log(`🎉 Distribution completed for epoch ${epochId}`);

      // log gas optimization summary
      if (status.gasOptimizations) {
        this.logGasOptimizationSummary(status.gasOptimizations);
      }

      return status;
    } catch (error) {
      this.logger.error(
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
    // retry logic with different block ranges if commitment already exists
    let commitSuccess = false;
    let retryCount = 0;
    const MAX_RETRIES = 10;
    let currentFromBlock = fromBlock;
    let currentToBlock = toBlock;

    while (!commitSuccess && retryCount < MAX_RETRIES) {
      try {
        this.logger.log(
          `🔍 Attempting to commit for block range [${currentFromBlock}, ${currentToBlock}]`,
        );

        // check if we can commit
        const canCommit = await this.publicClient.readContract({
          address: this.contractAddress,
          abi: this.contractAbi,
          functionName: 'canCommit',
          args: [this.walletClient.account.address],
        });

        if (!canCommit) {
          throw new Error('Account is not authorized to commit distributions');
        }

        // check if this range is already committed
        const commitmentKey = this.generateCommitmentKey(
          currentFromBlock,
          currentToBlock,
        );
        try {
          const commitment = await this.publicClient.readContract({
            address: this.contractAddress,
            abi: this.contractAbi,
            functionName: 'commitments',
            args: [commitmentKey],
          });

          if (commitment && commitment[0]) {
            // exists field
            this.logger.warn(
              `Block range [${currentFromBlock}, ${currentToBlock}] already committed`,
            );
            // try next block range
            currentFromBlock += 100;
            currentToBlock += 100;
            retryCount++;
            continue;
          }
        } catch (commitmentCheckError) {
          this.logger.warn(
            `Could not check commitment status: ${commitmentCheckError.message}`,
          );
        }

        // Commit the root
        const { request } = await this.publicClient.simulateContract({
          account: this.walletClient.account,
          address: this.contractAddress,
          abi: this.contractAbi,
          functionName: 'commitRoot',
          args: [
            [BigInt(currentFromBlock), BigInt(currentToBlock)],
            merkleRoot as `0x${string}`,
            totalBatches,
            `ipfs://rewards-${currentFromBlock}-${currentToBlock}`, // Placeholder IPFS link
          ],
        });

        const hash = await this.walletClient.writeContract(request);

        // Wait for confirmation
        const receipt = await this.publicClient.waitForTransactionReceipt({
          hash,
        });

        this.logger.log(
          `✅ Merkle root committed: tx=${receipt.transactionHash} for blocks [${currentFromBlock}, ${currentToBlock}]`,
        );
        commitSuccess = true;
      } catch (error) {
        const errorStr = String(error?.message || error);
        this.logger.error(
          `Commit attempt ${retryCount + 1} failed: ${errorStr}`,
        );

        if (
          errorStr.includes('ALREADY_COMMITTED') ||
          errorStr.includes('MerkleRootAlreadyCommitted')
        ) {
          this.logger.warn(
            `Root already committed for block range [${currentFromBlock}, ${currentToBlock}]. Trying next range...`,
          );
          currentFromBlock += 100;
          currentToBlock += 100;
          retryCount++;
        } else if (retryCount === MAX_RETRIES - 1) {
          throw new Error(
            `Failed to commit Merkle root after ${MAX_RETRIES} attempts: ${errorStr}`,
          );
        } else {
          retryCount++;
          // Wait before retrying
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    }

    if (!commitSuccess) {
      throw new Error(
        `Failed to find an available block range after ${MAX_RETRIES} attempts`,
      );
    }
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
      this.logger.debug(
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

      this.logger.debug(
        `✅ Gas simulation successful: ${gasEstimate} gas for ${recipients.length} workers`,
      );

      return {
        success: true,
        estimatedGas: gasEstimate,
      };
    } catch (error) {
      const errorMessage = error?.message || String(error);
      this.logger.warn(
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
    this.logger.log(
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
        this.logger.warn(
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
        this.logger.warn('⚠️ No leaves generated for test batch');
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
        this.logger.log(
          `✅ Optimal batch size found: ${testBatchSize} workers (${gasSimulations} simulations)`,
        );
        return { optimizedBatchSize: testBatchSize, gasSimulations };
      } else {
        this.logger.warn(
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

        this.logger.log(
          `🔄 Retrying with reduced batch size: ${testBatchSize}`,
        );
      }
    }

    this.logger.warn(
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
    this.logger.log(
      `Distributing ${merkleTree.totalBatches} batches with gas simulation...`,
    );

    for (let i = 0; i < merkleTree.leaves.length; i++) {
      const leaf = merkleTree.leaves[i];
      const proof = merkleTree.proofs[i];

      try {
        this.logger.log(
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
            this.logger.error(
              `❌ Pre-flight simulation failed for batch ${i + 1}: ${gasSimulation.error}`,
            );

            if (leaf.recipients.length > 1) {
              this.logger.warn(
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

          this.logger.log(
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

        this.logger.log(
          `✅ Batch ${i + 1} distributed successfully: tx=${receipt.transactionHash}, gas used: ${receipt.gasUsed}`,
        );
      } catch (error) {
        this.logger.error(
          `❌ Failed to distribute batch ${i + 1}: ${error.message}`,
        );
        throw error;
      }
    }

    this.logger.log(
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
    this.logger.log(
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

      this.logger.log(
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
          this.logger.error(
            `❌ Chunk ${chunkIndex} simulation failed: ${chunkSimulation.error}`,
          );

          if (chunkRecipients.length === 1) {
            this.logger.error(
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

        this.logger.log(
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

        this.logger.log(
          `✅ Chunk ${chunkIndex}/${totalChunks} of batch ${batchNumber} distributed: tx=${receipt.transactionHash}, gas used: ${receipt.gasUsed}`,
        );
      } catch (error) {
        this.logger.error(
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
      this.logger.error(`Failed to get distribution status: ${error.message}`);
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
    this.logger.log(`📊 Gas Optimization Summary:`);
    this.logger.log(
      `   - Original batch size: ${gasOptimizations.originalBatchSize} workers`,
    );
    this.logger.log(
      `   - Final batch size: ${gasOptimizations.finalBatchSize} workers`,
    );
    this.logger.log(
      `   - Batches adjusted: ${gasOptimizations.batchesAdjusted}`,
    );
    this.logger.log(
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
      this.logger.log(`   - Batch size reduction: ${reduction}%`);
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
