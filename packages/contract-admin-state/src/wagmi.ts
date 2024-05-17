import { arbitrum, mainnet } from "wagmi/chains";
import { createConfig, http } from "wagmi";

export const config = createConfig({
  chains: [arbitrum, mainnet],
  connectors: [],
  transports: {
    [mainnet.id]: http(),
    [arbitrum.id]: http(),
  },
});
