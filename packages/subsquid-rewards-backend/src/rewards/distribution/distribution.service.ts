import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Web3Service } from '../../blockchain/web3.service';
import { MerkleTreeService, MerkleTreeResult } from './merkle-tree.service';
import { RewardsCalculatorService, WorkerReward } from '../calculation/rewards-calculator.service';
import { createPublicClient, createWalletClient, http, parseAbi, Address, encodePacked, keccak256 } from 'viem';
import { arbitrum, foundry } from 'viem/chains';
import { defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export interface DistributionStatus {
  epochId: string;
  fromBlock: number;
  toBlock: number;
  status: 'calculating' | 'generating_tree' | 'committing' | 'distributing' | 'completed' | 'failed';
  totalWorkers: number;
  totalBatches: number;
  processedBatches: number;
  merkleRoot?: string;
  totalRewards: bigint;
  error?: string;
  startedAt: Date;
  completedAt?: Date;
}

@Injectable()
export class DistributionService {
  private readonly logger = new Logger(DistributionService.name);
  private readonly publicClient;
  private readonly walletClient;
  private readonly contractAddress: Address;
  
  // contract ABI for the essential functions
  private readonly contractAbi = parseAbi([
    'function commitRoot(uint256[2] calldata blockRange, bytes32 root, uint16 totalBatches, string calldata ipfs) external',
    'function approveRoot(uint256[2] calldata blockRange) external',
    'function distribute(uint256[2] calldata blockRange, uint256[] calldata recipients, uint256[] calldata workerRewards, uint256[] calldata stakerRewards, bytes32[] calldata merkleProof) external',
    'function commitments(bytes32 key) external view returns (bool exists, bytes32 merkleRoot, uint16 totalBatches, uint16 processedBatches, uint256 approvalCount, string memory ipfsLink)',
    'function canCommit(address who) external view returns (bool)',
    'function requiredApproves() external view returns (uint256)',
  ]);

  constructor(
    private configService: ConfigService,
    private web3Service: Web3Service,
    private merkleTreeService: MerkleTreeService,
    private rewardsCalculatorService: RewardsCalculatorService,
  ) {
    // read from environment variables via config service
    const rpcUrl = this.configService.get('blockchain.network.l2RpcUrl', 'http://localhost:8545');
    
    // get private key from environment variable with validation
    const privateKey = process.env.DISTRIBUTOR_PRIVATE_KEY || this.configService.get('blockchain.distributor.privateKey');
    
    if (!privateKey) {
      throw new Error('DISTRIBUTOR_PRIVATE_KEY environment variable is required');
    }
    
    // validate private key format
    if (!privateKey.startsWith('0x') || privateKey.length !== 66) {
      throw new Error('Invalid private key format. Must be 64 hex characters prefixed with 0x');
    }
    
    // get contract address from environment variable (use NEW deployed contract)
    const contractAddress = process.env.REWARDS_DISTRIBUTION_ADDRESS || 
                           this.configService.get('blockchain.contracts.rewardsDistribution', '0x36fE2E7a1c19F7Be268272540E9A4aB306686506');
    
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

    this.logger.log(`Distribution service initialized with contract: ${this.contractAddress}`);
    this.logger.log(`Using distributor address: ${account.address}`);
    this.logger.log(`RPC URL: ${rpcUrl}`);
  }

  // execute complete distribution flow for an epoch
  async distributeEpochRewards(
    fromBlock: number,
    toBlock: number,
    batchSize: number = 50
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
        this.logger.log(`   - Active workers in contract: ${activeWorkerCount}`);
      } catch (error) {
        this.logger.warn(`Failed to get contract state: ${error.message}`);
      }

      // calc rewards for all workers from ClickHouse
      status.status = 'calculating';
      const calculationResult = await this.rewardsCalculatorService.calculateRewardsDetailed(
        fromBlock,
        toBlock,
        true // skip signature validation for development
      );

      this.logger.log(`✅ Calculated rewards for ${calculationResult.workers.length} workers from ClickHouse`);

      // map to contract worker IDs (this filters out unregistered workers)
      // get timestamp range for the epoch to fetch worker data
      const startTime = await this.web3Service.getBlockTimestamp(fromBlock);
      const endTime = await this.web3Service.getBlockTimestamp(toBlock);
      const activeWorkerData = await this.rewardsCalculatorService['clickHouseService'].getActiveWorkers(startTime, endTime, true);
      const workerRewards = await this.rewardsCalculatorService.mapToContractWorkerIds(
        calculationResult.workers,
        activeWorkerData
      );

      status.totalWorkers = workerRewards.length;
      status.totalRewards = workerRewards.reduce((sum, w) => sum + w.workerReward, 0n);

      this.logger.log(`✅ Mapped to ${status.totalWorkers} registered workers, total: ${Number(status.totalRewards) / 1e18} SQD`);

      // generate Merkle tree
      status.status = 'generating_tree';
      const merkleTree = await this.merkleTreeService.generateMerkleTree(workerRewards, batchSize);
      
      status.totalBatches = merkleTree.totalBatches;
      status.merkleRoot = merkleTree.root;

      this.logger.log(`✅ Generated Merkle tree: root=${merkleTree.root}, batches=${merkleTree.totalBatches}`);

      // commit root to contract
      status.status = 'committing';
      await this.commitMerkleRoot(fromBlock, toBlock, merkleTree.root, merkleTree.totalBatches);

      this.logger.log(`✅ Committed Merkle root to contract`);

      // distribute in batches
      status.status = 'distributing';
      await this.distributeBatches(fromBlock, toBlock, merkleTree);
      
      status.processedBatches = merkleTree.totalBatches;
      status.status = 'completed';
      status.completedAt = new Date();

      this.logger.log(`🎉 Distribution completed for epoch ${epochId}`);

      return status;

    } catch (error) {
      this.logger.error(`❌ Distribution failed for epoch ${epochId}: ${error.message}`);
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
    totalBatches: number
  ): Promise<void> {
    // retry logic with different block ranges if commitment already exists
    let commitSuccess = false;
    let retryCount = 0;
    const MAX_RETRIES = 10;
    let currentFromBlock = fromBlock;
    let currentToBlock = toBlock;

    while (!commitSuccess && retryCount < MAX_RETRIES) {
      try {
        this.logger.log(`🔍 Attempting to commit for block range [${currentFromBlock}, ${currentToBlock}]`);
        
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
        const commitmentKey = this.generateCommitmentKey(currentFromBlock, currentToBlock);
        try {
          const commitment = await this.publicClient.readContract({
            address: this.contractAddress,
            abi: this.contractAbi,
            functionName: 'commitments',
            args: [commitmentKey],
          });

          if (commitment && commitment[0]) { // exists field
            this.logger.warn(`Block range [${currentFromBlock}, ${currentToBlock}] already committed`);
            // try next block range
            currentFromBlock += 100;
            currentToBlock += 100;
            retryCount++;
            continue;
          }
        } catch (commitmentCheckError) {
          this.logger.warn(`Could not check commitment status: ${commitmentCheckError.message}`);
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
            `ipfs://rewards-${currentFromBlock}-${currentToBlock}` // Placeholder IPFS link
          ],
        });

        const hash = await this.walletClient.writeContract(request);
        
        // Wait for confirmation
        const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
        
        this.logger.log(`✅ Merkle root committed: tx=${receipt.transactionHash} for blocks [${currentFromBlock}, ${currentToBlock}]`);
        commitSuccess = true;

      } catch (error) {
        const errorStr = String(error?.message || error);
        this.logger.error(`Commit attempt ${retryCount + 1} failed: ${errorStr}`);

        if (errorStr.includes('ALREADY_COMMITTED') || errorStr.includes('MerkleRootAlreadyCommitted')) {
          this.logger.warn(`Root already committed for block range [${currentFromBlock}, ${currentToBlock}]. Trying next range...`);
          currentFromBlock += 100;
          currentToBlock += 100;
          retryCount++;
        } else if (retryCount === MAX_RETRIES - 1) {
          throw new Error(`Failed to commit Merkle root after ${MAX_RETRIES} attempts: ${errorStr}`);
        } else {
          retryCount++;
          // Wait before retrying
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }

    if (!commitSuccess) {
      throw new Error(`Failed to find an available block range after ${MAX_RETRIES} attempts`);
    }
  }

  /**
   * Distribute rewards in batches using Merkle proofs
   */
  private async distributeBatches(
    fromBlock: number,
    toBlock: number,
    merkleTree: MerkleTreeResult
  ): Promise<void> {
    this.logger.log(`Distributing ${merkleTree.totalBatches} batches...`);

    for (let i = 0; i < merkleTree.leaves.length; i++) {
      const leaf = merkleTree.leaves[i];
      const proof = merkleTree.proofs[i];

      try {
        this.logger.log(`Distributing batch ${i + 1}/${merkleTree.totalBatches} with ${leaf.recipients.length} workers`);

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
        const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
        
        this.logger.log(`✅ Batch ${i + 1} distributed: tx=${receipt.transactionHash}`);

      } catch (error) {
        this.logger.error(`Failed to distribute batch ${i + 1}: ${error.message}`);
        throw error;
      }
    }

    this.logger.log(`🎉 All ${merkleTree.totalBatches} batches distributed successfully`);
  }

  /**
   * Get distribution status from contract
   */
  async getDistributionStatus(fromBlock: number, toBlock: number): Promise<any> {
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
  private generateCommitmentKey(fromBlock: number, toBlock: number): `0x${string}` {
    const encoded = encodePacked(
      ['uint256', 'uint256'],
      [BigInt(fromBlock), BigInt(toBlock)]
    );
    return keccak256(encoded);
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