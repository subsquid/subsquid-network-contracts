"use client";

import { useReadContract } from "wagmi";
import { PORTAL_POOL_ABI, STATE_NAMES } from "@/config/contracts";
import { formatUnits } from "viem";

interface Portal {
  address: string;
  consumer: string;
  targetSQD: bigint;
  collectionTarget: bigint;
  paymentToken: string;
  budget: bigint;
}

interface PortalCardProps {
  portal: Portal;
  filterState: "all" | "collecting" | "active" | "closed" | "failed";
}

export function PortalCard({ portal, filterState }: PortalCardProps) {
  const { data: state } = useReadContract({
    address: portal.address as `0x${string}`,
    abi: PORTAL_POOL_ABI,
    functionName: "state",
  });

  const { data: totalActiveSQD } = useReadContract({
    address: portal.address as `0x${string}`,
    abi: PORTAL_POOL_ABI,
    functionName: "totalActiveSQD",
  });

  const { data: totalRewards } = useReadContract({
    address: portal.address as `0x${string}`,
    abi: PORTAL_POOL_ABI,
    functionName: "totalRewardsDistributed",
  });

  const { data: depositDeadline } = useReadContract({
    address: portal.address as `0x${string}`,
    abi: PORTAL_POOL_ABI,
    functionName: "depositDeadline",
  });

  const stateNum = typeof state === "number" ? state : 0;
  const stateName = STATE_NAMES[stateNum] || "Unknown";

  // Filter logic
  if (filterState !== "all") {
    const filterMap: Record<string, number> = {
      collecting: 0,
      active: 1,
      failed: 2,
      closed: 3,
    };
    if (stateNum !== filterMap[filterState]) {
      return null;
    }
  }

  const progress = totalActiveSQD
    ? Number((totalActiveSQD * 100n) / portal.collectionTarget)
    : 0;

  const stateColors: Record<string, string> = {
    Collecting: "bg-blue-100 text-blue-700 border-blue-200",
    Active: "bg-green-100 text-green-700 border-green-200",
    Failed: "bg-red-100 text-red-700 border-red-200",
    Closed: "bg-gray-100 text-gray-700 border-gray-200",
  };

  const progressColors: Record<string, string> = {
    Collecting: "bg-blue-500",
    Active: "bg-green-500",
    Failed: "bg-red-500",
    Closed: "bg-gray-500",
  };

  const deadlineDate = depositDeadline
    ? new Date(Number(depositDeadline) * 1000).toLocaleDateString()
    : "N/A";

  return (
    <div className="bg-white rounded-lg border border-sqd-divider p-5 hover:shadow-md transition-shadow">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1 min-w-0">
          <div className="text-xs text-sqd-text-secondary mb-1">Portal</div>
          <div className="text-sm font-mono text-sqd-text-primary truncate">
            {portal.address.slice(0, 6)}...{portal.address.slice(-4)}
          </div>
        </div>
        <div
          className={`px-2.5 py-1 rounded-full text-xs font-medium border ${
            stateColors[stateName] || stateColors.Collecting
          }`}
        >
          {stateName}
        </div>
      </div>

      {/* Progress Bar (only for Collecting state) */}
      {stateNum === 0 && (
        <div className="mb-4">
          <div className="flex justify-between text-xs text-sqd-text-secondary mb-1.5">
            <span>Collection Progress</span>
            <span>{progress.toFixed(1)}%</span>
          </div>
          <div className="w-full bg-sqd-primary rounded-full h-2 overflow-hidden">
            <div
              className={`h-full transition-all ${progressColors[stateName]}`}
              style={{ width: `${Math.min(progress, 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Stats Grid */}
      <div className="space-y-3">
        <div className="flex justify-between items-center">
          <span className="text-xs text-sqd-text-secondary">Target SQD</span>
          <span className="text-sm font-medium text-sqd-text-primary">
            {formatUnits(portal.targetSQD, 18)} SQD
          </span>
        </div>

        <div className="flex justify-between items-center">
          <span className="text-xs text-sqd-text-secondary">Total Staked</span>
          <span className="text-sm font-medium text-sqd-text-primary">
            {totalActiveSQD ? formatUnits(totalActiveSQD, 18) : "0"} SQD
          </span>
        </div>

        <div className="flex justify-between items-center">
          <span className="text-xs text-sqd-text-secondary">Budget</span>
          <span className="text-sm font-medium text-sqd-text-primary">
            {formatUnits(portal.budget, 6)} USDC
          </span>
        </div>

        {totalRewards && totalRewards > 0n && (
          <div className="flex justify-between items-center">
            <span className="text-xs text-sqd-text-secondary">Rewards Distributed</span>
            <span className="text-sm font-medium text-green-600">
              {formatUnits(totalRewards, 6)} USDC
            </span>
          </div>
        )}

        {stateNum === 0 && (
          <div className="flex justify-between items-center">
            <span className="text-xs text-sqd-text-secondary">Deadline</span>
            <span className="text-sm font-medium text-sqd-text-primary">{deadlineDate}</span>
          </div>
        )}
      </div>

      {/* Action Button */}
      <button className="w-full mt-4 bg-sqd-accent hover:bg-sqd-accent/90 text-white py-2 rounded-full text-sm font-medium transition-colors">
        View Details
      </button>
    </div>
  );
}
