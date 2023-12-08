import { createPublicClient, createWalletClient, http } from "viem";
import { arbitrumGoerli, goerli } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

export const publicClient = createPublicClient({
  chain: arbitrumGoerli,
  transport: http(
    "https://arbitrum-goerli.infura.io/v3/39b9cd000b9c4637b58d5a5214676196",
  ),
});

export const l1Client = createPublicClient({
  chain: goerli,
  transport: http(),
});

export const walletClient = createWalletClient({
  chain: arbitrumGoerli,
  transport: http(),
  account: privateKeyToAccount(process.env.PRIVATE_KEY as any),
});
