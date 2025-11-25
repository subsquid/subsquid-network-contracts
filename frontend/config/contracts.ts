export const PORTAL_FACTORY_ABI = [
  {
    inputs: [
      { internalType: "address", name: "operator", type: "address" },
      { internalType: "address[]", name: "paymentTokens", type: "address[]" },
      { internalType: "uint256", name: "maxCapacity", type: "uint256" },
      { internalType: "uint256", name: "depositDeadline", type: "uint256" },
      { internalType: "bytes", name: "peerId", type: "bytes" },
    ],
    name: "createPortal",
    outputs: [{ internalType: "address", name: "portal", type: "address" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "getPortalCount",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    name: "allPortals",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "portal", type: "address" },
      { indexed: true, internalType: "address", name: "operator", type: "address" },
      { indexed: false, internalType: "bytes", name: "peerId", type: "bytes" },
    ],
    name: "PortalCreated",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "portal", type: "address" },
      { indexed: false, internalType: "address[]", name: "paymentTokens", type: "address[]" },
    ],
    name: "PortalPaymentTokensSet",
    type: "event",
  },
] as const;

export const PORTAL_ABI = [
  {
    inputs: [{ internalType: "uint256", name: "amount", type: "uint256" }],
    name: "stake",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "amount", type: "uint256" }],
    name: "requestExit",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "withdrawFromFailed",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "token", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "distributeFees",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "token", type: "address" }],
    name: "claimFees",
    outputs: [{ internalType: "uint256", name: "claimed", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "getPortalInfo",
    outputs: [
      {
        internalType: "struct PortalStorage.PortalInfo",
        name: "",
        type: "tuple",
        components: [
          { internalType: "address", name: "operator", type: "address" },
          { internalType: "uint256", name: "maxCapacity", type: "uint256" },
          { internalType: "uint256", name: "totalStaked", type: "uint256" },
          { internalType: "uint64", name: "depositDeadline", type: "uint64" },
          { internalType: "uint64", name: "activationTime", type: "uint64" },
          { internalType: "uint8", name: "state", type: "uint8" },
          { internalType: "bool", name: "paused", type: "bool" },
        ],
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "provider", type: "address" }],
    name: "getProviderStake",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "provider", type: "address" }],
    name: "getExitRequest",
    outputs: [
      {
        internalType: "struct PortalStorage.ExitRequest",
        name: "",
        type: "tuple",
        components: [
          { internalType: "uint256", name: "amount", type: "uint256" },
          { internalType: "uint64", name: "requestEpoch", type: "uint64" },
          { internalType: "uint64", name: "unlockEpoch", type: "uint64" },
        ],
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "provider", type: "address" },
      { internalType: "address", name: "token", type: "address" },
    ],
    name: "getClaimableFees",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getActiveStake",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getAllowedPaymentTokens",
    outputs: [{ internalType: "address[]", name: "tokens", type: "address[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getPeerId",
    outputs: [{ internalType: "bytes", name: "", type: "bytes" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "", type: "address" }],
    name: "allowedPaymentTokens",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "", type: "address" }],
    name: "totalFeesDistributed",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "", type: "address" }],
    name: "lastDistributionTime",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const ERC20_ABI = [
  {
    inputs: [
      { internalType: "address", name: "spender", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "owner", type: "address" },
      { internalType: "address", name: "spender", type: "address" },
    ],
    name: "allowance",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "to", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "mint",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

// Add Gateway Registry ABI for staking and exit operations
export const GATEWAY_REGISTRY_ABI = [
  {
    inputs: [
      { internalType: "address", name: "portal", type: "address" },
      { internalType: "address", name: "provider", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "stake",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "provider", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "requestUnlock",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "provider", type: "address" }],
    name: "unlockRequests",
    outputs: [
      { internalType: "uint256", name: "amount", type: "uint256" },
      { internalType: "uint256", name: "requestedAt", type: "uint256" },
      { internalType: "uint256", name: "withdrawn", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "withdrawUnlocked",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "provider", type: "address" }],
    name: "getTotalAllocation",
    outputs: [{ internalType: "uint256", name: "total", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "provider", type: "address" }],
    name: "getProviderPortals",
    outputs: [{ internalType: "address[]", name: "", type: "address[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "portal", type: "address" },
      { internalType: "address", name: "provider", type: "address" },
    ],
    name: "providerAllocations",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "portal", type: "address" }],
    name: "portals",
    outputs: [
      { internalType: "bytes", name: "peerId", type: "bytes" },
      { internalType: "address", name: "portalAddress", type: "address" },
      { internalType: "uint256", name: "totalStaked", type: "uint256" },
      { internalType: "uint256", name: "registeredAt", type: "uint256" },
      { internalType: "bool", name: "active", type: "bool" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "minStake",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "mana",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "portalAddress", type: "address" }],
    name: "getComputationUnits",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// Network Controller ABI for epoch info
export const NETWORK_CONTROLLER_ABI = [
  {
    inputs: [],
    name: "epochNumber",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "workerEpochLength",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "minStakeThreshold",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "workerRewardPool",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// Default addresses (Arbitrum Sepolia deployment)
const DEFAULT_ADDRESSES = {
  portalFactory: "0xf290A3aB59E15cC5e1f1Ab588712E0FF54BAfd37" as `0x${string}`,
  sqdToken: "0xD61bB229E2Ee312Dda5feaF1610E8317a319f3D1" as `0x${string}`,
  usdcToken: "0xA911Abb691d1F09DF1063cE28D78Ba5f9E1E66A2" as `0x${string}`,
  gatewayRegistry: "0xB89aA8d5C20A7A7F3351b6B0B1e3B4d126477C81" as `0x${string}`,
  networkController: "0x465D7702a171899e22ce2727508BCd573044178D" as `0x${string}`,
};

const DEFAULT_CHAIN_ID = 421614; // Arbitrum Sepolia

// Load addresses from localStorage if available
function loadContractAddresses() {
  if (typeof window === "undefined") return { addresses: DEFAULT_ADDRESSES, chainId: DEFAULT_CHAIN_ID };

  try {
    const saved = localStorage.getItem("portal-config");
    if (saved) {
      const config = JSON.parse(saved);
      // force chainId to be Arbitrum Sepolia (421614) - ignore any stored chainId
      const chainId = DEFAULT_CHAIN_ID; // always use Arbitrum Sepolia
      return {
        addresses: {
          portalFactory: (config.portalFactoryAddress || DEFAULT_ADDRESSES.portalFactory) as `0x${string}`,
          sqdToken: (config.sqdTokenAddress || DEFAULT_ADDRESSES.sqdToken) as `0x${string}`,
          usdcToken: (config.usdcTokenAddress || DEFAULT_ADDRESSES.usdcToken) as `0x${string}`,
          gatewayRegistry: (config.gatewayRegistryAddress || DEFAULT_ADDRESSES.gatewayRegistry) as `0x${string}`,
          networkController: (config.networkControllerAddress || DEFAULT_ADDRESSES.networkController) as `0x${string}`,
        },
        chainId,
      };
    }
  } catch (e) {
    console.error("Failed to load config:", e);
  }

  return { addresses: DEFAULT_ADDRESSES, chainId: DEFAULT_CHAIN_ID };
}

const config = loadContractAddresses();
export const contractAddresses = config.addresses;
export const targetChainId = config.chainId;

// Portal states - SUNSET was removed, only COLLECTING, ACTIVE, FAILED
export const STATE_NAMES = ["Collecting", "Active", "Failed"];
