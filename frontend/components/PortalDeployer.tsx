"use client";

import { useState, useEffect, useRef } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContract, useChainId, useSwitchChain, useBlockNumber, usePublicClient } from "wagmi";
import { PORTAL_FACTORY_ABI, ERC20_ABI, contractAddresses, targetChainId } from "@/config/contracts";
import { parseUnits, formatUnits, stringToHex } from "viem";
import { useMock } from "@/context/MockContext";

// Helper to save portal metadata to localStorage
function savePortalMetadata(portalAddress: string, metadata: { expectedRatePerDay: string; rateType: "day" | "month" }) {
  try {
    const existing = JSON.parse(localStorage.getItem("portal-metadata") || "{}");
    existing[portalAddress.toLowerCase()] = metadata;
    localStorage.setItem("portal-metadata", JSON.stringify(existing));
  } catch (e) {
    console.error("Failed to save portal metadata:", e);
  }
}

// Helper to get portal metadata from localStorage
export function getPortalMetadata(portalAddress: string): { expectedRatePerDay: string; rateType: "day" | "month" } | null {
  try {
    const existing = JSON.parse(localStorage.getItem("portal-metadata") || "{}");
    return existing[portalAddress.toLowerCase()] || null;
  } catch (e) {
    console.error("Failed to load portal metadata:", e);
    return null;
  }
}

export function PortalDeployer({ onPortalCreated }: { onPortalCreated?: () => void }) {
  const { address } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const publicClient = usePublicClient();
  const [showForm, setShowForm] = useState(false);
  const hasHandledSuccess = useRef(false);
  const pendingMetadata = useRef<{ expectedRate: string; rateType: "day" | "month" } | null>(null);

  // Mock context
  const { isMockMode, addMockPortal, mockMinStakeThreshold, mockUserAddress } = useMock();

  // Form state
  const [capacityMultiplier, setCapacityMultiplier] = useState(10);
  const [customCapacity, setCustomCapacity] = useState(1000000); // For mock mode - direct SQD amount
  const [collectionDays, setCollectionDays] = useState(30);
  const [preDepositAmount, setPreDepositAmount] = useState("");
  const [enablePreDeposit, setEnablePreDeposit] = useState(false);
  const [selectedTokens, setSelectedTokens] = useState<string[]>([contractAddresses.usdcToken]);
  const [description, setDescription] = useState("");

  // Expected USDC rate state
  const [expectedRate, setExpectedRate] = useState("");
  const [rateType, setRateType] = useState<"day" | "month">("day");

  const { writeContract, data: hash, isPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess, data: receipt } = useWaitForTransactionReceipt({ hash });
  const { data: currentBlock } = useBlockNumber();

  const isWrongChain = chainId !== targetChainId;

  // Read minimum stake threshold from network controller (or use mock)
  const { data: minStakeThresholdReal } = useReadContract({
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
    query: { enabled: !isMockMode },
  });

  const minStakeThreshold = isMockMode ? mockMinStakeThreshold : minStakeThresholdReal;
  const minStake = minStakeThreshold ? Number(formatUnits(minStakeThreshold, 18)) : 100000;
  // In mock mode, use customCapacity directly; otherwise use multiplier
  const capacity = isMockMode ? customCapacity : minStake * capacityMultiplier;

  // Calculate expected APY for display
  const calculateExpectedAPY = () => {
    if (!expectedRate || !capacity) return 0;
    const rateNum = parseFloat(expectedRate);
    const annualRate = rateType === "day" ? rateNum * 365 : rateNum * 12;
    // Assuming SQD price of $0.01 for display
    const sqdValue = capacity * 0.01;
    if (sqdValue === 0) return 0;
    return ((annualRate / sqdValue) * 100).toFixed(2);
  };

  // Calculate effective multiplier for mock mode
  const effectiveMultiplier = isMockMode ? customCapacity / 100000 : capacityMultiplier;

  const getTemperatureColor = () => {
    if (effectiveMultiplier <= 1) return "from-red-500 to-red-600";
    if (effectiveMultiplier <= 3) return "from-orange-500 to-orange-600";
    if (effectiveMultiplier <= 7) return "from-yellow-500 to-yellow-600";
    if (effectiveMultiplier <= 10) return "from-green-500 to-green-600";
    return "from-blue-500 to-blue-600";
  };

  const getCapacityLabel = () => {
    if (effectiveMultiplier <= 1) return "Low CUs Amount";
    if (effectiveMultiplier <= 3) return "Medium CUs";
    if (effectiveMultiplier <= 7) return "Good CUs";
    if (effectiveMultiplier <= 10) return "Optimal Amount";
    return "Maximum Capacity";
  };

  const getCUEstimate = () => {
    return Math.floor(capacity / 10); // 10 SQD = 1 CU
  };

  const { data: sqdAllowance } = useReadContract({
    address: contractAddresses.sqdToken,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: address ? [address, contractAddresses.gatewayRegistry] : undefined,
    query: { enabled: !isMockMode && !!address },
  });

  const handleApproveSQD = async () => {
    if (!preDepositAmount || !enablePreDeposit) return;

    writeContract({
      address: contractAddresses.sqdToken,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [contractAddresses.gatewayRegistry, parseUnits(preDepositAmount, 18)],
    });
  };

  const handleDeployPortal = async () => {
    const effectiveAddress = isMockMode ? mockUserAddress : address;
    if (!effectiveAddress || !description) return;

    // Reset success handler for new transaction
    hasHandledSuccess.current = false;

    // Mock mode - just add to mock state
    if (isMockMode) {
      const ratePerDay = rateType === "day"
        ? parseUnits(expectedRate || "0", 6)
        : parseUnits(expectedRate || "0", 6) / BigInt(30);

      addMockPortal({
        operator: effectiveAddress,
        description,
        capacity: parseUnits(capacity.toString(), 18),
        totalStaked: BigInt(0),
        state: 0,
        depositDeadline: BigInt(Date.now() + collectionDays * 24 * 60 * 60 * 1000),
        activationTime: BigInt(0),
        paused: false,
        paymentTokens: selectedTokens as `0x${string}`[],
        expectedRatePerDay: ratePerDay,
        rateType,
        gradualBalance: BigInt(0),
        gradualRatePerSecond: BigInt(0),
        gradualLastUpdate: Date.now(),
      });

      setShowForm(false);
      resetForm();
      if (onPortalCreated) onPortalCreated();
      return;
    }

    // Real mode - store pending metadata to save after success
    pendingMetadata.current = {
      expectedRate: rateType === "day" ? (expectedRate || "0") : (parseFloat(expectedRate || "0") / 30).toString(),
      rateType: "day", // Always store as per-day rate
    };

    if (isWrongChain && switchChain) {
      try {
        await switchChain({ chainId: targetChainId });
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        console.error("Failed to switch chain:", error);
        return;
      }
    }

    if (chainId !== targetChainId) {
      alert("Please switch to Arbitrum Sepolia network in your wallet");
      return;
    }

    const blocksPerDay = (24 * 60 * 60) / 12;
    const depositDeadline = currentBlock
      ? currentBlock + BigInt(Math.floor(collectionDays * blocksPerDay))
      : BigInt(Math.floor(Date.now() / 1000) + collectionDays * 24 * 60 * 60);

    const peerIdBytes = description ? stringToHex(description) : stringToHex(`portal-${Date.now()}`);

    writeContract({
      address: contractAddresses.portalFactory,
      abi: PORTAL_FACTORY_ABI,
      functionName: "createPortal",
      args: [
        effectiveAddress,
        selectedTokens as `0x${string}`[],
        parseUnits(capacity.toString(), 18),
        depositDeadline,
        peerIdBytes,
      ],
      chainId: targetChainId,
    });
  };

  const resetForm = () => {
    setCapacityMultiplier(10);
    setCustomCapacity(1000000);
    setCollectionDays(30);
    setPreDepositAmount("");
    setEnablePreDeposit(false);
    setDescription("");
    setExpectedRate("");
    setRateType("day");
  };

  useEffect(() => {
    if (isSuccess && !hasHandledSuccess.current) {
      hasHandledSuccess.current = true;

      // Try to extract portal address from transaction logs and save metadata
      if (receipt && receipt.logs && pendingMetadata.current) {
        // PortalCreated event has portal address as first indexed topic
        const portalCreatedLog = receipt.logs.find(log =>
          log.address.toLowerCase() === contractAddresses.portalFactory.toLowerCase()
        );

        if (portalCreatedLog && portalCreatedLog.topics[1]) {
          // Extract portal address from topics (remove padding)
          const portalAddress = "0x" + portalCreatedLog.topics[1].slice(26);
          console.log("New portal created at:", portalAddress);

          // Save expected rate to localStorage
          savePortalMetadata(portalAddress, {
            expectedRatePerDay: pendingMetadata.current.expectedRate,
            rateType: pendingMetadata.current.rateType,
          });
        }
        pendingMetadata.current = null;
      }

      setShowForm(false);
      resetForm();
      if (onPortalCreated) {
        onPortalCreated();
      }
    }
  }, [isSuccess, receipt, onPortalCreated]);

  const needsSQDApproval =
    !isMockMode &&
    enablePreDeposit &&
    preDepositAmount &&
    (!sqdAllowance || sqdAllowance < parseUnits(preDepositAmount, 18));

  const effectiveAddress = isMockMode ? mockUserAddress : address;

  if (!showForm) {
    return (
      <div className="bg-gradient-to-r from-sqd-accent/10 to-sqd-secondary/10 rounded-lg p-6 border border-sqd-accent/20">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-medium text-sqd-text-primary mb-1">Deploy New Portal</h3>
            <p className="text-sm text-sqd-text-secondary">
              Launch a staking portal with configurable capacity
            </p>
          </div>
          <button
            onClick={() => setShowForm(true)}
            className="bg-sqd-accent hover:bg-sqd-accent/90 text-white px-6 py-2.5 rounded-full text-sm font-semibold transition-colors"
          >
            + Deploy Portal
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg p-6 border border-sqd-divider shadow-lg">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-lg font-medium text-sqd-text-primary">Deploy New Portal</h3>
        <button
          onClick={() => setShowForm(false)}
          className="text-sqd-text-secondary hover:text-sqd-text-primary"
        >
          X
        </button>
      </div>

      <div className="space-y-6">
        {/* Description Input */}
        <div>
          <label className="block text-sm font-medium text-sqd-text-secondary mb-2">
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="This portal is hosted and maintained by..."
            rows={2}
            className="w-full bg-white border border-sqd-divider rounded-lg px-3.5 py-2.5 text-sqd-text-primary placeholder-sqd-text-disabled focus:outline-none focus:border-sqd-secondary resize-none"
          />
        </div>

        {/* Capacity - Different UI for mock vs real mode */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium text-sqd-text-secondary">Portal Capacity</label>
            <div className="text-right">
              <div className="text-lg font-semibold text-sqd-text-primary">
                {capacity.toLocaleString()} SQD
              </div>
              <div className="text-xs text-sqd-text-secondary">
                {isMockMode ? `${getCUEstimate()} CUs` : `${capacityMultiplier}x Minimum (${getCUEstimate()} CUs)`}
              </div>
            </div>
          </div>

          {isMockMode ? (
            /* Mock Mode: Direct input with 10k steps, max 1.2M */
            <>
              <div
                className={`bg-gradient-to-r ${getTemperatureColor()} rounded-lg p-4 mb-3 text-white text-center font-medium`}
              >
                {getCapacityLabel()}
              </div>

              <div className="flex gap-2 mb-3">
                <input
                  type="number"
                  value={customCapacity}
                  onChange={(e) => setCustomCapacity(Math.min(1200000, Math.max(100000, Number(e.target.value))))}
                  step={10000}
                  min={100000}
                  max={1200000}
                  placeholder="1000000"
                  className="flex-1 bg-white border border-sqd-divider rounded-lg px-3.5 py-2.5 text-sqd-text-primary focus:outline-none focus:border-sqd-secondary"
                />
                <span className="flex items-center text-sqd-text-secondary">SQD</span>
              </div>
              <input
                type="range"
                min={100000}
                max={1200000}
                step={10000}
                value={customCapacity}
                onChange={(e) => setCustomCapacity(Number(e.target.value))}
                className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                style={{
                  background: `linear-gradient(to right, rgb(239 68 68) 0%, rgb(234 179 8) 50%, rgb(34 197 94) 83%, rgb(59 130 246) 100%)`,
                }}
              />
              <div className="flex justify-between text-xs text-sqd-text-secondary mt-1">
                <span>100k (1x)</span>
                <span>1M (10x)</span>
                <span>1.2M (12x)</span>
              </div>
            </>
          ) : (
            /* Real Mode: Multiplier-based slider */
            <>
              <div
                className={`bg-gradient-to-r ${getTemperatureColor()} rounded-lg p-4 mb-3 text-white text-center font-medium`}
              >
                {getCapacityLabel()}
              </div>

              <input
                type="range"
                min="1"
                max="12"
                step="1"
                value={capacityMultiplier}
                onChange={(e) => setCapacityMultiplier(Number(e.target.value))}
                className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                style={{
                  background: `linear-gradient(to right, rgb(239 68 68) 0%, rgb(234 179 8) 50%, rgb(34 197 94) 83%, rgb(59 130 246) 100%)`,
                }}
              />
              <div className="flex justify-between text-xs text-sqd-text-secondary mt-1">
                <span>1x (Min)</span>
                <span>10x (Optimal)</span>
                <span>12x (Max)</span>
              </div>
            </>
          )}

          <div className="mt-3 p-3 bg-sqd-primary rounded-lg text-xs text-sqd-text-secondary">
            <div className="flex justify-between mb-1">
              <span>Minimum Threshold:</span>
              <span className="font-medium">{minStake.toLocaleString()} SQD</span>
            </div>
            <div className="flex justify-between mb-1">
              <span>Selected Capacity:</span>
              <span className="font-medium">{capacity.toLocaleString()} SQD</span>
            </div>
            <div className="flex justify-between">
              <span>Estimated CUs:</span>
              <span className="font-medium text-sqd-accent">{getCUEstimate()} CUs</span>
            </div>
          </div>
        </div>

        {/* Expected USDC Rate */}
        <div className="border border-blue-200 rounded-lg p-4 bg-blue-50/50">
          <label className="block text-sm font-medium text-sqd-text-primary mb-3">
            Expected Provider Earnings (USDC)
          </label>
          <div className="flex gap-2">
            <input
              type="number"
              value={expectedRate}
              onChange={(e) => setExpectedRate(e.target.value)}
              placeholder="100"
              className="flex-1 bg-white border border-sqd-divider rounded-lg px-3.5 py-2.5 text-sqd-text-primary placeholder-sqd-text-disabled focus:outline-none focus:border-sqd-secondary"
            />
            <select
              value={rateType}
              onChange={(e) => setRateType(e.target.value as "day" | "month")}
              className="bg-white border border-sqd-divider rounded-lg px-3.5 py-2.5 text-sqd-text-primary focus:outline-none focus:border-sqd-secondary"
            >
              <option value="day">per Day</option>
              <option value="month">per Month</option>
            </select>
          </div>
          {expectedRate && (
            <div className="mt-3 p-3 bg-white rounded-lg border border-blue-200">
              <div className="flex justify-between text-sm">
                <span className="text-sqd-text-secondary">Daily Rate:</span>
                <span className="font-medium text-sqd-text-primary">
                  ${rateType === "day" ? expectedRate : (parseFloat(expectedRate) / 30).toFixed(2)} USDC/day
                </span>
              </div>
              <div className="flex justify-between text-sm mt-1">
                <span className="text-sqd-text-secondary">Monthly Rate:</span>
                <span className="font-medium text-sqd-text-primary">
                  ${rateType === "month" ? expectedRate : (parseFloat(expectedRate) * 30).toFixed(2)} USDC/month
                </span>
              </div>
              <div className="flex justify-between text-sm mt-1">
                <span className="text-sqd-text-secondary">Est. APY:</span>
                <span className="font-semibold text-green-600">
                  ~{calculateExpectedAPY()}%
                </span>
              </div>
            </div>
          )}
          <p className="text-xs text-sqd-text-secondary mt-2">
            This is your expected payment to liquidity providers. Displayed to help providers estimate returns.
          </p>
        </div>

        {/* Collection Duration */}
        <div>
          <label className="block text-sm font-medium text-sqd-text-secondary mb-2">
            Collection Period (Days)
          </label>
          <input
            type="number"
            value={collectionDays}
            onChange={(e) => setCollectionDays(Number(e.target.value))}
            placeholder="30"
            className="w-full bg-white border border-sqd-divider rounded-lg px-3.5 py-2.5 text-sqd-text-primary placeholder-sqd-text-disabled focus:outline-none focus:border-sqd-secondary"
          />
          <p className="text-xs text-sqd-text-secondary mt-1">
            Deadline: {new Date(Date.now() + collectionDays * 24 * 60 * 60 * 1000).toLocaleDateString()}
          </p>
        </div>

        {/* Pre-Deposit Option */}
        <div className="border border-sqd-divider rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <label className="text-sm font-medium text-sqd-text-secondary">Pre-Deposit SQD</label>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={enablePreDeposit}
                onChange={(e) => setEnablePreDeposit(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-sqd-accent"></div>
            </label>
          </div>

          {enablePreDeposit && (
            <>
              <input
                type="number"
                value={preDepositAmount}
                onChange={(e) => setPreDepositAmount(e.target.value)}
                placeholder="10000"
                className="w-full bg-white border border-sqd-divider rounded-lg px-3.5 py-2.5 text-sqd-text-primary placeholder-sqd-text-disabled focus:outline-none focus:border-sqd-secondary mb-2"
              />
              <p className="text-xs text-sqd-text-secondary">
                Kickstart your portal by depositing SQD upfront as the operator
              </p>
            </>
          )}
        </div>

        {/* Payment Tokens */}
        <div>
          <label className="block text-sm font-medium text-sqd-text-secondary mb-2">
            Payment Tokens (for fee distribution)
          </label>
          <div className="flex gap-2">
            <div className="px-3 py-2 bg-blue-100 text-blue-700 rounded-lg text-sm font-medium">
              USDC
            </div>
            <div className="px-3 py-2 bg-gray-100 text-gray-400 rounded-lg text-sm">DAI (Coming soon)</div>
            <div className="px-3 py-2 bg-gray-100 text-gray-400 rounded-lg text-sm">USDT (Coming soon)</div>
          </div>
        </div>

        {/* Action Buttons */}
        {effectiveAddress ? (
          <div className="space-y-2 pt-2">
            {!isMockMode && isWrongChain ? (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-2">
                <p className="text-sm text-yellow-800 mb-2">
                  Please switch to Arbitrum Sepolia network
                </p>
                <button
                  onClick={() => switchChain?.({ chainId: targetChainId })}
                  className="w-full bg-yellow-500 hover:bg-yellow-600 text-white text-sm font-medium py-2 rounded-full transition-colors"
                >
                  Switch to Arbitrum Sepolia
                </button>
              </div>
            ) : null}
            {needsSQDApproval && (
              <button
                onClick={handleApproveSQD}
                disabled={!preDepositAmount || isPending || isConfirming || isWrongChain}
                className="w-full bg-sqd-primary hover:bg-sqd-divider disabled:opacity-50 disabled:cursor-not-allowed text-sqd-text-primary text-sm font-medium py-2.5 rounded-full transition-colors"
              >
                {isPending || isConfirming ? "Approving SQD..." : "Approve SQD for Pre-Deposit"}
              </button>
            )}
            <button
              onClick={handleDeployPortal}
              disabled={!description || (enablePreDeposit && needsSQDApproval) || isPending || isConfirming || (!isMockMode && isWrongChain)}
              className="w-full bg-sqd-accent hover:bg-sqd-accent/90 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold py-2.5 rounded-full transition-colors"
            >
              {isPending || isConfirming ? "Deploying Portal..." : isMockMode ? "Deploy Portal (Mock)" : "Deploy Portal"}
            </button>
          </div>
        ) : (
          <button
            disabled
            className="w-full bg-sqd-primary text-sqd-text-disabled text-sm font-medium py-2.5 rounded-full cursor-not-allowed"
          >
            {isMockMode ? "Mock Mode Active" : "Connect Wallet to Deploy"}
          </button>
        )}
      </div>

      {/* Info Box */}
      <div className="mt-6 p-4 bg-sqd-primary rounded-lg">
        <h4 className="text-sm font-medium text-sqd-text-primary mb-2">How it works</h4>
        <ul className="space-y-1.5 text-xs text-sqd-text-secondary">
          <li>Portal collects SQD from liquidity providers until capacity is met</li>
          <li>Once activated, portal stakes 100% in GatewayRegistry</li>
          <li>CUs (Compute Units) are calculated: 10 SQD = 1 CU</li>
          <li>Optimal capacity (10x) maximizes CU efficiency</li>
          <li>Expected rate helps providers estimate their earnings</li>
        </ul>
      </div>
    </div>
  );
}
