// Quarterly testnet (tethys) worker rewards: squid query -> normalization -> merkle tree -> cdn files.
//
//   bun scripts/testnet-rewards.ts build --quarter 2026-Q3 [--from YYYY-MM-DD --to YYYY-MM-DD]
//       [--price 0.0357] [--target-usd 225] [--workers 25] [--from-csv file.csv] [--allow-incomplete]
//   bun scripts/testnet-rewards.ts publish --quarter 2026-Q3 --contract 0x... --cdn-dir ~/dev/subsquid/cdn
//
// See the "Testnet rewards" section of the package README for the full quarterly procedure.

import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { SQL } from "bun";
import { ethers, utils } from "ethers";
import fs from "fs";
import os from "os";
import path from "path";
import { parseArgs } from "util";

const CHAIN_ID = 42161;
const RPC_URL = "https://arb1.arbitrum.io/rpc";
const SQD_TOKEN = "0x1337420dED5ADb9980CFc35f8f2B054ea86f8aB1";
const DISTRIBUTOR_OWNER = "0x24B97D7eE13Abc7c1fc109Ea66CabdcBe3ADe1a7";
const LEAF_ENCODING = ["uint32", "address", "uint256"];
const DEFAULT_WORKERS = "25";
const DEFAULT_TARGET_USD = "225";
const COINGECKO_COIN_ID = "subsquid";

const PACKAGE_DIR = path.resolve(import.meta.dir, "..");
const DATA_DIR = path.join(PACKAGE_DIR, "airdrop-data");
const WEI = 10n ** 18n;

type Leaf = [number, string, string];

interface Summary {
  label: string;
  chainId: number;
  token: string;
  periodStart: string;
  periodEnd: string;
  periodEndExclusive: string;
  source: string;
  params: {
    workers: string | null;
    targetUsd: string | null;
    price: string | null;
    priceSource: string | null;
  };
  testnetRewardTotal: string | null;
  wallets: number;
  total: string;
  totalSqd: string;
  root: string;
  generatedAt: string;
}

function fail(message: string): never {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}

function warn(message: string) {
  console.warn(`WARNING: ${message}`);
}

// ---------- dates ----------

function parseDay(value: string, flag: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`${flag} must be YYYY-MM-DD, got "${value}"`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || formatDay(date) !== value) fail(`${flag} is not a valid date: "${value}"`);
  return date;
}

function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function quarterBounds(quarter: string): { from: Date; to: Date } {
  const match = /^(\d{4})-Q([1-4])$/.exec(quarter);
  if (!match) fail(`--quarter must look like 2026-Q3, got "${quarter}"`);
  const year = Number(match[1]);
  const q = Number(match[2]);
  // Exclusive end: first day of the next quarter, so the last day of the quarter is included.
  return { from: new Date(Date.UTC(year, (q - 1) * 3, 1)), to: new Date(Date.UTC(year, q * 3, 1)) };
}

function previousQuarter(quarter: string): string | null {
  const match = /^(\d{4})-Q([1-4])$/.exec(quarter);
  if (!match) return null;
  const year = Number(match[1]);
  const q = Number(match[2]);
  return q === 1 ? `${year - 1}-Q4` : `${year}-Q${q - 1}`;
}

// ---------- exact decimal math ----------

interface Fraction {
  num: bigint;
  den: bigint;
}

function parseDecimal(value: string, what: string): Fraction {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) fail(`${what} must be a non-negative decimal number, got "${value}"`);
  const fraction = match[2] ?? "";
  return { num: BigInt(match[1] + fraction), den: 10n ** BigInt(fraction.length) };
}

function formatSqd(wei: bigint): string {
  const whole = wei / WEI;
  const frac = (wei % WEI).toString().padStart(18, "0").replace(/0+$/, "");
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${wholeStr}.${frac}` : wholeStr;
}

function formatSqdShort(wei: bigint): string {
  const [whole, frac = ""] = formatSqd(wei).split(".");
  return `${whole}.${frac.padEnd(2, "0").slice(0, 2)}`;
}

// amount_i = wallet_i * workers * targetUsd / (sum_all * price), in wei, rounded down.
// Same formula as the old fetch-rewards-from-testnet-squid.sh, without the floating point.
function normalize(
  rewards: [string, bigint][],
  workers: Fraction,
  targetUsd: Fraction,
  price: Fraction,
): [string, bigint][] {
  const sumAll = rewards.reduce((acc, [, amount]) => acc + amount, 0n);
  if (sumAll === 0n) fail("sum of all testnet rewards in the period is zero");
  if (price.num === 0n) fail("price must be positive");
  const num = workers.num * targetUsd.num * price.den * WEI;
  const den = workers.den * targetUsd.den * price.num * sumAll;
  return rewards.map(([wallet, amount]) => [wallet, (amount * num) / den]);
}

// ---------- validation ----------

function normalizeAddress(value: string, where: string): string {
  const trimmed = value.trim();
  if (!utils.isAddress(trimmed)) fail(`invalid address "${value}" (${where})`);
  const lower = trimmed.toLowerCase();
  if (lower === ethers.constants.AddressZero) fail(`zero address (${where})`);
  return lower;
}

function rejectDuplicates(wallets: string[]) {
  const seen = new Set<string>();
  for (const wallet of wallets) {
    if (seen.has(wallet)) fail(`duplicate wallet ${wallet}`);
    seen.add(wallet);
  }
}

// ---------- sources ----------

async function fetchSquidRewards(from: Date, to: Date, allowIncomplete: boolean): Promise<[string, bigint][]> {
  const url = process.env.TESTNET_SQUID_PG_URL;
  if (!url) {
    fail(
      "TESTNET_SQUID_PG_URL is not set. Get the read-only URI of the subsquid-network-testnet squid with\n" +
        "  sqd view -o subsquid -n subsquid-network-testnet -t prod --json --no-interactive | jq -r '.addons.postgres.connections[] | select(.type==\"read\") | .uri'",
    );
  }
  const sql = new SQL(url);
  try {
    const [head] = await sql`select max(timestamp) as head from block`;
    const headTime = head?.head ? new Date(head.head) : null;
    console.log(`Squid indexed up to: ${headTime?.toISOString() ?? "nothing"}`);
    if (!headTime || headTime < to) {
      const msg = `the squid has only indexed up to ${headTime?.toISOString() ?? "nothing"}, before the period end ${to.toISOString()}; rewards would be incomplete`;
      if (!allowIncomplete) fail(`${msg}. Wait for the squid to catch up, or pass --allow-incomplete.`);
      warn(msg);
    }

    // Same semantics as the old shell script: worker_reward joined to worker, summed per real owner,
    // timestamp >= from and < to.
    const rows: { wallet: string | null; total: string }[] = await sql`
      select w.real_owner_id as wallet, sum(r.amount)::text as total
      from worker_reward r
      join worker w on w.id = r.worker_id
      where r.timestamp >= ${from.toISOString()}::timestamptz
        and r.timestamp < ${to.toISOString()}::timestamptz
      group by w.real_owner_id
    `;
    return rows.map((row): [string, bigint] => {
      if (!row.wallet) fail(`a worker with rewards has no real_owner_id (total ${row.total})`);
      if (!/^\d+$/.test(row.total)) fail(`non-integer reward total "${row.total}" for ${row.wallet}`);
      return [normalizeAddress(row.wallet, "squid real_owner_id"), BigInt(row.total)];
    });
  } finally {
    await sql.close();
  }
}

type CsvInput = { kind: "raw"; rows: [string, bigint][] } | { kind: "final"; rows: [string, bigint][] };

// Accepts either the old normalized output (wallet,normalized_sqd_reward; SQD decimals, with or
// without header) or the raw per-wallet testnet totals (wallet,total_reward; wei integers).
// Row order is preserved so old trees can be reproduced exactly.
function readCsv(file: string): CsvInput {
  const lines = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) fail(`${file} is empty`);
  let kind: "raw" | "final" = "final";
  if (!utils.isAddress(lines[0].split(",")[0].trim())) {
    const header = lines.shift()!.split(",").map((h) => h.trim());
    if (header.length !== 2) fail(`${file}: expected 2 columns, got header "${header.join(",")}"`);
    if (header[1] === "total_reward") kind = "raw";
    else if (header[1] !== "normalized_sqd_reward") fail(`${file}: unknown amount column "${header[1]}"`);
  }
  const rows = lines.map((line, i): [string, bigint] => {
    const parts = line.split(",");
    if (parts.length !== 2) fail(`${file}: expected 2 columns on data line ${i + 1}: "${line}"`);
    const wallet = normalizeAddress(parts[0], `${file} data line ${i + 1}`);
    const value = parts[1].trim();
    if (kind === "raw") {
      if (!/^\d+$/.test(value)) fail(`${file}: non-integer reward "${value}" on data line ${i + 1}`);
      return [wallet, BigInt(value)];
    }
    if (!/^\d+(\.\d{1,18})?$/.test(value)) fail(`${file}: invalid SQD amount "${value}" on data line ${i + 1}`);
    return [wallet, utils.parseEther(value).toBigInt()];
  });
  return { kind, rows };
}

async function fetchAveragePrice(from: Date, to: Date): Promise<{ price: string; source: string }> {
  if (to.getTime() > Date.now()) fail("the period has not ended yet; pass --price explicitly if you really mean it");
  const fromTs = Math.floor(from.getTime() / 1000);
  const toTs = Math.floor(to.getTime() / 1000);
  const url = `https://api.coingecko.com/api/v3/coins/${COINGECKO_COIN_ID}/market_chart/range?vs_currency=usd&from=${fromTs}&to=${toTs}`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (process.env.COINGECKO_API_KEY) headers["x-cg-demo-api-key"] = process.env.COINGECKO_API_KEY;
  const res = await fetch(url, { headers });
  const body: any = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(body?.prices)) {
    fail(
      `CoinGecko price request failed (HTTP ${res.status}): ${JSON.stringify(body?.error ?? body)}\n` +
        "The keyless API only covers the last 365 days. Set COINGECKO_API_KEY (demo key) or pass --price.",
    );
  }
  const prices: number[] = body.prices.map((p: [number, number]) => p[1]);
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000);
  if (prices.length < days - 1) warn(`CoinGecko returned only ${prices.length} samples for a ${days}-day period`);
  if (prices.length === 0) fail("CoinGecko returned no prices for the period");
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  return {
    price: avg.toFixed(6),
    source: `CoinGecko ${COINGECKO_COIN_ID}/usd mean of ${prices.length} daily samples, ${formatDay(from)} to ${formatDay(to)} (exclusive), rounded to 6 decimals from ${avg}`,
  };
}

// ---------- build ----------

async function build(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      quarter: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      price: { type: "string" },
      "target-usd": { type: "string" },
      workers: { type: "string" },
      "from-csv": { type: "string" },
      "allow-incomplete": { type: "boolean", default: false },
    },
    strict: true,
  });

  let from: Date;
  let to: Date;
  if (values.quarter) ({ from, to } = quarterBounds(values.quarter));
  if (values.from) from = parseDay(values.from, "--from");
  if (values.to) to = parseDay(values.to, "--to");
  // @ts-ignore definite assignment is checked right here
  if (!from || !to) fail("pass --quarter, or both --from and --to (exclusive end)");
  if (from >= to) fail("--from must be before --to");
  const label = values.quarter ?? `${formatDay(from)}_${formatDay(to)}`;
  const quarterDefault = values.quarter ? quarterBounds(values.quarter) : null;
  if (quarterDefault && (quarterDefault.from.getTime() !== from.getTime() || quarterDefault.to.getTime() !== to.getTime())) {
    warn(`period ${formatDay(from)}..${formatDay(to)} (exclusive) differs from the calendar bounds of ${values.quarter}`);
  }

  console.log(`Period: ${formatDay(from)} to ${formatDay(addDays(to, -1))} inclusive (timestamp >= ${from.toISOString()} and < ${to.toISOString()})`);

  const workers = values.workers ?? DEFAULT_WORKERS;
  const targetUsd = values["target-usd"] ?? DEFAULT_TARGET_USD;
  let price: string | null = values.price ?? null;
  let priceSource: string | null = values.price ? "--price" : null;
  let testnetRewardTotal: bigint | null = null;
  let source: string;
  let allocations: [string, bigint][];

  let raw: [string, bigint][] | null = null;
  if (values["from-csv"]) {
    const file = path.resolve(values["from-csv"]);
    const csv = readCsv(file);
    source = `csv:${path.basename(file)}`;
    if (csv.kind === "raw") raw = csv.rows;
    else {
      console.log(`Using final SQD amounts from ${file} as-is (no normalization).`);
      if (values.price || values.workers || values["target-usd"]) warn("--price/--workers/--target-usd are ignored for a normalized CSV");
      price = priceSource = null;
      rejectDuplicates(csv.rows.map(([w]) => w));
      allocations = csv.rows;
    }
  } else {
    source = "squid:subsquid-network-testnet";
    if (to.getTime() > Date.now() && !values["allow-incomplete"]) fail(`the period has not ended yet (last day ${formatDay(addDays(to, -1))})`);
    raw =await fetchSquidRewards(from, to, values["allow-incomplete"]!);
    // Deterministic leaf order for fresh builds.
    raw.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  if (raw) {
    rejectDuplicates(raw.map(([w]) => w));
    const dropped = raw.filter(([, amount]) => amount === 0n);
    if (dropped.length) warn(`dropping ${dropped.length} wallet(s) with zero testnet rewards: ${dropped.map(([w]) => w).join(", ")}`);
    raw = raw.filter(([, amount]) => amount > 0n);
    testnetRewardTotal = raw.reduce((acc, [, a]) => acc + a, 0n);
    if (!price) ({ price, source: priceSource } = await fetchAveragePrice(from, to));
    console.log(`SQD price: $${price} (${priceSource})`);
    console.log(`Target: ${workers} workers x $${targetUsd}`);
    allocations = normalize(
      raw,
      parseDecimal(workers, "--workers"),
      parseDecimal(targetUsd, "--target-usd"),
      parseDecimal(price, "--price"),
    );
  }

  allocations = allocations!.filter(([wallet, amount]) => {
    if (amount === 0n) warn(`dropping ${wallet}: allocation rounds to 0 wei`);
    return amount > 0n;
  });
  if (allocations.length === 0) fail("no wallets to reward");

  const leaves: Leaf[] = allocations.map(([wallet, amount], i) => [i + 1, wallet, amount.toString()]);
  const total = allocations.reduce((acc, [, amount]) => acc + amount, 0n);
  const tree = StandardMerkleTree.of(leaves, LEAF_ENCODING);

  const outDir = path.join(DATA_DIR, label);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "rewards.csv"),
    ["index,wallet,amount_wei,amount_sqd", ...leaves.map(([i, w, a]) => `${i},${w},${a},${formatSqd(BigInt(a)).replace(/,/g, "")}`)].join("\n") + "\n",
  );
  fs.writeFileSync(path.join(outDir, "tree.json"), JSON.stringify(tree.dump()));
  const summary: Summary = {
    label,
    chainId: CHAIN_ID,
    token: SQD_TOKEN,
    periodStart: formatDay(from),
    periodEnd: formatDay(addDays(to, -1)),
    periodEndExclusive: formatDay(to),
    source,
    params: { workers: raw ? workers : null, targetUsd: raw ? targetUsd : null, price, priceSource },
    testnetRewardTotal: testnetRewardTotal?.toString() ?? null,
    wallets: leaves.length,
    total: total.toString(),
    totalSqd: formatSqd(total).replace(/,/g, ""),
    root: tree.root,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");

  console.log(`\nWrote ${path.relative(process.cwd(), outDir)}/{rewards.csv,tree.json,summary.json}`);
  console.log(`Wallets: ${leaves.length}`);
  console.log(`Total:   ${formatSqd(total)} SQD (${total} wei)`);
  console.log(`Root:    ${tree.root}`);

  compareWithPrevious(label, summary, leaves);

  const relPkg = path.relative(process.cwd(), PACKAGE_DIR) || ".";
  console.log(`
Next steps (run from ${relPkg}; nothing has been broadcast):

1. Deploy the distributor on Arbitrum One and verify it on Sourcify:
   forge create src/MerkleDistributor.sol:MerkleDistributor \\
     --rpc-url ${RPC_URL} --account sqd-ops --broadcast \\
     --verify --verifier sourcify \\
     --constructor-args ${SQD_TOKEN} ${tree.root} ${DISTRIBUTOR_OWNER}
   # if verification fails, retry it on its own:
   # forge verify-contract <CONTRACT> src/MerkleDistributor.sol:MerkleDistributor --chain ${CHAIN_ID} --verifier sourcify \\
   #   --constructor-args $(cast abi-encode "constructor(address,bytes32,address)" ${SQD_TOKEN} ${tree.root} ${DISTRIBUTOR_OWNER})

2. Fund it with the total (${formatSqd(total)} SQD):
   cast send ${SQD_TOKEN} "transfer(address,uint256)" <CONTRACT> ${total} \\
     --rpc-url ${RPC_URL} --account sqd-ops

3. Check the contract and write the cdn files:
   bun scripts/testnet-rewards.ts publish --quarter ${label} --contract <CONTRACT> --cdn-dir ~/dev/subsquid/cdn`);
}

function compareWithPrevious(label: string, summary: Summary, leaves: Leaf[]) {
  const prev = previousQuarter(label);
  const prevDir = prev ? path.join(DATA_DIR, prev) : null;
  if (!prev || !prevDir || !fs.existsSync(path.join(prevDir, "summary.json"))) {
    console.log(`\nNo previous quarter data${prev ? ` (airdrop-data/${prev}/summary.json)` : ""} to compare with.`);
    return;
  }
  const prevSummary: Summary = JSON.parse(fs.readFileSync(path.join(prevDir, "summary.json"), "utf8"));
  const prevTree = StandardMerkleTree.load<Leaf>(JSON.parse(fs.readFileSync(path.join(prevDir, "tree.json"), "utf8")));
  const prevWallets = new Map<string, bigint>();
  for (const [, [, wallet, amount]] of prevTree.entries()) prevWallets.set(wallet.toLowerCase(), BigInt(amount));
  const curWallets = new Map(leaves.map(([, w, a]) => [w, BigInt(a)]));
  const added = [...curWallets.keys()].filter((w) => !prevWallets.has(w));
  const removed = [...prevWallets.keys()].filter((w) => !curWallets.has(w));
  const prevTotal = BigInt(prevSummary.total);
  const curTotal = BigInt(summary.total);
  const pct = prevTotal === 0n ? "n/a" : `${(Number(((curTotal - prevTotal) * 10000n) / prevTotal) / 100).toFixed(2)}%`;
  console.log(`\nCompared with ${prev} (root ${prevSummary.root}):`);
  console.log(`  total:   ${formatSqdShort(prevTotal)} -> ${formatSqdShort(curTotal)} SQD (${pct})`);
  console.log(`  wallets: ${prevSummary.wallets} -> ${summary.wallets} (+${added.length} new, -${removed.length} gone)`);
  console.log(`  price:   ${prevSummary.params.price ?? "n/a"} -> ${summary.params.price ?? "n/a"}`);
  for (const w of added) console.log(`  new:  ${w} ${formatSqdShort(curWallets.get(w)!)}`);
  for (const w of removed) console.log(`  gone: ${w} (had ${formatSqdShort(prevWallets.get(w)!)})`);
}

// ---------- publish ----------

const DISTRIBUTOR_ABI = [
  "function merkleRoot() view returns (bytes32)",
  "function token() view returns (address)",
  "function owner() view returns (address)",
  "function isClaimed(uint256 index) view returns (bool)",
];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

async function publish(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      quarter: { type: "string" },
      contract: { type: "string" },
      "cdn-dir": { type: "string" },
      "rpc-url": { type: "string", default: process.env.ARBITRUM_RPC_URL ?? RPC_URL },
      force: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (!values.quarter || !values.contract || !values["cdn-dir"]) fail("publish needs --quarter, --contract and --cdn-dir");
  if (!utils.isAddress(values.contract)) fail(`--contract is not an address: ${values.contract}`);
  const contractAddress = utils.getAddress(values.contract);
  const cdnDir = path.resolve(expandHome(values["cdn-dir"]));
  if (!fs.existsSync(path.join(cdnDir, "src", "points"))) fail(`${cdnDir} does not look like the cdn repo (no src/points)`);

  const dir = path.join(DATA_DIR, values.quarter);
  if (!fs.existsSync(path.join(dir, "summary.json"))) fail(`no build output in ${dir}; run build first`);
  const summary: Summary = JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf8"));
  const treeRaw = fs.readFileSync(path.join(dir, "tree.json"), "utf8");
  const treeDump = JSON.parse(treeRaw);
  const tree = StandardMerkleTree.load<Leaf>(treeDump);
  tree.validate();
  if (JSON.stringify(treeDump.leafEncoding) !== JSON.stringify(LEAF_ENCODING)) fail(`unexpected leaf encoding ${treeDump.leafEncoding}`);
  const leaves = [...tree.entries()].map(([, leaf]) => leaf);
  const total = leaves.reduce((acc, [, , amount]) => acc + BigInt(amount), 0n);
  if (tree.root !== summary.root) fail(`tree.json root ${tree.root} != summary.json root ${summary.root}`);
  if (total.toString() !== summary.total) fail(`tree.json total ${total} != summary.json total ${summary.total}`);
  console.log(`Local ${values.quarter}: root ${tree.root}, ${leaves.length} wallets, total ${formatSqd(total)} SQD`);

  const provider = new ethers.providers.StaticJsonRpcProvider(values["rpc-url"]);
  const { chainId } = await provider.getNetwork();
  if (chainId !== CHAIN_ID) fail(`RPC ${values["rpc-url"]} is chain ${chainId}, expected ${CHAIN_ID}`);
  if ((await provider.getCode(contractAddress)) === "0x") fail(`no contract deployed at ${contractAddress} on chain ${CHAIN_ID}`);

  const distributor = new ethers.Contract(contractAddress, DISTRIBUTOR_ABI, provider);
  const [onchainRoot, onchainToken, onchainOwner]: [string, string, string] = await Promise.all([
    distributor.merkleRoot(),
    distributor.token(),
    distributor.owner(),
  ]);
  const problems: string[] = [];
  if (onchainRoot.toLowerCase() !== tree.root.toLowerCase()) problems.push(`merkleRoot() is ${onchainRoot}, local tree root is ${tree.root}`);
  if (utils.getAddress(onchainToken) !== SQD_TOKEN) problems.push(`token() is ${onchainToken}, expected SQD ${SQD_TOKEN}`);
  if (problems.length) fail(`contract ${contractAddress} does not match ${values.quarter}:\n  - ${problems.join("\n  - ")}`);
  console.log(`On-chain merkleRoot() matches, token() is SQD.`);
  if (utils.getAddress(onchainOwner) !== DISTRIBUTOR_OWNER) warn(`owner() is ${onchainOwner}, not the usual ${DISTRIBUTOR_OWNER}`);

  const sqd = new ethers.Contract(SQD_TOKEN, ERC20_ABI, provider);
  const balance: bigint = (await sqd.balanceOf(contractAddress)).toBigInt();
  if (balance >= total) {
    console.log(`Funded: balance ${formatSqd(balance)} SQD >= total ${formatSqd(total)} SQD.`);
  } else {
    // Re-publishing after some claims: the balance only has to cover what is still unclaimed.
    const claimed = await Promise.all(leaves.map(([index]) => distributor.isClaimed(index) as Promise<boolean>));
    const unclaimed = leaves.reduce((acc, [, , amount], i) => (claimed[i] ? acc : acc + BigInt(amount)), 0n);
    const claimedCount = claimed.filter(Boolean).length;
    if (balance < unclaimed) {
      fail(
        `contract is underfunded: balance ${formatSqd(balance)} SQD < ${formatSqd(unclaimed)} SQD still claimable ` +
          `(${claimedCount}/${leaves.length} claimed). Fund it with:\n` +
          `  cast send ${SQD_TOKEN} "transfer(address,uint256)" ${contractAddress} ${unclaimed - balance} --rpc-url ${RPC_URL} --account sqd-ops`,
      );
    }
    warn(
      `balance ${formatSqd(balance)} SQD is below the total ${formatSqd(total)} SQD, but ${claimedCount}/${leaves.length} leaves ` +
        `are already claimed and the balance covers the ${formatSqd(unclaimed)} SQD still claimable. OK for a re-publish.`,
    );
  }

  const currentPath = path.join(cdnDir, "src", "points", "testnet-rewards", "current.json");
  const archivePath = path.join(cdnDir, "src", "points", `${contractAddress}.json`);
  const current = {
    version: 1,
    chainId: CHAIN_ID,
    contract: contractAddress,
    token: SQD_TOKEN,
    periodStart: summary.periodStart,
    periodEnd: summary.periodEnd,
    total: total.toString(),
    tree: treeDump,
  };
  if (fs.existsSync(archivePath) && fs.readFileSync(archivePath, "utf8").trim() !== treeRaw.trim() && !values.force) {
    fail(`${archivePath} already exists with different content; pass --force to overwrite`);
  }
  fs.mkdirSync(path.dirname(currentPath), { recursive: true });
  fs.writeFileSync(currentPath, JSON.stringify(current) + "\n");
  fs.writeFileSync(archivePath, treeRaw);
  console.log(`\nWrote:\n  ${currentPath}\n  ${archivePath}`);

  const rel = (p: string) => path.relative(cdnDir, p);
  const branch = `testnet-rewards-${values.quarter}`;
  console.log(`
Open the cdn PR (not done automatically):
  cd ${cdnDir}
  git switch -c ${branch}
  git add ${rel(currentPath)} ${rel(archivePath)}
  git commit -m "Add testnet rewards for ${values.quarter} (${contractAddress})"
  git push -u origin ${branch}
  gh pr create --fill --base main`);
}

// ---------- main ----------

const [command, ...rest] = process.argv.slice(2);
if (command === "build") await build(rest);
else if (command === "publish") await publish(rest);
else {
  console.error("usage: bun scripts/testnet-rewards.ts <build|publish> [options]  (see the header of this file)");
  process.exit(1);
}
