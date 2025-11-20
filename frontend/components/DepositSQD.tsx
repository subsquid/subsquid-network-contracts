"use client";

import { useState } from "react";
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { PORTAL_POOL_ABI, ERC20_ABI, contractAddresses } from "@/config/contracts";
import { parseUnits, formatUnits } from "viem";

export function DepositSQD({ portalAddress }: { portalAddress: `0x${string}` }) {
  const { address } = useAccount();
  const [amount, setAmount] = useState("");
  const { writeContract, data: hash, isPending } = useWriteContract();
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({ hash });

  const { data: userBalance } = useReadContract({
    address: contractAddresses.sqdToken as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
  });

  const { data: stakedBalance } = useReadContract({
    address: portalAddress,
    abi: PORTAL_POOL_ABI,
    functionName: "balances",
    args: address ? [address] : undefined,
  });

  const { data: allowance } = useReadContract({
    address: contractAddresses.sqdToken as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: address ? [address, portalAddress] : undefined,
  });

  const handleApprove = async () => {
    if (!amount) return;

    writeContract({
      address: contractAddresses.sqdToken as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [portalAddress, parseUnits(amount, 18)],
    });
  };

  const handleDeposit = async () => {
    if (!amount) return;

    writeContract({
      address: portalAddress,
      abi: PORTAL_POOL_ABI,
      functionName: "depositSQD",
      args: [parseUnits(amount, 18)],
    });
  };

  const needsApproval = !allowance || (amount && allowance < parseUnits(amount, 18));

  return (
    <div className="bg-white rounded-lg p-4 border border-sqd-divider">
      <h3 className="text-base font-medium mb-4 text-sqd-text-primary">Stake SQD</h3>

      <div className="space-y-3">
        <div>
          <div className="flex justify-between mb-2">
            <label className="text-sm text-sqd-text-secondary font-medium">Amount</label>
            <span className="text-xs text-sqd-text-secondary">
              Balance: {userBalance ? formatUnits(userBalance as bigint, 18) : "0"} SQD
            </span>
          </div>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.0"
            className="w-full bg-white border border-sqd-divider rounded-lg px-3.5 py-2.5 text-sqd-text-primary text-base placeholder-sqd-text-disabled focus:outline-none focus:border-sqd-secondary transition-colors"
          />
        </div>

        {address ? (
          <div className="space-y-2">
            {needsApproval && (
              <button
                onClick={handleApprove}
                disabled={!amount || isPending || isConfirming}
                className="w-full bg-sqd-primary hover:bg-sqd-divider disabled:opacity-50 disabled:cursor-not-allowed text-sqd-text-primary text-sm font-medium py-2.5 rounded-full transition-colors"
              >
                {isPending || isConfirming ? "Approving..." : "Approve SQD"}
              </button>
            )}
            <button
              onClick={handleDeposit}
              disabled={!amount || needsApproval || isPending || isConfirming}
              className="w-full bg-sqd-accent hover:bg-sqd-accent/90 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold py-2.5 rounded-full transition-colors"
            >
              {isPending || isConfirming ? "Depositing..." : "Deposit SQD"}
            </button>
          </div>
        ) : (
          <button
            disabled
            className="w-full bg-sqd-primary text-sqd-text-disabled text-sm font-medium py-2.5 rounded-full cursor-not-allowed"
          >
            Connect Wallet
          </button>
        )}

        {stakedBalance && Number(stakedBalance) > 0 && (
          <div className="pt-3 border-t border-sqd-divider">
            <div className="flex justify-between text-sm">
              <span className="text-sqd-text-secondary">Your Staked Balance:</span>
              <span className="font-medium text-sqd-text-primary">
                {formatUnits(stakedBalance as bigint, 18)} SQD
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
