"use client";

import { useReadContract } from "wagmi";
import { PORTAL_ABI, STATE_NAMES } from "@/config/contracts";
import { formatUnits } from "viem";

interface PortalCardProps {
  portalAddress: string;
  filterState: "all" | "collecting" | "active" | "failed";
  onClick?: () => void;
}

interface PortalInfo {
  operator: string;
  capacity: bigint;
  totalStaked: bigint;
  depositDeadline: bigint;
  activationTime: bigint;
  state: number;
  paused: boolean;
}

export function PortalCard({ portalAddress, filterState, onClick }: PortalCardProps) {
  // Read portal info
  const { data: portalInfo } = useReadContract({
    address: portalAddress as `0x${string}`,
    abi: PORTAL_ABI,
    functionName: "getPortalInfo",
  }) as { data: PortalInfo | undefined };

  // Read active stake
  const { data: activeStake } = useReadContract({
    address: portalAddress as `0x${string}`,
    abi: PORTAL_ABI,
    functionName: "getActiveStake",
  });

  // Read peerId
  const { data: peerId } = useReadContract({
    address: portalAddress as `0x${string}`,
    abi: PORTAL_ABI,
    functionName: "getPeerId",
  });

  if (!portalInfo) {
    return (
      <div className="bg-white rounded-lg border border-sqd-divider p-5 animate-pulse">
        <div className="h-4 bg-gray-200 rounded w-3/4 mb-4"></div>
        <div className="h-4 bg-gray-200 rounded w-1/2 mb-4"></div>
        <div className="h-2 bg-gray-200 rounded w-full mb-4"></div>
        <div className="h-8 bg-gray-200 rounded w-full"></div>
      </div>
    );
  }

  const stateNum = portalInfo.state;
  const stateName = STATE_NAMES[stateNum] || "Unknown";

  // Filter logic
  if (filterState !== "all") {
    const filterMap: Record<string, number> = {
      collecting: 0,
      active: 1,
      failed: 2,
    };
    if (stateNum !== filterMap[filterState]) {
      return null;
    }
  }

  const capacity = Number(formatUnits(portalInfo.capacity, 18));
  const totalStaked = Number(formatUnits(portalInfo.totalStaked, 18));
  const activeStakeAmount = activeStake ? Number(formatUnits(activeStake, 18)) : totalStaked;
  const progress = capacity > 0 ? (totalStaked / capacity) * 100 : 0;

  const stateColors: Record<string, string> = {
    "Accepting Tokens": "bg-blue-100 text-blue-700 border-blue-200",
    Active: "bg-green-100 text-green-700 border-green-200",
    Inactive: "bg-red-100 text-red-700 border-red-200",
  };

  const progressColors: Record<string, string> = {
    "Accepting Tokens": "bg-blue-500",
    Active: "bg-green-500",
    Inactive: "bg-red-500",
  };

  // Deadline is in block number, not timestamp
  const deadlineBlock = Number(portalInfo.depositDeadline);

  return (
    <div
      className="bg-white rounded-lg border border-sqd-divider p-5 hover:shadow-md transition-shadow cursor-pointer"
      onClick={onClick}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1 min-w-0">
          <div className="text-xs text-sqd-text-secondary mb-1">Portal</div>
          <div className="text-sm font-mono text-sqd-text-primary truncate">
            {portalAddress.slice(0, 6)}...{portalAddress.slice(-4)}
          </div>
        </div>
        <div
          className={`px-2.5 py-1 rounded-full text-xs font-medium border ${
            stateColors[stateName] || stateColors["Accepting Tokens"]
          }`}
        >
          {stateName}
        </div>
      </div>

      {/* Progress Bar (only for Accepting Tokens state) */}
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
          <span className="text-xs text-sqd-text-secondary">Max Capacity</span>
          <span className="text-sm font-medium text-sqd-text-primary">
            {capacity.toLocaleString()} SQD
          </span>
        </div>

        <div className="flex justify-between items-center">
          <span className="text-xs text-sqd-text-secondary">Total Staked</span>
          <span className="text-sm font-medium text-sqd-text-primary">
            {totalStaked.toLocaleString()} SQD
          </span>
        </div>

        {stateNum === 1 && activeStakeAmount !== totalStaked && (
          <div className="flex justify-between items-center">
            <span className="text-xs text-sqd-text-secondary">Active Stake</span>
            <span className="text-sm font-medium text-sqd-accent">
              {activeStakeAmount.toLocaleString()} SQD
            </span>
          </div>
        )}

        {stateNum === 0 && (
          <div className="flex justify-between items-center">
            <span className="text-xs text-sqd-text-secondary">Deadline Block</span>
            <span className="text-sm font-medium text-sqd-text-primary">#{deadlineBlock}</span>
          </div>
        )}

        {portalInfo.paused && (
          <div className="flex justify-between items-center">
            <span className="text-xs text-red-600">⚠️ Portal Paused</span>
          </div>
        )}
      </div>

      {/* Action Button */}
      <button
        className="w-full mt-4 bg-sqd-accent hover:bg-sqd-accent/90 text-white py-2 rounded-full text-sm font-medium transition-colors"
        onClick={(e) => {
          e.stopPropagation();
          onClick?.();
        }}
      >
        View Details
      </button>
    </div>
  );
}
