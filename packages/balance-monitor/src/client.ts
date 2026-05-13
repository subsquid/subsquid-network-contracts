import { createPublicClient, http } from "viem";
import { arbitrum, arbitrumSepolia } from "viem/chains";

if (!process.env.RPC_URL) {
  throw new Error("RPC_URL is not set");
}

export const chainId = await createPublicClient({
  transport: http(process.env.RPC_URL),
}).getChainId();

const chain = chainId === arbitrum.id ? arbitrum : arbitrumSepolia;

export const client = createPublicClient({
  chain,
  transport: http(process.env.RPC_URL),
});
