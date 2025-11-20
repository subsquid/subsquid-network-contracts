"use client";

import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { PORTAL_POOL_ABI } from "@/config/contracts";
import { formatUnits } from "viem";

export function ClaimRewards({ portalAddress }: { portalAddress: `0x${string}` }) {
  const { address } = useAccount();
  const { writeContract, data: hash, isPending } = useWriteContract();
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({ hash });

  const { data: pendingRewards, refetch } = useReadContract({
    address: portalAddress,
    abi: PORTAL_POOL_ABI,
    functionName: "pendingRewards",
    args: address ? [address] : undefined,
  });

  const handleClaim = async () => {
    writeContract({
      address: portalAddress,
      abi: PORTAL_POOL_ABI,
      functionName: "claimRewards",
    });
  };

  const hasPendingRewards = pendingRewards && Number(pendingRewards) > 0;

  return (
    <div className="bg-white rounded-lg p-4 border border-sqd-divider">
      <h3 className="text-base font-medium mb-4 text-sqd-text-primary">Claim Rewards</h3>

      <div className="space-y-3">
        <div className="bg-sqd-primary rounded-lg p-4">
          <div className="text-xs text-sqd-text-secondary mb-2 font-medium">Your Pending Rewards</div>
          <div className="text-2xl font-medium text-sqd-text-primary">
            {pendingRewards ? formatUnits(pendingRewards as bigint, 6) : "0"}
            <span className="text-base text-sqd-text-secondary ml-1.5 font-normal">Tokens</span>
          </div>
        </div>

        {address ? (
          <button
            onClick={handleClaim}
            disabled={!hasPendingRewards || isPending || isConfirming}
            className="w-full bg-sqd-accent hover:bg-sqd-accent/90 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold py-2.5 rounded-full transition-colors"
          >
            {isPending || isConfirming
              ? "Claiming..."
              : hasPendingRewards
              ? "Claim Rewards"
              : "No Rewards to Claim"}
          </button>
        ) : (
          <button
            disabled
            className="w-full bg-sqd-primary text-sqd-text-disabled text-sm font-medium py-2.5 rounded-full cursor-not-allowed"
          >
            Connect Wallet
          </button>
        )}
      </div>
    </div>
  );
}
