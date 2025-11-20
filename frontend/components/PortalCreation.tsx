"use client";

import { useState } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContract } from "wagmi";
import { PORTAL_FACTORY_ABI, ERC20_ABI, contractAddresses } from "@/config/contracts";
import { parseUnits } from "viem";

export function PortalCreation({ onPortalCreated }: { onPortalCreated?: () => void }) {
  const { address } = useAccount();
  const [showForm, setShowForm] = useState(false);
  const [targetSQD, setTargetSQD] = useState("");
  const [budget, setBudget] = useState("");
  const [days, setDays] = useState("30");

  const { writeContract, data: hash, isPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  const { data: usdcAllowance } = useReadContract({
    address: contractAddresses.usdcToken,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: address ? [address, contractAddresses.portalFactory] : undefined,
  });

  const handleApprove = async () => {
    if (!budget) return;

    writeContract({
      address: contractAddresses.usdcToken,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [contractAddresses.portalFactory, parseUnits(budget, 6)],
    });
  };

  const handleCreatePortal = async () => {
    if (!targetSQD || !budget || !days || !address) return;

    const depositDeadline = Math.floor(Date.now() / 1000) + parseInt(days) * 24 * 60 * 60;

    writeContract({
      address: contractAddresses.portalFactory,
      abi: PORTAL_FACTORY_ABI,
      functionName: "createPortal",
      args: [
        address,
        parseUnits(targetSQD, 18),
        BigInt(depositDeadline),
        contractAddresses.usdcToken,
        parseUnits(budget, 6),
      ],
    });
  };

  if (isSuccess && onPortalCreated) {
    onPortalCreated();
    setShowForm(false);
    setTargetSQD("");
    setBudget("");
    setDays("30");
  }

  const needsApproval = !usdcAllowance || (budget && usdcAllowance < parseUnits(budget, 6));

  if (!showForm) {
    return (
      <div className="bg-gradient-to-r from-sqd-accent/10 to-sqd-secondary/10 rounded-lg p-6 border border-sqd-accent/20">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-medium text-sqd-text-primary mb-1">Create New Portal</h3>
            <p className="text-sm text-sqd-text-secondary">Launch a new staking portal for your project</p>
          </div>
          <button
            onClick={() => setShowForm(true)}
            className="bg-sqd-accent hover:bg-sqd-accent/90 text-white px-6 py-2.5 rounded-full text-sm font-semibold transition-colors"
          >
            + New Portal
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg p-6 border border-sqd-divider shadow-sm">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-lg font-medium text-sqd-text-primary">Create New Portal</h3>
        <button
          onClick={() => setShowForm(false)}
          className="text-sqd-text-secondary hover:text-sqd-text-primary"
        >
          ✕
        </button>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-sqd-text-secondary mb-2">
            Target SQD Amount (Operational Capacity)
          </label>
          <input
            type="number"
            value={targetSQD}
            onChange={(e) => setTargetSQD(e.target.value)}
            placeholder="100000"
            className="w-full bg-white border border-sqd-divider rounded-lg px-3.5 py-2.5 text-sqd-text-primary placeholder-sqd-text-disabled focus:outline-none focus:border-sqd-secondary"
          />
          <p className="text-xs text-sqd-text-secondary mt-1">
            Portal will collect 120% ({targetSQD ? (parseFloat(targetSQD) * 1.2).toLocaleString() : "0"} SQD) and stake 100% in GatewayRegistry
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-sqd-text-secondary mb-2">
            Budget (USDC Payment to Providers)
          </label>
          <input
            type="number"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            placeholder="10000"
            className="w-full bg-white border border-sqd-divider rounded-lg px-3.5 py-2.5 text-sqd-text-primary placeholder-sqd-text-disabled focus:outline-none focus:border-sqd-secondary"
          />
          <p className="text-xs text-sqd-text-secondary mt-1">
            Payment tokens for SQD liquidity providers (70% to providers, 30% to workers)
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-sqd-text-secondary mb-2">
            Collection Period (Days)
          </label>
          <input
            type="number"
            value={days}
            onChange={(e) => setDays(e.target.value)}
            placeholder="30"
            className="w-full bg-white border border-sqd-divider rounded-lg px-3.5 py-2.5 text-sqd-text-primary placeholder-sqd-text-disabled focus:outline-none focus:border-sqd-secondary"
          />
          <p className="text-xs text-sqd-text-secondary mt-1">
            Time window for liquidity providers to deposit SQD
          </p>
        </div>

        {address ? (
          <div className="space-y-2 pt-2">
            {needsApproval && (
              <button
                onClick={handleApprove}
                disabled={!budget || isPending || isConfirming}
                className="w-full bg-sqd-primary hover:bg-sqd-divider disabled:opacity-50 disabled:cursor-not-allowed text-sqd-text-primary text-sm font-medium py-2.5 rounded-full transition-colors"
              >
                {isPending || isConfirming ? "Approving USDC..." : "Approve USDC"}
              </button>
            )}
            <button
              onClick={handleCreatePortal}
              disabled={!targetSQD || !budget || needsApproval || isPending || isConfirming}
              className="w-full bg-sqd-accent hover:bg-sqd-accent/90 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold py-2.5 rounded-full transition-colors"
            >
              {isPending || isConfirming ? "Creating Portal..." : "Create Portal"}
            </button>
          </div>
        ) : (
          <button
            disabled
            className="w-full bg-sqd-primary text-sqd-text-disabled text-sm font-medium py-2.5 rounded-full cursor-not-allowed"
          >
            Connect Wallet to Create
          </button>
        )}
      </div>

      <div className="mt-6 p-4 bg-sqd-primary rounded-lg">
        <h4 className="text-sm font-medium text-sqd-text-primary mb-2">What happens next?</h4>
        <ul className="space-y-1.5 text-xs text-sqd-text-secondary">
          <li>• Portal collects SQD from liquidity providers (120% of target)</li>
          <li>• Once target met, portal stakes 100% in GatewayRegistry</li>
          <li>• Keeps 20% buffer for instant exits (Kiln pattern)</li>
          <li>• You distribute payments to providers over time</li>
        </ul>
      </div>
    </div>
  );
}
