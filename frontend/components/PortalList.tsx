"use client";

import { useState, useEffect } from "react";
import { usePublicClient, useReadContract } from "wagmi";
import { PORTAL_FACTORY_ABI, PORTAL_ABI, contractAddresses } from "@/config/contracts";
import { formatUnits } from "viem";
import { useMock, MockPortal } from "@/context/MockContext";

interface PortalInfo {
  operator: string;
  maxCapacity: bigint;
  totalStaked: bigint;
  depositDeadline: bigint;
  activationTime: bigint;
  state: number;
  paused: boolean;
}

const STATE_NAMES = ["Accepting Tokens", "Active", "Inactive"];
const STATE_COLORS = {
  0: "bg-yellow-100 text-yellow-800 border-yellow-300",
  1: "bg-green-100 text-green-800 border-green-300",
  2: "bg-red-100 text-red-800 border-red-300",
};

const MIN_THRESHOLD = 100000; // 100k SQD minimum for CUs

function MockPortalCard({ portal, onClick }: { portal: MockPortal; onClick: () => void }) {
  const maxCapacity = Number(formatUnits(portal.maxCapacity, 18));
  const totalStaked = Number(formatUnits(portal.totalStaked, 18));
  const meetsThreshold = totalStaked >= MIN_THRESHOLD;
  const cus = meetsThreshold ? Math.floor(totalStaked / 10) : 0; // 10 SQD = 1 CU, only if >= 100k
  const progressPercent = maxCapacity > 0 ? (totalStaked / maxCapacity) * 100 : 0;
  // Use red color for inactive or when below threshold
  const effectiveState = meetsThreshold ? portal.state : 2;
  const stateColor = STATE_COLORS[effectiveState as keyof typeof STATE_COLORS] || STATE_COLORS[2];

  const expectedRatePerDay = Number(formatUnits(portal.expectedRatePerDay, 6));
  const runway = portal.gradualBalance > 0n && portal.gradualRatePerSecond > 0n
    ? Number(portal.gradualBalance / portal.gradualRatePerSecond / BigInt(86400))
    : 0;

  return (
    <div
      onClick={onClick}
      className="bg-white rounded-lg p-6 border border-sqd-divider hover:border-sqd-accent hover:shadow-lg transition-all cursor-pointer"
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-sqd-accent"></div>
          <span className="text-sm font-mono text-sqd-text-secondary">
            {portal.address.slice(0, 6)}...{portal.address.slice(-4)}
          </span>
          <span className="px-1.5 py-0.5 bg-purple-100 text-purple-700 text-xs rounded">MOCK</span>
        </div>
        <span className={`px-2.5 py-1 rounded-full text-xs font-medium border ${stateColor}`}>
          {portal.state === 2 || !meetsThreshold ? "Inactive" : STATE_NAMES[portal.state]}
        </span>
      </div>

      {/* Description */}
      <p className="text-xs text-sqd-text-secondary mb-4 line-clamp-2">{portal.description}</p>

      <div className="mb-4">
        <div className="flex justify-between text-sm mb-2">
          <span className="text-sqd-text-secondary">Capacity</span>
          <span className="font-medium text-sqd-text-primary">
            {totalStaked.toLocaleString()} / {maxCapacity.toLocaleString()} SQD
          </span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-2.5">
          <div
            className="bg-sqd-accent h-2.5 rounded-full transition-all"
            style={{ width: `${Math.min(progressPercent, 100)}%` }}
          ></div>
        </div>
        <div className="text-xs text-sqd-text-secondary mt-1">{progressPercent.toFixed(1)}% filled</div>
      </div>

      {expectedRatePerDay > 0 && (
        <div className="mb-4 p-3 bg-blue-50 rounded-lg border border-blue-200">
          <div className="flex justify-between text-sm">
            <span className="text-blue-700">Expected Rate</span>
            <span className="font-semibold text-blue-800">${expectedRatePerDay.toFixed(2)}/day</span>
          </div>
          {runway > 0 && (
            <div className="flex justify-between text-xs mt-1">
              <span className="text-blue-600">Runway</span>
              <span className="text-blue-700">{runway} days</span>
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="text-xs text-sqd-text-secondary mb-1">Compute Units</div>
          <div className="text-lg font-semibold text-sqd-accent">{cus} CUs</div>
        </div>
        <div>
          <div className="text-xs text-sqd-text-secondary mb-1">Status</div>
          <div className={`text-lg font-semibold ${effectiveState === 2 ? "text-red-600" : "text-sqd-text-primary"}`}>
            {effectiveState === 1 ? "Active" : effectiveState === 0 ? "Accepting Tokens" : "Insufficient funds"}
          </div>
        </div>
      </div>

      <div className="mt-4 pt-4 border-t border-sqd-divider">
        <div className="flex justify-between text-xs text-sqd-text-secondary">
          <span>Operator</span>
          <span className="font-mono">
            {portal.operator.slice(0, 6)}...{portal.operator.slice(-4)}
          </span>
        </div>
      </div>
    </div>
  );
}

function PortalCard({ address, onClick }: { address: string; onClick: () => void }) {
  const { data: portalInfo } = useReadContract({
    address: address as `0x${string}`,
    abi: PORTAL_ABI,
    functionName: "getPortalInfo",
  }) as { data: PortalInfo | undefined };

  const { data: minStakeThreshold } = useReadContract({
    address: contractAddresses.networkController,
    abi: [
      {
        inputs: [],
        name: "minStakeThreshold",
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
      },
    ],
    functionName: "minStakeThreshold",
  });

  if (!portalInfo) {
    return (
      <div className="bg-white rounded-lg p-6 border border-sqd-divider animate-pulse">
        <div className="h-4 bg-gray-200 rounded w-3/4 mb-2"></div>
        <div className="h-4 bg-gray-200 rounded w-1/2"></div>
      </div>
    );
  }

  const maxCapacity = Number(formatUnits(portalInfo.maxCapacity, 18));
  const totalStaked = Number(formatUnits(portalInfo.totalStaked, 18));
  const cus = Math.floor(totalStaked / 10); // 10 SQD = 1 CU
  const progressPercent = maxCapacity > 0 ? (totalStaked / maxCapacity) * 100 : 0;
  const stateColor = STATE_COLORS[portalInfo.state as keyof typeof STATE_COLORS] || STATE_COLORS[2];

  return (
    <div
      onClick={onClick}
      className="bg-white rounded-lg p-6 border border-sqd-divider hover:border-sqd-accent hover:shadow-lg transition-all cursor-pointer"
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-sqd-accent"></div>
          <span className="text-sm font-mono text-sqd-text-secondary">
            {address.slice(0, 6)}...{address.slice(-4)}
          </span>
        </div>
        <span className={`px-2.5 py-1 rounded-full text-xs font-medium border ${stateColor}`}>
          {STATE_NAMES[portalInfo.state]}
        </span>
      </div>

      <div className="mb-4">
        <div className="flex justify-between text-sm mb-2">
          <span className="text-sqd-text-secondary">Capacity</span>
          <span className="font-medium text-sqd-text-primary">
            {totalStaked.toLocaleString()} / {maxCapacity.toLocaleString()} SQD
          </span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-2.5">
          <div
            className="bg-sqd-accent h-2.5 rounded-full transition-all"
            style={{ width: `${Math.min(progressPercent, 100)}%` }}
          ></div>
        </div>
        <div className="text-xs text-sqd-text-secondary mt-1">{progressPercent.toFixed(1)}% filled</div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="text-xs text-sqd-text-secondary mb-1">Compute Units</div>
          <div className="text-lg font-semibold text-sqd-accent">{cus} CUs</div>
        </div>
        <div>
          <div className="text-xs text-sqd-text-secondary mb-1">Status</div>
          <div className="text-lg font-semibold text-sqd-text-primary">
            {portalInfo.state === 1 ? "Active" : portalInfo.state === 0 ? "Accepting Tokens" : "Inactive"}
          </div>
        </div>
      </div>

      <div className="mt-4 pt-4 border-t border-sqd-divider">
        <div className="flex justify-between text-xs text-sqd-text-secondary">
          <span>Operator</span>
          <span className="font-mono">
            {portalInfo.operator.slice(0, 6)}...{portalInfo.operator.slice(-4)}
          </span>
        </div>
      </div>
    </div>
  );
}

export function PortalList({ onPortalSelect, refreshKey = 0 }: { onPortalSelect: (address: string) => void; refreshKey?: number }) {
  const publicClient = usePublicClient();
  const [portalAddresses, setPortalAddresses] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const { isMockMode, mockPortals } = useMock();

  useEffect(() => {
    if (isMockMode) {
      setLoading(false);
      return;
    }

    const fetchPortals = async () => {
      if (!publicClient) return;

      setLoading(true);
      try {
        // Use view functions instead of getLogs for reliability
        const portalCount = await publicClient.readContract({
          address: contractAddresses.portalFactory,
          abi: PORTAL_FACTORY_ABI,
          functionName: "getPortalCount",
        });

        if (portalCount === 0n) {
          setPortalAddresses([]);
          return;
        }

        // Fetch all portal addresses
        const addresses: string[] = [];
        for (let i = 0n; i < portalCount; i++) {
          const portalAddress = await publicClient.readContract({
            address: contractAddresses.portalFactory,
            abi: PORTAL_FACTORY_ABI,
            functionName: "allPortals",
            args: [i],
          });
          addresses.push(portalAddress);
        }

        setPortalAddresses(addresses);
      } catch (error) {
        console.error("Error fetching portals:", error);
        // Set empty array on error to show "No Portals Yet" instead of loading forever
        setPortalAddresses([]);
      } finally {
        setLoading(false);
      }
    };

    fetchPortals();
  }, [publicClient, refreshKey, isMockMode]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-sqd-text-secondary">Loading portals...</div>
      </div>
    );
  }

  // Mock mode - show mock portals
  if (isMockMode) {
    if (mockPortals.length === 0) {
      return (
        <div className="bg-gradient-to-r from-purple-50 to-blue-50 rounded-lg p-12 border border-purple-200 text-center">
          <div className="text-4xl mb-4">🧪</div>
          <h3 className="text-lg font-medium text-sqd-text-primary mb-2">Mock Mode Active</h3>
          <p className="text-sm text-sqd-text-secondary">Deploy a mock portal to get started</p>
        </div>
      );
    }

    return (
      <div>
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-semibold text-sqd-text-primary">Mock Portals ({mockPortals.length})</h2>
            <span className="px-2 py-1 bg-purple-100 text-purple-700 text-xs rounded-full font-medium">MOCK MODE</span>
          </div>
          <div className="text-sm text-sqd-text-secondary">Click any portal to interact</div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {mockPortals.map((portal) => (
            <MockPortalCard key={portal.address} portal={portal} onClick={() => onPortalSelect(portal.address)} />
          ))}
        </div>
      </div>
    );
  }

  // Real mode
  if (portalAddresses.length === 0) {
    return (
      <div className="bg-gradient-to-r from-sqd-accent/5 to-sqd-secondary/5 rounded-lg p-12 border border-sqd-divider text-center">
        <div className="text-4xl mb-4">🚀</div>
        <h3 className="text-lg font-medium text-sqd-text-primary mb-2">No Portals Yet</h3>
        <p className="text-sm text-sqd-text-secondary">Deploy your first portal to get started</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-sqd-text-primary">Available Portals ({portalAddresses.length})</h2>
        <div className="text-sm text-sqd-text-secondary">Click any portal to invest</div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {portalAddresses.map((address) => (
          <PortalCard key={address} address={address} onClick={() => onPortalSelect(address)} />
        ))}
      </div>
    </div>
  );
}
