import { createPublicClient, formatEther, http, parseAbi } from "viem";
import { arbitrum, arbitrumSepolia } from "viem/chains";
import express from "express";
import promClient from "prom-client";

if (!process.env.RPC_URL) {
  throw new Error("RPC_URL is not set");
}

const ethBalanceWallets = (process.env.ETH_HOLDERS ?? "")
  .split(",")
  .map((address) => address.trim())
  .filter((address) => address);

const sqdBalanceWallets = (process.env.SQD_HOLDERS ?? "")
  .split(",")
  .map((address) => address.trim())
  .filter((address) => address);

if (ethBalanceWallets.length + sqdBalanceWallets.length === 0) {
  throw new Error("No wallets to monitor. Set ETH_HOLDERS and SQD_HOLDERS");
}

const chainId = await createPublicClient({
  transport: http(process.env.RPC_URL),
}).getChainId();
const chain = chainId === arbitrum.id ? arbitrum : arbitrumSepolia;

const client = createPublicClient({
  chain,
  transport: http(process.env.RPC_URL),
});

const multicallAbi = parseAbi([
  "function getEthBalance(address) view returns (uint256)",
]);
const tokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);

const tokenAddress =
  chainId === arbitrum.id
    ? "0x1337420dED5ADb9980CFc35f8f2B054ea86f8aB1"
    : "0x24f9C46d86c064a6FA2a568F918fe62fC6917B3c";

const ethMulticalls = ethBalanceWallets.map(
  (address) =>
    ({
      address: client.chain.contracts.multicall3.address,
      abi: multicallAbi,
      functionName: "getEthBalance",
      args: [address],
    }) as const,
);
const tokenMulticalls = sqdBalanceWallets.map(
  (address) =>
    ({
      address: tokenAddress,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [address],
    }) as const,
);

// start express server with /metrics endpoint
const app = express();
const port = process.env.PORT ?? 3000;

app.get("/metrics", async (_, res) => {
  res.set("Content-Type", promClient.register.contentType);
  res.end(await promClient.register.metrics());
});

app.listen(port, () => {
  console.log(`Server listening at ${port}`);
});

const balanceGauge = new promClient.Gauge({
  name: "sqd_wallet_balance",
  help: "Balance of the wallet",
  labelNames: ["wallet", "token"],
});

const updateMetrics = async () => {
  const balances =
    (await client
      .multicall({
        contracts: [...ethMulticalls, ...tokenMulticalls],
      })
      .catch(console.error)) ?? [];
  const timestamp = new Date().toISOString();
  let i = 0;
  for (const balance of balances) {
    if (balance.status === "success") {
      if (i < ethMulticalls.length) {
        balanceGauge.set(
          { wallet: ethBalanceWallets[i], token: "ETH" },
          Number(formatEther(balance.result)),
        );
      } else {
        balanceGauge.set(
          { wallet: sqdBalanceWallets[i - ethMulticalls.length], token: "SQD" },
          Number(formatEther(balance.result)),
        );
      }
    }
    i++;
  }
  setTimeout(
    updateMetrics,
    1000 * 60 * Number(process.env.INTERVAL_MINUTES ?? 120),
  );
};

void updateMetrics();
