import { arbitrum, mainnet } from "wagmi/chains";
import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";

export const config = createConfig({
  chains: [arbitrum, mainnet],
  connectors: [injected({})],
  transports: {
    [mainnet.id]: http(),
    [arbitrum.id]: http(),
  },
});
