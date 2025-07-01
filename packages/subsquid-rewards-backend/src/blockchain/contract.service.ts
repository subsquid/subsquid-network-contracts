import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Web3Service } from './web3.service';
import { FordefiService } from './fordefi/fordefi.service';
import { ClickHouseService } from '../database/clickhouse.service';
import {
  Address,
  Hex,
  getContract,
  parseAbiItem,
  encodeFunctionData,
  keccak256,
  encodePacked,
} from 'viem';
import {
  DistributedRewardsDistributionABI,
  RewardCalculationABI,
  WorkerRegistrationABI,
  NetworkControllerABI,
  StakingABI,
  CapedStakingABI,
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
    private clickHouseService: ClickHouseService,
  ) {}

  async getCurrentApy(): Promise<bigint> {
    try {
      try {
        const networkName =
          this.configService.get('blockchain.network.networkName') || 'mainnet';
        const query = `
          SELECT 
            base_apr
          FROM ${networkName}.rewards_stats
          WHERE is_commit_success = true
          ORDER BY epoch_end DESC
          LIMIT 1
        `;

        // use the properly injected ClickHouse service
        const client = (this.clickHouseService as any).client;
        if (client) {
          const resultSet = await client.query({
            query,
            format: 'JSONEachRow',
          });

          const results = await resultSet.json();
          const resultArray = Array.isArray(results) ? results : [results];

          if (resultArray.length > 0 && resultArray[0].base_apr !== undefined) {
            const apr = BigInt(resultArray[0].base_apr);
            this.logger.log(
              `Retrieved APR from ClickHouse: ${apr} basis points`,
            );
            return apr;
          }
        }
      } catch (error) {
        this.logger.warn(`Failed to get APR from ClickHouse: ${error.message}`);
      }

      // try to get from contract
      const rewardCalculationAddress = this.configService.get(
        'blockchain.contracts.rewardCalculation',
      ) as Address;
      const networkControllerAddress = this.configService.get(
        'blockchain.contracts.networkController',
      ) as Address;

      if (rewardCalculationAddress) {
        try {
          const contract = getContract({
            address: rewardCalculationAddress,
            abi: RewardCalculationABI,
            client: this.web3Service.client,
          });

          this.logger.log(
            'Contract APY calculation not available in current ABIs',
          );
          return BigInt('2000'); // 20% default
        } catch (error) {
          this.logger.warn(
            `Failed to calculate APY from contract: ${error.message}`,
          );
        }
      }

      // Default: return 20% APY (2000 basis points)
      const defaultApy = BigInt('2000');
      this.logger.log('Using default APY (20%)');
      return defaultApy;
    } catch (error) {
      this.logger.error(`Failed to get current APY: ${error.message}`);
      throw error;
    }
  }

  async getEpochLength(blockNumber?: bigint): Promise<number> {
    const configuredLength = this.configService.get(
      'blockchain.rewardEpochLength',
    );
    if (configuredLength) {
      return configuredLength;
    }

    try {
      const workerRegistrationAddress = this.configService.get(
        'blockchain.contracts.workerRegistration',
      ) as Address;

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
      const networkControllerAddress = this.configService.get(
        'blockchain.contracts.networkController',
      ) as Address;

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
      const stakingAddress = this.configService.get(
        'blockchain.contracts.staking',
      ) as Address;

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
      const rewardsDistributionAddress = this.configService.get(
        'blockchain.contracts.rewardsDistribution',
      ) as Address;

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
      const rewardsDistributionAddress = this.configService.get(
        'blockchain.contracts.rewardsDistribution',
      ) as Address;

      const contract = getContract({
        address: rewardsDistributionAddress,
        abi: DistributedRewardsDistributionABI,
        client: this.web3Service.client,
      });

      // create the commitment key
      const commitmentKey = keccak256(
        encodePacked(
          ['uint256', 'uint256'],
          [BigInt(fromBlock), BigInt(toBlock)],
        ),
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
      const rewardsDistributionAddress = this.configService.get(
        'blockchain.contracts.rewardsDistribution',
      ) as Address;

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
      const workerRegistrationAddress = this.configService.get(
        'blockchain.contracts.workerRegistration',
      ) as Address;

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
      const workerRegistrationAddress = this.configService.get(
        'blockchain.contracts.workerRegistration',
      ) as Address;

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
      const workerRegistrationAddress = this.configService.get(
        'blockchain.contracts.workerRegistration',
      ) as Address;

      const contract = getContract({
        address: workerRegistrationAddress,
        abi: WorkerRegistrationABI,
        client: this.web3Service.client,
      });

      return Number(
        await contract.read.registeredWorkersCount({ blockNumber }),
      );
    } catch (error) {
      this.logger.error(
        `Failed to get registered workers count: ${error.message}`,
      );
      return 0;
    }
  }

  async getLatestCommitment(): Promise<CommitmentInfo | undefined> {
    try {
      const rewardsDistributionAddress = this.configService.get(
        'blockchain.contracts.rewardsDistribution',
      ) as Address;

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
      if (
        !latestLog.args ||
        latestLog.args.fromBlock === undefined ||
        latestLog.args.toBlock === undefined ||
        latestLog.args.merkleRoot === undefined
      ) {
        this.logger.warn(
          'Latest commitment log found but arguments are incomplete.',
        );
        return undefined;
      }

      const {
        fromBlock: commitFromBlock,
        toBlock: commitToBlock,
        merkleRoot: commitMerkleRoot,
      } = latestLog.args;

      // get additional commitment info from contract
      const contract = getContract({
        address: rewardsDistributionAddress,
        abi: DistributedRewardsDistributionABI,
        client: this.web3Service.client,
      });

      const commitmentKey = keccak256(
        encodePacked(['uint256', 'uint256'], [commitFromBlock, commitToBlock]),
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

  async getStakes(
    workerIds: string[],
  ): Promise<[MulticallResult<bigint>[], MulticallResult<bigint>[]]> {
    try {
      const stakingAddress = this.configService.get(
        'blockchain.contracts.staking',
      ) as Address;
      const capedStakingAddress = this.configService.get(
        'blockchain.contracts.capedStaking',
      ) as Address;

      this.logger.log(
        `🔍 Fetching stakes for ${workerIds.length} workers from contracts...`,
      );
      this.logger.log(`📍 Staking address: ${stakingAddress}`);
      this.logger.log(`📍 CapedStaking address: ${capedStakingAddress}`);

      if (!stakingAddress) {
        throw new Error('STAKING_ADDRESS not configured in environment');
      }

      if (!capedStakingAddress) {
        throw new Error('CAPED_STAKING_ADDRESS not configured in environment');
      }

      // get worker contract IDs first
      const workerIdMapping =
        await this.web3Service.preloadWorkerIds(workerIds);

      // create a list of valid workers that are registered on-chain
      const validWorkers = workerIds
        .map((peerId) => ({ peerId, contractId: workerIdMapping[peerId] }))
        .filter(({ contractId }) => contractId && contractId !== 0n);

      if (validWorkers.length === 0) {
        this.logger.warn(
          'No registered workers found among the provided peer IDs.',
        );
        // Return zero stakes for all workers
        const emptyResults: MulticallResult<bigint>[] = workerIds.map(() => ({
          status: 'success' as const,
          result: 0n,
        }));
        return [emptyResults, emptyResults];
      }

      this.logger.log(
        `🎯 Found ${validWorkers.length} registered workers to query for stakes.`,
      );

      // prepare multicalls ONLY for valid, registered workers
      const capedStakeCalls = validWorkers.map(({ contractId }) => ({
        address: capedStakingAddress,
        abi: CapedStakingABI,
        functionName: 'capedStake' as const,
        args: [contractId] as const,
      }));

      const totalStakeCalls = validWorkers.map(({ contractId }) => ({
        address: stakingAddress,
        abi: StakingABI,
        functionName: 'delegated' as const,
        args: [contractId] as const,
      }));

      // execute the multicalls
      this.logger.log(`📞 Executing multicalls for stakes...`);
      const [capedStakesResults, totalStakesResults] = await Promise.all([
        this.web3Service.client.multicall({
          contracts: capedStakeCalls,
          allowFailure: true,
        }),
        this.web3Service.client.multicall({
          contracts: totalStakeCalls,
          allowFailure: true,
        }),
      ]);

      // map the results back to the original list of workerIds
      const capedStakesMap = new Map<string, MulticallResult<bigint>>();
      validWorkers.forEach((worker, i) => {
        capedStakesMap.set(worker.peerId, capedStakesResults[i]);
      });

      const totalStakesMap = new Map<string, MulticallResult<bigint>>();
      validWorkers.forEach((worker, i) => {
        totalStakesMap.set(worker.peerId, totalStakesResults[i]);
      });

      const finalCapedStakes: MulticallResult<bigint>[] = workerIds.map(
        (peerId) =>
          capedStakesMap.get(peerId) || {
            status: 'success' as const,
            result: 0n,
          },
      );
      const finalTotalStakes: MulticallResult<bigint>[] = workerIds.map(
        (peerId) =>
          totalStakesMap.get(peerId) || {
            status: 'success' as const,
            result: 0n,
          },
      );

      // log successful stakes
      const successfulCaped = finalCapedStakes.filter(
        (s) => s.status === 'success' && s.result && s.result > 0n,
      ).length;
      const successfulTotal = finalTotalStakes.filter(
        (s) => s.status === 'success' && s.result && s.result > 0n,
      ).length;

      this.logger.log(`✅ Successfully mapped stakes for workers:`);
      this.logger.log(
        `   - Caped stakes: ${successfulCaped}/${workerIds.length} workers with stakes > 0`,
      );
      this.logger.log(
        `   - Total stakes: ${successfulTotal}/${workerIds.length} workers with stakes > 0`,
      );

      return [finalCapedStakes, finalTotalStakes];
    } catch (error) {
      this.logger.error(
        `❌ Failed to get stakes from contracts: ${error.message}`,
      );
      this.logger.error(`Stack trace: ${error.stack}`);

      throw new Error(`Contract stake fetching failed: ${error.message}`);
    }
  }

  private async getStakesFromClickHouse(
    workerIds: string[],
    networkName: string,
  ): Promise<[any[], any[]]> {
    try {
      const workerIdList = workerIds.map((id) => `'${id}'`).join(',');
      const query = `
        SELECT 
          worker_id,
          stake,
          staker_reward
        FROM ${networkName}.worker_stats
        WHERE worker_id IN (${workerIdList})
          AND time >= NOW() - INTERVAL 1 HOUR
        ORDER BY time DESC
        LIMIT ${workerIds.length}
      `;

      // use the properly injected ClickHouse service
      const client = (this.clickHouseService as any).client;
      if (!client) {
        throw new Error('ClickHouse client not available');
      }

      const resultSet = await client.query({
        query,
        format: 'JSONEachRow',
      });

      const results = await resultSet.json();
      const resultArray = Array.isArray(results) ? results : [results];

      // map results back to worker order
      const stakeMap = new Map<string, bigint>();
      for (const row of resultArray) {
        stakeMap.set(row.worker_id, BigInt(row.stake || 0));
      }

      const capedStakes = workerIds.map((id) => ({
        result: stakeMap.get(id) || BigInt('10000000000000000000'), // Default 10 SQD
        status: 'success',
      }));

      const totalStakes = capedStakes; // For now, same as caped stakes

      this.logger.log(
        `Retrieved stakes from ClickHouse for ${resultArray.length} workers`,
      );
      return [capedStakes, totalStakes];
    } catch (error) {
      this.logger.warn(
        `Failed to get stakes from ClickHouse: ${error.message}`,
      );
      throw error;
    }
  }

  // updated Merkle tree distribution methods with Fordefi integration
  async commitRoot(
    fromBlock: number,
    toBlock: number,
    merkleRoot: Hex,
    totalBatches: number,
    ipfsLink: string = '',
  ): Promise<Hex | undefined> {
    try {
      const rewardsDistributionAddress = this.configService.get(
        'blockchain.contracts.rewardsDistribution',
      ) as Address;

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
        { priority_level: 'high' },
      );

      this.logger.log(`Root committed successfully: ${txHash}`);
      return txHash;
    } catch (error) {
      this.logger.error(`Failed to commit root: ${error.message}`);
      return undefined;
    }
  }

  async approveRoot(
    fromBlock: number,
    toBlock: number,
  ): Promise<Hex | undefined> {
    try {
      const rewardsDistributionAddress = this.configService.get(
        'blockchain.contracts.rewardsDistribution',
      ) as Address;

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
        { priority_level: 'high' },
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
    merkleProof: Hex[],
  ): Promise<Hex | undefined> {
    try {
      const rewardsDistributionAddress = this.configService.get(
        'blockchain.contracts.rewardsDistribution',
      ) as Address;

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
          recipients.map((r) => BigInt(r)),
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
        { priority_level: 'medium' },
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
    leafHash: Hex,
  ): Promise<boolean> {
    try {
      const rewardsDistributionAddress = this.configService.get(
        'blockchain.contracts.rewardsDistribution',
      ) as Address;

      const contract = getContract({
        address: rewardsDistributionAddress,
        abi: DistributedRewardsDistributionABI,
        client: this.web3Service.client,
      });

      // create the commitment key
      const commitmentKey = keccak256(
        encodePacked(
          ['uint256', 'uint256'],
          [BigInt(fromBlock), BigInt(toBlock)],
        ),
      );

      return await contract.read.processed([commitmentKey, leafHash]);
    } catch (error) {
      this.logger.error(
        `Failed to check if batch is processed: ${error.message}`,
      );
      return false;
    }
  }

  // legacy methods for backward compatibility
  async commitRewards(
    fromBlock: number,
    toBlock: number,
    workerIds: bigint[],
    workerRewards: bigint[],
    stakerRewards: bigint[],
  ): Promise<Hex | undefined> {
    this.logger.warn(
      'commitRewards (legacy) not implemented - use commitRoot instead',
    );
    return undefined;
  }

  async approveRewards(
    fromBlock: number,
    toBlock: number,
    workerIds: bigint[],
    workerRewards: bigint[],
    stakerRewards: bigint[],
  ): Promise<Hex | undefined> {
    this.logger.warn(
      'approveRewards (legacy) not implemented - use approveRoot instead',
    );
    return undefined;
  }
}
