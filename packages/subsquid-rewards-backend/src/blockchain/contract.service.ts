import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Context, TaskContext, CommitmentKeyService } from '../common';
import {
  Address,
  Hex,
  PublicClient,
  getContract,
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
} from 'viem';
import {
  DistributedRewardsDistributionABI,
  RewardCalculationABI,
  WorkerRegistrationABI,
  NetworkControllerABI,
  StakingABI,
  CapedStakingABI,
} from './contracts/abis';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum, arbitrumSepolia, mainnet, sepolia } from 'viem/chains';
const bs58 = require('bs58');

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
  private publicClient: PublicClient;
  private l1Client: PublicClient;
  private lastKnownBlockPair: { l1Block: bigint; l2Block: bigint } | undefined;

  constructor(
    private configService: ConfigService,
    private commitmentKeyService: CommitmentKeyService,
  ) {
    this.initializeClients();
  }

  private initializeClients() {
    const networkName = this.configService.get('blockchain.network.networkName');
    const isTestnet = networkName === 'testnet' || networkName === 'sepolia';
    const l2RpcUrl = this.configService.get('blockchain.network.l2RpcUrl');

    this.publicClient = createPublicClient({
      chain: isTestnet ? arbitrumSepolia : arbitrum,
      transport: http(l2RpcUrl, { retryCount: 3, timeout: 30000 }),
      cacheTime: 0,
      batch: { multicall: { batchSize: 2 ** 16 } },
    });

    this.l1Client = createPublicClient({
      chain: isTestnet ? sepolia : mainnet,
      // RWD-H-008: bound L1 RPC calls so a dead node cannot stall the cron.
      transport: http(this.configService.get('blockchain.network.l1RpcUrl'), {
        retryCount: 3,
        retryDelay: 1_000,
        timeout: 30_000,
      }),
      batch: { multicall: true },
    });
  }

  // ---------------------------------------------------------------------------
  // RPC client accessors
  // ---------------------------------------------------------------------------

  get client(): PublicClient {
    return this.publicClient;
  }

  get l1(): PublicClient {
    return this.l1Client;
  }

  // ---------------------------------------------------------------------------
  // L1/L2 block helpers
  // ---------------------------------------------------------------------------

  async getL1BlockNumber(ctx: Context): Promise<number> {
    try {
      return Number(await this.l1Client.getBlockNumber());
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to get L1 block number');
      return Number(await this.publicClient.getBlockNumber());
    }
  }

  async getBlockTimestamp(ctx: Context, blockNumber: number): Promise<Date> {
    const block = await this.l1Client.getBlock({ blockNumber: BigInt(blockNumber) });
    return new Date(Number(block.timestamp) * 1000);
  }

  async getLatestL2Block(): Promise<bigint> {
    return await this.publicClient.getBlockNumber();
  }

  async getL1Block(
    ctx: Context,
    blockNumber: bigint,
  ): Promise<{ timestamp: bigint; number: bigint }> {
    const block = await this.l1Client.getBlock({ blockNumber });
    return { timestamp: block.timestamp, number: block.number };
  }

  async getBlock(ctx: Context): Promise<{ number: bigint; l1BlockNumber: bigint }> {
    const block = await this.publicClient.getBlock();
    return {
      number: block.number,
      l1BlockNumber: BigInt((block as any).l1BlockNumber),
    };
  }

  async getFirstBlockForL1Block(targetL1Block: number | bigint): Promise<bigint> {
    targetL1Block = BigInt(targetL1Block);

    let start: bigint;
    if (!this.lastKnownBlockPair || this.lastKnownBlockPair.l1Block > targetL1Block) {
      const chainId = await this.publicClient.getChainId();
      start = chainId === 42161 ? 15447158n : 0n;
      if (targetL1Block < start) {
        throw new Error(`Target L1 block ${targetL1Block} is before Nitro genesis ${start}`);
      }
    } else if (this.lastKnownBlockPair.l1Block < targetL1Block) {
      start = this.lastKnownBlockPair.l2Block;
    } else {
      return this.lastKnownBlockPair.l2Block;
    }

    let end = await this.publicClient.getBlock().then((b) => b.number);
    let targetL2Block: bigint | undefined;

    while (start <= end) {
      const mid = start + (end - start) / 2n;
      const l1Block = await this.publicClient
        .getBlock({ blockNumber: mid })
        .then((b) => BigInt((b as any).l1BlockNumber));

      if (l1Block >= targetL1Block) end = mid - 1n;
      else start = mid + 1n;

      if (l1Block === targetL1Block) targetL2Block = mid;
    }

    if (targetL2Block == null) {
      throw new Error(`Unable to find l2 block for l1 block ${targetL1Block}`);
    }

    this.lastKnownBlockPair = { l1Block: targetL1Block, l2Block: targetL2Block };
    return targetL2Block;
  }

  // ---------------------------------------------------------------------------
  // Worker registration helpers
  // ---------------------------------------------------------------------------

  async preloadWorkerIds(
    ctx: Context,
    workers: string[],
    blockNumber?: bigint,
  ): Promise<Record<string, bigint>> {
    const workerRegistrationAddress = this.configService.get(
      'blockchain.contracts.workerRegistration',
    ) as Address;
    const workerIds: Record<string, bigint> = {};

    try {
      const contracts = workers.map((workerId) => ({
        address: workerRegistrationAddress,
        abi: WorkerRegistrationABI,
        functionName: 'workerIds' as const,
        args: [this.fromBase58(ctx, workerId)] as const,
      }));

      const results = await this.publicClient.multicall({
        contracts,
        blockNumber,
        batchSize: 2 ** 16,
      });

      let successCount = 0;
      let errorCount = 0;

      workers.forEach((workerId, i) => {
        if (results[i].status === 'success' && results[i].result) {
          workerIds[workerId] = results[i].result;
          if (results[i].result > 0n) successCount++;
        } else {
          errorCount++;
          if (errorCount <= 3) {
            ctx.logger.warn(
              `Failed to get workerId for peer ${workerId.slice(0, 20)}...: ${results[i].error?.message || 'Unknown error'}`,
            );
          }
          workerIds[workerId] = 0n;
        }
      });

      ctx.logger.debug(
        `Worker ID mapping: ${successCount} found, ${errorCount} errors (total: ${workers.length})`,
      );
      return workerIds;
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to preload worker IDs');
      return {};
    }
  }

  private fromBase58(ctx: Context, value: string): Hex {
    try {
      return `0x${Buffer.from(bs58.decode(value)).toString('hex')}` as Hex;
    } catch (error) {
      ctx.logger.error({ error }, `Failed to convert peer ID ${value} from base58`);
      return `0x${Buffer.from(value, 'utf8').toString('hex')}` as Hex;
    }
  }

  async getBondAmount(ctx: Context, blockNumber?: bigint): Promise<bigint> {
    const address = this.configService.get('blockchain.contracts.workerRegistration') as Address;
    const bondAmount = await this.publicClient.readContract({
      address,
      abi: WorkerRegistrationABI,
      functionName: 'bondAmount',
      blockNumber,
    });
    ctx.logger.debug(`Bond amount: ${Number(bondAmount) / 1e18} SQD`);
    return bondAmount;
  }

  async getActiveWorkerCount(ctx: Context, blockNumber?: bigint): Promise<bigint> {
    const address = this.configService.get('blockchain.contracts.workerRegistration') as Address;
    return await this.publicClient.readContract({
      address,
      abi: WorkerRegistrationABI,
      functionName: 'getActiveWorkerCount',
      blockNumber,
    });
  }

  // ---------------------------------------------------------------------------
  // Contract read methods
  // ---------------------------------------------------------------------------

  async getEffectiveTVL(ctx: Context, blockNumber?: bigint): Promise<bigint> {
    const address = this.configService.get('blockchain.contracts.rewardCalculation') as Address;
    const contract = getContract({ address, abi: RewardCalculationABI, client: this.publicClient });
    return await contract.read.effectiveTVL({ blockNumber });
  }

  async getInitialRewardPoolSize(ctx: Context, blockNumber?: bigint): Promise<bigint> {
    const address = this.configService.get('blockchain.contracts.rewardCalculation') as Address;
    const contract = getContract({ address, abi: RewardCalculationABI, client: this.publicClient });
    return await contract.read.INITIAL_REWARD_POOL_SIZE({ blockNumber });
  }

  async getYearlyRewardCapCoefficient(ctx: Context, blockNumber?: bigint): Promise<bigint> {
    const address = this.configService.get('blockchain.contracts.networkController') as Address;
    const contract = getContract({ address, abi: NetworkControllerABI, client: this.publicClient });
    return await contract.read.yearlyRewardCapCoefficient({ blockNumber });
  }

  async getCurrentApy(ctx: Context, blockNumber?: bigint): Promise<bigint> {
    try {
      const tvl = await this.getEffectiveTVL(ctx, blockNumber);
      if (tvl === 0n) return 2000n;

      const initialPool = await this.getInitialRewardPoolSize(ctx, blockNumber);
      const capCoeff = await this.getYearlyRewardCapCoefficient(ctx, blockNumber);
      const apyCap = (capCoeff * initialPool) / tvl;
      return 2000n > apyCap ? apyCap : 2000n;
    } catch (error) {
      ctx.logger.warn({ error }, 'Failed to calculate APY, using default 20%');
      return 2000n;
    }
  }

  async getEpochLength(ctx: Context, blockNumber?: bigint): Promise<number> {
    const configuredLength = this.configService.get('blockchain.rewardEpochLength');
    if (configuredLength) return configuredLength;

    try {
      const address = this.configService.get('blockchain.contracts.workerRegistration') as Address;
      const contract = getContract({ address, abi: WorkerRegistrationABI, client: this.publicClient });
      return Number(await contract.read.epochLength({ blockNumber }));
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to get epoch length, using default 7000');
      return 7000;
    }
  }

  async getLastBlockRewarded(ctx: Context): Promise<number> {
    try {
      const address = this.configService.get('blockchain.contracts.rewardsDistribution') as Address;

      try {
        const lastBlock = await this.publicClient.readContract({
          address,
          abi: DistributedRewardsDistributionABI,
          functionName: 'lastBlockRewarded',
        });

        const lastBlockNum = Number(lastBlock);
        if (lastBlockNum === 0) {
          const startingBlock = this.configService.get('rewards.distributionStartingBlock') || 0;
          if (startingBlock > 0) {
            ctx.logger.info(`Using configured starting block: ${startingBlock} (lastBlockRewarded = 0)`);
            return startingBlock - 1;
          }
          throw new Error(
            'Fresh rewards-distribution contract detected (lastBlockRewarded = 0) but DISTRIBUTION_STARTING_BLOCK is not configured.',
          );
        }
        return lastBlockNum;
      } catch (contractError: any) {
        if (contractError.message?.includes('returned no data')) {
          const startingBlock = this.configService.get('rewards.distributionStartingBlock') || 0;
          if (startingBlock > 0) {
            return startingBlock - 1;
          }
          throw new Error(
            'Rewards distribution contract has no lastBlockRewarded data and DISTRIBUTION_STARTING_BLOCK is not configured.',
          );
        }
        throw contractError;
      }
    } catch (error: any) {
      if (typeof error === 'number') return error;
      ctx.logger.error(
        { error },
        'Unexpected error getting last rewarded block',
      );
      throw error;
    }
  }

  async canCommit(address: Hex): Promise<boolean> {
    const ctx = new TaskContext('contract-service:can-commit');
    try {
      const contractAddr = this.configService.get('blockchain.contracts.rewardsDistribution') as Address;
      const contract = getContract({
        address: contractAddr,
        abi: DistributedRewardsDistributionABI,
        client: this.publicClient,
      });
      return await contract.read.canCommit([address]);
    } catch (error: any) {
      if (error.message?.includes('returned no data')) {
        ctx.logger.debug(`canCommit returned no data for ${address}`);
        return false;
      }
      ctx.logger.error({ error }, `canCommit failed for ${address}`);
      return false;
    }
  }

  async getTargetCapacity(blockNumber?: bigint): Promise<bigint> {
    try {
      const address = this.configService.get('blockchain.contracts.networkController') as Address;
      const contract = getContract({ address, abi: NetworkControllerABI, client: this.publicClient });
      const capacityGb = await contract.read.targetCapacityGb({ blockNumber });
      return BigInt(capacityGb) * BigInt(1e9);
    } catch (error) {
      const configValue = this.configService.get('rewards.targetCapacityGB');
      return BigInt(configValue || 30000) * BigInt(1e9);
    }
  }

  async getStoragePerWorkerInGb(blockNumber?: bigint): Promise<number> {
    try {
      const address = this.configService.get('blockchain.contracts.networkController') as Address;
      const contract = getContract({ address, abi: NetworkControllerABI, client: this.publicClient });
      return Number(await contract.read.storagePerWorkerInGb({ blockNumber }));
    } catch {
      return 200;
    }
  }

  async getStakes(
    workerIds: string[],
    blockNumber?: bigint,
  ): Promise<[MulticallResult<bigint>[], MulticallResult<bigint>[]]> {
    const stakingAddress = this.configService.get('blockchain.contracts.staking') as Address;
    const capedStakingAddress = this.configService.get('blockchain.contracts.capedStaking') as Address;

    if (!stakingAddress || !capedStakingAddress) {
      throw new Error('Staking contract addresses not configured');
    }

    const ctx = new TaskContext('contract-service:get-stakes');
    const workerIdMapping = await this.preloadWorkerIds(ctx, workerIds);

    const validWorkers = workerIds
      .map((peerId) => ({ peerId, contractId: workerIdMapping[peerId] }))
      .filter(({ contractId }) => contractId && contractId !== 0n);

    if (validWorkers.length === 0) {
      const empty: MulticallResult<bigint>[] = workerIds.map(() => ({
        status: 'success' as const,
        result: 0n,
      }));
      return [empty, empty];
    }

    const multicallOpts = blockNumber ? { blockNumber } : {};
    const [capedResults, totalResults] = await Promise.all([
      this.publicClient.multicall({
        contracts: validWorkers.map(({ contractId }) => ({
          address: capedStakingAddress,
          abi: CapedStakingABI,
          functionName: 'capedStake' as const,
          args: [contractId] as const,
        })),
        allowFailure: true,
        ...multicallOpts,
      }),
      this.publicClient.multicall({
        contracts: validWorkers.map(({ contractId }) => ({
          address: stakingAddress,
          abi: StakingABI,
          functionName: 'delegated' as const,
          args: [contractId] as const,
        })),
        allowFailure: true,
        ...multicallOpts,
      }),
    ]);

    const capedMap = new Map<string, MulticallResult<bigint>>();
    const totalMap = new Map<string, MulticallResult<bigint>>();
    validWorkers.forEach((w, i) => {
      capedMap.set(w.peerId, capedResults[i]);
      totalMap.set(w.peerId, totalResults[i]);
    });

    const defaultResult: MulticallResult<bigint> = { status: 'success', result: 0n };
    return [
      workerIds.map((id) => capedMap.get(id) || defaultResult),
      workerIds.map((id) => totalMap.get(id) || defaultResult),
    ];
  }

  // ---------------------------------------------------------------------------
  // Commitment read methods
  // ---------------------------------------------------------------------------

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
    const address = this.configService.get('blockchain.contracts.rewardsDistribution') as Address;
    const commitmentKey = this.commitmentKeyService.generateKey(fromBlock, toBlock);
    const emptyResult = {
      exists: false,
      merkleRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      totalBatches: 0,
      processedBatches: 0,
      approvalCount: 0,
      ipfsLink: '',
    };

    try {
      const commitment = await this.publicClient.readContract({
        address,
        abi: DistributedRewardsDistributionABI,
        functionName: 'getCommitment',
        args: [[BigInt(fromBlock), BigInt(toBlock)]],
      });

      if (!commitment) return emptyResult;

      return {
        exists: Number(commitment[0]) !== 0,
        merkleRoot: (commitment[1] || emptyResult.merkleRoot) as string,
        totalBatches: Number(commitment[2] || 0),
        processedBatches: Number(commitment[3] || 0),
        approvalCount: Number(commitment[4] || 0),
        ipfsLink: commitment[5] || '',
      };
    } catch (contractError: any) {
      if (contractError.message?.includes('returned no data')) return emptyResult;
      ctx.logger.error({ error: contractError, fromBlock, toBlock }, 'Failed to get commitment');
      throw contractError;
    }
  }

  async getCommitmentV2(
    ctx: Context,
    fromBlock: number,
    toBlock: number,
  ): Promise<{
    status: number;
    merkleRoot: string;
    totalBatches: number;
    processedBatches: number;
    approvalCount: number;
    ipfsLink: string;
  }> {
    const address = this.configService.get('blockchain.contracts.rewardsDistribution') as Address;
    const result = await this.publicClient.readContract({
      address,
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
      ipfsLink: result[5],
    };
  }

  async getProcessedBatches(
    ctx: Context,
    fromBlock: number,
    toBlock: number,
    leafHashes: string[],
  ): Promise<boolean[]> {
    const address = this.configService.get('blockchain.contracts.rewardsDistribution') as Address;
    const contract = getContract({
      address,
      abi: DistributedRewardsDistributionABI,
      client: this.publicClient,
    });
    const commitmentKey = this.commitmentKeyService.generateKey(fromBlock, toBlock);

    const results = await Promise.all(
      leafHashes.map(async (leafHash) => {
        try {
          return await contract.read.processed([commitmentKey, leafHash as Hex]);
        } catch {
          return false;
        }
      }),
    );

    ctx.logger.debug(
      `Checked ${leafHashes.length} batches: ${results.filter(Boolean).length} processed`,
    );
    return results;
  }

  async getLastCommitmentKey(ctx: Context): Promise<string> {
    const address = this.configService.get('blockchain.contracts.rewardsDistribution') as Address;
    return (await this.publicClient.readContract({
      address,
      abi: DistributedRewardsDistributionABI,
      functionName: 'lastCommitmentKey',
      args: [],
    })) as string;
  }

  async getCommitmentInfo(commitmentKey: string): Promise<{
    status: number;
    fromBlock: number;
    toBlock: number;
    merkleRoot: string;
    totalBatches: number;
    processedBatches: number;
    approvalCount: bigint;
    ipfsLink: string;
  } | null> {
    try {
      const address = this.configService.get('blockchain.contracts.rewardsDistribution') as Address;
      const contract = getContract({
        address,
        abi: DistributedRewardsDistributionABI,
        client: this.publicClient,
      });

      const [status, fromBlock, toBlock, merkleRoot, totalBatches, processedBatches, approvalCount, ipfsLink] =
        await contract.read.commitments([commitmentKey as `0x${string}`]);

      return {
        status: Number(status),
        fromBlock: Number(fromBlock),
        toBlock: Number(toBlock),
        merkleRoot: merkleRoot as string,
        totalBatches: Number(totalBatches),
        processedBatches: Number(processedBatches),
        approvalCount,
        ipfsLink,
      };
    } catch (error) {
      const ctx = new TaskContext('contract-service:get-commitment-info');
      ctx.logger.error({ error, commitmentKey }, 'Failed to get commitment info');
      return null;
    }
  }

  /**
   * Read the contract-configured approval quorum.
   *
   * RWD-H-004 — fail-closed. The previous implementation silently fell back
   * to `1` on any read failure, which caused premature distribution when the
   * RPC flaked: a freshly committed commitment already carries the
   * committer's auto-approval (see v2 contract line 215), so `1 >= 1` would
   * pass quorum on a single-approval fallback even when the real requirement
   * was higher. The backend layer must refuse to progress until the real
   * value is known, not guess. The outer callers (`approveCommitment`,
   * `EpochProcessorService.checkCommitmentStatus`) already have try/catch
   * blocks that will treat a throw here as "status unknown, retry next
   * cycle" — which is the safe behaviour.
   */
  async getRequiredApprovals(): Promise<number> {
    const ctx = new TaskContext('contract-service:get-required-approvals');
    try {
      const address = this.configService.get('blockchain.contracts.rewardsDistribution') as Address;
      const contract = getContract({
        address,
        abi: DistributedRewardsDistributionABI,
        client: this.publicClient,
      });
      return Number(await contract.read.requiredApproves());
    } catch (error) {
      ctx.logger.error(
        { error },
        'RWD-H-004: failed to read requiredApproves from contract; refusing to progress rather than fall back to a guess.',
      );
      throw new Error(
        'getRequiredApprovals: contract read failed; quorum unknown, refusing fail-open fallback',
      );
    }
  }

  async getCommitmentsNeedingApproval(): Promise<Array<{ fromBlock: number; toBlock: number; merkleRoot: string }>> {
    try {
      const address = this.configService.get('blockchain.contracts.rewardsDistribution') as Address;
      const contract = getContract({
        address,
        abi: DistributedRewardsDistributionABI,
        client: this.publicClient,
      });

      const lastCommitmentKey = await contract.read.lastCommitmentKey();
      if (lastCommitmentKey === '0x0000000000000000000000000000000000000000000000000000000000000000') {
        return [];
      }

      const [status, fromBlock, toBlock, merkleRoot, , , approvalCount] =
        await contract.read.commitments([lastCommitmentKey]);
      const requiredApproves = await contract.read.requiredApproves();

      if (status === 1 && approvalCount < requiredApproves) {
        return [{ fromBlock: Number(fromBlock), toBlock: Number(toBlock), merkleRoot: merkleRoot as string }];
      }
      return [];
    } catch (error) {
      const ctx = new TaskContext('contract-service:commitments-needing-approval');
      ctx.logger.error({ error }, 'Failed to get commitments needing approval');
      return [];
    }
  }

  async hasApprovedCommitment(fromBlock: number, toBlock: number, address: `0x${string}`): Promise<boolean> {
    try {
      const contractAddr = this.configService.get('blockchain.contracts.rewardsDistribution') as Address;
      const commitmentKey = this.commitmentKeyService.generateKey(fromBlock, toBlock);
      return await this.publicClient.readContract({
        address: contractAddr,
        abi: DistributedRewardsDistributionABI,
        functionName: 'approvedBy',
        args: [commitmentKey, address],
      });
    } catch (error) {
      const ctx = new TaskContext('contract-service:has-approved-commitment');
      ctx.logger.error({ error, fromBlock, toBlock, address }, 'Failed to check approval status');
      return false;
    }
  }

  async getPendingCommitments(): Promise<Array<{
    fromBlock: number; toBlock: number; merkleRoot: string;
    totalBatches: number; processedBatches: number; status: string;
  }>> {
    try {
      const address = this.configService.get('blockchain.contracts.rewardsDistribution') as Address;
      const contract = getContract({
        address,
        abi: DistributedRewardsDistributionABI,
        client: this.publicClient,
      });

      const lastCommitmentKey = await contract.read.lastCommitmentKey();
      if (!lastCommitmentKey || lastCommitmentKey === '0x0000000000000000000000000000000000000000000000000000000000000000') {
        return [];
      }

      const [status, fromBlock, toBlock, merkleRoot, totalBatches, processedBatches, approvalCount] =
        await contract.read.commitments([lastCommitmentKey]);

      if (status === 1 && approvalCount > 0n && processedBatches < totalBatches) {
        return [{
          fromBlock: Number(fromBlock), toBlock: Number(toBlock), merkleRoot: merkleRoot as string,
          totalBatches: Number(totalBatches), processedBatches: Number(processedBatches),
          status: 'pending_distribution',
        }];
      }
      return [];
    } catch (error) {
      const ctx = new TaskContext('contract-service:pending-commitments');
      ctx.logger.error({ error }, 'Failed to get pending commitments');
      return [];
    }
  }

  async getRecentDistributionEvents(blockWindow: number = 50): Promise<any[]> {
    try {
      const address = this.configService.get('blockchain.contracts.rewardsDistribution') as Address;
      const currentBlock = await this.publicClient.getBlockNumber();

      const logs = await this.publicClient.getLogs({
        address,
        event: DistributedRewardsDistributionABI.find(
          (item) => item.type === 'event' && item.name === 'BatchDistributed',
        )!,
        fromBlock: currentBlock - BigInt(blockWindow),
      });

      return await Promise.all(
        logs.map(async (log) => {
          const block = await this.publicClient.getBlock({ blockNumber: log.blockNumber });
          return {
            ...log.args,
            blockNumber: log.blockNumber,
            blockTimestamp: Number(block.timestamp),
            transactionHash: log.transactionHash,
            batchIndex: Number(log.args?.batchId || 0),
            totalBatches: null,
          };
        }),
      );
    } catch (error) {
      const ctx = new TaskContext('contract-service:recent-distribution-events');
      ctx.logger.error({ error }, 'Failed to get recent distribution events');
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Distribution status
  // ---------------------------------------------------------------------------

  async getDistributionStatus(ctx: Context): Promise<{
    nextFromBlock: number;
    nextToBlock: number;
    isReadyForDistribution: boolean;
    needsConfirmation: boolean;
    hasExistingCommitment: boolean;
    blocksUntilNextDistribution: number;
    confirmationBlocksNeeded: number;
  }> {
    const currentBlock = await this.getL1BlockNumber(ctx);
    const lastRewardedBlock = await this.getLastBlockRewarded(ctx);
    const blockInterval = this.configService.get('rewards.distributionBlockInterval') || 520;
    const confirmationBlocks = this.configService.get('blockchain.epochConfirmationBlocks') || 1000;
    const startingBlock = this.configService.get('rewards.distributionStartingBlock') || 0;
    const contractAddr = this.configService.get('blockchain.contracts.rewardsDistribution') as Address;

    let lastCommitmentKey: string;
    try {
      lastCommitmentKey = await this.getLastCommitmentKey(ctx);
    } catch {
      lastCommitmentKey = '0x0000000000000000000000000000000000000000000000000000000000000000';
    }

    let nextFromBlock = 0;
    let nextToBlock = 0;
    const ZERO_KEY = '0x0000000000000000000000000000000000000000000000000000000000000000';

    if (lastCommitmentKey !== ZERO_KEY) {
      try {
        const commitment = await this.publicClient.readContract({
          address: contractAddr,
          abi: DistributedRewardsDistributionABI,
          functionName: 'commitments',
          args: [lastCommitmentKey as `0x${string}`],
        });

        const commitmentStatus = Number(commitment[0]);
        if (commitmentStatus === 1) {
          nextFromBlock = Number(commitment[1]);
          nextToBlock = Number(commitment[2]);
        } else {
          nextFromBlock = lastRewardedBlock + 1;
          nextToBlock = nextFromBlock + blockInterval - 1;
        }
      } catch {
        nextFromBlock = lastRewardedBlock + 1;
        nextToBlock = nextFromBlock + blockInterval - 1;
      }
    } else if (lastRewardedBlock === 0) {
      nextFromBlock = startingBlock;
      nextToBlock = nextFromBlock + blockInterval - 1;
    } else {
      nextFromBlock = lastRewardedBlock + 1;
      nextToBlock = nextFromBlock + blockInterval - 1;
    }

    const lastConfirmedBlock = currentBlock - confirmationBlocks;
    const needsConfirmation = nextToBlock > lastConfirmedBlock;
    const commitment = await this.getCommitment(ctx, nextFromBlock, nextToBlock);

    return {
      nextFromBlock,
      nextToBlock,
      isReadyForDistribution: currentBlock >= nextToBlock && !needsConfirmation && !commitment.exists,
      needsConfirmation,
      hasExistingCommitment: commitment.exists,
      blocksUntilNextDistribution: Math.max(0, nextToBlock - currentBlock),
      confirmationBlocksNeeded: needsConfirmation ? nextToBlock - lastConfirmedBlock : 0,
    };
  }

  async isNextDistributionReady(ctx: Context): Promise<{
    isReady: boolean;
    nextFromBlock: number;
    nextToBlock: number;
    blocksUntilReady: number;
    needsConfirmation: boolean;
    confirmationBlocksNeeded: number;
  }> {
    const currentBlock = await this.getL1BlockNumber(ctx);
    const lastRewardedBlock = await this.getLastBlockRewarded(ctx);
    const blockInterval = this.configService.get('rewards.distributionBlockInterval') || 520;
    const confirmationBlocks = this.configService.get('blockchain.epochConfirmationBlocks') || 150;

    const nextFromBlock = lastRewardedBlock + 1;
    const nextToBlock = nextFromBlock + blockInterval - 1;
    const lastConfirmedBlock = currentBlock - confirmationBlocks;
    const needsConfirmation = nextToBlock > lastConfirmedBlock;

    return {
      isReady: currentBlock >= nextToBlock && !needsConfirmation,
      nextFromBlock,
      nextToBlock,
      blocksUntilReady: nextToBlock > currentBlock ? nextToBlock - currentBlock : 0,
      needsConfirmation,
      confirmationBlocksNeeded: needsConfirmation ? nextToBlock - lastConfirmedBlock : 0,
    };
  }

  // ---------------------------------------------------------------------------
  // Approve commitment (direct wallet transaction)
  // ---------------------------------------------------------------------------

  async approveCommitment(fromBlock: number, toBlock: number): Promise<boolean> {
    const ctx = new TaskContext(`contract-service:approve-commitment:${fromBlock}-${toBlock}`);

    try {
      const contractAddr = this.configService.get('blockchain.contracts.rewardsDistribution') as Address;
      const commitmentKey = this.commitmentKeyService.generateKey(fromBlock, toBlock);

      const privateKey = this.configService.get('blockchain.distributor.privateKey') as `0x${string}`;
      if (!privateKey) throw new Error('Missing DISTRIBUTOR_PRIVATE_KEY');

      const account = privateKeyToAccount(privateKey);
      const commitment = await this.getCommitmentInfo(commitmentKey);
      if (!commitment || commitment.status !== 1) return false;

      const requiredApprovals = await this.getRequiredApprovals();
      if (commitment.approvalCount >= requiredApprovals) return true;

      const rpcUrl = this.configService.get('blockchain.network.l2RpcUrl');
      const chain = (rpcUrl.includes('localhost') || rpcUrl.includes('127.0.0.1'))
        ? defineChain({
            id: 42161, name: 'Anvil Local', network: 'anvil',
            nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
            rpcUrls: { default: { http: [rpcUrl] }, public: { http: [rpcUrl] } },
          })
        : arbitrum;

      // RWD-H-008: explicit transport timeout so a flaky L2 node cannot
      // block the approve path indefinitely.
      const walletClient = createWalletClient({
        account,
        chain,
        transport: http(rpcUrl, {
          retryCount: 3,
          retryDelay: 1_000,
          timeout: 30_000,
        }),
      });

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const { request } = await this.publicClient.simulateContract({
            account,
            address: contractAddr,
            abi: DistributedRewardsDistributionABI,
            functionName: 'approveRoot',
            args: [[BigInt(fromBlock), BigInt(toBlock)]],
          });

          const txHash = await walletClient.writeContract(request);
          const receipt = await this.publicClient.waitForTransactionReceipt({
            hash: txHash, confirmations: 2, timeout: 120000,
          });

          if (receipt.status === 'success') {
            ctx.logger.info(`Approval confirmed for ${fromBlock}-${toBlock} (tx: ${txHash})`);
            return true;
          }
          if (attempt === 3) return false;
        } catch (error: any) {
          if (error.message?.includes('AlreadyApproved') || error.message?.includes('0x101f817a')) {
            return true;
          }
          if (attempt === 3) return false;
          await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
        }
      }
      return false;
    } catch (error) {
      ctx.logger.error({ error }, 'failed to approve commitment');
      return false;
    }
  }
}
