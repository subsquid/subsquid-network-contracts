import { http, createConfig } from "wagmi";
import { mainnet, sepolia, hardhat, arbitrum, arbitrumSepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";

export const config = createConfig({
  chains: [arbitrumSepolia, hardhat, sepolia, mainnet, arbitrum],
  connectors: [injected()],
  transports: {
    [arbitrumSepolia.id]: http("https://sepolia-rollup.arbitrum.io/rpc"),
    [hardhat.id]: http(),
    [sepolia.id]: http(),
    [mainnet.id]: http(),
    [arbitrum.id]: http(),
  },
});

// Export chain IDs for easy reference
export const SUPPORTED_CHAINS = {
  HARDHAT: hardhat.id,
  SEPOLIA: sepolia.id,
  MAINNET: mainnet.id,
  ARBITRUM: arbitrum.id,
  ARBITRUM_SEPOLIA: arbitrumSepolia.id,
};
