import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Web3Service } from './web3.service';
import { FordefiService } from './fordefi/fordefi.service';
import { ErrorDecoderService } from './error-decoder.service';
import { ClickHouseService } from '../database/clickhouse.service';
import { Context, TaskContext } from '../common';
import {
  Address,
  Hex,
  getContract,
  parseAbiItem,
  encodeFunctionData,
  keccak256,
  encodePacked,
  encodeAbiParameters,
  parseAbiParameters,
  BaseError,
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
  constructor(
    private configService: ConfigService,
    private web3Service: Web3Service,
    private fordefiService: FordefiService,
    private clickHouseService: ClickHouseService,
    private errorDecoder: ErrorDecoderService,
  ) {}

  async getEffectiveTVL(ctx: Context, blockNumber?: bigint): Promise<bigint> {
    try {
      const rewardCalculationAddress = this.configService.get(
        'blockchain.contracts.rewardCalculation',
      ) as Address;

      if (!rewardCalculationAddress) {
        throw new Error('RewardCalculation contract address not configured');
      }

      const contract = getContract({
        address: rewardCalculationAddress,
        abi: RewardCalculationABI,
        client: this.web3Service.client,
      });

      return await contract.read.effectiveTVL({ blockNumber });
    } catch (error) {
      ctx.logger.error({ error }, `Failed to get effective TVL from contract`);
      throw error;
    }
  }

  async getInitialRewardPoolSize(
    ctx: Context,
    blockNumber?: bigint,
  ): Promise<bigint> {
    try {
      const rewardCalculationAddress = this.configService.get(
        'blockchain.contracts.rewardCalculation',
      ) as Address;

      if (!rewardCalculationAddress) {
        throw new Error('RewardCalculation contract address not configured');
      }

      const contract = getContract({
        address: rewardCalculationAddress,
        abi: RewardCalculationABI,
        client: this.web3Service.client,
      });

      return await contract.read.INITIAL_REWARD_POOL_SIZE({ blockNumber });
    } catch (error) {
      ctx.logger.error(
        { error },
        `Failed to get initial reward pool size from contract`,
      );
      throw error;
    }
  }

  async getYearlyRewardCapCoefficient(
    ctx: Context,
    blockNumber?: bigint,
  ): Promise<bigint> {
    try {
      const networkControllerAddress = this.configService.get(
        'blockchain.contracts.networkController',
      ) as Address;

      if (!networkControllerAddress) {
        throw new Error('NetworkController contract address not configured');
      }

      const contract = getContract({
        address: networkControllerAddress,
        abi: NetworkControllerABI,
        client: this.web3Service.client,
      });

      return await contract.read.yearlyRewardCapCoefficient({ blockNumber });
    } catch (error) {
      ctx.logger.error(
        { error },
        `Failed to get yearly reward cap coefficient from contract`,
      );
      throw error;
    }
  }

  async getBoostFactor(ctx: Context, duration: bigint): Promise<bigint> {
    try {
      const rewardCalculationAddress = this.configService.get(
        'blockchain.contracts.rewardCalculation',
      ) as Address;

      if (!rewardCalculationAddress) {
        throw new Error('RewardCalculation contract address not configured');
      }

      const contract = getContract({
        address: rewardCalculationAddress,
        abi: RewardCalculationABI,
        client: this.web3Service.client,
      });

      const boostFactor = await contract.read.boostFactor([duration]);
      ctx.logger.debug(
        `Retrieved boost factor from contract: ${boostFactor} basis points for duration ${duration}`,
      );
      return boostFactor;
    } catch (error) {
      ctx.logger.error({ error }, `Failed to get boost factor from contract`);
      return 10000n;
    }
  }

  async getCurrentApy(ctx: Context, blockNumber?: bigint): Promise<bigint> {
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
            ctx.logger.debug(
              `Retrieved APR from ClickHouse: ${apr} basis points`,
            );
            return apr;
          }
        }
      } catch (error) {
        ctx.logger.warn({ error }, `Failed to get APR from ClickHouse`);
      }

      try {
        const tvl = await this.getEffectiveTVL(ctx, blockNumber);
        ctx.logger.debug(`TVL: ${tvl.toString()}`);

        if (tvl === 0n) {
          return 2000n;
        }

        const initialRewardPoolSize = await this.getInitialRewardPoolSize(
          ctx,
          blockNumber,
        );
        ctx.logger.debug(
          `Initial Reward Pool Size: ${initialRewardPoolSize.toString()}`,
        );

        const yearlyRewardCapCoefficient =
          await this.getYearlyRewardCapCoefficient(ctx, blockNumber);
        ctx.logger.debug(
          `Yearly Reward Cap Coefficient: ${yearlyRewardCapCoefficient.toString()}`,
        );

        const apyCap =
          (yearlyRewardCapCoefficient * initialRewardPoolSize) / tvl;
        ctx.logger.debug(`APY Cap: ${apyCap.toString()}`);

        const finalApr = 2000n > apyCap ? apyCap : 2000n;
        ctx.logger.debug(`Final APR: ${finalApr} basis points`);
        return finalApr;
      } catch (error) {
        ctx.logger.warn({ error }, `Failed to calculate APY from contract`);
      }

      // Default: return 20% APY (2000 basis points)
      const defaultApy = BigInt('2000');
      ctx.logger.debug('Using default APY (20%)');
      return defaultApy;
    } catch (error) {
      ctx.logger.error({ error }, `Failed to get current APY`);
      throw error;
    }
  }

  async getEpochLength(ctx: Context, blockNumber?: bigint): Promise<number> {
    const configuredLength = this.configService.get(
      'blockchain.rewardEpochLength',
    );
    if (configuredLength) {
      ctx.logger.debug(
        `📏 Using configured epoch length: ${configuredLength} blocks`,
      );
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

      const contractEpochLength = Number(
        await contract.read.epochLength({ blockNumber }),
      );
      ctx.logger.debug(
        `📏 Retrieved epoch length from contract: ${contractEpochLength} blocks`,
      );
      return contractEpochLength;
    } catch (error) {
      ctx.logger.error({ error }, `Failed to get epoch length from contract`);
      ctx.logger.debug(`📏 Using default epoch length: 7000 blocks`);
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
      new TaskContext('error-handling').logger.error(
        `Failed to get next epoch: ${error.message}`,
      );
      return 1;
    }
  }

  async getBondAmount(): Promise<bigint> {
    try {
      const stakingAddress = this.configService.get(
        'blockchain.contracts.staking',
      ) as Address;

      if (!stakingAddress) {
        new TaskContext('warning').logger.warn(
          'Staking contract address not configured',
        );
      }

      // for dev: return mock bond amount
      const mockBondAmount = BigInt('100000000000000000000000'); // 100k SQD
      new TaskContext('method-call').logger.debug(
        'Using mock bond amount (100k SQD) for development',
      );
      return mockBondAmount;
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `Failed to get bond amount: ${error.message}`,
      );
      throw error;
    }
  }

  async getLastRewardedBlock(ctx: Context): Promise<number> {
    try {
      const rewardsDistributionAddress = this.configService.get(
        'blockchain.contracts.rewardsDistribution',
      ) as Address;

      ctx.logger.debug(
        `Getting lastBlockRewarded from contract at ${rewardsDistributionAddress}`
      );

      try {
        const lastBlock = await this.web3Service.client.readContract({
          address: rewardsDistributionAddress,
          abi: DistributedRewardsDistributionABI,
          functionName: 'lastBlockRewarded',
        });
        
        const lastBlockNum = Number(lastBlock);
        ctx.logger.debug(`lastBlockRewarded value: ${lastBlockNum}`);
        
        // if lastBlockRewarded is 0, use the configured starting block
        if (lastBlockNum === 0) {
          const startingBlock = this.configService.get('rewards.distributionStartingBlock') || 0;
          if (startingBlock > 0) {
            ctx.logger.info(
              `Using configured starting block: ${startingBlock} (lastBlockRewarded = 0)`
            );
            // return startingBlock - 1 so the first distribution starts at startingBlock
            return startingBlock - 1;
          }
        }
        
        return lastBlockNum;
      } catch (contractError: any) {
        if (contractError.message?.includes('returned no data')) {
          ctx.logger.debug('Contract returned no data for lastBlockRewarded - using starting block');
          const startingBlock = this.configService.get('rewards.distributionStartingBlock') || 0;
          if (startingBlock > 0) {
            ctx.logger.info(`Using configured starting block: ${startingBlock}`);
            return startingBlock - 1;
          }
          return 0;
        }
        
        ctx.logger.error(
          `Contract call failed: ${contractError.shortMessage || contractError.message}`
        );
        throw contractError;
      }
    } catch (error: any) {
      if (typeof error === 'number') {
        return error;
      }
      
      ctx.logger.error(`Unexpected error getting last rewarded block: ${error.message}`);
      return 0;
    }
  }

  async isCommitted(fromBlock: number, toBlock: number): Promise<boolean> {
    try {
      const rewardsDistributionAddress = this.configService.get(
        'blockchain.contracts.rewardsDistribution',
      ) as Address;

      const ctx = new TaskContext('contract:isCommitted');
      ctx.logger.debug(
        `Checking if committed: ${fromBlock}-${toBlock} at contract ${rewardsDistributionAddress}`
      );

      // create the commitment key using abi.encode to match contract
      const commitmentKey = keccak256(
        encodeAbiParameters(parseAbiParameters('uint256, uint256'), [
          BigInt(fromBlock),
          BigInt(toBlock),
        ]),
      );
      
      ctx.logger.debug(`Commitment key: ${commitmentKey}`);

      try {
        // try direct readContract call for better error handling
        const commitment = await this.web3Service.client.readContract({
          address: rewardsDistributionAddress,
          abi: DistributedRewardsDistributionABI,
          functionName: 'commitments',
          args: [commitmentKey],
        });
        
        ctx.logger.debug(`Commitment result: ${JSON.stringify(commitment)}`);
        // New struct has status as first field, check if not NONEXISTENT (0)
        return Number(commitment[0]) !== 0;
      } catch (readError: any) {
        ctx.logger.error(
          {
            error: readError,
            errorMessage: readError.message,
            shortMessage: readError.shortMessage,
            commitmentKey,
            fromBlock,
            toBlock,
          },
          'Failed to read commitment from contract'
        );
        throw readError;
      }
    } catch (error: any) {
      new TaskContext('error-handling').logger.error(
        `Failed to check if committed: ${error.message}`,
      );
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
    } catch (error: any) {
      if (error.message?.includes('returned no data')) {
        new TaskContext('contract-service:canCommit').logger.debug(
          'Contract returned no data for canCommit - returning false'
        );
        return false;
      }
      
      new TaskContext('contract-service:canCommit').logger.warn(
        `Failed to check if can commit: ${error.shortMessage || error.message}`
      );
      return false;
    }
  }

  async getTargetCapacity(blockNumber?: bigint): Promise<bigint> {
    try {
      const networkControllerAddress = this.configService.get(
        'blockchain.contracts.networkController',
      ) as Address;

      const contract = getContract({
        address: networkControllerAddress,
        abi: NetworkControllerABI,
        client: this.web3Service.client,
      });

      const capacityGb = await contract.read.targetCapacityGb({ blockNumber });
      return BigInt(capacityGb) * BigInt(1e9);
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `Failed to get target capacity: ${error.message}`,
      );
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
      new TaskContext('error-handling').logger.error(
        `Failed to get storage per worker: ${error.message}`,
      );
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
      new TaskContext('error-handling').logger.error(
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
        new TaskContext('contract-service:getLatestCommitment').logger.debug('No commitment logs found');
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
        new TaskContext('warning').logger.warn(
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
        totalBatches: Number(commitmentData[2] || 0),
        processedBatches: Number(commitmentData[3] || 0),
        approvalCount: BigInt(commitmentData[4] || 0),
        ipfsLink: (commitmentData[5] || '') as string,
        exists: Boolean(commitmentData[0])
      };
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `Failed to get latest commitment: ${error.message}`,
      );
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

      new TaskContext('method-call').logger.debug(
        `🔍 Fetching stakes for ${workerIds.length} workers from contracts...`,
      );
      new TaskContext('method-call').logger.debug(
        `📍 Staking address: ${stakingAddress}`,
      );
      new TaskContext('method-call').logger.debug(
        `📍 CapedStaking address: ${capedStakingAddress}`,
      );

      if (!stakingAddress) {
        throw new Error('STAKING_ADDRESS not configured in environment');
      }

      if (!capedStakingAddress) {
        throw new Error('CAPED_STAKING_ADDRESS not configured in environment');
      }

      // get worker contract IDs first
      const ctx = new TaskContext('contract-service:get-stakes');
      const workerIdMapping = await this.web3Service.preloadWorkerIds(
        ctx,
        workerIds,
      );

      // create a list of valid workers that are registered on-chain
      const validWorkers = workerIds
        .map((peerId) => ({ peerId, contractId: workerIdMapping[peerId] }))
        .filter(({ contractId }) => contractId && contractId !== 0n);

      if (validWorkers.length === 0) {
        new TaskContext('warning').logger.warn(
          'No registered workers found among the provided peer IDs.',
        );
        // Return zero stakes for all workers
        const emptyResults: MulticallResult<bigint>[] = workerIds.map(() => ({
          status: 'success' as const,
          result: 0n,
        }));
        return [emptyResults, emptyResults];
      }

      new TaskContext('method-call').logger.debug(
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
      new TaskContext('method-call').logger.debug(
        `📞 Executing multicalls for stakes...`,
      );
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

      new TaskContext('method-call').logger.debug(
        `✅ Successfully mapped stakes for workers:`,
      );
      new TaskContext('method-call').logger.debug(
        `   - Caped stakes: ${successfulCaped}/${workerIds.length} workers with stakes > 0`,
      );
      new TaskContext('method-call').logger.debug(
        `   - Total stakes: ${successfulTotal}/${workerIds.length} workers with stakes > 0`,
      );

      return [finalCapedStakes, finalTotalStakes];
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `❌ Failed to get stakes from contracts: ${error.message}`,
      );
      new TaskContext('error-handling').logger.error(
        `Stack trace: ${error.stack}`,
      );

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

      new TaskContext('method-call').logger.debug(
        `Retrieved stakes from ClickHouse for ${resultArray.length} workers`,
      );
      return [capedStakes, totalStakes];
    } catch (error) {
      new TaskContext('warning').logger.warn(
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
        new TaskContext('error-handling').logger.error(
          'Fordefi is not properly configured',
        );
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

      new TaskContext('method-call').logger.debug(
        `Root committed successfully: ${txHash}`,
      );
      return txHash;
    } catch (error) {
      const errorCtx = new TaskContext('error-handling');
      if (error instanceof BaseError) {
        const errorMessage = this.errorDecoder.formatError(error, errorCtx);
        const errorContext = this.errorDecoder.getErrorContext(error, errorCtx);
        errorCtx.logger.error(
          { errorContext },
          `Failed to commit root: ${errorMessage}`,
        );
      } else {
        errorCtx.logger.error(
          `Failed to commit root: ${error?.message || error}`,
        );
      }
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
        new TaskContext('error-handling').logger.error(
          'Fordefi is not properly configured',
        );
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

      new TaskContext('method-call').logger.debug(
        `Root approved successfully: ${txHash}`,
      );
      return txHash;
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `Failed to approve root: ${error.message}`,
      );
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
        new TaskContext('error-handling').logger.error(
          'Fordefi is not properly configured',
        );
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

      new TaskContext('method-call').logger.debug(
        `Batch distributed successfully: ${txHash}`,
      );
      return txHash;
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `Failed to distribute batch: ${error.message}`,
      );
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

      // create the commitment key using abi.encode to match contract
      const commitmentKey = keccak256(
        encodeAbiParameters(parseAbiParameters('uint256, uint256'), [
          BigInt(fromBlock),
          BigInt(toBlock),
        ]),
      );

      return await contract.read.processed([commitmentKey, leafHash]);
    } catch (error) {
      new TaskContext('error-handling').logger.error(
        `Failed to check if batch is processed: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * get commitment info for a block range from the contract
   */
  async getCommitment(
    ctx: Context,
    fromBlock: number,
    toBlock: number,
  ): Promise<{
    exists: boolean;
    merkleRoot: string;
    totalBatches: number;
    processedBatches: number;
    approvalCount: number;
    ipfsLink: string;
  }> {
    try {
      const rewardsDistributionAddress = this.configService.get(
        'blockchain.contracts.rewardsDistribution',
      ) as Address;

      if (!rewardsDistributionAddress) {
        throw new Error('Rewards distribution contract address not configured');
      }

      const commitmentKey = keccak256(
        encodeAbiParameters(parseAbiParameters('uint256, uint256'), [
          BigInt(fromBlock),
          BigInt(toBlock),
        ]),
      );

      ctx.logger.debug(
        `Getting commitment for blocks ${fromBlock}-${toBlock}, key: ${commitmentKey}, contract: ${rewardsDistributionAddress}`
      );

      try {

        const commitment = await this.web3Service.client.readContract({
          address: rewardsDistributionAddress,
          abi: DistributedRewardsDistributionABI,
          functionName: 'commitments',
          args: [commitmentKey],
        });

        const commitmentForLogging = commitment ? {
          status: commitment[0]?.toString(),
          fromBlock: commitment[1]?.toString(),
          toBlock: commitment[2]?.toString(),
          merkleRoot: commitment[3],
          totalBatches: commitment[4]?.toString(),
          processedBatches: commitment[5]?.toString(),
          approvalCount: commitment[6]?.toString(),
          ipfsLink: commitment[7],
        } : null;
        
        ctx.logger.debug(
          `Raw commitment response: ${JSON.stringify(commitmentForLogging)}`
        );
        
        if (!commitment) {
          ctx.logger.debug('No commitment found (null/undefined response)');
          return {
            exists: false,
            merkleRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
            totalBatches: 0,
            processedBatches: 0,
            approvalCount: 0,
            ipfsLink: '',
          };
        }

        const status = Number(commitment[0]);
        return {
          exists: status !== 0, // NONEXISTENT = 0
          merkleRoot: (commitment[3] || '0x0000000000000000000000000000000000000000000000000000000000000000') as string,
          totalBatches: Number(commitment[4] || 0),
          processedBatches: Number(commitment[5] || 0),
          approvalCount: Number(commitment[6] || 0),
          ipfsLink: (commitment[7] || '') as string,
        };
      } catch (contractError: any) {
        if (contractError.message?.includes('returned no data')) {
          ctx.logger.debug(
            'Contract returned no data - this likely means no commitment exists yet'
          );
          return {
            exists: false,
            merkleRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
            totalBatches: 0,
            processedBatches: 0,
            approvalCount: 0,
            ipfsLink: '',
          };
        }
        throw contractError;
      }
    } catch (error) {
      ctx.logger.error(
        { 
          error,
          fromBlock,
          toBlock,
          contractAddress: this.configService.get('blockchain.contracts.rewardsDistribution'),
        },
        `Failed to get commitment for blocks ${fromBlock}-${toBlock}`,
      );
      throw error;
    }
  }

  /**
   * get the last block that completed reward distribution
   * (alias for getLastRewardedBlock to maintain compatibility)
   */
  async getLastBlockRewarded(ctx: Context): Promise<number> {
    return this.getLastRewardedBlock(ctx);
  }

  /**
   * Check which batches have been processed for a commitment
   */
  async getProcessedBatches(
    ctx: Context,
    fromBlock: number,
    toBlock: number,
    leafHashes: string[],
  ): Promise<boolean[]> {
    try {
      const results = await Promise.all(
        leafHashes.map((leafHash) =>
          this.isBatchProcessed(fromBlock, toBlock, leafHash as Hex),
        ),
      );
      
      ctx.logger.debug(
        `Checked ${leafHashes.length} batches: ${results.filter(r => r).length} processed`,
      );
      
      return results;
    } catch (error) {
      ctx.logger.error(
        { error },
        `Failed to check processed batches for blocks ${fromBlock}-${toBlock}`,
      );
      throw error;
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
    new TaskContext('warning').logger.warn(
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
    new TaskContext('warning').logger.warn(
      'approveRewards (legacy) not implemented - use approveRoot instead',
    );
    return undefined;
  }

  async getDistributionStatus(ctx: Context): Promise<{
    nextFromBlock: number;
    nextToBlock: number;
    isReadyForDistribution: boolean;
    needsConfirmation: boolean;
    hasExistingCommitment: boolean;
    blocksUntilNextDistribution: number;
    confirmationBlocksNeeded: number;
  }> {
    try {
      const currentBlock = await this.web3Service.getL1BlockNumber(ctx);
      const lastRewardedBlock = await this.getLastRewardedBlock(ctx);
      const blockInterval = this.configService.get('rewards.distributionBlockInterval') || 520;
      const confirmationBlocks = this.configService.get('blockchain.epochConfirmationBlocks') || 150;
      const startingBlock = this.configService.get('rewards.distributionStartingBlock') || 0;
      const rewardsDistributionAddress = this.configService.get(
        'blockchain.contracts.rewardsDistribution',
      ) as Address;
      
      let lastCommitmentKey: string;
      try {
        lastCommitmentKey = await this.getLastCommitmentKey(ctx);
      } catch (error) {
        ctx.logger.debug('Could not fetch lastCommitmentKey - might be using older contract');
        lastCommitmentKey = '0x0000000000000000000000000000000000000000000000000000000000000000';
      }

      let nextFromBlock: number = 0;
      let nextToBlock: number = 0;
      
      if (lastCommitmentKey !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
        ctx.logger.info(`Found lastCommitmentKey: ${lastCommitmentKey}`);
        
        try {
          const commitment = await this.web3Service.client.readContract({
            address: rewardsDistributionAddress,
            abi: DistributedRewardsDistributionABI,
            functionName: 'commitments',
            args: [lastCommitmentKey as `0x${string}`],
          });
          
          const commitmentStatus = Number(commitment[0]); 
          const commitmentFromBlock = Number(commitment[1]); 
          const commitmentToBlock = Number(commitment[2]); 
          
          ctx.logger.info(
            `Last commitment status: ${commitmentStatus}, blocks: ${commitmentFromBlock}-${commitmentToBlock}`
          );
          
          if (commitmentStatus === 1) { // ACTIVE - not fully processed
            // need to recover this distribution
            nextFromBlock = commitmentFromBlock;
            nextToBlock = commitmentToBlock;
            ctx.logger.info(
              `Found ACTIVE commitment that needs recovery for blocks ${nextFromBlock}-${nextToBlock}`
            );
          } else if (commitmentStatus === 2) { // COMPLETED
            // skip and go to lastBlockRewarded + 1
            nextFromBlock = lastRewardedBlock + 1;
            nextToBlock = nextFromBlock + blockInterval - 1;
            ctx.logger.info(
              `Last commitment COMPLETED, continuing from block ${nextFromBlock}`
            );
          } else {
            // status is NONEXISTENT (0)
            ctx.logger.warn('Last commitment key exists but status is NONEXISTENT');
            nextFromBlock = lastRewardedBlock + 1;
            nextToBlock = nextFromBlock + blockInterval - 1;
          }
        } catch (error) {
          ctx.logger.error('Failed to read commitment from contract', error);
          // fallback to lastRewardedBlock
          nextFromBlock = lastRewardedBlock + 1;
          nextToBlock = nextFromBlock + blockInterval - 1;
        }
      } else {
        // no lastCommitmentKey
        if (lastRewardedBlock === 0) {
          // fresh start - use starting block
          nextFromBlock = startingBlock;
          nextToBlock = nextFromBlock + blockInterval - 1;
          ctx.logger.info(`Fresh start: Using configured starting block: ${startingBlock}`);
        } else {
          // continue from lastRewardedBlock
          nextFromBlock = lastRewardedBlock + 1;
          nextToBlock = nextFromBlock + blockInterval - 1;
          ctx.logger.info(`Continuing from lastRewardedBlock + 1: ${nextFromBlock}`);
        }
      }
      
      // calculate blocks until distribution
      const blocksUntilNextDistribution = Math.max(0, nextToBlock - currentBlock);
      
      // check if needs confirmation
      const lastConfirmedBlock = currentBlock - confirmationBlocks;
      const needsConfirmation = nextToBlock > lastConfirmedBlock;
      const confirmationBlocksNeeded = needsConfirmation ? nextToBlock - lastConfirmedBlock : 0;
      
      // check for existing commitment
      const commitment = await this.getCommitment(ctx, nextFromBlock, nextToBlock);
      
      // determine if ready for distribution
      const isReadyForDistribution = 
        currentBlock >= nextToBlock && 
        !needsConfirmation && 
        !commitment.exists;
      
      return {
        nextFromBlock,
        nextToBlock,
        isReadyForDistribution,
        needsConfirmation,
        hasExistingCommitment: commitment.exists,
        blocksUntilNextDistribution,
        confirmationBlocksNeeded,
      };
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to get distribution status');
      throw error;
    }
  }

  async getCommitmentV2(
    ctx: Context,
    fromBlock: number,
    toBlock: number,
  ): Promise<{
    status: number; // 0=NONEXISTENT, 1=ACTIVE, 2=COMPLETED
    merkleRoot: string;
    totalBatches: number;
    processedBatches: number;
    approvalCount: number;
    ipfsLink: string;
  }> {
    try {
      const rewardsDistributionAddress = this.configService.get(
        'blockchain.contracts.rewardsDistribution',
      ) as Address;

      if (!rewardsDistributionAddress) {
        throw new Error('Rewards distribution contract address not configured');
      }

      const result = await this.web3Service.client.readContract({
        address: rewardsDistributionAddress,
        abi: DistributedRewardsDistributionABI,
        functionName: 'getCommitment',
        args: [[BigInt(fromBlock), BigInt(toBlock)]],
      });

      return {
        status: Number(result[0]),
        merkleRoot: result[1] as string,
        totalBatches: Number(result[2]),
        processedBatches: Number(result[3]),
        approvalCount: Number(result[4]),
        ipfsLink: result[5] as string,
      };
    } catch (error) {
      ctx.logger.error(
        { error, fromBlock, toBlock },
        'Failed to get commitment V2',
      );
      throw error;
    }
  }

  async isCommitmentComplete(
    ctx: Context,
    fromBlock: number,
    toBlock: number,
  ): Promise<boolean> {
    try {
      const rewardsDistributionAddress = this.configService.get(
        'blockchain.contracts.rewardsDistribution',
      ) as Address;

      if (!rewardsDistributionAddress) {
        throw new Error('Rewards distribution contract address not configured');
      }

      const isComplete = await this.web3Service.client.readContract({
        address: rewardsDistributionAddress,
        abi: DistributedRewardsDistributionABI,
        functionName: 'isCommitmentComplete',
        args: [[BigInt(fromBlock), BigInt(toBlock)]],
      });

      return isComplete as boolean;
    } catch (error) {
      ctx.logger.error(
        { error, fromBlock, toBlock },
        'Failed to check if commitment is complete',
      );
      throw error;
    }
  }

  async getLastCommitmentKey(ctx: Context): Promise<string> {
    try {
      const rewardsDistributionAddress = this.configService.get(
        'blockchain.contracts.rewardsDistribution',
      ) as Address;

      if (!rewardsDistributionAddress) {
        throw new Error('Rewards distribution contract address not configured');
      }

      const key = await this.web3Service.client.readContract({
        address: rewardsDistributionAddress,
        abi: DistributedRewardsDistributionABI,
        functionName: 'lastCommitmentKey',
        args: [],
      });

      return key as string;
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to get last commitment key');
      throw error;
    }
  }


  async isNextDistributionReady(ctx: Context): Promise<{
    isReady: boolean;
    nextFromBlock: number;
    nextToBlock: number;
    blocksUntilReady: number;
    needsConfirmation: boolean;
    confirmationBlocksNeeded: number;
  }> {
    try {
      const currentBlock = await this.web3Service.getL1BlockNumber(ctx);
      const lastRewardedBlock = await this.getLastRewardedBlock(ctx);
      const blockInterval = this.configService.get('rewards.distributionBlockInterval') || 520;
      const confirmationBlocks = this.configService.get('blockchain.epochConfirmationBlocks') || 150;
      
      const nextFromBlock = lastRewardedBlock + 1;
      const nextToBlock = nextFromBlock + blockInterval - 1;
      
      const blocksUntilReady = Math.max(0, nextToBlock - currentBlock);
      
      const lastConfirmedBlock = currentBlock - confirmationBlocks;
      const needsConfirmation = nextToBlock > lastConfirmedBlock;
      const confirmationBlocksNeeded = needsConfirmation ? nextToBlock - lastConfirmedBlock : 0;
      
      // ready if: end block reached + confirmed + no existing commitment
      const isReady = 
        currentBlock >= nextToBlock && 
        !needsConfirmation;
      
      ctx.logger.debug(
        `📊 Distribution check: current=${currentBlock}, target=${nextToBlock}, ready=${isReady}, blocksLeft=${blocksUntilReady}`
      );
      
      return {
        isReady,
        nextFromBlock,
        nextToBlock,
        blocksUntilReady,
        needsConfirmation,
        confirmationBlocksNeeded,
      };
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to check if next distribution is ready');
      throw error;
    }
  }
}

