"use client";

import { useReadContract } from "wagmi";
import { PORTAL_ABI, STATE_NAMES } from "@/config/contracts";
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

export function PortalDashboard({ portalAddress }: { portalAddress: `0x${string}` }) {
  // Read portal info
  const { data: portalInfo } = useReadContract({
    address: portalAddress,
    abi: PORTAL_ABI,
    functionName: "getPortalInfo",
  }) as { data: PortalInfo | undefined };

  // Read active stake
  const { data: activeStake } = useReadContract({
    address: portalAddress,
    abi: PORTAL_ABI,
    functionName: "getActiveStake",
  });

  const state = portalInfo?.state;
  const totalStaked = portalInfo?.totalStaked;
  const maxCapacity = portalInfo?.maxCapacity;
  const activeStakeAmount = activeStake as bigint | undefined;

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-medium text-sqd-text-primary">Portal Overview</h2>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <MetricCard
          title="Portal State"
          value={state !== undefined ? STATE_NAMES[state] : "Loading..."}
        />

        <MetricCard
          title="Total SQD Staked"
          value={totalStaked ? Number(formatUnits(totalStaked, 18)).toLocaleString() : "0"}
          suffix="SQD"
        />

        <MetricCard
          title="Active Stake"
          value={activeStakeAmount ? Number(formatUnits(activeStakeAmount, 18)).toLocaleString() : "0"}
          suffix="SQD"
        />
      </div>

      <div className="bg-white rounded-lg p-4 border border-sqd-divider">
        <h3 className="text-sm font-medium mb-3 text-sqd-text-primary">Capacity Information</h3>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-sqd-text-secondary">Max Capacity:</span>
            <span className="font-medium text-sqd-text-primary">
              {maxCapacity ? Number(formatUnits(maxCapacity, 18)).toLocaleString() : "0"} SQD
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-sqd-text-secondary">Capacity Utilization:</span>
            <span className="font-medium text-sqd-text-primary">
              {totalStaked && maxCapacity
                ? `${((Number(totalStaked) / Number(maxCapacity)) * 100).toFixed(2)}%`
                : "0%"}
            </span>
          </div>
          {activeStakeAmount && totalStaked && activeStakeAmount !== totalStaked && (
            <div className="flex justify-between">
              <span className="text-sqd-text-secondary">Pending Exits:</span>
              <span className="font-medium text-sqd-accent">
                {Number(formatUnits(totalStaked - activeStakeAmount, 18)).toLocaleString()} SQD
              </span>
            </div>
          )}
          {portalInfo?.paused && (
            <div className="flex justify-between">
              <span className="text-red-600 font-medium">⚠️ Portal is Paused</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MetricCard({
  title,
  value,
  suffix,
}: {
  title: string;
  value: string | number;
  suffix?: string;
}) {
  return (
    <div className="bg-sqd-primary rounded-lg p-4 border border-sqd-divider">
      <div className="text-xs text-sqd-text-secondary mb-2 font-medium">{title}</div>
      <div className="text-2xl font-medium text-sqd-text-primary">
        {value}
        {suffix && <span className="text-base ml-1.5 text-sqd-text-secondary font-normal">{suffix}</span>}
      </div>
    </div>
  );
}
