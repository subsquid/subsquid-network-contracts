import { formatEther, parseAbi, type Address } from "viem";
import { arbitrum } from "viem/chains";
import promClient from "prom-client";
import { chainId, client } from "./client.js";

const ethBalanceWallets = (process.env.ETH_HOLDERS ?? "")
  .split(",")
  .map((a) => a.trim())
  .filter(Boolean) as Address[];

const sqdBalanceWallets = (process.env.SQD_HOLDERS ?? "")
  .split(",")
  .map((a) => a.trim())
  .filter(Boolean) as Address[];

export const hasWalletsToMonitor =
  ethBalanceWallets.length + sqdBalanceWallets.length > 0;

const sqdTokenAddress: Address =
  chainId === arbitrum.id
    ? "0x1337420dED5ADb9980CFc35f8f2B054ea86f8aB1"
    : "0x24f9C46d86c064a6FA2a568F918fe62fC6917B3c";

const multicallAbi = parseAbi([
  "function getEthBalance(address) view returns (uint256)",
]);
const tokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);

const balanceGauge = new promClient.Gauge({
  name: "sqd_wallet_balance",
  help: "Balance of the wallet",
  labelNames: ["wallet", "token"],
});

export async function updateWalletMetrics() {
  if (!hasWalletsToMonitor) return;

  const ethCalls = ethBalanceWallets.map(
    (address) =>
      ({
        address: client.chain.contracts.multicall3.address,
        abi: multicallAbi,
        functionName: "getEthBalance",
        args: [address],
      }) as const,
  );
  const sqdCalls = sqdBalanceWallets.map(
    (address) =>
      ({
        address: sqdTokenAddress,
        abi: tokenAbi,
        functionName: "balanceOf",
        args: [address],
      }) as const,
  );

  const results = await client.multicall({
    contracts: [...ethCalls, ...sqdCalls],
  });

  for (let i = 0; i < ethCalls.length; i++) {
    const res = results[i];
    if (res.status === "success") {
      balanceGauge.set(
        { wallet: ethBalanceWallets[i], token: "ETH" },
        Number(formatEther(res.result)),
      );
    }
  }
  for (let i = 0; i < sqdCalls.length; i++) {
    const res = results[ethCalls.length + i];
    if (res.status === "success") {
      balanceGauge.set(
        { wallet: sqdBalanceWallets[i], token: "SQD" },
        Number(formatEther(res.result)),
      );
    }
  }
}
