"use client";

import { createContext, useContext, useState, useRef, useEffect, ReactNode } from "react";

// Mock portal data
export interface MockPortal {
  address: `0x${string}`;
  operator: `0x${string}`;
  peerId: string;
  maxCapacity: bigint;
  totalStaked: bigint;
  state: number; // 0=Collecting, 1=Active, 2=Failed
  depositDeadline: bigint;
  activationTime: bigint;
  paused: boolean;
  paymentTokens: `0x${string}`[];
  expectedRatePerDay: bigint; // USDC per day (6 decimals)
  rateType: "day" | "month";
  // Gradual distribution mock
  gradualBalance: bigint;
  gradualRatePerSecond: bigint;
  gradualLastUpdate: number;
}

export interface MockProvider {
  address: `0x${string}`;
  stakes: Record<string, bigint>; // portalAddress -> stake amount
  claimable: Record<string, Record<string, bigint>>; // portalAddress -> token -> amount
  exitRequests: Record<string, { amount: bigint; requestEpoch: bigint; unlockEpoch: bigint }>;
}

interface MockContextType {
  isMockMode: boolean;
  setMockMode: (enabled: boolean) => void;
  mockPortals: MockPortal[];
  mockProviders: MockProvider[];
  mockCurrentEpoch: bigint;
  mockMinStakeThreshold: bigint;
  mockUserAddress: `0x${string}`;
  mockSqdBalance: bigint;
  mockUsdcBalance: bigint;
  // Actions
  addMockPortal: (portal: Omit<MockPortal, "address">) => void;
  stakeMock: (portalAddress: string, amount: bigint) => void;
  requestExitMock: (portalAddress: string, amount: bigint) => void;
  claimFeesMock: (portalAddress: string, token: string) => void;
  distributeFeesMock: (portalAddress: string, token: string, amount: bigint) => void;
  advanceEpochMock: () => void;
}

const MockContext = createContext<MockContextType | null>(null);

// Generate a random address
const randomAddress = (): `0x${string}` => {
  const hex = "0123456789abcdef";
  let addr = "0x";
  for (let i = 0; i < 40; i++) {
    addr += hex[Math.floor(Math.random() * 16)];
  }
  return addr as `0x${string}`;
};

// Initial mock data
const MOCK_USER = "0xd409943eD69aDe02d0B25D0cbc47dc43b7391c34" as `0x${string}`;
const MOCK_OPERATOR = "0x1234567890123456789012345678901234567890" as `0x${string}`;
const MOCK_USDC = "0xA911Abb691d1F09DF1063cE28D78Ba5f9E1E66A2" as `0x${string}`;

const INITIAL_PORTALS: MockPortal[] = [
  {
    address: "0x1111111111111111111111111111111111111111" as `0x${string}`,
    operator: MOCK_OPERATOR,
    peerId: "peer_12D3KooWDemo1",
    maxCapacity: BigInt("1000000000000000000000000"), // 1M SQD
    totalStaked: BigInt("750000000000000000000000"), // 750k SQD
    state: 1, // Active
    depositDeadline: BigInt(Date.now() + 30 * 24 * 60 * 60 * 1000),
    activationTime: BigInt(Date.now() - 7 * 24 * 60 * 60 * 1000),
    paused: false,
    paymentTokens: [MOCK_USDC],
    expectedRatePerDay: BigInt("100000000"), // 100 USDC/day
    rateType: "day",
    gradualBalance: BigInt("3000000000"), // 3000 USDC
    gradualRatePerSecond: BigInt("1157"), // ~100 USDC/day
    gradualLastUpdate: Date.now(),
  },
  {
    address: "0x2222222222222222222222222222222222222222" as `0x${string}`,
    operator: MOCK_USER,
    peerId: "peer_12D3KooWDemo2",
    maxCapacity: BigInt("500000000000000000000000"), // 500k SQD
    totalStaked: BigInt("200000000000000000000000"), // 200k SQD
    state: 0, // Collecting
    depositDeadline: BigInt(Date.now() + 14 * 24 * 60 * 60 * 1000),
    activationTime: BigInt(0),
    paused: false,
    paymentTokens: [MOCK_USDC],
    expectedRatePerDay: BigInt("50000000"), // 50 USDC/day
    rateType: "day",
    gradualBalance: BigInt("0"),
    gradualRatePerSecond: BigInt("0"),
    gradualLastUpdate: Date.now(),
  },
  {
    address: "0x3333333333333333333333333333333333333333" as `0x${string}`,
    operator: MOCK_OPERATOR,
    peerId: "peer_12D3KooWDemo3",
    maxCapacity: BigInt("2000000000000000000000000"), // 2M SQD
    totalStaked: BigInt("2000000000000000000000000"), // 2M SQD (full)
    state: 1, // Active
    depositDeadline: BigInt(Date.now() - 10 * 24 * 60 * 60 * 1000),
    activationTime: BigInt(Date.now() - 5 * 24 * 60 * 60 * 1000),
    paused: false,
    paymentTokens: [MOCK_USDC],
    expectedRatePerDay: BigInt("500000000"), // 500 USDC/day
    rateType: "month",
    gradualBalance: BigInt("15000000000"), // 15000 USDC
    gradualRatePerSecond: BigInt("5787"), // ~500 USDC/day
    gradualLastUpdate: Date.now(),
  },
];

const INITIAL_PROVIDERS: MockProvider[] = [
  {
    address: MOCK_USER,
    stakes: {
      "0x1111111111111111111111111111111111111111": BigInt("100000000000000000000000"), // 100k SQD
      "0x3333333333333333333333333333333333333333": BigInt("500000000000000000000000"), // 500k SQD
    },
    claimable: {
      "0x1111111111111111111111111111111111111111": {
        [MOCK_USDC]: BigInt("25000000"), // 25 USDC
      },
      "0x3333333333333333333333333333333333333333": {
        [MOCK_USDC]: BigInt("150000000"), // 150 USDC
      },
    },
    exitRequests: {},
  },
];

export function MockProvider({ children }: { children: ReactNode }) {
  const [isMockMode, setIsMockMode] = useState(false);
  const [mockPortals, setMockPortals] = useState<MockPortal[]>(INITIAL_PORTALS);
  const [mockProviders, setMockProviders] = useState<MockProvider[]>(INITIAL_PROVIDERS);
  const [mockCurrentEpoch, setMockCurrentEpoch] = useState(BigInt(1000));

  // Refs to always have latest state available for distribution calculations
  const portalsRef = useRef(mockPortals);
  const providersRef = useRef(mockProviders);

  useEffect(() => {
    portalsRef.current = mockPortals;
  }, [mockPortals]);

  useEffect(() => {
    providersRef.current = mockProviders;
  }, [mockProviders]);

  const setMockMode = (enabled: boolean) => {
    setIsMockMode(enabled);
    if (typeof window !== "undefined") {
      localStorage.setItem("mock-mode", enabled ? "true" : "false");
    }
  };

  const addMockPortal = (portal: Omit<MockPortal, "address">) => {
    const newPortal: MockPortal = {
      ...portal,
      address: randomAddress(),
    };
    setMockPortals((prev) => [...prev, newPortal]);
  };

  const stakeMock = (portalAddress: string, amount: bigint) => {
    // Find the portal and validate capacity
    const portal = mockPortals.find(
      (p) => p.address.toLowerCase() === portalAddress.toLowerCase()
    );
    if (!portal) return;

    // Cap amount at available capacity
    const availableCapacity = portal.maxCapacity - portal.totalStaked;
    if (availableCapacity <= 0n) return; // Portal is full
    const actualAmount = amount > availableCapacity ? availableCapacity : amount;

    // Update portal
    setMockPortals((prev) =>
      prev.map((p) =>
        p.address.toLowerCase() === portalAddress.toLowerCase()
          ? { ...p, totalStaked: p.totalStaked + actualAmount }
          : p
      )
    );
    // Update provider
    setMockProviders((prev) => {
      const existing = prev.find((p) => p.address === MOCK_USER);
      if (existing) {
        return prev.map((p) =>
          p.address === MOCK_USER
            ? {
                ...p,
                stakes: {
                  ...p.stakes,
                  [portalAddress]: (p.stakes[portalAddress] || BigInt(0)) + actualAmount,
                },
              }
            : p
        );
      }
      return [
        ...prev,
        {
          address: MOCK_USER,
          stakes: { [portalAddress]: actualAmount },
          claimable: {},
          exitRequests: {},
        },
      ];
    });
  };

  const requestExitMock = (portalAddress: string, amount: bigint) => {
    const unlockEpoch = mockCurrentEpoch + BigInt(10);
    setMockProviders((prev) =>
      prev.map((p) =>
        p.address === MOCK_USER
          ? {
              ...p,
              exitRequests: {
                ...p.exitRequests,
                [portalAddress]: {
                  amount,
                  requestEpoch: mockCurrentEpoch,
                  unlockEpoch,
                },
              },
            }
          : p
      )
    );
  };

  const claimFeesMock = (portalAddress: string, token: string) => {
    setMockProviders((prev) =>
      prev.map((p) =>
        p.address === MOCK_USER
          ? {
              ...p,
              claimable: {
                ...p.claimable,
                [portalAddress]: {
                  ...p.claimable[portalAddress],
                  [token]: BigInt(0),
                },
              },
            }
          : p
      )
    );
  };

  const distributeFeesMock = (portalAddress: string, token: string, amount: bigint) => {
    // Use ref to get latest portal state
    const portal = portalsRef.current.find(
      (p) => p.address.toLowerCase() === portalAddress.toLowerCase()
    );
    if (!portal || portal.totalStaked === 0n) return;

    // 50% goes to liquidity providers, 50% to worker pool (simulated)
    const providerShare = amount / 2n;
    const totalStaked = portal.totalStaked;

    // Update portal gradual balance
    setMockPortals((prev) =>
      prev.map((p) =>
        p.address.toLowerCase() === portalAddress.toLowerCase()
          ? { ...p, gradualBalance: p.gradualBalance + amount }
          : p
      )
    );

    // Distribute to all providers based on their stake share
    // Use providersRef to get latest stakes
    const portalAddrLower = portalAddress.toLowerCase();

    setMockProviders((prev) => {
      // Get latest stakes from ref (in case state is stale)
      const latestProviders = providersRef.current;

      return prev.map((provider) => {
        // Find latest stake info for this provider
        const latestProvider = latestProviders.find(p => p.address === provider.address);

        // Find stake with case-insensitive lookup
        const findStake = (stakes: Record<string, bigint>) => {
          for (const [addr, amount] of Object.entries(stakes)) {
            if (addr.toLowerCase() === portalAddrLower) return amount;
          }
          return BigInt(0);
        };

        const stake = latestProvider
          ? findStake(latestProvider.stakes)
          : findStake(provider.stakes);

        if (stake === 0n) return provider;

        // Calculate provider's share: (stake / totalStaked) * providerShare
        const reward = (stake * providerShare) / totalStaked;

        // Find existing claimable with case-insensitive lookup
        const findClaimable = (claimable: Record<string, Record<string, bigint>>) => {
          for (const [addr, tokens] of Object.entries(claimable)) {
            if (addr.toLowerCase() === portalAddrLower) return tokens[token] || BigInt(0);
          }
          return BigInt(0);
        };

        const existingClaimable = findClaimable(provider.claimable);

        return {
          ...provider,
          claimable: {
            ...provider.claimable,
            [portalAddress]: {
              ...provider.claimable[portalAddress],
              [token]: existingClaimable + reward,
            },
          },
        };
      });
    });
  };

  const advanceEpochMock = () => {
    setMockCurrentEpoch((prev) => prev + BigInt(1));
    // Simulate some rewards accruing
    setMockProviders((prev) =>
      prev.map((provider) => {
        const newClaimable = { ...provider.claimable };
        Object.keys(provider.stakes).forEach((portalAddr) => {
          const stake = provider.stakes[portalAddr];
          const portal = mockPortals.find(
            (p) => p.address.toLowerCase() === portalAddr.toLowerCase()
          );
          if (portal && portal.state === 1 && stake > BigInt(0)) {
            // Add some rewards proportional to stake
            const reward = (stake * BigInt(100)) / portal.totalStaked; // simplified
            if (!newClaimable[portalAddr]) newClaimable[portalAddr] = {};
            newClaimable[portalAddr][MOCK_USDC] =
              (newClaimable[portalAddr][MOCK_USDC] || BigInt(0)) + reward;
          }
        });
        return { ...provider, claimable: newClaimable };
      })
    );
  };

  return (
    <MockContext.Provider
      value={{
        isMockMode,
        setMockMode,
        mockPortals,
        mockProviders,
        mockCurrentEpoch,
        mockMinStakeThreshold: BigInt("100000000000000000000000"), // 100k SQD
        mockUserAddress: MOCK_USER,
        mockSqdBalance: BigInt("10000000000000000000000000"), // 10M SQD
        mockUsdcBalance: BigInt("100000000000"), // 100k USDC
        addMockPortal,
        stakeMock,
        requestExitMock,
        claimFeesMock,
        distributeFeesMock,
        advanceEpochMock,
      }}
    >
      {children}
    </MockContext.Provider>
  );
}

export function useMock() {
  const context = useContext(MockContext);
  if (!context) {
    throw new Error("useMock must be used within MockProvider");
  }
  return context;
}

// Helper to check if in mock mode and get mock data
export function useMockMode() {
  const context = useContext(MockContext);
  return context?.isMockMode ?? false;
}
