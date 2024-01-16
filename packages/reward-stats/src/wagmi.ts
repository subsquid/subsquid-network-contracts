import { sepolia } from "wagmi/chains";
import { CoinbaseWalletConnector } from "wagmi/connectors/coinbaseWallet";
import { InjectedConnector } from "wagmi/connectors/injected";
import { MetaMaskConnector } from "wagmi/connectors/metaMask";

import { publicProvider } from "wagmi/providers/public";
import { configureChains, createConfig } from "wagmi";
import { Address } from "viem";

export const arbitrumSepolia = {
  id: 421614,
  name: "Arbitrum Sepolia",
  network: "arbitrum-sepolia",
  nativeCurrency: {
    name: "Arbitrum Sepolia Ether",
    symbol: "ETH",
    decimals: 18,
  },
  rpcUrls: {
    alchemy: {
      http: ["https://arb-sepolia.g.alchemy.com/v2"],
      webSocket: ["wss://arb-sepolia.g.alchemy.com/v2"],
    },
    infura: {
      http: ["https://arbitrum-sepolia.infura.io/v3"],
      webSocket: ["wss://arbitrum-sepolia.infura.io/ws/v3"],
    },
    default: {
      http: ["https://sepolia-rollup.arbitrum.io/rpc"],
    },
    public: {
      http: ["https://sepolia-rollup.arbitrum.io/rpc"],
    },
  },
  blockExplorers: {
    etherscan: {
      name: "Arbiscan",
      url: "https://sepolia.arbiscan.io/",
    },
    default: {
      name: "Arbiscan",
      url: "https://sepolia.arbiscan.io/",
    },
  },
  contracts: {
    multicall3: {
      address: "0xcA11bde05977b3631167028862bE2a173976CA11" as Address,
      blockCreated: 81930,
    },
  },
  testnet: true,
};

const { chains, publicClient, webSocketPublicClient } = configureChains(
  [arbitrumSepolia, sepolia],
  [publicProvider()],
);

export const config = createConfig({
  autoConnect: true,
  connectors: [
    new MetaMaskConnector({ chains }),
    new CoinbaseWalletConnector({
      chains,
      options: {
        appName: "wagmi",
      },
    }),
    new InjectedConnector({
      chains,
      options: {
        name: "Injected",
        shimDisconnect: true,
      },
    }),
  ],
  publicClient,
  webSocketPublicClient,
});
