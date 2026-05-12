import {
  formatUnits,
  parseAbi,
  zeroAddress,
  type Address,
} from "viem";
import promClient from "prom-client";
import { client } from "./client.js";

const portalRegistryAddress = (process.env.PORTAL_REGISTRY ?? "").trim() as
  | Address
  | "";

const portalOperators = (process.env.PORTAL_OPERATORS ?? "")
  .split(",")
  .map((a) => a.trim().toLowerCase())
  .filter(Boolean);

if (portalRegistryAddress && portalOperators.length === 0) {
  throw new Error(
    "PORTAL_REGISTRY is set but PORTAL_OPERATORS is empty. Set PORTAL_OPERATORS to a comma-separated list of operator addresses to monitor.",
  );
}
if (!portalRegistryAddress && portalOperators.length > 0) {
  throw new Error(
    "PORTAL_OPERATORS is set but PORTAL_REGISTRY is empty. Set PORTAL_REGISTRY to the portal registry contract address.",
  );
}

const portalOperatorSet = new Set(portalOperators);

export const hasPortalToMonitor =
  !!portalRegistryAddress && portalOperatorSet.size > 0;

// Unix timestamp at end of year 9999, used as a cap when distribution is paused.
const RUNWAY_INFINITY_CAP = 253402300799;

const portalRegistryAbi = parseAbi([
  "function clusterCount() view returns (uint256)",
  "struct Portal { bytes peerId; string metadata; uint64 addedAt; }",
  "struct Cluster { address clusterAddress; address operator; uint256 totalStaked; uint256 registeredAt; bool active; string metadata; Portal[] portals; }",
  "function getClustersPaginated(uint256 offset, uint256 limit) view returns (bytes32[] clusterIds, Cluster[] clusters)",
]);

const portalPoolAbi = parseAbi([
  "function getRunway() view returns (int256)",
  "function getCurrentRewardBalance() view returns (int256)",
  "function getRewardToken() view returns (address)",
]);

const tokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

const portalRunwayGauge = new promClient.Gauge({
  name: "sqd_portal_runway_timestamp",
  help: "Unix timestamp at which the portal pool runs out of reward credit. Capped at year 9999 when distribution is paused (rate=0 or no active stake).",
  labelNames: ["portal", "operator", "active"],
});

const portalRewardBalanceGauge = new promClient.Gauge({
  name: "sqd_portal_reward_balance",
  help: "Portal pool reward token credit balance from getCurrentRewardBalance() (signed; negative means debt). Denominated in reward token units.",
  labelNames: ["portal", "operator", "active", "reward_token", "reward_token_symbol"],
});

const portalRewardErc20BalanceGauge = new promClient.Gauge({
  name: "sqd_portal_reward_erc20_balance",
  help: "Portal pool raw ERC20 reward token balance (balanceOf the pool contract). Denominated in reward token units.",
  labelNames: ["portal", "operator", "active", "reward_token", "reward_token_symbol"],
});

type Pool = {
  address: Address;
  operator: Address;
  active: boolean;
};

type PoolData = {
  pool: Pool;
  runway?: bigint;
  rewardBalance?: bigint;
  rewardToken?: Address;
  erc20Balance?: bigint;
};

type TokenMetadata = { decimals: number; symbol: string };
const tokenMetadataCache = new Map<Address, TokenMetadata>();

async function fetchPools(): Promise<Pool[]> {
  const count = await client.readContract({
    address: portalRegistryAddress as Address,
    abi: portalRegistryAbi,
    functionName: "clusterCount",
  });
  if (count === 0n) return [];

  const [, clusters] = await client.readContract({
    address: portalRegistryAddress as Address,
    abi: portalRegistryAbi,
    functionName: "getClustersPaginated",
    args: [0n, count],
  });

  return clusters
    .map(
      (c): Pool => ({
        address: c.clusterAddress,
        operator: c.operator,
        active: c.active,
      }),
    )
    .filter(
      (p) =>
        p.address !== zeroAddress &&
        portalOperatorSet.has(p.operator.toLowerCase()),
    );
}

async function fetchPoolData(pools: Pool[]): Promise<PoolData[]> {
  const calls = pools.flatMap(
    (p) =>
      [
        {
          address: p.address,
          abi: portalPoolAbi,
          functionName: "getRunway",
        } as const,
        {
          address: p.address,
          abi: portalPoolAbi,
          functionName: "getCurrentRewardBalance",
        } as const,
        {
          address: p.address,
          abi: portalPoolAbi,
          functionName: "getRewardToken",
        } as const,
      ] as const,
  );
  const results = await client.multicall({ contracts: calls });

  return pools.map((pool, i) => {
    const r = results[i * 3];
    const b = results[i * 3 + 1];
    const t = results[i * 3 + 2];
    return {
      pool,
      runway: r.status === "success" ? (r.result as bigint) : undefined,
      rewardBalance: b.status === "success" ? (b.result as bigint) : undefined,
      rewardToken: t.status === "success" ? (t.result as Address) : undefined,
    };
  });
}

async function loadTokenMetadata(tokens: Address[]) {
  const missing = tokens.filter((t) => !tokenMetadataCache.has(t));
  if (missing.length === 0) return;

  const calls = missing.flatMap(
    (address) =>
      [
        { address, abi: tokenAbi, functionName: "decimals" } as const,
        { address, abi: tokenAbi, functionName: "symbol" } as const,
      ] as const,
  );
  const results = await client.multicall({ contracts: calls });
  for (let i = 0; i < missing.length; i++) {
    const decimalsRes = results[i * 2];
    const symbolRes = results[i * 2 + 1];
    if (decimalsRes.status === "success" && symbolRes.status === "success") {
      tokenMetadataCache.set(missing[i], {
        decimals: Number(decimalsRes.result),
        symbol: String(symbolRes.result),
      });
    }
  }
}

async function fetchErc20Balances(poolData: PoolData[]) {
  const indexed = poolData
    .map((p, idx) => ({ idx, p }))
    .filter(({ p }) => !!p.rewardToken);
  if (indexed.length === 0) return;

  const calls = indexed.map(
    ({ p }) =>
      ({
        address: p.rewardToken!,
        abi: tokenAbi,
        functionName: "balanceOf",
        args: [p.pool.address],
      }) as const,
  );
  const results = await client.multicall({ contracts: calls });
  for (let i = 0; i < indexed.length; i++) {
    const res = results[i];
    if (res.status === "success") {
      poolData[indexed[i].idx].erc20Balance = res.result;
    }
  }
}

function setGauges(poolData: PoolData[]) {
  for (const { pool, runway, rewardBalance, rewardToken, erc20Balance } of poolData) {
    const labels = {
      portal: pool.address.toLowerCase(),
      operator: pool.operator.toLowerCase(),
      active: pool.active ? "true" : "false",
    };

    if (runway !== undefined) {
      let runwaySeconds: number;
      if (runway < 0n) {
        // Should not occur on a healthy pool; surface as 0 to make dashboards visible.
        runwaySeconds = 0;
      } else if (runway > BigInt(RUNWAY_INFINITY_CAP)) {
        runwaySeconds = RUNWAY_INFINITY_CAP;
      } else {
        runwaySeconds = Number(runway);
      }
      portalRunwayGauge.set(labels, runwaySeconds);
    }

    if (!rewardToken) continue;
    const meta = tokenMetadataCache.get(rewardToken);
    const decimals = meta?.decimals ?? 18;
    const symbol = meta?.symbol ?? "UNKNOWN";
    const tokenLabels = {
      ...labels,
      reward_token: rewardToken.toLowerCase(),
      reward_token_symbol: symbol,
    };

    if (rewardBalance !== undefined) {
      const sign = rewardBalance < 0n ? -1 : 1;
      const abs = rewardBalance < 0n ? -rewardBalance : rewardBalance;
      portalRewardBalanceGauge.set(
        tokenLabels,
        sign * Number(formatUnits(abs, decimals)),
      );
    }

    if (erc20Balance !== undefined) {
      portalRewardErc20BalanceGauge.set(
        tokenLabels,
        Number(formatUnits(erc20Balance, decimals)),
      );
    }
  }
}

export async function updatePortalMetrics() {
  if (!hasPortalToMonitor) return;

  const pools = await fetchPools();
  if (pools.length === 0) return;

  const poolData = await fetchPoolData(pools);

  const uniqueTokens = Array.from(
    new Set(poolData.map((p) => p.rewardToken).filter((t): t is Address => !!t)),
  );
  await loadTokenMetadata(uniqueTokens);

  await fetchErc20Balances(poolData);

  setGauges(poolData);
}
