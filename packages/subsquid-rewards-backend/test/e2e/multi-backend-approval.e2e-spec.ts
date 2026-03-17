/**
 * E2E: Multi-backend approval flow on a standalone anvil chain (no fork).
 *
 * Deploys MockStaking → MockRouter → DistributedRewardsDistribution V2 locally.
 * Simulates 3 independent backend instances (3 different wallets) to test:
 *   1. Backend A commits a merkle root (auto-approves → approvalCount=1)
 *   2. Backend B approves the same root (approvalCount=2)
 *   3. Backend C approves the same root (approvalCount=3)
 *   4. Distribution only proceeds after all 3 approvals
 *   5. Any backend can distribute once quorum is met
 *   6. Verify accumulated rewards on-chain match calculations
 *
 * Also tests edge cases:
 *   - Distribution reverts before quorum met
 *   - Duplicate approval reverts
 *   - Non-distributor cannot approve
 *   - Second epoch cycle with different committer
 */
import { spawn, ChildProcess, execSync } from 'child_process';
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  Hex,
  Address,
  PublicClient,
  WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DistributedRewardsDistributionABI } from '../../src/blockchain/contracts/abis';
import { MerkleTreeService } from '../../src/rewards/distribution/merkle-tree.service';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ANVIL_RPC = 'http://127.0.0.1:8546';
const CONTRACTS_DIR =
  '/Users/gradonsky/SQD/16.Feb/subsquid-network-contracts/packages/contracts';

const anvilChain = defineChain({
  id: 31337, // default anvil chain id
  name: 'Anvil Local',
  network: 'anvil',
  nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
  rpcUrls: {
    default: { http: [ANVIL_RPC] },
    public: { http: [ANVIL_RPC] },
  },
});

// ---------------------------------------------------------------------------
// 3 backend wallets — anvil well-known keys (accounts 0, 1, 2)
// ---------------------------------------------------------------------------

const BACKEND_A = {
  name: 'Backend-A (committer)',
  privateKey:
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex,
  address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address,
};

const BACKEND_B = {
  name: 'Backend-B (approver 1)',
  privateKey:
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex,
  address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address,
};

const BACKEND_C = {
  name: 'Backend-C (approver 2)',
  privateKey:
    '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as Hex,
  address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address,
};

// A 4th account that is NOT a distributor (for negative tests)
const OUTSIDER = {
  name: 'Outsider (no role)',
  privateKey:
    '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a' as Hex,
  address: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65' as Address,
};

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

jest.setTimeout(180_000);

let anvilProcess: ChildProcess;
let v2Address: Address;
let merkleTreeService: MerkleTreeService;

// Clients per backend
let clientA: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: ReturnType<typeof privateKeyToAccount>;
};
let clientB: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: ReturnType<typeof privateKeyToAccount>;
};
let clientC: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: ReturnType<typeof privateKeyToAccount>;
};
let clientOutsider: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: ReturnType<typeof privateKeyToAccount>;
};

// Shared public client for reads
let pub: PublicClient;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClients(privateKey: Hex) {
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({
    chain: anvilChain,
    transport: http(ANVIL_RPC, { timeout: 60_000 }),
  });
  const walletClient = createWalletClient({
    account,
    chain: anvilChain,
    transport: http(ANVIL_RPC, { timeout: 60_000 }),
  });
  return { publicClient, walletClient, account };
}

function castSend(
  to: Address,
  sig: string,
  args: string[],
  opts?: { privateKey?: Hex },
): void {
  execSync(
    [
      'cast',
      'send',
      to,
      `"${sig}"`,
      ...args,
      '--private-key',
      opts?.privateKey || BACKEND_A.privateKey,
      '--rpc-url',
      ANVIL_RPC,
    ].join(' '),
    { stdio: 'pipe', timeout: 30_000 },
  );
}

function forgeCreate(
  contract: string,
  constructorArgs: string[],
  privateKey: Hex,
): Address {
  const cmd = [
    'forge',
    'create',
    '--rpc-url',
    ANVIL_RPC,
    '--private-key',
    privateKey,
    '--broadcast',
    contract,
    ...(constructorArgs.length > 0
      ? ['--constructor-args', ...constructorArgs]
      : []),
  ].join(' ');

  const output = execSync(cmd, {
    cwd: CONTRACTS_DIR,
    stdio: 'pipe',
    timeout: 120_000,
    env: { ...process.env, FOUNDRY_PROFILE: 'ci' },
  }).toString();

  const match = output.match(/Deployed to:\s+(0x[0-9a-fA-F]{40})/);
  if (!match) {
    throw new Error(
      `Failed to parse deployed address from forge output:\n${output}`,
    );
  }
  return match[1] as Address;
}

async function startAnvilStandalone(): Promise<ChildProcess> {
  const anvil = spawn(
    'anvil',
    ['--port', '8546', '--silent'],
    { stdio: 'pipe' },
  );

  const maxWait = 30_000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      execSync(`cast chain-id --rpc-url ${ANVIL_RPC}`, {
        stdio: 'pipe',
        timeout: 5000,
      });
      return anvil;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  anvil.kill();
  throw new Error('Anvil did not start within 30 seconds');
}

async function getCommitmentStatus(fromBlock: bigint, toBlock: bigint) {
  const result = await pub.readContract({
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

function makeWorkers(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    workerId: BigInt(i + 1),
    workerReward: BigInt((i + 1) * 1_000_000_000_000_000_000), // 1e18 scale
    stakerReward: BigInt((i + 1) * 500_000_000_000_000_000),
  }));
}

async function commitRoot(
  client: {
    walletClient: WalletClient;
    account: ReturnType<typeof privateKeyToAccount>;
  },
  fromBlock: bigint,
  toBlock: bigint,
  root: Hex,
  totalBatches: number,
) {
  const hash = await client.walletClient.writeContract({
    address: v2Address,
    abi: DistributedRewardsDistributionABI,
    functionName: 'commitRoot',
    args: [[fromBlock, toBlock], root, totalBatches, ''],
    chain: anvilChain,
    account: client.account,
  });
  return pub.waitForTransactionReceipt({ hash });
}

async function approveRoot(
  client: {
    walletClient: WalletClient;
    account: ReturnType<typeof privateKeyToAccount>;
  },
  fromBlock: bigint,
  toBlock: bigint,
) {
  const hash = await client.walletClient.writeContract({
    address: v2Address,
    abi: DistributedRewardsDistributionABI,
    functionName: 'approveRoot',
    args: [[fromBlock, toBlock]],
    chain: anvilChain,
    account: client.account,
  });
  return pub.waitForTransactionReceipt({ hash });
}

async function distributeBatch(
  client: {
    walletClient: WalletClient;
    account: ReturnType<typeof privateKeyToAccount>;
  },
  fromBlock: bigint,
  toBlock: bigint,
  leaf: {
    recipients: bigint[];
    workerRewards: bigint[];
    stakerRewards: bigint[];
  },
  proof: Hex[],
) {
  const hash = await client.walletClient.writeContract({
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
    account: client.account,
  });
  return pub.waitForTransactionReceipt({ hash });
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // 1. Start anvil in standalone mode (no fork — no RPC dependency)
  anvilProcess = await startAnvilStandalone();

  // 2. Create clients for all backends
  clientA = makeClients(BACKEND_A.privateKey);
  clientB = makeClients(BACKEND_B.privateKey);
  clientC = makeClients(BACKEND_C.privateKey);
  clientOutsider = makeClients(OUTSIDER.privateKey);
  pub = clientA.publicClient;

  // 3. Deploy mock contracts: MockStaking → MockRouter → V2
  const mockStakingAddr = forgeCreate(
    'test/mocks/MockStaking.sol:MockStaking',
    [],
    BACKEND_A.privateKey,
  );

  const mockRouterAddr = forgeCreate(
    'test/mocks/MockRouter.sol:MockRouter',
    [mockStakingAddr],
    BACKEND_A.privateKey,
  );

  v2Address = forgeCreate(
    'src/DistributedRewardsDistribution.sol:DistributedRewardsDistribution',
    [mockRouterAddr],
    BACKEND_A.privateKey,
  );

  // 4. Configure V2: add all 3 distributors, set requiredApproves=3
  castSend(v2Address, 'addDistributor(address)', [BACKEND_A.address], {
    privateKey: BACKEND_A.privateKey,
  });
  castSend(v2Address, 'addDistributor(address)', [BACKEND_B.address], {
    privateKey: BACKEND_A.privateKey,
  });
  castSend(v2Address, 'addDistributor(address)', [BACKEND_C.address], {
    privateKey: BACKEND_A.privateKey,
  });

  // Require all 3 to approve
  castSend(v2Address, 'setApprovesRequired(uint256)', ['3'], {
    privateKey: BACKEND_A.privateKey,
  });

  // Set round-robin to 1 block
  castSend(v2Address, 'setRoundRobinBlocks(uint256)', ['1'], {
    privateKey: BACKEND_A.privateKey,
  });

  // Set windowSize=3 so all distributors can commit at any block
  castSend(v2Address, 'setWindowSize(uint256)', ['3'], {
    privateKey: BACKEND_A.privateKey,
  });

  // 5. Mine blocks so block.number > 200 (our test epochs use blocks 1-200)
  //    commitRoot reverts if toBlock >= block.number
  execSync(`cast rpc anvil_mine 250 --rpc-url ${ANVIL_RPC}`, {
    stdio: 'pipe',
    timeout: 10_000,
  });

  // 6. Create MerkleTreeService
  merkleTreeService = new MerkleTreeService({ get: () => 100 } as any);
});

afterAll(() => {
  if (anvilProcess) {
    anvilProcess.kill('SIGTERM');
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Multi-Backend Approval E2E (standalone anvil)', () => {
  const FROM_BLOCK = 1n;
  const TO_BLOCK = 100n;
  const BATCH_SIZE = 3;

  let workers: ReturnType<typeof makeWorkers>;
  let tree: Awaited<ReturnType<typeof merkleTreeService.generateMerkleTree>>;

  beforeAll(async () => {
    workers = makeWorkers(6);
    tree = await merkleTreeService.generateMerkleTree(workers, BATCH_SIZE);
  });

  // =========================================================================
  // 1. Verify setup
  // =========================================================================

  it('should have 3 distributors and requiredApproves=3', async () => {
    const required = await pub.readContract({
      address: v2Address,
      abi: DistributedRewardsDistributionABI,
      functionName: 'requiredApproves',
    });
    expect(Number(required)).toBe(3);

    // All 3 can commit because windowSize=3
    for (const backend of [BACKEND_A, BACKEND_B, BACKEND_C]) {
      const canCommitResult = await pub.readContract({
        address: v2Address,
        abi: DistributedRewardsDistributionABI,
        functionName: 'canCommit',
        args: [backend.address],
      });
      expect(canCommitResult).toBe(true);
    }
  });

  // =========================================================================
  // 2. Backend A commits (auto-approves → approvalCount=1)
  // =========================================================================

  it('Backend A commits merkle root — auto-approves (count=1)', async () => {
    const receipt = await commitRoot(
      clientA,
      FROM_BLOCK,
      TO_BLOCK,
      tree.root as Hex,
      tree.totalBatches,
    );
    expect(receipt.status).toBe('success');

    const commitment = await getCommitmentStatus(FROM_BLOCK, TO_BLOCK);
    expect(commitment.status).toBe(1); // ACTIVE
    expect(commitment.approvalCount).toBe(1); // committer auto-approves
    expect(commitment.merkleRoot).toBe(tree.root);
    expect(commitment.totalBatches).toBe(2);
    expect(commitment.processedBatches).toBe(0);
  });

  // =========================================================================
  // 3. Distribution REVERTS before quorum (only 1 of 3 approvals)
  // =========================================================================

  it('distribution reverts before quorum is met (1/3 approvals)', async () => {
    await expect(
      distributeBatch(
        clientA,
        FROM_BLOCK,
        TO_BLOCK,
        tree.leaves[0],
        tree.proofs[0] as Hex[],
      ),
    ).rejects.toThrow(); // NotEnoughApprovals
  });

  // =========================================================================
  // 4. Duplicate approval from Backend A REVERTS
  // =========================================================================

  it('duplicate approval from Backend A reverts', async () => {
    await expect(
      approveRoot(clientA, FROM_BLOCK, TO_BLOCK),
    ).rejects.toThrow(); // AlreadyApproved
  });

  // =========================================================================
  // 5. Outsider (non-distributor) cannot approve
  // =========================================================================

  it('outsider without REWARDS_DISTRIBUTOR_ROLE cannot approve', async () => {
    await expect(
      approveRoot(clientOutsider, FROM_BLOCK, TO_BLOCK),
    ).rejects.toThrow(); // AccessControl revert
  });

  // =========================================================================
  // 6. Backend B approves (approvalCount=2) — still not enough
  // =========================================================================

  it('Backend B approves — count becomes 2, still below quorum', async () => {
    const receipt = await approveRoot(clientB, FROM_BLOCK, TO_BLOCK);
    expect(receipt.status).toBe('success');

    const commitment = await getCommitmentStatus(FROM_BLOCK, TO_BLOCK);
    expect(commitment.approvalCount).toBe(2);
    expect(commitment.status).toBe(1); // still ACTIVE
  });

  it('distribution still reverts with 2/3 approvals', async () => {
    await expect(
      distributeBatch(
        clientA,
        FROM_BLOCK,
        TO_BLOCK,
        tree.leaves[0],
        tree.proofs[0] as Hex[],
      ),
    ).rejects.toThrow(); // NotEnoughApprovals
  });

  // =========================================================================
  // 7. Backend C approves (approvalCount=3) — quorum met!
  // =========================================================================

  it('Backend C approves — quorum met (3/3)', async () => {
    const receipt = await approveRoot(clientC, FROM_BLOCK, TO_BLOCK);
    expect(receipt.status).toBe('success');

    const commitment = await getCommitmentStatus(FROM_BLOCK, TO_BLOCK);
    expect(commitment.approvalCount).toBe(3);
    expect(commitment.status).toBe(1); // still ACTIVE (not distributed yet)
  });

  // =========================================================================
  // 8. Distribution succeeds now — Backend B distributes batch 0
  // =========================================================================

  it('Backend B distributes batch 0 after quorum', async () => {
    const receipt = await distributeBatch(
      clientB,
      FROM_BLOCK,
      TO_BLOCK,
      tree.leaves[0],
      tree.proofs[0] as Hex[],
    );
    expect(receipt.status).toBe('success');

    const commitment = await getCommitmentStatus(FROM_BLOCK, TO_BLOCK);
    expect(commitment.processedBatches).toBe(1);
    expect(commitment.status).toBe(1); // still ACTIVE (1 more batch)
  });

  // =========================================================================
  // 9. Backend C distributes batch 1 — completes distribution
  // =========================================================================

  it('Backend C distributes batch 1 — distribution COMPLETED', async () => {
    const receipt = await distributeBatch(
      clientC,
      FROM_BLOCK,
      TO_BLOCK,
      tree.leaves[1],
      tree.proofs[1] as Hex[],
    );
    expect(receipt.status).toBe('success');

    const commitment = await getCommitmentStatus(FROM_BLOCK, TO_BLOCK);
    expect(commitment.processedBatches).toBe(2);
    expect(commitment.totalBatches).toBe(2);
    expect(commitment.status).toBe(2); // COMPLETED
  });

  // =========================================================================
  // 10. Verify on-chain state
  // =========================================================================

  it('lastBlockRewarded updated to TO_BLOCK', async () => {
    const lastBlock = await pub.readContract({
      address: v2Address,
      abi: DistributedRewardsDistributionABI,
      functionName: 'lastBlockRewarded',
    });
    expect(Number(lastBlock)).toBe(Number(TO_BLOCK));
  });

  it('accumulated rewards match for all workers', async () => {
    for (const worker of workers) {
      const raw = execSync(
        `cast call ${v2Address} "accumulatedRewards(uint256)(uint256)" ${worker.workerId} --rpc-url ${ANVIL_RPC}`,
        { stdio: 'pipe', timeout: 10_000 },
      )
        .toString()
        .trim();

      const accumulated = BigInt(raw.split(' ')[0].split('\n')[0]);
      expect(accumulated).toBe(worker.workerReward);
    }
  });

  // =========================================================================
  // 11. Second epoch — full cycle again with different committer
  // =========================================================================

  describe('second epoch cycle', () => {
    const FROM_BLOCK_2 = 101n;
    const TO_BLOCK_2 = 200n;

    let workers2: ReturnType<typeof makeWorkers>;
    let tree2: Awaited<
      ReturnType<typeof merkleTreeService.generateMerkleTree>
    >;

    beforeAll(async () => {
      workers2 = makeWorkers(9); // 9 workers, 3 batches
      tree2 = await merkleTreeService.generateMerkleTree(workers2, BATCH_SIZE);
    });

    it('Backend B commits second epoch — auto-approves (1/3)', async () => {
      const receipt = await commitRoot(
        clientB,
        FROM_BLOCK_2,
        TO_BLOCK_2,
        tree2.root as Hex,
        tree2.totalBatches,
      );
      expect(receipt.status).toBe('success');

      const commitment = await getCommitmentStatus(FROM_BLOCK_2, TO_BLOCK_2);
      expect(commitment.approvalCount).toBe(1);
      expect(commitment.totalBatches).toBe(3);
    });

    it('Backend A and C approve second epoch (3/3)', async () => {
      const receiptA = await approveRoot(clientA, FROM_BLOCK_2, TO_BLOCK_2);
      expect(receiptA.status).toBe('success');

      const receiptC = await approveRoot(clientC, FROM_BLOCK_2, TO_BLOCK_2);
      expect(receiptC.status).toBe('success');

      const commitment = await getCommitmentStatus(FROM_BLOCK_2, TO_BLOCK_2);
      expect(commitment.approvalCount).toBe(3);
    });

    it('distribute all 3 batches from different backends', async () => {
      // Batch 0 by Backend A
      const r0 = await distributeBatch(
        clientA,
        FROM_BLOCK_2,
        TO_BLOCK_2,
        tree2.leaves[0],
        tree2.proofs[0] as Hex[],
      );
      expect(r0.status).toBe('success');

      // Batch 1 by Backend B
      const r1 = await distributeBatch(
        clientB,
        FROM_BLOCK_2,
        TO_BLOCK_2,
        tree2.leaves[1],
        tree2.proofs[1] as Hex[],
      );
      expect(r1.status).toBe('success');

      // Batch 2 by Backend C
      const r2 = await distributeBatch(
        clientC,
        FROM_BLOCK_2,
        TO_BLOCK_2,
        tree2.leaves[2],
        tree2.proofs[2] as Hex[],
      );
      expect(r2.status).toBe('success');

      const commitment = await getCommitmentStatus(FROM_BLOCK_2, TO_BLOCK_2);
      expect(commitment.status).toBe(2); // COMPLETED
      expect(commitment.processedBatches).toBe(3);
    });

    it('lastBlockRewarded updated to 200', async () => {
      const lastBlock = await pub.readContract({
        address: v2Address,
        abi: DistributedRewardsDistributionABI,
        functionName: 'lastBlockRewarded',
      });
      expect(Number(lastBlock)).toBe(200);
    });

    it('accumulated rewards are sum of both epochs', async () => {
      // Workers 1-6 got rewards in both epochs, workers 7-9 only in epoch 2
      for (let i = 0; i < 6; i++) {
        const raw = execSync(
          `cast call ${v2Address} "accumulatedRewards(uint256)(uint256)" ${i + 1} --rpc-url ${ANVIL_RPC}`,
          { stdio: 'pipe', timeout: 10_000 },
        )
          .toString()
          .trim();

        const accumulated = BigInt(raw.split(' ')[0].split('\n')[0]);
        const expectedFromEpoch1 = workers[i].workerReward;
        const expectedFromEpoch2 = workers2[i].workerReward;
        expect(accumulated).toBe(expectedFromEpoch1 + expectedFromEpoch2);
      }

      // Workers 7-9 only existed in epoch 2
      for (let i = 6; i < 9; i++) {
        const raw = execSync(
          `cast call ${v2Address} "accumulatedRewards(uint256)(uint256)" ${i + 1} --rpc-url ${ANVIL_RPC}`,
          { stdio: 'pipe', timeout: 10_000 },
        )
          .toString()
          .trim();

        const accumulated = BigInt(raw.split(' ')[0].split('\n')[0]);
        expect(accumulated).toBe(workers2[i].workerReward);
      }
    });
  });

  // =========================================================================
  // 12. Edge case — cannot re-distribute already completed commitment
  // =========================================================================

  it('cannot distribute batch on already completed commitment', async () => {
    await expect(
      distributeBatch(
        clientA,
        FROM_BLOCK,
        TO_BLOCK,
        tree.leaves[0],
        tree.proofs[0] as Hex[],
      ),
    ).rejects.toThrow(); // CommitmentAlreadyCompleted or similar
  });
});
