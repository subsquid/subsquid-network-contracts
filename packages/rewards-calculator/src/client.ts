import { createPublicClient, createWalletClient, http } from "viem";
import { arbitrumSepolia, goerli, sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

export const publicClient = createPublicClient({
  chain: arbitrumSepolia,
  transport: http(
    "https://arbitrum-sepolia.infura.io/v3/39b9cd000b9c4637b58d5a5214676196",
  ),
});

export const l1Client = createPublicClient({
  chain: goerli,
  transport: http(),
});

export const walletClient = createWalletClient({
  chain: arbitrumSepolia,
  transport: http(),
  account: privateKeyToAccount(process.env.PRIVATE_KEY as any),
});
