"use client";

import { useState, useEffect } from "react";
import { usePublicClient, useReadContract } from "wagmi";
import { PORTAL_FACTORY_ABI, PORTAL_ABI, contractAddresses } from "@/config/contracts";
import { formatUnits } from "viem";

interface PortalInfo {
  operator: string;
  maxCapacity: bigint;
  totalStaked: bigint;
  depositDeadline: bigint;
  activationTime: bigint;
  state: number;
  paused: boolean;
}

const STATE_NAMES = ["Collecting", "Active", "Sunset", "Failed"];
const STATE_COLORS = {
  0: "bg-yellow-100 text-yellow-800 border-yellow-300", // Collecting
  1: "bg-green-100 text-green-800 border-green-300", // Active
  2: "bg-orange-100 text-orange-800 border-orange-300", // Sunset
  3: "bg-red-100 text-red-800 border-red-300", // Failed
};

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
  const minStake = minStakeThreshold ? Number(formatUnits(minStakeThreshold, 18)) : 100000;
  const cus = Math.floor(totalStaked / minStake);
  const progressPercent = maxCapacity > 0 ? (totalStaked / maxCapacity) * 100 : 0;
  const stateColor = STATE_COLORS[portalInfo.state as keyof typeof STATE_COLORS] || STATE_COLORS[3];

  return (
    <div
      onClick={onClick}
      className="bg-white rounded-lg p-6 border border-sqd-divider hover:border-sqd-accent hover:shadow-lg transition-all cursor-pointer"
    >
      {/* Header */}
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

      {/* Capacity Progress */}
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

      {/* CUs and Status */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="text-xs text-sqd-text-secondary mb-1">Compute Units</div>
          <div className="text-lg font-semibold text-sqd-accent">{cus} CUs</div>
        </div>
        <div>
          <div className="text-xs text-sqd-text-secondary mb-1">Status</div>
          <div className="text-lg font-semibold text-sqd-text-primary">
            {portalInfo.state === 1 ? "✅ Active" : portalInfo.state === 0 ? "⏳ Collecting" : "❌ Inactive"}
          </div>
        </div>
      </div>

      {/* Footer Info */}
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

  useEffect(() => {
    const fetchPortals = async () => {
      if (!publicClient) return;

      setLoading(true);
      try {
        // Get current block number
        const currentBlock = await publicClient.getBlockNumber();

        // Query only last 50,000 blocks to avoid RPC limits
        const fromBlock = currentBlock > 50000n ? currentBlock - 50000n : 0n;

        // Fetch PortalCreated events from PortalFactory (new multi-token format)
        const logs = await publicClient.getLogs({
          address: contractAddresses.portalFactory,
          event: {
            type: "event",
            name: "PortalCreated",
            inputs: [
              { indexed: true, name: "portal", type: "address" },
              { indexed: true, name: "operator", type: "address" },
              { indexed: false, name: "peerId", type: "bytes" },
            ],
          },
          fromBlock: fromBlock,
          toBlock: "latest",
        });

        const addresses = logs.map((log) => log.args.portal as string);
        setPortalAddresses(addresses);
      } catch (error) {
        console.error("Error fetching portals:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchPortals();
  }, [publicClient, refreshKey]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-sqd-text-secondary">Loading portals...</div>
      </div>
    );
  }

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
