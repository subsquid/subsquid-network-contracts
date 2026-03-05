"use client";

import { useState, useEffect } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContract, useChainId } from "wagmi";
import { ERC20_ABI, contractAddresses, targetChainId } from "@/config/contracts";
import { parseUnits, formatUnits } from "viem";

const MINT_ABI = [
  {
    inputs: [
      { internalType: "address", name: "to", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "mint",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

export function MintSQD() {
  const [showModal, setShowModal] = useState(false);

  if (!showModal) {
    return (
      <button
        onClick={() => setShowModal(true)}
        className="bg-sqd-accent hover:bg-sqd-accent/90 text-white px-6 py-2.5 rounded-full text-sm font-semibold transition-colors"
      >
        Mint SQD
      </button>
    );
  }

  return <MintSQDModal onClose={() => setShowModal(false)} />;
}

function MintSQDModal({ onClose }: { onClose: () => void }) {
  const { address } = useAccount();
  const chainId = useChainId();
  const [recipient, setRecipient] = useState("0xd409943eD69aDe02d0B25D0cbc47dc43b7391c34");
  const [amount, setAmount] = useState("100000000"); // 100 million

  const { writeContract, data: hash, isPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  // Read current balance with refetch capability
  const { data: balance, refetch: refetchBalance } = useReadContract({
    address: contractAddresses.sqdToken,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: recipient ? [recipient as `0x${string}`] : undefined,
  });

  const isWrongChain = chainId !== targetChainId;

  // refresh balance after successful mint
  useEffect(() => {
    if (isSuccess) {
      refetchBalance();
      // close modal after 2 seconds
      setTimeout(() => {
        onClose();
      }, 2000);
    }
  }, [isSuccess, refetchBalance, onClose]);

  const handleMint = async () => {
    if (!recipient || !amount) return;

    if (isWrongChain) {
      alert("Please switch to Arbitrum Sepolia network");
      return;
    }

    const amountWei = parseUnits(amount, 18);

    writeContract({
      address: contractAddresses.sqdToken,
      abi: MINT_ABI,
      functionName: "mint",
      args: [recipient as `0x${string}`, amountWei],
      chainId: targetChainId,
    });
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-md w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-sqd-divider p-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-semibold text-sqd-text-primary mb-1">Mint SQD Tokens</h2>
              <p className="text-sm text-sqd-text-secondary">Mana: 1000</p>
            </div>
            <button
              onClick={onClose}
              className="text-sqd-text-secondary hover:text-sqd-text-primary text-2xl"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-sqd-text-secondary mb-2">
              Recipient Address
            </label>
            <input
              type="text"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="0x..."
              className="w-full bg-white border border-sqd-divider rounded-lg px-3.5 py-2.5 text-sqd-text-primary placeholder-sqd-text-disabled focus:outline-none focus:border-sqd-accent font-mono text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-sqd-text-secondary mb-2">
              Amount (SQD)
            </label>
            <input
              type="text"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="100000000"
              className="w-full bg-white border border-sqd-divider rounded-lg px-3.5 py-2.5 text-sqd-text-primary placeholder-sqd-text-disabled focus:outline-none focus:border-sqd-accent"
            />
            <p className="text-xs text-sqd-text-secondary mt-1">
              Enter amount without decimals (e.g., 100000000 for 100M SQD)
            </p>
          </div>

          {balance && (
            <div className="p-3 bg-sqd-primary rounded-lg">
              <div className="text-xs text-sqd-text-secondary mb-1">Current Balance</div>
              <div className="text-lg font-semibold text-sqd-accent">
                {formatUnits(balance, 18).replace(/\.?0+$/, "")} SQD
              </div>
            </div>
          )}

          {isWrongChain && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
              <p className="text-sm text-yellow-800">
                ⚠️ Please switch to Arbitrum Sepolia network
              </p>
            </div>
          )}

          {address ? (
            <button
              onClick={handleMint}
              disabled={!recipient || !amount || isPending || isConfirming || isWrongChain}
              className="w-full bg-sqd-accent hover:bg-sqd-accent/90 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold py-2.5 rounded-full transition-colors"
            >
              {isPending || isConfirming
                ? "Minting..."
                : isSuccess
                  ? "Minted Successfully!"
                  : "Mint SQD Tokens"}
            </button>
          ) : (
            <button
              disabled
              className="w-full bg-sqd-primary text-sqd-text-disabled text-sm font-medium py-2.5 rounded-full cursor-not-allowed"
            >
              Connect Wallet to Mint
            </button>
          )}

          {isSuccess && hash && (
            <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded-lg">
              <p className="text-sm text-green-800 mb-2">✅ Transaction successful!</p>
              <a
                href={`https://sepolia.arbiscan.io/tx/${hash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-green-600 hover:underline font-mono"
              >
                View on Arbiscan: {hash.slice(0, 10)}...{hash.slice(-8)}
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

