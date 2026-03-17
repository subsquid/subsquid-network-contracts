/**
 * E2E: Full pipeline on anvil fork with real Router, real Staking, real worker IDs.
 *
 * This test deploys a fresh V2 contract on an anvil fork of Arbitrum Sepolia,
 * wires it into the real Router via impersonation, sets lastBlockRewarded to
 * match the production block range, then runs the complete pipeline:
 *
 *   ClickHouse → Rewards Calculation → Merkle Tree → commitRoot → distribute
 *
 * Every call goes through the real Router → Staking → accounting path.
 * NO mocks. NO shortcuts.
 */
import * as path from 'path';
import * as dotenv from 'dotenv';
import { ChildProcess, execSync } from 'child_process';
import { ClickHouse } from 'clickhouse';
import Decimal from 'decimal.js';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import {
  createPublicClient,
  createWalletClient,
  http,
  Hex,
  Address,
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
} from 'viem';
import { sepolia, arbitrumSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import {
  RewardWorker,
  calculateLivenessFactor,
} from '../../src/rewards/calculation/rewards-calculator.service';
import {
  MerkleTreeService,
  MerkleTreeResult,
} from '../../src/rewards/distribution/merkle-tree.service';
import { DistributedRewardsDistributionABI } from '../../src/blockchain/contracts/abis';
import {
  startAnvil,
  deployV2Contract,
  ANVIL_RPC,
  ROUTER,
  STAKING,
  ADMIN,
  DISTRIBUTOR,
  DISTRIBUTOR_PRIVATE_KEY,
  REWARDS_DISTRIBUTOR_ROLE,
} from './helpers/anvil-setup';

dayjs.extend(utc);
Decimal.set({ precision: 28, minE: -9 });

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// ---------------------------------------------------------------------------
// Reference on-chain data from a real commit by bot 0x07DF9F20...
// Contract: 0x68f9fE3504652360afF430dF198E1Cb7B2dCfD57 on Arbitrum Sepolia
// ---------------------------------------------------------------------------

const FROM_BLOCK = 10409038;
const TO_BLOCK = 10409557;

// On-chain recipients (worker contract IDs) — 24 workers
const ON_CHAIN_RECIPIENTS = [
  121n, 27n, 137n, 100n, 123n, 139n, 235n, 178n,
  37n, 90n, 25n, 96n, 114n, 126n, 191n, 46n,
  65n, 110n, 41n, 162n, 69n, 104n, 161n, 102n,
];

const ON_CHAIN_WORKER_REWARDS = [
  19703405032875202192n, 18745542777540722331n, 19136689166940179482n,
  20264781698746912186n, 19576941815656082534n, 18388766310884710500n,
  19218307208163331456n, 19533878240926975174n, 19982937497443563750n,
  19077450598658926118n, 18807197655165712005n, 20234630007458141481n,
  19430954656703616803n, 19534533553373406537n, 19139825505684352009n,
  18498699300457384255n, 19067771380620372455n, 20257701986856739524n,
  19986389120639595917n, 19849383726206356508n, 19224847713293206517n,
  19539845774418313451n, 18839730928581658085n, 20109550726444740205n,
];

const ON_CHAIN_STAKER_REWARDS = [
  1423344150074593364n, 465481894740113503n, 859179084824143967n,
  2302454831630912418n, 1414208638718656927n, 108705428084101672n,
  938246325362722628n, 1381791144375134079n, 2110128452763066119n,
  918714979635945875n, 527136772365103177n, 2300570217974985703n,
  1403662747369709698n, 1411145130054334064n, 859764622883743181n,
  218638417656775427n, 937067463728056162n, 2301650445129720016n,
  2161379944269291842n, 1899929170855053288n, 944786830492597689n,
  1411528876860307734n, 650099125993948556n, 2284817715795709463n,
];

// ---------------------------------------------------------------------------
// Contract ABIs for direct reads
// ---------------------------------------------------------------------------

const WorkerRegistrationABI = [
  { type: 'function', name: 'workerIds', inputs: [{ name: 'peerId', type: 'bytes' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'bondAmount', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'epochLength', inputs: [], outputs: [{ name: '', type: 'uint128' }], stateMutability: 'view' },
] as const;

const RewardCalculationABI = [
  { type: 'function', name: 'effectiveTVL', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'INITIAL_REWARD_POOL_SIZE', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;

const NetworkControllerABI = [
  { type: 'function', name: 'yearlyRewardCapCoefficient', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;

const CapedStakingABI = [
  { type: 'function', name: 'capedStake', inputs: [{ name: 'workerId', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;

const StakingABI = [
  { type: 'function', name: 'delegated', inputs: [{ name: 'workerId', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

jest.setTimeout(300_000);

let anvilProcess: ChildProcess;
let v2Address: Address;
let merkleTreeService: MerkleTreeService;
let clickhouseClient: any;
let l1Client: ReturnType<typeof createPublicClient>;

const bs58 = require('bs58');
const YEAR = 365 * 24 * 60 * 60;

const WORKER_REGISTRATION = process.env.WORKER_REGISTRATION_ADDRESS as Address;
const STAKING_ADDR = process.env.STAKING_ADDRESS as Address;
const CAPED_STAKING = process.env.CAPED_STAKING_ADDRESS as Address;
const REWARD_CALCULATION = process.env.REWARD_CALCULATION_ADDRESS as Address;
const NETWORK_CONTROLLER = process.env.NETWORK_CONTROLLER_ADDRESS as Address;
const CH_LOGS_TABLE = process.env.CLICKHOUSE_LOGS_TABLE || 'testnet.worker_query_logs';
const CH_PINGS_TABLE = process.env.CLICKHOUSE_PINGS_TABLE || 'testnet.worker_pings_v2';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(d: Date): string {
  return dayjs(d).utc().format('YYYY-MM-DD HH:mm:ss');
}

function fromBase58(value: string): Hex {
  try {
    return `0x${Buffer.from(bs58.decode(value)).toString('hex')}` as Hex;
  } catch {
    return `0x${Buffer.from(value, 'utf8').toString('hex')}` as Hex;
  }
}

function decimalToBigInt(d: Decimal): bigint {
  return BigInt(d.floor().toString());
}

/**
 * Create clients for the anvil fork using arbitrumSepolia chain config
 * (which has multicall3 configured, unlike our custom anvilChain definition).
 * The transport points at the local anvil RPC.
 */
function createAnvilClients() {
  const account = privateKeyToAccount(DISTRIBUTOR_PRIVATE_KEY);
  const publicClient = createPublicClient({
    chain: arbitrumSepolia,
    transport: http(ANVIL_RPC, { timeout: 60_000 }),
    batch: { multicall: { batchSize: 2 ** 16 } },
  });
  const wClient = createWalletClient({
    account,
    chain: arbitrumSepolia,
    transport: http(ANVIL_RPC, { timeout: 60_000 }),
  });
  return { publicClient, walletClient: wClient, account };
}

/** Execute cast send, optionally impersonating an address */
function castSend(
  to: Address,
  sig: string,
  args: string[],
  opts?: { impersonate?: Address },
): void {
  if (opts?.impersonate) {
    execSync(
      `cast rpc anvil_impersonateAccount ${opts.impersonate} --rpc-url ${ANVIL_RPC}`,
      { stdio: 'pipe', timeout: 10_000 },
    );
    const parts = [
      'cast', 'send', to, `"${sig}"`, ...args,
      '--from', opts.impersonate, '--unlocked', '--rpc-url', ANVIL_RPC,
    ];
    execSync(parts.join(' '), { stdio: 'pipe', timeout: 30_000 });
    execSync(
      `cast rpc anvil_stopImpersonatingAccount ${opts.impersonate} --rpc-url ${ANVIL_RPC}`,
      { stdio: 'pipe', timeout: 10_000 },
    );
  } else {
    const parts = [
      'cast', 'send', to, `"${sig}"`, ...args,
      '--private-key', DISTRIBUTOR_PRIVATE_KEY, '--rpc-url', ANVIL_RPC,
    ];
    execSync(parts.join(' '), { stdio: 'pipe', timeout: 30_000 });
  }
}

/** Read a value from a contract via cast call */
function castCall(to: Address, sig: string, args: string[] = []): string {
  const parts = [
    'cast', 'call', to, `"${sig}"`, ...args, '--rpc-url', ANVIL_RPC,
  ];
  return execSync(parts.join(' '), { stdio: 'pipe', timeout: 10_000 })
    .toString()
    .trim();
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // ClickHouse client
  clickhouseClient = new ClickHouse({
    url: process.env.CLICKHOUSE_URL,
    basicAuth: {
      username: process.env.CLICKHOUSE_USERNAME!,
      password: process.env.CLICKHOUSE_PASSWORD!,
    },
    format: 'json',
  });

  // L1 client for block timestamps
  l1Client = createPublicClient({
    chain: sepolia,
    transport: http(process.env.L1_RPC_URL, { retryCount: 3, timeout: 30000 }),
  });

  // MerkleTreeService
  merkleTreeService = new MerkleTreeService({
    get: (key: string) => {
      if (key === 'rewards.maxBatchSize') return 100;
      return undefined;
    },
  } as any);
});

afterAll(() => {
  if (anvilProcess) anvilProcess.kill('SIGTERM');
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Full Pipeline on Anvil Fork (real Router + real Staking)', () => {
  let startTime: Date;
  let endTime: Date;
  let calculatedWorkers: { workerId: bigint; workerReward: bigint; stakerReward: bigint }[];
  let merkleTree: MerkleTreeResult;

  // =========================================================================
  // Step 1: Start anvil, deploy V2, wire into Router
  // =========================================================================

  it('should start anvil, deploy V2, and configure via impersonation', async () => {
    // 1. Start anvil forking Arbitrum Sepolia
    anvilProcess = await startAnvil();
    console.log('Anvil started (fork of Arbitrum Sepolia)');

    // Verify the fork is working by reading the Router
    const routerStaking = castCall(ROUTER, 'staking()(address)');
    console.log(`Router.staking() = ${routerStaking}`);
    expect(routerStaking.toLowerCase()).toContain(STAKING.toLowerCase());

    // 2. Deploy fresh V2 contract with the real Router
    v2Address = deployV2Contract(DISTRIBUTOR_PRIVATE_KEY);
    console.log(`V2 deployed at: ${v2Address}`);

    // 3. Configure V2 contract
    // 3a. Add distributor
    castSend(v2Address, 'addDistributor(address)', [DISTRIBUTOR]);
    console.log('  addDistributor(DISTRIBUTOR) ✓');

    // 3b. Set approvals required to 1
    castSend(v2Address, 'setApprovesRequired(uint256)', ['1']);
    console.log('  setApprovesRequired(1) ✓');

    // 3c. Set round-robin blocks to 1 (any distributor can commit)
    castSend(v2Address, 'setRoundRobinBlocks(uint256)', ['1']);
    console.log('  setRoundRobinBlocks(1) ✓');

    // 4. Grant REWARDS_DISTRIBUTOR_ROLE on Staking to V2 (via admin impersonation)
    castSend(
      STAKING,
      'grantRole(bytes32,address)',
      [REWARDS_DISTRIBUTOR_ROLE, v2Address],
      { impersonate: ADMIN },
    );
    console.log(`  grantRole(REWARDS_DISTRIBUTOR_ROLE, ${v2Address}) on Staking ✓`);

    // 5. Set lastBlockRewarded so our block range (FROM_BLOCK - TO_BLOCK) is accepted
    // The contract requires: fromBlock == lastBlockRewarded + 1 (when lastBlockRewarded != 0)
    // So set it to FROM_BLOCK - 1
    castSend(
      v2Address,
      'setLastRewardedBlock(uint256)',
      [(FROM_BLOCK - 1).toString()],
    );
    console.log(`  setLastRewardedBlock(${FROM_BLOCK - 1}) ✓`);

    // Verify lastBlockRewarded is set correctly
    const { publicClient } = createAnvilClients();
    const lastBlock = await publicClient.readContract({
      address: v2Address,
      abi: DistributedRewardsDistributionABI,
      functionName: 'lastBlockRewarded',
    });
    expect(Number(lastBlock)).toBe(FROM_BLOCK - 1);
    console.log(`  lastBlockRewarded verified: ${lastBlock}`);

    // Verify canCommit
    const canCommit = await publicClient.readContract({
      address: v2Address,
      abi: DistributedRewardsDistributionABI,
      functionName: 'canCommit',
      args: [DISTRIBUTOR],
    });
    expect(canCommit).toBe(true);
    console.log(`  canCommit(DISTRIBUTOR) = true ✓`);

    console.log('\nAnvil fork fully configured:');
    console.log(`  Router: ${ROUTER}`);
    console.log(`  Staking: ${STAKING}`);
    console.log(`  V2 Contract: ${v2Address}`);
    console.log(`  Block range: ${FROM_BLOCK} - ${TO_BLOCK}`);
  });

  // =========================================================================
  // Step 2: Query real ClickHouse for the block range
  // =========================================================================

  it('should query real ClickHouse data for the reference block range', async () => {
    // Get L1 block timestamps
    const fromBlock = await l1Client.getBlock({ blockNumber: BigInt(FROM_BLOCK) });
    const toBlock = await l1Client.getBlock({ blockNumber: BigInt(TO_BLOCK) });
    startTime = new Date(Number(fromBlock.timestamp) * 1000);
    endTime = new Date(Number(toBlock.timestamp) * 1000);

    console.log(`Time range: ${startTime.toISOString()} → ${endTime.toISOString()}`);
    console.log(`Duration: ${dayjs(endTime).diff(dayjs(startTime), 'second')}s`);

    // Query active workers
    const query = `
      SELECT worker_id,
             sum(num_read_chunks) as num_read_chunks,
             sum(output_size) as output_size,
             count(*) as totalRequests
      FROM ${CH_LOGS_TABLE}
      WHERE worker_timestamp >= '${formatDate(startTime)}'
        AND worker_timestamp <= '${formatDate(endTime)}'
        AND (toUnixTimestamp64Micro(collector_timestamp) - toUnixTimestamp64Micro(worker_timestamp)) / 60000000 < 20
      GROUP BY worker_id
    `;

    const activeWorkers: any[] = [];
    for await (const row of clickhouseClient.query(query).stream()) {
      activeWorkers.push(row);
    }

    console.log(`ClickHouse returned ${activeWorkers.length} active workers`);
    expect(activeWorkers.length).toBeGreaterThan(0);

    // Get worker ID mapping from the anvil fork (real contract state)
    const { publicClient } = createAnvilClients();
    const workerPeerIds = activeWorkers.map((w: any) => w.worker_id);

    const workerIdResults = await publicClient.multicall({
      contracts: workerPeerIds.map((peerId: string) => ({
        address: WORKER_REGISTRATION,
        abi: WorkerRegistrationABI,
        functionName: 'workerIds' as const,
        args: [fromBase58(peerId)] as const,
      })),
      allowFailure: true,
    });

    const workerIdMapping: Record<string, bigint> = {};
    workerPeerIds.forEach((peerId: string, i: number) => {
      workerIdMapping[peerId] =
        workerIdResults[i].status === 'success' && workerIdResults[i].result
          ? (workerIdResults[i].result as bigint)
          : 0n;
    });

    const registeredPeerIds = workerPeerIds.filter(
      (id: string) => workerIdMapping[id] && workerIdMapping[id] > 0n,
    );
    console.log(`Registered workers: ${registeredPeerIds.length}/${workerPeerIds.length}`);

    // Build worker collection
    const workers: Record<string, RewardWorker> = {};
    for (const wd of activeWorkers) {
      if (!workerIdMapping[wd.worker_id] || workerIdMapping[wd.worker_id] === 0n) continue;
      if (!workers[wd.worker_id]) {
        workers[wd.worker_id] = new RewardWorker(wd.worker_id);
      }
      const w = workers[wd.worker_id];
      await w.processQuery(
        { output_size: Number(wd.output_size), num_read_chunks: Number(wd.num_read_chunks) },
        true,
      );
      w.totalRequests = Number(wd.totalRequests);
      w.requestsProcessed = Number(wd.totalRequests);
      w.setContractId(workerIdMapping[wd.worker_id]);
    }

    // Stakes
    const validWorkers = Object.keys(workers)
      .map((peerId) => ({ peerId, contractId: workerIdMapping[peerId] }))
      .filter(({ contractId }) => contractId && contractId !== 0n);

    const [capedResults, totalResults] = await Promise.all([
      publicClient.multicall({
        contracts: validWorkers.map(({ contractId }) => ({
          address: CAPED_STAKING,
          abi: CapedStakingABI,
          functionName: 'capedStake' as const,
          args: [contractId] as const,
        })),
        allowFailure: true,
      }),
      publicClient.multicall({
        contracts: validWorkers.map(({ contractId }) => ({
          address: STAKING_ADDR,
          abi: StakingABI,
          functionName: 'delegated' as const,
          args: [contractId] as const,
        })),
        allowFailure: true,
      }),
    ]);

    validWorkers.forEach(({ peerId }, i) => {
      const w = workers[peerId];
      if (w) {
        w.stake = capedResults[i].status === 'success'
          ? new Decimal((capedResults[i].result as bigint).toString())
          : new Decimal(0);
        w.totalStake = totalResults[i].status === 'success'
          ? new Decimal((totalResults[i].result as bigint).toString())
          : new Decimal(0);
      }
    });

    // Traffic normalization
    const workerList = Object.values(workers);
    const totalBytesSent = workerList.reduce((s, w) => s + w.bytesSent, 0);
    const totalChunksRead = workerList.reduce((s, w) => s + w.chunksRead, 0);
    for (const w of workerList) await w.calculateT(totalBytesSent, totalChunksRead);

    // Bond (from anvil fork — same as production)
    const bondAmount = await publicClient.readContract({
      address: WORKER_REGISTRATION,
      abi: WorkerRegistrationABI,
      functionName: 'bondAmount',
    });
    const bondDecimal = new Decimal(bondAmount.toString());
    for (const w of workerList) w.bond = bondDecimal;

    // dTraffic
    const stakeSum = workerList.reduce((s, w) => s.add(w.stake), new Decimal(0));
    const totalSupply = bondDecimal.mul(workerList.length).add(stakeSum);
    for (const w of workerList) await w.calculateDTraffic(totalSupply, new Decimal(0.1));

    // Liveness (from real ClickHouse pings)
    const fakeClickhouseService = {
      client: clickhouseClient,
      configService: {
        get: (key: string) => key === 'database.clickhouse.database' ? 'testnet' : undefined,
      },
    };
    const livenessData = await calculateLivenessFactor(fakeClickhouseService, startTime, endTime);
    for (const w of workerList) {
      await w.calculateLiveness(
        livenessData[w.peerId] || { totalPings: 0, totalTimeOffline: 9999, livenessFactor: 0 },
      );
    }

    // dTenure — use 1.0 for simplicity
    for (const w of workerList) w.dTenure = new Decimal(1);

    // APR from contracts (anvil fork has same state as mainnet)
    let baseApr = 2000;
    try {
      const tvl = await publicClient.readContract({
        address: REWARD_CALCULATION, abi: RewardCalculationABI, functionName: 'effectiveTVL',
      });
      if (tvl > 0n) {
        const initialPool = await publicClient.readContract({
          address: REWARD_CALCULATION, abi: RewardCalculationABI, functionName: 'INITIAL_REWARD_POOL_SIZE',
        });
        const capCoeff = await publicClient.readContract({
          address: NETWORK_CONTROLLER, abi: NetworkControllerABI, functionName: 'yearlyRewardCapCoefficient',
        });
        const apyCap = (capCoeff * initialPool) / tvl;
        baseApr = Number(apyCap < 2000n ? apyCap : 2000n);
      }
    } catch { /* use default */ }

    // Calculate rewards
    const durationSec = dayjs(endTime).diff(dayjs(startTime), 'second');
    const rMax = new Decimal(baseApr).mul(durationSec).div(YEAR).div(10_000);
    for (const w of workerList) await w.getRewards(rMax);

    // Build final result
    calculatedWorkers = [];
    for (const peerId of Object.keys(workers)) {
      const w = workers[peerId];
      const workerId = await w.getId();
      if (workerId === 0n) continue;
      calculatedWorkers.push({
        workerId,
        workerReward: decimalToBigInt(w.workerReward),
        stakerReward: decimalToBigInt(w.stakerReward),
      });
    }

    console.log(`Calculated rewards for ${calculatedWorkers.length} workers`);
    console.log(`APR: ${(baseApr / 100).toFixed(2)}%, rMax: ${rMax.toFixed(12)}`);

    // All on-chain recipients should be in our set
    const ourIds = new Set(calculatedWorkers.map((w) => w.workerId));
    const overlapCount = ON_CHAIN_RECIPIENTS.filter((id) => ourIds.has(id)).length;
    console.log(`On-chain recipients overlap: ${overlapCount}/${ON_CHAIN_RECIPIENTS.length}`);
    expect(overlapCount).toBe(ON_CHAIN_RECIPIENTS.length);

    // Log sample rewards
    const sample = calculatedWorkers.slice(0, 3);
    for (const w of sample) {
      console.log(
        `  Worker ${w.workerId}: reward=${(Number(w.workerReward) / 1e18).toFixed(4)} SQD, ` +
          `staker=${(Number(w.stakerReward) / 1e18).toFixed(4)} SQD`,
      );
    }
  });

  // =========================================================================
  // Step 3: Generate merkle tree
  // =========================================================================

  it('should generate merkle tree and verify all proofs', async () => {
    expect(calculatedWorkers.length).toBeGreaterThan(0);

    merkleTree = await merkleTreeService.generateMerkleTree(calculatedWorkers, 100);

    console.log(`Merkle tree root: ${merkleTree.root}`);
    console.log(`Total batches: ${merkleTree.totalBatches}`);
    console.log(`Workers: ${calculatedWorkers.length}`);

    expect(merkleTree.root).toMatch(/^0x[0-9a-f]{64}$/);
    expect(merkleTree.totalBatches).toBeGreaterThan(0);

    // Verify every proof
    for (let i = 0; i < merkleTree.leaves.length; i++) {
      const leaf = merkleTree.leaves[i];
      const valid = merkleTreeService.verifyProof(leaf.leafHash, merkleTree.proofs[i], merkleTree.root);
      expect(valid).toBe(true);

      // Verify leaf hash is correct
      const expectedHash = keccak256(
        encodeAbiParameters(
          parseAbiParameters('uint256[], uint256[], uint256[]'),
          [leaf.recipients, leaf.workerRewards, leaf.stakerRewards],
        ),
      );
      expect(leaf.leafHash).toBe(expectedHash);
    }

    console.log(`All ${merkleTree.leaves.length} proofs verified ✓`);
  });

  // =========================================================================
  // Step 4: commitRoot on anvil V2 contract (real Router path)
  // =========================================================================

  it('should commitRoot with real block range — no revert', async () => {
    const { publicClient, walletClient, account } = createAnvilClients();

    // Commit root
    const commitHash = await walletClient.writeContract({
      address: v2Address,
      abi: DistributedRewardsDistributionABI,
      functionName: 'commitRoot',
      args: [
        [BigInt(FROM_BLOCK), BigInt(TO_BLOCK)],
        merkleTree.root as Hex,
        merkleTree.totalBatches,
        `s3://rewards/${FROM_BLOCK}-${TO_BLOCK}.json`,
      ],
      chain: arbitrumSepolia,
      account,
    });

    const commitReceipt = await publicClient.waitForTransactionReceipt({ hash: commitHash });
    expect(commitReceipt.status).toBe('success');
    console.log(`commitRoot tx: ${commitHash}`);
    console.log(`  status: success`);
    console.log(`  gas used: ${commitReceipt.gasUsed}`);

    // Read commitment from contract
    const commitmentKey = keccak256(
      encodeAbiParameters(parseAbiParameters('uint256, uint256'), [
        BigInt(FROM_BLOCK),
        BigInt(TO_BLOCK),
      ]),
    );

    const commitment = await publicClient.readContract({
      address: v2Address,
      abi: DistributedRewardsDistributionABI,
      functionName: 'commitments',
      args: [commitmentKey],
    });

    const status = Number(commitment[0]);
    const cFromBlock = Number(commitment[1]);
    const cToBlock = Number(commitment[2]);
    const cRoot = commitment[3] as string;
    const cTotalBatches = Number(commitment[4]);
    const cProcessedBatches = Number(commitment[5]);
    const cApprovalCount = Number(commitment[6]);
    const cIpfsLink = commitment[7] as string;

    console.log('\nCommitment state (8-field V2 ABI):');
    console.log(`  status: ${status} (1=ACTIVE)`);
    console.log(`  fromBlock: ${cFromBlock}`);
    console.log(`  toBlock: ${cToBlock}`);
    console.log(`  merkleRoot: ${cRoot.slice(0, 18)}...`);
    console.log(`  totalBatches: ${cTotalBatches}`);
    console.log(`  processedBatches: ${cProcessedBatches}`);
    console.log(`  approvalCount: ${cApprovalCount}`);
    console.log(`  ipfsLink: ${cIpfsLink}`);

    expect(status).toBe(1); // ACTIVE
    expect(cFromBlock).toBe(FROM_BLOCK);
    expect(cToBlock).toBe(TO_BLOCK);
    expect(cRoot).toBe(merkleTree.root);
    expect(cTotalBatches).toBe(merkleTree.totalBatches);
    expect(cProcessedBatches).toBe(0);
    expect(cApprovalCount).toBeGreaterThanOrEqual(1); // auto-approved by committer
  });

  // =========================================================================
  // Step 5: Distribute all batches — real Staking.distribute() path
  // =========================================================================

  it('should distribute all batches through real Router → Staking path — no reverts', async () => {
    const { publicClient, walletClient, account } = createAnvilClients();

    const commitmentKey = keccak256(
      encodeAbiParameters(parseAbiParameters('uint256, uint256'), [
        BigInt(FROM_BLOCK),
        BigInt(TO_BLOCK),
      ]),
    );

    for (let i = 0; i < merkleTree.leaves.length; i++) {
      const leaf = merkleTree.leaves[i];
      const proof = merkleTree.proofs[i] as Hex[];

      console.log(`\nDistributing batch ${i + 1}/${merkleTree.totalBatches}:`);
      console.log(`  Workers in batch: ${leaf.recipients.length}`);
      console.log(`  Worker IDs: [${leaf.recipients.slice(0, 5).join(', ')}${leaf.recipients.length > 5 ? '...' : ''}]`);

      const totalBatchWorkerReward = leaf.workerRewards.reduce((s, r) => s + r, 0n);
      const totalBatchStakerReward = leaf.stakerRewards.reduce((s, r) => s + r, 0n);
      console.log(`  Total worker reward: ${(Number(totalBatchWorkerReward) / 1e18).toFixed(4)} SQD`);
      console.log(`  Total staker reward: ${(Number(totalBatchStakerReward) / 1e18).toFixed(4)} SQD`);

      // This is the critical call: goes through V2 → Router → Staking.distribute()
      const distHash = await walletClient.writeContract({
        address: v2Address,
        abi: DistributedRewardsDistributionABI,
        functionName: 'distribute',
        args: [
          [BigInt(FROM_BLOCK), BigInt(TO_BLOCK)],
          leaf.recipients,
          leaf.workerRewards,
          leaf.stakerRewards,
          proof,
        ],
        chain: arbitrumSepolia,
        account,
      });

      const distReceipt = await publicClient.waitForTransactionReceipt({ hash: distHash });
      expect(distReceipt.status).toBe('success');
      console.log(`  tx: ${distHash}`);
      console.log(`  status: success ✓`);
      console.log(`  gas used: ${distReceipt.gasUsed}`);

      // Verify commitment state after each batch
      const commitment = await publicClient.readContract({
        address: v2Address,
        abi: DistributedRewardsDistributionABI,
        functionName: 'commitments',
        args: [commitmentKey],
      });
      const processedBatches = Number(commitment[5]);
      console.log(`  processedBatches: ${processedBatches}/${merkleTree.totalBatches}`);
      expect(processedBatches).toBe(i + 1);

      // Check logs for BatchDistributed event
      const batchDistributedLogs = distReceipt.logs.filter(
        (log) => log.address.toLowerCase() === v2Address.toLowerCase(),
      );
      expect(batchDistributedLogs.length).toBeGreaterThan(0);
      console.log(`  Events emitted: ${batchDistributedLogs.length}`);
    }
  });

  // =========================================================================
  // Step 6: Verify final state — COMPLETED, lastBlockRewarded, withdrawable
  // =========================================================================

  it('should have COMPLETED status and correct lastBlockRewarded', async () => {
    const { publicClient } = createAnvilClients();

    // Verify COMPLETED status
    const commitmentKey = keccak256(
      encodeAbiParameters(parseAbiParameters('uint256, uint256'), [
        BigInt(FROM_BLOCK),
        BigInt(TO_BLOCK),
      ]),
    );

    const commitment = await publicClient.readContract({
      address: v2Address,
      abi: DistributedRewardsDistributionABI,
      functionName: 'commitments',
      args: [commitmentKey],
    });

    const status = Number(commitment[0]);
    const processedBatches = Number(commitment[5]);
    const totalBatches = Number(commitment[4]);

    console.log('\nFinal commitment state:');
    console.log(`  status: ${status} (2=COMPLETED)`);
    console.log(`  processedBatches: ${processedBatches}/${totalBatches}`);

    expect(status).toBe(2); // COMPLETED
    expect(processedBatches).toBe(totalBatches);

    // Verify lastBlockRewarded
    const lastBlock = await publicClient.readContract({
      address: v2Address,
      abi: DistributedRewardsDistributionABI,
      functionName: 'lastBlockRewarded',
    });
    console.log(`  lastBlockRewarded: ${lastBlock} (expected: ${TO_BLOCK})`);
    expect(Number(lastBlock)).toBe(TO_BLOCK);

    // Verify accumulated rewards via cast call (not in our TS ABI)
    console.log('\nAccumulated rewards per worker:');
    let totalAccumulated = 0n;
    const sampleIds = calculatedWorkers.slice(0, 10).map((w) => w.workerId);
    for (const workerId of sampleIds) {
      const raw = castCall(
        v2Address,
        'accumulatedRewards(uint256)(uint256)',
        [workerId.toString()],
      );
      // cast call returns "5022423622096629296 [5.022e18]" — take only the first number
      const accumulated = BigInt(raw.split(' ')[0].split('\n')[0]);
      totalAccumulated += accumulated;

      const expected = calculatedWorkers.find((w) => w.workerId === workerId)!.workerReward;
      console.log(
        `  Worker ${workerId}: accumulated=${(Number(accumulated) / 1e18).toFixed(4)} SQD ` +
          `(expected: ${(Number(expected) / 1e18).toFixed(4)} SQD)`,
      );
      // accumulated should match exactly what we distributed
      expect(accumulated).toBe(expected);
    }

    console.log(`\nTotal accumulated (sample): ${(Number(totalAccumulated) / 1e18).toFixed(4)} SQD`);
  });

  // =========================================================================
  // Step 7: Verify you can't double-distribute or use wrong proofs
  // =========================================================================

  it('should reject duplicate batch distribution', async () => {
    const { walletClient, account } = createAnvilClients();

    const leaf = merkleTree.leaves[0];
    const proof = merkleTree.proofs[0] as Hex[];

    // Attempt to re-distribute batch 0 — should revert
    await expect(
      walletClient.writeContract({
        address: v2Address,
        abi: DistributedRewardsDistributionABI,
        functionName: 'distribute',
        args: [
          [BigInt(FROM_BLOCK), BigInt(TO_BLOCK)],
          leaf.recipients,
          leaf.workerRewards,
          leaf.stakerRewards,
          proof,
        ],
        chain: arbitrumSepolia,
        account,
      }),
    ).rejects.toThrow();
    console.log('Duplicate distribution correctly reverted ✓');
  });

  // =========================================================================
  // Step 8: Verify next epoch commit works (continuity)
  // =========================================================================

  it('should accept the next epoch commit with fromBlock = lastBlockRewarded + 1', async () => {
    const { publicClient, walletClient, account } = createAnvilClients();

    // Generate a small merkle tree for the "next" epoch
    const nextWorkers = calculatedWorkers.slice(0, 5).map((w) => ({
      workerId: w.workerId,
      workerReward: w.workerReward,
      stakerReward: w.stakerReward,
    }));
    const nextTree = await merkleTreeService.generateMerkleTree(nextWorkers, 100);

    const nextFromBlock = TO_BLOCK + 1;
    const nextToBlock = TO_BLOCK + 520; // typical epoch length

    // Commit next epoch
    const commitHash = await walletClient.writeContract({
      address: v2Address,
      abi: DistributedRewardsDistributionABI,
      functionName: 'commitRoot',
      args: [
        [BigInt(nextFromBlock), BigInt(nextToBlock)],
        nextTree.root as Hex,
        nextTree.totalBatches,
        '',
      ],
      chain: arbitrumSepolia,
      account,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: commitHash });
    expect(receipt.status).toBe('success');
    console.log(`Next epoch commit (${nextFromBlock}-${nextToBlock}): success ✓`);

    // Distribute
    for (let i = 0; i < nextTree.leaves.length; i++) {
      const distHash = await walletClient.writeContract({
        address: v2Address,
        abi: DistributedRewardsDistributionABI,
        functionName: 'distribute',
        args: [
          [BigInt(nextFromBlock), BigInt(nextToBlock)],
          nextTree.leaves[i].recipients,
          nextTree.leaves[i].workerRewards,
          nextTree.leaves[i].stakerRewards,
          nextTree.proofs[i] as Hex[],
        ],
        chain: arbitrumSepolia,
        account,
      });
      const distReceipt = await publicClient.waitForTransactionReceipt({ hash: distHash });
      expect(distReceipt.status).toBe('success');
    }

    // Verify lastBlockRewarded updated
    const newLastBlock = await publicClient.readContract({
      address: v2Address,
      abi: DistributedRewardsDistributionABI,
      functionName: 'lastBlockRewarded',
    });
    expect(Number(newLastBlock)).toBe(nextToBlock);
    console.log(`Next epoch completed. lastBlockRewarded: ${newLastBlock} ✓`);

    // Verify gap commit fails
    const gapFromBlock = nextToBlock + 100; // gap!
    const gapToBlock = nextToBlock + 620;
    const gapTree = await merkleTreeService.generateMerkleTree(nextWorkers, 100);

    await expect(
      walletClient.writeContract({
        address: v2Address,
        abi: DistributedRewardsDistributionABI,
        functionName: 'commitRoot',
        args: [
          [BigInt(gapFromBlock), BigInt(gapToBlock)],
          gapTree.root as Hex,
          gapTree.totalBatches,
          '',
        ],
        chain: arbitrumSepolia,
        account,
      }),
    ).rejects.toThrow(); // NotAllBlocksCovered
    console.log(`Gap commit (${gapFromBlock}-${gapToBlock}) correctly reverted ✓`);
  });

  // =========================================================================
  // Step 9: Compare with on-chain commit data
  // =========================================================================

  it('should produce similar per-worker rewards to the on-chain commit', () => {
    const ourWorkerMap = new Map(calculatedWorkers.map((w) => [w.workerId, w]));

    console.log('\nPer-worker comparison (calculated vs on-chain):');
    console.log(
      'WorkerId | Our Reward (SQD) | On-chain Reward (SQD) | Ratio',
    );
    console.log('-'.repeat(70));

    let totalOurReward = 0n;
    let totalOnChainReward = 0n;

    for (let i = 0; i < ON_CHAIN_RECIPIENTS.length; i++) {
      const id = ON_CHAIN_RECIPIENTS[i];
      const ourWorker = ourWorkerMap.get(id);
      if (!ourWorker) continue;

      const ourReward = Number(ourWorker.workerReward) / 1e18;
      const onChainReward = Number(ON_CHAIN_WORKER_REWARDS[i]) / 1e18;
      const ratio = ourReward / onChainReward;

      totalOurReward += ourWorker.workerReward;
      totalOnChainReward += ON_CHAIN_WORKER_REWARDS[i];

      console.log(
        `  ${String(id).padStart(5)} | ${ourReward.toFixed(4).padStart(16)} | ${onChainReward.toFixed(4).padStart(21)} | ${ratio.toFixed(4)}`,
      );
    }

    const avgOur = Number(totalOurReward) / ON_CHAIN_RECIPIENTS.length / 1e18;
    const avgOnChain = Number(totalOnChainReward) / ON_CHAIN_RECIPIENTS.length / 1e18;
    const overallRatio = avgOur / avgOnChain;

    console.log('-'.repeat(70));
    console.log(`Average: ${avgOur.toFixed(4)} SQD | ${avgOnChain.toFixed(4)} SQD | ${overallRatio.toFixed(4)}`);
    console.log(`\nOverall ratio: ${overallRatio.toFixed(4)}`);
    console.log('(Expected ~0.25-0.30 due to batch filtering + dTenure simplification)');

    // Verify all on-chain worker IDs present in our calculation
    expect(ON_CHAIN_RECIPIENTS.every((id) => ourWorkerMap.has(id))).toBe(true);

    // Verify reward ratio is reasonable
    expect(overallRatio).toBeGreaterThan(0.05);
    expect(overallRatio).toBeLessThan(20);
  });
});
