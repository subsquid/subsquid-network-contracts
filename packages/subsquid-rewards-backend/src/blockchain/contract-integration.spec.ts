/**
 * Contract integration tests against the Tenderly virtual fork.
 *
 * These tests call the DistributedRewardsDistribution V2 contract directly
 * using viem, without any NestJS scaffolding.
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
import { createPublicClient, http, keccak256, encodeAbiParameters } from 'viem';
import { DistributedRewardsDistributionABI } from './contracts/abis';

// Load .env from the package root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const RPC_URL = process.env.L2_RPC_URL!;
const CONTRACT_ADDRESS = process.env.REWARDS_DISTRIBUTION_ADDRESS! as `0x${string}`;
const DISTRIBUTOR_ADDRESS = process.env.DISTRIBUTOR_ADDRESS! as `0x${string}`;

const client = createPublicClient({
  transport: http(RPC_URL),
});

describe('DistributedRewardsDistribution V2 - contract integration', () => {
  // Increase timeout for network calls
  jest.setTimeout(15_000);

  it('should read lastBlockRewarded from contract', async () => {
    const result = await client.readContract({
      address: CONTRACT_ADDRESS,
      abi: DistributedRewardsDistributionABI,
      functionName: 'lastBlockRewarded',
    });

    expect(typeof result).toBe('bigint');
    expect(result).toBeGreaterThanOrEqual(0n);
  });

  it('should read canCommit for distributor address', async () => {
    const result = await client.readContract({
      address: CONTRACT_ADDRESS,
      abi: DistributedRewardsDistributionABI,
      functionName: 'canCommit',
      args: [DISTRIBUTOR_ADDRESS],
    });

    expect(typeof result).toBe('boolean');
  });

  it('should read requiredApproves', async () => {
    const result = await client.readContract({
      address: CONTRACT_ADDRESS,
      abi: DistributedRewardsDistributionABI,
      functionName: 'requiredApproves',
    });

    expect(typeof result).toBe('bigint');
    // The contract initialises requiredApproves = 1, so it must be >= 1
    expect(result).toBeGreaterThanOrEqual(1n);
  });

  it('should read commitment status for non-existent range', async () => {
    // Replicate the Solidity _key(a, b) = keccak256(abi.encode(a, b))
    const key = keccak256(
      encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'uint256' }],
        [999999n, 999999n],
      ),
    );

    const result = await client.readContract({
      address: CONTRACT_ADDRESS,
      abi: DistributedRewardsDistributionABI,
      functionName: 'commitments',
      args: [key],
    });

    // commitments() returns a tuple; first element is status (uint8)
    // NONEXISTENT = 0
    const status = result[0]; // uint8
    expect(status).toBe(0);
  });

  it('should decode commitments(bytes32) with the V2 8-field layout', async () => {
    // Use a random key that almost certainly has no commitment
    const testKey = keccak256(
      encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'uint256' }],
        [123456789n, 987654321n],
      ),
    );

    const result = await client.readContract({
      address: CONTRACT_ADDRESS,
      abi: DistributedRewardsDistributionABI,
      functionName: 'commitments',
      args: [testKey],
    });

    // The V2 Commitment struct has 8 fields:
    //   status, fromBlock, toBlock, merkleRoot,
    //   totalBatches, processedBatches, approvalCount, ipfsLink
    // viem returns them as a tuple (array)
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(8);

    // Verify types of each field
    const [
      status,
      fromBlock,
      toBlock,
      merkleRoot,
      totalBatches,
      processedBatches,
      approvalCount,
      ipfsLink,
    ] = result;

    expect(typeof status).toBe('number');        // uint8
    expect(typeof fromBlock).toBe('bigint');      // uint256
    expect(typeof toBlock).toBe('bigint');        // uint256
    expect(typeof merkleRoot).toBe('string');     // bytes32 hex
    expect(typeof totalBatches).toBe('number');   // uint16
    expect(typeof processedBatches).toBe('number'); // uint16
    expect(typeof approvalCount).toBe('bigint');  // uint256
    expect(typeof ipfsLink).toBe('string');       // string
  });
});
