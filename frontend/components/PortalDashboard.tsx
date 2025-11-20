"use client";

import { useReadContract } from "wagmi";
import { PORTAL_POOL_ABI, STATE_NAMES } from "@/config/contracts";
import { formatUnits } from "viem";

export function PortalDashboard({ portalAddress }: { portalAddress: `0x${string}` }) {
  const { data: state } = useReadContract({
    address: portalAddress,
    abi: PORTAL_POOL_ABI,
    functionName: "state",
  });

  const { data: totalActiveSQD } = useReadContract({
    address: portalAddress,
    abi: PORTAL_POOL_ABI,
    functionName: "totalActiveSQD",
  });

  const { data: totalRewards } = useReadContract({
    address: portalAddress,
    abi: PORTAL_POOL_ABI,
    functionName: "totalRewardsDistributed",
  });

  const { data: targetSQD } = useReadContract({
    address: portalAddress,
    abi: PORTAL_POOL_ABI,
    functionName: "targetSQD",
  });

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-medium text-sqd-text-primary">Portal Overview</h2>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <MetricCard
          title="Portal State"
          value={state !== undefined ? STATE_NAMES[Number(state)] : "Loading..."}
        />

        <MetricCard
          title="Total SQD Staked"
          value={totalActiveSQD ? formatUnits(totalActiveSQD as bigint, 18) : "0"}
          suffix="SQD"
        />

        <MetricCard
          title="Rewards Distributed"
          value={totalRewards ? formatUnits(totalRewards as bigint, 6) : "0"}
          suffix="Tokens"
        />
      </div>

      <div className="bg-white rounded-lg p-4 border border-sqd-divider">
        <h3 className="text-sm font-medium mb-3 text-sqd-text-primary">Target Information</h3>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-sqd-text-secondary">Target SQD:</span>
            <span className="font-medium text-sqd-text-primary">
              {targetSQD ? formatUnits(targetSQD as bigint, 18) : "0"} SQD
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-sqd-text-secondary">Current Progress:</span>
            <span className="font-medium text-sqd-text-primary">
              {totalActiveSQD && targetSQD
                ? `${((Number(totalActiveSQD) / Number(targetSQD)) * 100).toFixed(2)}%`
                : "0%"}
            </span>
          </div>
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
