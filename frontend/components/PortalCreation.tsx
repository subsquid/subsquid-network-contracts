"use client";

import { useState } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContract, useBlockNumber } from "wagmi";
import { PORTAL_FACTORY_ABI, contractAddresses, targetChainId } from "@/config/contracts";
import { parseUnits, toHex, stringToHex } from "viem";

export function PortalCreation({ onPortalCreated }: { onPortalCreated?: () => void }) {
  const { address } = useAccount();
  const [showForm, setShowForm] = useState(false);
  const [maxCapacity, setMaxCapacity] = useState("");
  const [peerId, setPeerId] = useState("");
  const [blocksUntilDeadline, setBlocksUntilDeadline] = useState("50000"); // ~7 days at 12s/block

  const { writeContract, data: hash, isPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });
  const { data: currentBlock } = useBlockNumber();

  const handleCreatePortal = async () => {
    if (!maxCapacity || !blocksUntilDeadline || !address) return;

    // Calculate deposit deadline as block number
    const depositDeadline = currentBlock
      ? currentBlock + BigInt(blocksUntilDeadline)
      : BigInt(Date.now() / 1000) + BigInt(blocksUntilDeadline); // Fallback

    // Default payment tokens: USDC
    const paymentTokens = [contractAddresses.usdcToken];

    // PeerId as bytes (use a default if not provided)
    const peerIdBytes = peerId ? stringToHex(peerId) : stringToHex(`portal-${Date.now()}`);

    writeContract({
      address: contractAddresses.portalFactory,
      abi: PORTAL_FACTORY_ABI,
      functionName: "createPortal",
      args: [
        address,                          // operator
        paymentTokens,                    // paymentTokens array
        parseUnits(maxCapacity, 18),      // maxCapacity
        depositDeadline,                  // depositDeadline (block number)
        peerIdBytes,                      // peerId as bytes
      ],
      chainId: targetChainId,
    });
  };

  if (isSuccess && onPortalCreated) {
    onPortalCreated();
    setShowForm(false);
    setMaxCapacity("");
    setPeerId("");
    setBlocksUntilDeadline("50000");
  }

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
            Max Capacity (SQD)
          </label>
          <input
            type="number"
            value={maxCapacity}
            onChange={(e) => setMaxCapacity(e.target.value)}
            placeholder="100000"
            className="w-full bg-white border border-sqd-divider rounded-lg px-3.5 py-2.5 text-sqd-text-primary placeholder-sqd-text-disabled focus:outline-none focus:border-sqd-secondary"
          />
          <p className="text-xs text-sqd-text-secondary mt-1">
            Maximum SQD that can be staked in this portal (min: 100,000 SQD)
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-sqd-text-secondary mb-2">
            Peer ID (Optional)
          </label>
          <input
            type="text"
            value={peerId}
            onChange={(e) => setPeerId(e.target.value)}
            placeholder="my-portal-peer-id"
            className="w-full bg-white border border-sqd-divider rounded-lg px-3.5 py-2.5 text-sqd-text-primary placeholder-sqd-text-disabled focus:outline-none focus:border-sqd-secondary"
          />
          <p className="text-xs text-sqd-text-secondary mt-1">
            Identifier for the gateway node (auto-generated if empty)
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-sqd-text-secondary mb-2">
            Collection Period (Blocks)
          </label>
          <input
            type="number"
            value={blocksUntilDeadline}
            onChange={(e) => setBlocksUntilDeadline(e.target.value)}
            placeholder="50000"
            className="w-full bg-white border border-sqd-divider rounded-lg px-3.5 py-2.5 text-sqd-text-primary placeholder-sqd-text-disabled focus:outline-none focus:border-sqd-secondary"
          />
          <p className="text-xs text-sqd-text-secondary mt-1">
            Number of blocks from now until deposit deadline (~{Math.round(parseInt(blocksUntilDeadline || "0") * 12 / 86400)} days at 12s/block)
          </p>
        </div>

        {address ? (
          <div className="space-y-2 pt-2">
            <button
              onClick={handleCreatePortal}
              disabled={!maxCapacity || isPending || isConfirming}
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
          <li>• Portal collects SQD from liquidity providers until deadline</li>
          <li>• You can manually activate the portal once enough SQD is staked</li>
          <li>• Portal auto-activates when max capacity is reached</li>
          <li>• You distribute payment tokens to providers over time</li>
          <li>• Providers earn fees based on their active stake</li>
        </ul>
      </div>
    </div>
  );
}
