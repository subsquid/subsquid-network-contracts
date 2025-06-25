import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Web3Service } from './web3.service';
import { FordefiService } from './fordefi/fordefi.service';
import { Address, Hex, getContract, parseAbiItem, encodeFunctionData, keccak256, encodePacked } from 'viem';
import {
  DistributedRewardsDistributionABI,
  RewardCalculationABI,
  WorkerRegistrationABI,
  NetworkControllerABI,
  StakingABI,
} from './contracts/abis';

export interface MulticallResult<T> {
  error?: Error;
  result?: T;
  status: 'success' | 'failure';
}

export interface CommitmentInfo {
  fromBlock: bigint;
  toBlock: bigint;
  merkleRoot: Hex;
  totalBatches: number;
  processedBatches: number;
  approvalCount: bigint;
  ipfsLink: string;
  exists: boolean;
}

@Injectable()
export class ContractService {
  private readonly logger = new Logger(ContractService.name);

  constructor(
    private configService: ConfigService,
    private web3Service: Web3Service,
    private fordefiService: FordefiService,
  ) {}

  async getCurrentApy(): Promise<bigint> {
    try {
      const rewardCalculationAddress = this.configService.get('blockchain.contracts.rewardCalculation') as Address;
      
      if (!rewardCalculationAddress) {
        this.logger.warn('Reward calculation contract address not configured');
      }

      // for dev: return mock APY (15% = 1500 basis points)
      const mockApy = BigInt('1500');
      this.logger.log('Using mock APY (15%) for development');
      return mockApy;
      
    } catch (error) {
      this.logger.error(`Failed to get current APY: ${error.message}`);
      throw error;
    }
  }

  async getEpochLength(blockNumber?: bigint): Promise<number> {
    const configuredLength = this.configService.get('blockchain.rewardEpochLength');
    if (configuredLength) {
      return configuredLength;
    }

    try {
      const workerRegistrationAddress = this.configService.get('blockchain.contracts.workerRegistration') as Address;
      
      const contract = getContract({
        address: workerRegistrationAddress,
        abi: WorkerRegistrationABI,
        client: this.web3Service.client,
      });

      return Number(await contract.read.epochLength({ blockNumber }));
    } catch (error) {
      this.logger.error(`Failed to get epoch length: ${error.message}`);
      return 7000; // Default
    }
  }

  async getNextEpoch(blockNumber?: bigint): Promise<number> {
    try {
      const networkControllerAddress = this.configService.get('blockchain.contracts.networkController') as Address;
      
      const contract = getContract({
        address: networkControllerAddress,
        abi: NetworkControllerABI,
        client: this.web3Service.client,
      });

      return Number(await contract.read.nextEpoch({ blockNumber }));
    } catch (error) {
      this.logger.error(`Failed to get next epoch: ${error.message}`);
      return 1;
    }
  }

  async getBondAmount(): Promise<bigint> {
    try {
      const stakingAddress = this.configService.get('blockchain.contracts.staking') as Address;
      
      if (!stakingAddress) {
        this.logger.warn('Staking contract address not configured');
      }

      // for dev: return mock bond amount
      const mockBondAmount = BigInt('100000000000000000000000'); // 100k SQD
      this.logger.log('Using mock bond amount (100k SQD) for development');
      return mockBondAmount;
      
    } catch (error) {
      this.logger.error(`Failed to get bond amount: ${error.message}`);
      throw error;
    }
  }

  async getLastRewardedBlock(): Promise<number> {
    try {
      const rewardsDistributionAddress = this.configService.get('blockchain.contracts.rewardsDistribution') as Address;
      
      const contract = getContract({
        address: rewardsDistributionAddress,
        abi: DistributedRewardsDistributionABI,
        client: this.web3Service.client,
      });

      return Number(await contract.read.lastBlockRewarded());
    } catch (error) {
      this.logger.error(`Failed to get last rewarded block: ${error.message}`);
      return 0;
    }
  }

  async isCommitted(fromBlock: number, toBlock: number): Promise<boolean> {
    try {
      const rewardsDistributionAddress = this.configService.get('blockchain.contracts.rewardsDistribution') as Address;
      
      const contract = getContract({
        address: rewardsDistributionAddress,
        abi: DistributedRewardsDistributionABI,
        client: this.web3Service.client,
      });

      // create the commitment key
      const commitmentKey = keccak256(
        encodePacked(['uint256', 'uint256'], [BigInt(fromBlock), BigInt(toBlock)])
      );

      const commitment = await contract.read.commitments([commitmentKey]);
      return commitment[0]; // exists field
    } catch (error) {
      this.logger.error(`Failed to check if committed: ${error.message}`);
      return false;
    }
  }

  async canCommit(address: Hex): Promise<boolean> {
    try {
      const rewardsDistributionAddress = this.configService.get('blockchain.contracts.rewardsDistribution') as Address;
      
      const contract = getContract({
        address: rewardsDistributionAddress,
        abi: DistributedRewardsDistributionABI,
        client: this.web3Service.client,
      });

      return await contract.read.canCommit([address]);
    } catch (error) {
      this.logger.error(`Failed to check if can commit: ${error.message}`);
      return false;
    }
  }

  async getTargetCapacity(blockNumber?: bigint): Promise<bigint> {
    try {
      const workerRegistrationAddress = this.configService.get('blockchain.contracts.workerRegistration') as Address;
      
      const contract = getContract({
        address: workerRegistrationAddress,
        abi: WorkerRegistrationABI,
        client: this.web3Service.client,
      });

      return await contract.read.targetCapacity({ blockNumber });
    } catch (error) {
      this.logger.error(`Failed to get target capacity: ${error.message}`);
      const configValue = this.configService.get('rewards.targetCapacityGB');
      return BigInt(configValue || 30000) * BigInt(1e9);
    }
  }

  async getStoragePerWorkerInGb(blockNumber?: bigint): Promise<number> {
    try {
      const workerRegistrationAddress = this.configService.get('blockchain.contracts.workerRegistration') as Address;
      
      const contract = getContract({
        address: workerRegistrationAddress,
        abi: WorkerRegistrationABI,
        client: this.web3Service.client,
      });

      return Number(await contract.read.storagePerWorkerInGb({ blockNumber }));
    } catch (error) {
      this.logger.error(`Failed to get storage per worker: ${error.message}`);
      return 200; // default 200GB
    }
  }

  async getRegisteredWorkersCount(blockNumber?: bigint): Promise<number> {
    try {
      const workerRegistrationAddress = this.configService.get('blockchain.contracts.workerRegistration') as Address;
      
      const contract = getContract({
        address: workerRegistrationAddress,
        abi: WorkerRegistrationABI,
        client: this.web3Service.client,
      });

      return Number(await contract.read.registeredWorkersCount({ blockNumber }));
    } catch (error) {
      this.logger.error(`Failed to get registered workers count: ${error.message}`);
      return 0;
    }
  }

  async getLatestCommitment(): Promise<CommitmentInfo | undefined> {
    try {
      const rewardsDistributionAddress = this.configService.get('blockchain.contracts.rewardsDistribution') as Address;
      
      const logs = await this.web3Service.client.getLogs({
        address: rewardsDistributionAddress,
        event: parseAbiItem(
          `event NewCommitment(address indexed committer, uint256 fromBlock, uint256 toBlock, bytes32 merkleRoot)`,
        ),
        fromBlock: 1n,
      });

      if (logs.length === 0) {
        this.logger.warn('No commitment logs found');
        return undefined;
      }

      const latestLog = logs[logs.length - 1];
      
      // ensure args and required properties exist
      if (!latestLog.args || 
          latestLog.args.fromBlock === undefined || 
          latestLog.args.toBlock === undefined || 
          latestLog.args.merkleRoot === undefined) {
        this.logger.warn('Latest commitment log found but arguments are incomplete.');
        return undefined;
      }

      const { fromBlock: commitFromBlock, toBlock: commitToBlock, merkleRoot: commitMerkleRoot } = latestLog.args;
      
      // get additional commitment info from contract
      const contract = getContract({
        address: rewardsDistributionAddress,
        abi: DistributedRewardsDistributionABI,
        client: this.web3Service.client,
      });

      const commitmentKey = keccak256(
        encodePacked(['uint256', 'uint256'], [commitFromBlock, commitToBlock])
      );

      const commitmentData = await contract.read.commitments([commitmentKey]);

      return {
        fromBlock: commitFromBlock,
        toBlock: commitToBlock,
        merkleRoot: commitMerkleRoot,
        totalBatches: 0, // plcholder
        processedBatches: 0, // plcholder
        approvalCount: BigInt(commitmentData[3] || 0), // ensure bigint conversion
        ipfsLink: '', // plcholder
        exists: commitmentData[0] || false, // Assuming 1st element is exists flag
      };
    } catch (error) {
      this.logger.error(`Failed to get latest commitment: ${error.message}`);
      return undefined;
    }
  }

  async getStakes(workerIds: string[]): Promise<[any[], any[]]> {
    try {
      // use the proper config keys that match blockchain.config.ts
      const stakingAddress = this.configService.get('blockchain.contracts.staking') as Address;
      
      if (!stakingAddress) {
        this.logger.warn('Staking contract address not configured, using mock data');
        const mockStakes = workerIds.map(() => ({ result: BigInt('10000000000000000000') })); // 10 SQD each
        return [mockStakes, mockStakes];
      }

      this.logger.log(`Getting stakes for ${workerIds.length} workers from contract ${stakingAddress}`);
      
      // for dev: mock data but with proper contract address configured
      const mockStakes = workerIds.map(() => ({ result: BigInt('10000000000000000000') })); // 10 SQD each
      this.logger.log('Using mock stakes for development (contract integration pending)');
      return [mockStakes, mockStakes];
      
    } catch (error) {
      this.logger.error(`Failed to get stakes: ${error.message}`);
      throw error;
    }
  }

  // updated Merkle tree distribution methods with Fordefi integration
  async commitRoot(
    fromBlock: number,
    toBlock: number,
    merkleRoot: Hex,
    totalBatches: number,
    ipfsLink: string = ''
  ): Promise<Hex | undefined> {
    try {
      const rewardsDistributionAddress = this.configService.get('blockchain.contracts.rewardsDistribution') as Address;
      
      if (!this.fordefiService.isConfigured()) {
        this.logger.error('Fordefi is not properly configured');
        return undefined;
      }

      // encode the function call
      const data = encodeFunctionData({
        abi: DistributedRewardsDistributionABI,
        functionName: 'commitRoot',
        args: [
          [BigInt(fromBlock), BigInt(toBlock)],
          merkleRoot,
          totalBatches,
          ipfsLink,
        ],
      });

      // send transaction through Fordefi
      const txHash = await this.fordefiService.sendTransaction(
        rewardsDistributionAddress,
        data,
        `Commit Merkle root for blocks ${fromBlock}-${toBlock}`,
        { priority_level: 'high' }
      );

      this.logger.log(`Root committed successfully: ${txHash}`);
      return txHash;
    } catch (error) {
      this.logger.error(`Failed to commit root: ${error.message}`);
      return undefined;
    }
  }

  async approveRoot(fromBlock: number, toBlock: number): Promise<Hex | undefined> {
    try {
      const rewardsDistributionAddress = this.configService.get('blockchain.contracts.rewardsDistribution') as Address;
      
      if (!this.fordefiService.isConfigured()) {
        this.logger.error('Fordefi is not properly configured');
        return undefined;
      }

      // encode the function call
      const data = encodeFunctionData({
        abi: DistributedRewardsDistributionABI,
        functionName: 'approveRoot',
        args: [[BigInt(fromBlock), BigInt(toBlock)]],
      });

      // send transaction through Fordefi
      const txHash = await this.fordefiService.sendTransaction(
        rewardsDistributionAddress,
        data,
        `Approve root for blocks ${fromBlock}-${toBlock}`,
        { priority_level: 'high' }
      );

      this.logger.log(`Root approved successfully: ${txHash}`);
      return txHash;
    } catch (error) {
      this.logger.error(`Failed to approve root: ${error.message}`);
      return undefined;
    }
  }

  async distributeBatch(
    fromBlock: number,
    toBlock: number,
    recipients: number[],
    workerRewards: bigint[],
    stakerRewards: bigint[],
    merkleProof: Hex[]
  ): Promise<Hex | undefined> {
    try {
      const rewardsDistributionAddress = this.configService.get('blockchain.contracts.rewardsDistribution') as Address;
      
      if (!this.fordefiService.isConfigured()) {
        this.logger.error('Fordefi is not properly configured');
        return undefined;
      }

      // encode the function call
      const data = encodeFunctionData({
        abi: DistributedRewardsDistributionABI,
        functionName: 'distribute',
        args: [
          [BigInt(fromBlock), BigInt(toBlock)],
          recipients.map(r => BigInt(r)),
          workerRewards,
          stakerRewards,
          merkleProof,
        ],
      });

      // send transaction through Fordefi
      const txHash = await this.fordefiService.sendTransaction(
        rewardsDistributionAddress,
        data,
        `Distribute batch ${recipients.length} workers (blocks ${fromBlock}-${toBlock})`,
        { priority_level: 'medium' }
      );

      this.logger.log(`Batch distributed successfully: ${txHash}`);
      return txHash;
    } catch (error) {
      this.logger.error(`Failed to distribute batch: ${error.message}`);
      return undefined;
    }
  }

  async isBatchProcessed(
    fromBlock: number,
    toBlock: number,
    leafHash: Hex
  ): Promise<boolean> {
    try {
      const rewardsDistributionAddress = this.configService.get('blockchain.contracts.rewardsDistribution') as Address;
      
      const contract = getContract({
        address: rewardsDistributionAddress,
        abi: DistributedRewardsDistributionABI,
        client: this.web3Service.client,
      });

      // create the commitment key
      const commitmentKey = keccak256(
        encodePacked(['uint256', 'uint256'], [BigInt(fromBlock), BigInt(toBlock)])
      );

      return await contract.read.processed([commitmentKey, leafHash]);
    } catch (error) {
      this.logger.error(`Failed to check if batch is processed: ${error.message}`);
      return false;
    }
  }

  // legacy methods for backward compatibility
  async commitRewards(fromBlock: number, toBlock: number, workerIds: bigint[], workerRewards: bigint[], stakerRewards: bigint[]): Promise<Hex | undefined> {
    this.logger.warn('commitRewards (legacy) not implemented - use commitRoot instead');
    return undefined;
  }

  async approveRewards(fromBlock: number, toBlock: number, workerIds: bigint[], workerRewards: bigint[], stakerRewards: bigint[]): Promise<Hex | undefined> {
    this.logger.warn('approveRewards (legacy) not implemented - use approveRoot instead');
    return undefined;
  }
} 