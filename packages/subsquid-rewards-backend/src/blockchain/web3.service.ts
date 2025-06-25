import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicClient, http, PublicClient, Address, parseAbiItem, Hex } from 'viem';
import { arbitrum, arbitrumSepolia, mainnet, sepolia } from 'viem/chains';
import { WorkerRegistrationABI } from './contracts/abis';

export interface Registrations {
  workerId: bigint;
  peerId: Hex;
  registrar: Address;
  registeredAt: bigint;
  metadata: string;
}

@Injectable()
export class Web3Service {
  private readonly logger = new Logger(Web3Service.name);
  private publicClient: PublicClient;
  private l1Client: PublicClient;
  private lastKnownBlockPair: { l1Block: bigint; l2Block: bigint } | undefined;
  private readonly MAX_BLOCK_RANGE_SIZE: bigint;

  constructor(private configService: ConfigService) {
    this.MAX_BLOCK_RANGE_SIZE = BigInt(this.configService.get('blockchain.logScanMaxRange') || 2000);
    this.initializeClients();
  }

  private initializeClients() {
    const networkName = this.configService.get('blockchain.networkName');
    const isTestnet = networkName === 'testnet' || networkName === 'sepolia';
    
    const l1Chain = isTestnet ? sepolia : mainnet;
    const l2Chain = isTestnet ? arbitrumSepolia : arbitrum;

    this.publicClient = createPublicClient({
      chain: l2Chain,
      transport: http(this.configService.get('blockchain.l2RpcUrl')),
      cacheTime: 120_000,
      batch: {
        multicall: {
          batchSize: 2 ** 16,
        },
      },
    });

    this.l1Client = createPublicClient({
      chain: l1Chain,
      transport: http(this.configService.get('blockchain.l1RpcUrl')),
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

  async getFirstBlockForL1Block(targetL1Block: number | bigint): Promise<bigint> {
    targetL1Block = BigInt(targetL1Block);

    let start: bigint;
    if (this.lastKnownBlockPair == null || this.lastKnownBlockPair.l1Block > targetL1Block) {
      const chainId = await this.publicClient.getChainId();
      start = this.getNitroGenesisBlock(chainId);

      if (targetL1Block < start) {
        throw new Error(`Target L1 block ${targetL1Block} is before the Nitro genesis block ${start}`);
      }
    } else if (this.lastKnownBlockPair.l1Block < targetL1Block) {
      start = this.lastKnownBlockPair.l2Block;
    } else {
      return this.lastKnownBlockPair.l2Block;
    }

    let end = await this.publicClient.getBlock().then(block => block.number);
    let targetL2Block: bigint | undefined;

    while (start <= end) {
      const mid = start + (end - start) / 2n;
      const l1Block = await this.publicClient.getBlock({ blockNumber: mid }).then(block => BigInt((block as any).l1BlockNumber));

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

  async getRegistrations(): Promise<Registrations[]> {
    const workerRegistrationAddress = this.configService.get('blockchain.contracts.workerRegistration') as Address;
    
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
          this.logger.warn('WorkerRegistered log with missing arguments, skipping.');
          return null; 
        }
        return {
          workerId: args.workerId,
          peerId: args.peerId as Hex,
          registrar: args.registrar,
          registeredAt: args.registeredAt,
          metadata: args.metadata,
        };
      })
      .filter(r => r !== null) as Registrations[];
  }

  async getLatestDistributionBlock(): Promise<bigint> {
    const rewardsDistributionAddress = this.configService.get('blockchain.contracts.rewardsDistribution') as Address;
    let toBlock = await this.publicClient.getBlockNumber();

    while (toBlock >= 0) {
      let fromBlock = toBlock - this.MAX_BLOCK_RANGE_SIZE;
      fromBlock = fromBlock < 0 ? 0n : fromBlock;

      const distributionBlocks = await this.publicClient.getLogs({
        address: rewardsDistributionAddress,
        event: parseAbiItem(
          `event Distributed(uint256 fromBlock, uint256 toBlock, uint256[] recipients, uint256[] workerRewards, uint256[] stakerRewards)`,
        ),
        fromBlock,
        toBlock,
      }).then(logs => logs.map(({ blockNumber }) => blockNumber));

      this.logger.log(`Fetched Distributed logs from ${fromBlock} to ${toBlock}: [${distributionBlocks.join(', ')}]`);

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

  async getL1BlockNumber(): Promise<number> {
    try {
      const l1Client = createPublicClient({
        chain: mainnet,
        transport: http(this.configService.get('blockchain.l1RpcUrl')),
      });
      
      return Number(await l1Client.getBlockNumber());
    } catch (error) {
      this.logger.error(`Failed to get L1 block number: ${error.message}`);
      // fallback to L2 block for testing
      return Number(await this.publicClient.getBlockNumber());
    }
  }

  async getBlockTimestamp(blockNumber: number): Promise<Date> {
    const blockBigInt = BigInt(blockNumber);
    const block = await this.publicClient.getBlock({ blockNumber: blockBigInt });
    return new Date(Number(block.timestamp) * 1000);
  }

  async preloadWorkerIds(workers: string[], blockNumber?: bigint): Promise<Record<string, bigint>> {
    const workerRegistrationAddress = this.configService.get('blockchain.contracts.workerRegistration') as Address;
    const workerIds: Record<string, bigint> = {};
    
    try {
      // convert peer ID strings to bytes format for contract calls
      const contracts = workers.map((workerId) => ({
        address: workerRegistrationAddress,
        abi: WorkerRegistrationABI,
        functionName: 'workerIds' as const,
        args: [this.fromBase58(workerId)] as const,
      }));

      const results = await this.publicClient.multicall({
        contracts,
        blockNumber,
        batchSize: 2 ** 16,
      });

      workers.forEach((workerId, i) => {
        if (results[i].status === 'success' && results[i].result) {
          workerIds[workerId] = results[i].result as bigint;
        } else {
          this.logger.warn(`Failed to get workerId for peer ${workerId}: ${results[i].error?.message || 'Unknown error'}`);
          workerIds[workerId] = 0n; // use 0 to indicate worker not found
        }
      });

      this.logger.log(`Preloaded ${Object.keys(workerIds).length} worker IDs`);
    return workerIds;
    } catch (error) {
      this.logger.error(`Failed to preload worker IDs: ${error.message}`);
      // return empty mapping on error - workers without IDs will be filtered out
      return {};
    }
  }

  /**
   * Convert base58 peer ID string to hex bytes format for smart contract calls
   * Uses the same bs58 library as the old rewards-calculator for consistency
   */
  private fromBase58(value: string): Hex {
    try {
      // use the same method as the old rewards-calculator
      const bs58 = require('bs58');
      return `0x${Buffer.from(bs58.decode(value)).toString('hex')}` as Hex;
    } catch (error) {
      this.logger.error(`Failed to convert peer ID ${value} from base58: ${error.message}`);
      // fallback: encode the string as UTF-8 bytes
      return `0x${Buffer.from(value, 'utf8').toString('hex')}` as Hex;
    }
  }

  /**
   * Get the current bond amount from WorkerRegistration contract
   */
  async getBondAmount(blockNumber?: bigint): Promise<bigint> {
    const workerRegistrationAddress = this.configService.get('blockchain.contracts.workerRegistration') as Address;
    
    try {
      const bondAmount = await this.publicClient.readContract({
        address: workerRegistrationAddress,
        abi: WorkerRegistrationABI,
        functionName: 'bondAmount',
        blockNumber,
      });

      this.logger.log(`Current bond amount: ${bondAmount} wei (${Number(bondAmount) / 1e18} SQD)`);
      return bondAmount as bigint;
    } catch (error) {
      this.logger.error(`Failed to get bond amount: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get active worker count from WorkerRegistration contract
   */
  async getActiveWorkerCount(blockNumber?: bigint): Promise<bigint> {
    const workerRegistrationAddress = this.configService.get('blockchain.contracts.workerRegistration') as Address;
    
    try {
      const count = await this.publicClient.readContract({
        address: workerRegistrationAddress,
        abi: WorkerRegistrationABI,
        functionName: 'getActiveWorkerCount',
        blockNumber,
      });

      this.logger.log(`Active worker count: ${count}`);
      return count as bigint;
    } catch (error) {
      this.logger.error(`Failed to get active worker count: ${error.message}`);
      throw error;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.publicClient.getBlockNumber();
      await this.l1Client.getBlockNumber();
      return true;
    } catch (error) {
      this.logger.error(`Web3 health check failed: ${error.message}`);
      return false;
    }
  }
} 