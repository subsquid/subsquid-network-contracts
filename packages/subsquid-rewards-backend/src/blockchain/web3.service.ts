import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPublicClient,
  http,
  PublicClient,
  Address,
  parseAbiItem,
  Hex,
} from 'viem';
import { arbitrum, arbitrumSepolia, mainnet, sepolia } from 'viem/chains';
import { WorkerRegistrationABI } from './contracts/abis';
import { Context } from '../common';
const bs58 = require('bs58');

export interface Registrations {
  workerId: bigint;
  peerId: Hex;
  registrar: Address;
  registeredAt: bigint;
  metadata: string;
}

@Injectable()
export class Web3Service {
  private publicClient: PublicClient;
  private l1Client: PublicClient;
  private lastKnownBlockPair: { l1Block: bigint; l2Block: bigint } | undefined;
  private readonly MAX_BLOCK_RANGE_SIZE: bigint;

  constructor(private configService: ConfigService) {
    this.MAX_BLOCK_RANGE_SIZE = BigInt(
      this.configService.get('blockchain.logScanMaxRange') || 2000,
    );
    this.initializeClients();
  }

  private initializeClients() {
    const networkName = this.configService.get(
      'blockchain.network.networkName',
    );
    const isTestnet = networkName === 'testnet' || networkName === 'sepolia';

    const l1Chain = isTestnet ? sepolia : mainnet;
    const l2Chain = isTestnet ? arbitrumSepolia : arbitrum;

    const l2RpcUrl = this.configService.get('blockchain.network.l2RpcUrl');
    console.log(`Initializing L2 client with RPC URL: ${l2RpcUrl}`);
    console.log(`Network: ${networkName}, Chain: ${l2Chain.name} (${l2Chain.id})`);

    this.publicClient = createPublicClient({
      chain: l2Chain,
      transport: http(l2RpcUrl, {
        retryCount: 3,
        timeout: 30000,
      }),
      cacheTime: 0, // disable caching to avoid stale responses
      batch: {
        multicall: {
          batchSize: 2 ** 16,
        },
      },
    });

    this.l1Client = createPublicClient({
      chain: l1Chain,
      transport: http(this.configService.get('blockchain.network.l1RpcUrl')),
      batch: {
        multicall: true,
      },
    });
  }

  get client(): PublicClient {
    return this.publicClient;
  }

  get l1(): PublicClient {
    return this.l1Client;
  }

  private getNitroGenesisBlock(chainId: number): bigint {
    // all networks except Arbitrum One started off with Nitro
    if (chainId === 42161) {
      return 15447158n;
    }
    return 0n;
  }

  async getFirstBlockForL1Block(
    targetL1Block: number | bigint,
  ): Promise<bigint> {
    targetL1Block = BigInt(targetL1Block);

    let start: bigint;
    if (
      this.lastKnownBlockPair == null ||
      this.lastKnownBlockPair.l1Block > targetL1Block
    ) {
      const chainId = await this.publicClient.getChainId();
      start = this.getNitroGenesisBlock(chainId);

      if (targetL1Block < start) {
        throw new Error(
          `Target L1 block ${targetL1Block} is before the Nitro genesis block ${start}`,
        );
      }
    } else if (this.lastKnownBlockPair.l1Block < targetL1Block) {
      start = this.lastKnownBlockPair.l2Block;
    } else {
      return this.lastKnownBlockPair.l2Block;
    }

    let end = await this.publicClient.getBlock().then((block) => block.number);
    let targetL2Block: bigint | undefined;

    while (start <= end) {
      const mid = start + (end - start) / 2n;
      const l1Block = await this.publicClient
        .getBlock({ blockNumber: mid })
        .then((block) => BigInt((block as any).l1BlockNumber));

      if (l1Block === targetL1Block) {
        end = mid - 1n;
      } else if (l1Block < targetL1Block) {
        start = mid + 1n;
      } else {
        end = mid - 1n;
      }

      if (l1Block === targetL1Block) {
        targetL2Block = mid;
      }
    }

    if (targetL2Block == null) {
      throw new Error(`Unable to find l2 block for l1 block ${targetL1Block}`);
    }

    this.lastKnownBlockPair = {
      l1Block: targetL1Block,
      l2Block: targetL2Block,
    };

    return targetL2Block;
  }

  async getRegistrations(ctx: Context): Promise<Registrations[]> {
    const workerRegistrationAddress = this.configService.get(
      'blockchain.contracts.workerRegistration',
    ) as Address;

    const logs = await this.publicClient.getLogs({
      address: workerRegistrationAddress,
      event: parseAbiItem(
        `event WorkerRegistered(uint256 indexed workerId, bytes peerId, address indexed registrar, uint256 registeredAt, string metadata)`,
      ),
      fromBlock: 1n,
    });

    return logs
      .map(({ args }) => {
        if (
          args.workerId === undefined ||
          args.peerId === undefined ||
          args.registrar === undefined ||
          args.registeredAt === undefined ||
          args.metadata === undefined
        ) {
          ctx.logger.warn(
            'WorkerRegistered log with missing arguments, skipping.',
          );
          return null;
        }
        return {
          workerId: args.workerId,
          peerId: args.peerId,
          registrar: args.registrar,
          registeredAt: args.registeredAt,
          metadata: args.metadata,
        };
      })
      .filter((r) => r !== null) as Registrations[];
  }

  async getLatestDistributionBlock(): Promise<bigint> {
    const rewardsDistributionAddress = this.configService.get(
      'blockchain.contracts.rewardsDistribution',
    ) as Address;
    let toBlock = await this.publicClient.getBlockNumber();

    while (toBlock >= 0) {
      let fromBlock = toBlock - this.MAX_BLOCK_RANGE_SIZE;
      fromBlock = fromBlock < 0 ? 0n : fromBlock;

      const distributionBlocks = await this.publicClient
        .getLogs({
          address: rewardsDistributionAddress,
          event: parseAbiItem(
            `event Distributed(uint256 fromBlock, uint256 toBlock, uint256[] recipients, uint256[] workerRewards, uint256[] stakerRewards)`,
          ),
          fromBlock,
          toBlock,
        })
        .then((logs) => logs.map(({ blockNumber }) => blockNumber));

      // Log moved to calling context

      if (distributionBlocks.length > 0) {
        return distributionBlocks[distributionBlocks.length - 1];
      }

      toBlock = fromBlock - 1n;
    }

    return -1n;
  }

  async getLatestL2Block(): Promise<bigint> {
    return await this.publicClient.getBlockNumber();
  }

  async getL1BlockNumber(ctx: Context): Promise<number> {
    try {
      return Number(await this.l1Client.getBlockNumber());
    } catch (error) {
      ctx.logger.error({ error }, `Failed to get L1 block number`);
      // fallback to L2 block for testing
      return Number(await this.publicClient.getBlockNumber());
    }
  }

  async getBlockTimestamp(ctx: Context, blockNumber: number): Promise<Date> {
    const blockBigInt = BigInt(blockNumber);
    // Use L1 client for L1 block timestamps
    const block = await this.l1Client.getBlock({ blockNumber: blockBigInt });
    return new Date(Number(block.timestamp) * 1000);
  }

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
      // convert peer ID strings to bytes format for contract calls
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
      let notRegisteredCount = 0;
      let errorCount = 0;

      workers.forEach((workerId, i) => {
        if (results[i].status === 'success' && results[i].result) {
          const contractId = results[i].result;
          workerIds[workerId] = contractId;
          if (contractId > 0n) {
            successCount++;
            if (successCount <= 3) {
              // Log first 3 successful mappings
              ctx.logger.debug(
                `✅ Worker ${workerId.slice(0, 20)}... -> Contract ID ${contractId}`,
              );
            }
          } else {
            notRegisteredCount++;
          }
        } else {
          errorCount++;
          if (errorCount <= 3) {
            // Log first 3 errors only
            ctx.logger.warn(
              `Failed to get workerId for peer ${workerId.slice(0, 20)}...: ${results[i].error?.message || 'Unknown error'}`,
            );
          }
          workerIds[workerId] = 0n; // use 0 to indicate worker not found
        }
      });

      ctx.logger.debug(
        `📊 Worker ID mapping results: ${successCount} successful, ${notRegisteredCount} unregistered, ${errorCount} errors (total: ${workers.length})`,
      );
      if (errorCount > 3) {
        ctx.logger.warn(
          `... and ${errorCount - 3} more errors (suppressed for brevity)`,
        );
      }
      return workerIds;
    } catch (error) {
      ctx.logger.error({ error }, `Failed to preload worker IDs`);
      // return empty mapping on error - workers without IDs will be filtered out
      return {};
    }
  }

  /**
   * Convert base58 peer ID string to hex bytes format for smart contract calls
   * Uses the same implementation as the old rewards-calculator for consistency
   */
  private fromBase58(ctx: Context, value: string): Hex {
    try {
      // same implementation as packages/rewards-calculator/src/utils.ts
      const { decode } = bs58;
      const hexValue = `0x${Buffer.from(decode(value)).toString('hex')}`;
      ctx.logger.debug(
        `Converted peer ID ${value.slice(0, 20)}... to ${hexValue.slice(0, 20)}...`,
      );
      return hexValue as `0x${string}`;
    } catch (error) {
      ctx.logger.error(
        { error },
        `Failed to convert peer ID ${value} from base58`,
      );
      // fallback: encode the string as UTF-8 bytes
      const fallbackHex = `0x${Buffer.from(value, 'utf8').toString('hex')}`;
      ctx.logger.warn(
        `Using UTF-8 fallback for ${value.slice(0, 20)}...: ${fallbackHex.slice(0, 20)}...`,
      );
      return fallbackHex as `0x${string}`;
    }
  }

  /**
   * Get the current bond amount from WorkerRegistration contract
   */
  async getBondAmount(ctx: Context, blockNumber?: bigint): Promise<bigint> {
    const workerRegistrationAddress = this.configService.get(
      'blockchain.contracts.workerRegistration',
    ) as Address;

    try {
      const bondAmount = await this.publicClient.readContract({
        address: workerRegistrationAddress,
        abi: WorkerRegistrationABI,
        functionName: 'bondAmount',
        blockNumber,
      });

      ctx.logger.debug(
        `Current bond amount: ${bondAmount} wei (${Number(bondAmount) / 1e18} SQD)`,
      );
      return bondAmount;
    } catch (error) {
      ctx.logger.error({ error }, `Failed to get bond amount`);
      throw error;
    }
  }

  /**
   * Get active worker count from WorkerRegistration contract
   */
  async getActiveWorkerCount(
    ctx: Context,
    blockNumber?: bigint,
  ): Promise<bigint> {
    const workerRegistrationAddress = this.configService.get(
      'blockchain.contracts.workerRegistration',
    ) as Address;

    try {
      const count = await this.publicClient.readContract({
        address: workerRegistrationAddress,
        abi: WorkerRegistrationABI,
        functionName: 'getActiveWorkerCount',
        blockNumber,
      });

      ctx.logger.debug(`Active worker count: ${count}`);
      return count;
    } catch (error) {
      ctx.logger.error({ error }, `Failed to get active worker count`);
      throw error;
    }
  }

  async healthCheck(ctx: Context): Promise<boolean> {
    try {
      await this.publicClient.getBlockNumber();
      await this.l1Client.getBlockNumber();
      return true;
    } catch (error) {
      ctx.logger.error({ error }, `Web3 health check failed`);
      return false;
    }
  }

  /**
   * get L1 block information
   */
  async getL1Block(
    ctx: Context,
    blockNumber: bigint,
  ): Promise<{ timestamp: bigint; number: bigint }> {
    try {
      const block = await this.l1Client.getBlock({ blockNumber });
      return {
        timestamp: block.timestamp,
        number: block.number,
      };
    } catch (error) {
      ctx.logger.error({ error }, `Failed to get L1 block ${blockNumber}`);
      throw error;
    }
  }

  /**
   * get latest L2 block with L1 block number
   */
  async getBlock(
    ctx: Context,
  ): Promise<{ number: bigint; l1BlockNumber: bigint }> {
    try {
      const block = await this.publicClient.getBlock();
      return {
        number: block.number,
        l1BlockNumber: BigInt((block as any).l1BlockNumber),
      };
    } catch (error) {
      ctx.logger.error({ error }, `Failed to get latest block`);
      throw error;
    }
  }
}
