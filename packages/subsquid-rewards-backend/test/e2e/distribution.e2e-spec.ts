/**
 * E2E: Full distribution flow on an anvil fork of Arbitrum Sepolia.
 *
 * Spins up anvil, deploys DistributedRewardsDistribution V2, configures it,
 * then runs through commit + distribute cycles using the real MerkleTreeService.
 */
import { ChildProcess } from 'child_process';
import { Hex, Address } from 'viem';
import { DistributedRewardsDistributionABI } from '../../src/blockchain/contracts/abis';
import { MerkleTreeService } from '../../src/rewards/distribution/merkle-tree.service';
import {
  startAnvil,
  deployV2Contract,
  configureV2Contract,
  createAnvilClients,
  anvilChain,
  DISTRIBUTOR_PRIVATE_KEY,
} from './helpers/anvil-setup';

// ---------------------------------------------------------------------------
// Global test state
// ---------------------------------------------------------------------------

jest.setTimeout(120_000);

let anvilProcess: ChildProcess;
let v2Address: Address;
let merkleTreeService: MerkleTreeService;

const { publicClient, walletClient, account } = createAnvilClients();

// ---------------------------------------------------------------------------
// Contract helper
// ---------------------------------------------------------------------------

async function getCommitmentStatus(fromBlock: bigint, toBlock: bigint) {
  const result = await publicClient.readContract({
    address: v2Address,
    abi: DistributedRewardsDistributionABI,
    functionName: 'getCommitment',
    args: [[fromBlock, toBlock]],
  });
  return {
    status: Number(result[0]),
    merkleRoot: result[1] as Hex,
    totalBatches: Number(result[2]),
    processedBatches: Number(result[3]),
    approvalCount: Number(result[4]),
    ipfsLink: result[5] as string,
  };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Start anvil fork
  anvilProcess = await startAnvil();

  // Deploy V2
  v2Address = deployV2Contract(DISTRIBUTOR_PRIVATE_KEY);

  // Configure V2 (add distributor, approvals=1, round-robin=1, grant Staking role)
  await configureV2Contract(v2Address);

  // Create MerkleTreeService with mock ConfigService
  merkleTreeService = new MerkleTreeService({ get: () => 100 } as any);
});

afterAll(() => {
  if (anvilProcess) {
    anvilProcess.kill('SIGTERM');
  }
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeWorkers(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    workerId: BigInt(i + 1),
    workerReward: BigInt((i + 1) * 1000),
    stakerReward: BigInt((i + 1) * 500),
  }));
}

async function commitRoot(
  fromBlock: bigint,
  toBlock: bigint,
  root: Hex,
  totalBatches: number,
) {
  const hash = await walletClient.writeContract({
    address: v2Address,
    abi: DistributedRewardsDistributionABI,
    functionName: 'commitRoot',
    args: [[fromBlock, toBlock], root, totalBatches, ''],
    chain: anvilChain,
    account,
  });
  return publicClient.waitForTransactionReceipt({ hash });
}

async function distributeBatch(
  fromBlock: bigint,
  toBlock: bigint,
  leaf: {
    recipients: bigint[];
    workerRewards: bigint[];
    stakerRewards: bigint[];
  },
  proof: Hex[],
) {
  const hash = await walletClient.writeContract({
    address: v2Address,
    abi: DistributedRewardsDistributionABI,
    functionName: 'distribute',
    args: [
      [fromBlock, toBlock],
      leaf.recipients,
      leaf.workerRewards,
      leaf.stakerRewards,
      proof,
    ],
    chain: anvilChain,
    account,
  });
  return publicClient.waitForTransactionReceipt({ hash });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Distribution E2E (anvil fork)', () => {
  it('happy path: 6 workers, batch size 3 => 2 batches, full cycle', async () => {
    const workers = makeWorkers(6);
    const tree = await merkleTreeService.generateMerkleTree(workers, 3);

    expect(tree.totalBatches).toBe(2);
    expect(tree.leaves).toHaveLength(2);

    const fromBlock = 1n;
    const toBlock = 100n;

    // Commit
    const commitReceipt = await commitRoot(
      fromBlock,
      toBlock,
      tree.root as Hex,
      tree.totalBatches,
    );
    expect(commitReceipt.status).toBe('success');

    // Verify ACTIVE status
    let commitment = await getCommitmentStatus(fromBlock, toBlock);
    expect(commitment.status).toBe(1); // ACTIVE
    expect(commitment.totalBatches).toBe(2);
    expect(commitment.processedBatches).toBe(0);

    // Distribute batch 0
    const receipt0 = await distributeBatch(
      fromBlock,
      toBlock,
      tree.leaves[0],
      tree.proofs[0] as Hex[],
    );
    expect(receipt0.status).toBe('success');

    commitment = await getCommitmentStatus(fromBlock, toBlock);
    expect(commitment.processedBatches).toBe(1);
    expect(commitment.status).toBe(1); // still ACTIVE

    // Distribute batch 1
    const receipt1 = await distributeBatch(
      fromBlock,
      toBlock,
      tree.leaves[1],
      tree.proofs[1] as Hex[],
    );
    expect(receipt1.status).toBe('success');

    // Verify COMPLETED
    commitment = await getCommitmentStatus(fromBlock, toBlock);
    expect(commitment.status).toBe(2); // COMPLETED
    expect(commitment.processedBatches).toBe(2);
    expect(commitment.totalBatches).toBe(2);

    // Verify lastBlockRewarded updated
    const lastBlock = await publicClient.readContract({
      address: v2Address,
      abi: DistributedRewardsDistributionABI,
      functionName: 'lastBlockRewarded',
    });
    expect(Number(lastBlock)).toBe(100);
  });

  it('recovery: partial distribution then resume remaining batches', async () => {
    // fromBlock must be lastBlockRewarded + 1 = 101
    const workers = makeWorkers(9); // 9 workers, batch size 3 = 3 batches
    const tree = await merkleTreeService.generateMerkleTree(workers, 3);
    expect(tree.totalBatches).toBe(3);

    const fromBlock = 101n;
    const toBlock = 200n;

    // Commit
    await commitRoot(fromBlock, toBlock, tree.root as Hex, tree.totalBatches);

    // Distribute only batch 0
    await distributeBatch(
      fromBlock,
      toBlock,
      tree.leaves[0],
      tree.proofs[0] as Hex[],
    );

    // Verify ACTIVE with processedBatches=1
    let commitment = await getCommitmentStatus(fromBlock, toBlock);
    expect(commitment.status).toBe(1); // ACTIVE
    expect(commitment.processedBatches).toBe(1);

    // "Recovery": re-generate same tree (deterministic) and distribute remaining
    const tree2 = await merkleTreeService.generateMerkleTree(workers, 3);
    expect(tree2.root).toBe(tree.root); // must be identical

    // Distribute batch 1
    await distributeBatch(
      fromBlock,
      toBlock,
      tree2.leaves[1],
      tree2.proofs[1] as Hex[],
    );

    commitment = await getCommitmentStatus(fromBlock, toBlock);
    expect(commitment.processedBatches).toBe(2);
    expect(commitment.status).toBe(1); // still ACTIVE

    // Distribute batch 2
    await distributeBatch(
      fromBlock,
      toBlock,
      tree2.leaves[2],
      tree2.proofs[2] as Hex[],
    );

    // Verify COMPLETED
    commitment = await getCommitmentStatus(fromBlock, toBlock);
    expect(commitment.status).toBe(2); // COMPLETED
    expect(commitment.processedBatches).toBe(3);

    // Verify lastBlockRewarded updated
    const lastBlock = await publicClient.readContract({
      address: v2Address,
      abi: DistributedRewardsDistributionABI,
      functionName: 'lastBlockRewarded',
    });
    expect(Number(lastBlock)).toBe(200);
  });

  it('error: wrong block range reverts with NotAllBlocksCovered', async () => {
    // lastBlockRewarded is 200, so next fromBlock should be 201
    // Attempt to commit with fromBlock = 500 (gap)
    const workers = makeWorkers(3);
    const tree = await merkleTreeService.generateMerkleTree(workers, 3);

    const badFromBlock = 500n;
    const badToBlock = 600n;

    await expect(
      commitRoot(badFromBlock, badToBlock, tree.root as Hex, tree.totalBatches),
    ).rejects.toThrow(); // NotAllBlocksCovered revert
  });
});
