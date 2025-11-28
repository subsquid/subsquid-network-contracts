"use client";

import { useState, useEffect } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContract, useChainId } from "wagmi";
import { PORTAL_ABI, GATEWAY_REGISTRY_ABI, NETWORK_CONTROLLER_ABI, ERC20_ABI, contractAddresses, targetChainId } from "@/config/contracts";
import { parseUnits, formatUnits, hexToString } from "viem";
import { getPortalMetadata } from "./PortalDeployer";

interface PortalInfo {
  operator: string;
  maxCapacity: bigint;
  totalStaked: bigint;
  depositDeadline: bigint;
  activationTime: bigint;
  state: number;
  paused: boolean;
}

const STATE_NAMES = ["Accepting Tokens", "Active", "Inactive"];
const MIN_THRESHOLD = 100000; // 100k SQD minimum for CUs

export function PortalInvestment({ portalAddress, onClose }: { portalAddress: string; onClose: () => void }) {
  const { address } = useAccount();
  const chainId = useChainId();
  const [activeTab, setActiveTab] = useState<"stake" | "rewards" | "exit" | "distribution">("stake");
  const [stakeAmount, setStakeAmount] = useState("");
  const [exitAmount, setExitAmount] = useState("");
  const [distributeAmount, setDistributeAmount] = useState("");
  const [distributionToken, setDistributionToken] = useState("");

  const { writeContract, data: hash, isPending, error: writeError } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  // Read portal info
  const { data: portalInfo, refetch: refetchPortalInfo } = useReadContract({
    address: portalAddress as `0x${string}`,
    abi: PORTAL_ABI,
    functionName: "getPortalInfo",
  }) as { data: PortalInfo | undefined; refetch: () => void };

  // Read description from peerId
  const { data: peerIdBytes } = useReadContract({
    address: portalAddress as `0x${string}`,
    abi: PORTAL_ABI,
    functionName: "getPeerId",
  }) as { data: `0x${string}` | undefined };

  // Read user's stake
  const { data: userStake, refetch: refetchUserStake } = useReadContract({
    address: portalAddress as `0x${string}`,
    abi: PORTAL_ABI,
    functionName: "getProviderStake",
    args: address ? [address] : undefined,
  });

  // Read allowed payment tokens
  const { data: paymentTokens } = useReadContract({
    address: portalAddress as `0x${string}`,
    abi: PORTAL_ABI,
    functionName: "getAllowedPaymentTokens",
  }) as { data: string[] | undefined };

  // Read SQD allowance for GatewayRegistry
  const { data: sqdAllowance, refetch: refetchAllowance } = useReadContract({
    address: contractAddresses.sqdToken,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: address ? [address, contractAddresses.gatewayRegistry] : undefined,
  });

  // Read SQD balance
  const { data: sqdBalance } = useReadContract({
    address: contractAddresses.sqdToken,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
  });

  // Read USDC balance
  const { data: usdcBalance } = useReadContract({
    address: contractAddresses.usdcToken,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
  });

  // Read current epoch
  const { data: currentEpoch } = useReadContract({
    address: contractAddresses.networkController,
    abi: NETWORK_CONTROLLER_ABI,
    functionName: "epochNumber",
  });

  // Read exit request from Portal
  const { data: exitRequest, refetch: refetchExitRequest } = useReadContract({
    address: portalAddress as `0x${string}`,
    abi: PORTAL_ABI,
    functionName: "getExitRequest",
    args: address ? [address] : undefined,
  }) as { data: { amount: bigint; requestEpoch: bigint; unlockEpoch: bigint } | undefined; refetch: () => void };

  // Read unlock request from GatewayRegistry (for withdrawal)
  const { data: unlockRequest, refetch: refetchUnlockRequest } = useReadContract({
    address: contractAddresses.gatewayRegistry,
    abi: GATEWAY_REGISTRY_ABI,
    functionName: "unlockRequests",
    args: address ? [address] : undefined,
  }) as { data: [bigint, bigint, bigint] | undefined; refetch: () => void };

  // Read claimable fees for USDC
  const { data: claimableUSDC, refetch: refetchClaimable } = useReadContract({
    address: portalAddress as `0x${string}`,
    abi: PORTAL_ABI,
    functionName: "getClaimableFees",
    args: address ? [address, contractAddresses.usdcToken] : undefined,
  });

  // Read USDC allowance for Portal (for distribution)
  const { data: usdcAllowance, refetch: refetchUsdcAllowance } = useReadContract({
    address: contractAddresses.usdcToken,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: address ? [address, portalAddress as `0x${string}`] : undefined,
  });

  // Refresh data after successful transactions
  useEffect(() => {
    if (isSuccess) {
      const timer = setTimeout(() => {
        refetchPortalInfo();
        refetchUserStake();
        refetchAllowance();
        refetchExitRequest();
        refetchUnlockRequest();
        refetchClaimable();
        refetchUsdcAllowance();
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [isSuccess]);

  if (!portalInfo) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4 animate-pulse">
          <div className="h-4 bg-gray-200 rounded w-3/4 mb-4"></div>
          <div className="h-4 bg-gray-200 rounded w-1/2"></div>
        </div>
      </div>
    );
  }

  // Parse values
  const maxCapacity = Number(formatUnits(portalInfo.maxCapacity, 18));
  const totalStaked = Number(formatUnits(portalInfo.totalStaked, 18));
  const myStake = userStake ? Number(formatUnits(userStake, 18)) : 0;
  const availableCapacity = maxCapacity - totalStaked;
  const balance = sqdBalance ? Number(formatUnits(sqdBalance, 18)) : 0;
  const meetsThreshold = totalStaked >= MIN_THRESHOLD;
  const cus = meetsThreshold ? Math.floor(totalStaked / 10) : 0;
  const effectiveState = meetsThreshold ? portalInfo.state : 2;
  const isOperator = address?.toLowerCase() === portalInfo.operator.toLowerCase();

  // Parse description from peerId bytes
  let description = "";
  try {
    if (peerIdBytes && peerIdBytes !== "0x") {
      description = hexToString(peerIdBytes);
    }
  } catch (e) {
    console.error("Failed to parse description:", e);
  }

  // Get expected rate from localStorage
  const metadata = getPortalMetadata(portalAddress);
  const expectedRatePerDay = metadata ? parseFloat(metadata.expectedRatePerDay) : 0;

  // Exit request data
  const exitAmount_ = exitRequest?.amount ? Number(formatUnits(exitRequest.amount, 18)) : 0;
  const exitUnlockEpoch = exitRequest?.unlockEpoch ? Number(exitRequest.unlockEpoch) : 0;
  const currentEpochNum = currentEpoch ? Number(currentEpoch) : 0;
  const epochsUntilUnlock = exitUnlockEpoch > 0 ? Math.max(0, exitUnlockEpoch - currentEpochNum) : 0;
  const canWithdraw = exitAmount_ > 0 && epochsUntilUnlock === 0;

  // Claimable USDC
  const claimableUSDCAmount = claimableUSDC ? Number(formatUnits(claimableUSDC, 6)) : 0;

  // Approval checks
  const hasGatewayApproval = sqdAllowance && sqdAllowance > 0n;
  const needsApprovalForStake = stakeAmount && (!sqdAllowance || sqdAllowance < parseUnits(stakeAmount || "0", 18));

  // Distribution approval
  const usdcBalanceNum = usdcBalance ? Number(formatUnits(usdcBalance, 6)) : 0;
  const distributeAmountNum = distributeAmount ? parseFloat(distributeAmount) : 0;
  const needsUsdcApproval = distributeAmountNum > 0 && (!usdcAllowance || usdcAllowance < parseUnits(distributeAmount || "0", 6));

  // Handlers
  const handleApproveGateway = () => {
    if (chainId !== targetChainId) {
      alert("Please switch to Arbitrum Sepolia network");
      return;
    }
    writeContract({
      address: contractAddresses.sqdToken,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [contractAddresses.gatewayRegistry, BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")],
      chainId: targetChainId,
    });
  };

  const handleStake = () => {
    if (!address || !stakeAmount || chainId !== targetChainId) {
      if (chainId !== targetChainId) alert("Please switch to Arbitrum Sepolia network");
      return;
    }
    const amount = parseFloat(stakeAmount);
    if (amount > balance) {
      alert(`Insufficient balance. You have ${balance.toLocaleString()} SQD`);
      return;
    }
    if (amount > availableCapacity) {
      alert(`Amount exceeds portal capacity. Max: ${availableCapacity.toLocaleString()} SQD`);
      return;
    }
    writeContract({
      address: portalAddress as `0x${string}`,
      abi: PORTAL_ABI,
      functionName: "stake",
      args: [parseUnits(stakeAmount, 18)],
      chainId: targetChainId,
    });
    setStakeAmount("");
  };

  const handleRequestExit = () => {
    if (!address || !exitAmount || chainId !== targetChainId) {
      if (chainId !== targetChainId) alert("Please switch to Arbitrum Sepolia network");
      return;
    }
    const amount = parseFloat(exitAmount);
    if (amount > myStake) {
      alert(`Insufficient stake. You have ${myStake.toLocaleString()} SQD staked`);
      return;
    }
    writeContract({
      address: portalAddress as `0x${string}`,
      abi: PORTAL_ABI,
      functionName: "requestExit",
      args: [parseUnits(exitAmount, 18)],
      chainId: targetChainId,
    });
    setExitAmount("");
  };

  const handleWithdraw = () => {
    if (!address || chainId !== targetChainId) {
      if (chainId !== targetChainId) alert("Please switch to Arbitrum Sepolia network");
      return;
    }
    writeContract({
      address: contractAddresses.gatewayRegistry,
      abi: GATEWAY_REGISTRY_ABI,
      functionName: "withdrawUnlocked",
      chainId: targetChainId,
    });
  };

  const handleClaim = () => {
    if (!address || chainId !== targetChainId) {
      if (chainId !== targetChainId) alert("Please switch to Arbitrum Sepolia network");
      return;
    }
    writeContract({
      address: portalAddress as `0x${string}`,
      abi: PORTAL_ABI,
      functionName: "claimFees",
      args: [contractAddresses.usdcToken],
      chainId: targetChainId,
    });
  };

  const handleApproveUSDC = () => {
    if (chainId !== targetChainId) {
      alert("Please switch to Arbitrum Sepolia network");
      return;
    }
    writeContract({
      address: contractAddresses.usdcToken,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [portalAddress as `0x${string}`, BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")],
      chainId: targetChainId,
    });
  };

  const handleDistribute = () => {
    if (!address || !distributeAmount || chainId !== targetChainId) {
      if (chainId !== targetChainId) alert("Please switch to Arbitrum Sepolia network");
      return;
    }
    writeContract({
      address: portalAddress as `0x${string}`,
      abi: PORTAL_ABI,
      functionName: "distributeFees",
      args: [contractAddresses.usdcToken, parseUnits(distributeAmount, 6)],
      chainId: targetChainId,
    });
    setDistributeAmount("");
  };

  // Calculate expected daily earnings based on stake share
  const mySharePercent = totalStaked > 0 ? (myStake / totalStaked) * 100 : 0;
  const myExpectedDaily = totalStaked > 0 ? (expectedRatePerDay * myStake) / totalStaked : 0;

  const tabs = [
    { id: "stake", label: "Stake" },
    { id: "rewards", label: "Rewards" },
    { id: "exit", label: "Exit" },
    ...(isOperator ? [{ id: "distribution", label: "Distribute" }] : []),
  ];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto shadow-2xl">
        {/* Header */}
        <div className="p-6 border-b border-sqd-divider">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-semibold text-sqd-text-primary">Portal Details</h2>
              {description && (
                <p className="text-sm text-sqd-text-secondary mt-1 line-clamp-2">{description}</p>
              )}
              <p className="text-xs text-sqd-text-disabled font-mono mt-1">
                {portalAddress.slice(0, 10)}...{portalAddress.slice(-8)}
              </p>
            </div>
            <button onClick={onClose} className="text-sqd-text-secondary hover:text-sqd-text-primary text-2xl">
              ✕
            </button>
          </div>
        </div>

        {/* Portal Stats */}
        <div className="p-6 bg-gray-50 border-b border-sqd-divider">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <div className="text-xs text-sqd-text-secondary">Status</div>
              <div className={`font-semibold ${effectiveState === 2 ? "text-red-600" : "text-sqd-text-primary"}`}>
                {effectiveState === 1 ? "Active" : effectiveState === 0 ? "Accepting Tokens" : "Insufficient funds"}
              </div>
            </div>
            <div>
              <div className="text-xs text-sqd-text-secondary">Total Staked</div>
              <div className="font-semibold text-sqd-text-primary">{totalStaked.toLocaleString()} SQD</div>
            </div>
            <div>
              <div className="text-xs text-sqd-text-secondary">Your Stake</div>
              <div className="font-semibold text-sqd-accent">{myStake.toLocaleString()} SQD</div>
            </div>
            <div>
              <div className="text-xs text-sqd-text-secondary">Compute Units</div>
              <div className="font-semibold text-sqd-accent">{cus} CUs</div>
            </div>
          </div>

          {/* Expected Rate */}
          {expectedRatePerDay > 0 && (
            <div className="mt-4 p-3 bg-blue-50 rounded-lg border border-blue-200">
              <div className="flex justify-between text-sm">
                <span className="text-blue-700">Expected Rate</span>
                <span className="font-semibold text-blue-800">${expectedRatePerDay.toFixed(2)}/day</span>
              </div>
            </div>
          )}

          {/* Capacity Bar */}
          <div className="mt-4">
            <div className="flex justify-between text-xs text-sqd-text-secondary mb-1">
              <span>Capacity</span>
              <span>{((totalStaked / maxCapacity) * 100).toFixed(1)}%</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className="bg-sqd-accent h-2 rounded-full"
                style={{ width: `${Math.min((totalStaked / maxCapacity) * 100, 100)}%` }}
              />
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-sqd-divider">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as typeof activeTab)}
              className={`flex-1 py-3 text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? "text-sqd-accent border-b-2 border-sqd-accent"
                  : "text-sqd-text-secondary hover:text-sqd-text-primary"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="p-6">
          {/* Stake Tab */}
          {activeTab === "stake" && (
            <div className="space-y-4">
              {/* Approval Section */}
              {address && !hasGatewayApproval && (
                <div className="p-4 bg-yellow-50 rounded-lg border border-yellow-200">
                  <div className="text-sm font-medium text-yellow-800 mb-2">Approval Required</div>
                  <p className="text-xs text-yellow-700 mb-3">
                    You need to approve the GatewayRegistry to stake SQD tokens.
                  </p>
                  <button
                    onClick={handleApproveGateway}
                    disabled={isPending || isConfirming}
                    className="w-full bg-yellow-600 hover:bg-yellow-700 disabled:opacity-50 text-white font-medium py-2 rounded-lg"
                  >
                    {isPending || isConfirming ? "Approving..." : "Approve SQD"}
                  </button>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-sqd-text-secondary mb-2">Stake Amount (SQD)</label>
                <div className="flex gap-2">
                  <input
                    type="number"
                    value={stakeAmount}
                    onChange={(e) => setStakeAmount(e.target.value)}
                    placeholder="0.0"
                    className="flex-1 bg-white border border-sqd-divider rounded-lg px-4 py-3 text-sqd-text-primary focus:outline-none focus:border-sqd-accent"
                  />
                  <button
                    onClick={() => setStakeAmount(Math.min(availableCapacity, balance).toString())}
                    className="px-4 py-2 bg-gray-100 text-sqd-text-secondary rounded-lg hover:bg-gray-200 text-sm"
                  >
                    MAX
                  </button>
                </div>
                <p className="text-xs text-sqd-text-secondary mt-1">
                  Available: {balance.toLocaleString()} SQD | Capacity remaining: {availableCapacity.toLocaleString()} SQD
                </p>
              </div>

              {stakeAmount && Number(stakeAmount) > 0 && (
                <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                  <div className="text-sm text-blue-800">
                    Your share after staking: {(((myStake + Number(stakeAmount)) / (totalStaked + Number(stakeAmount))) * 100).toFixed(2)}%
                  </div>
                  {expectedRatePerDay > 0 && (
                    <div className="text-sm text-blue-700 mt-1">
                      Expected daily earnings: ${((expectedRatePerDay * (myStake + Number(stakeAmount))) / (totalStaked + Number(stakeAmount))).toFixed(2)}
                    </div>
                  )}
                </div>
              )}

              <button
                onClick={handleStake}
                disabled={!stakeAmount || Number(stakeAmount) <= 0 || !hasGatewayApproval || isPending || isConfirming}
                className="w-full bg-sqd-accent hover:bg-sqd-accent/90 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-lg transition-colors"
              >
                {isPending || isConfirming ? "Staking..." : "Stake SQD"}
              </button>

              {writeError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
                  Error: {writeError.message.slice(0, 100)}
                </div>
              )}
            </div>
          )}

          {/* Rewards Tab */}
          {activeTab === "rewards" && (
            <div className="space-y-4">
              <div className="p-4 bg-green-50 rounded-lg border border-green-200">
                <div className="flex justify-between items-center">
                  <div>
                    <div className="text-sm text-green-700">Claimable USDC</div>
                    <div className="text-2xl font-bold text-green-800">${claimableUSDCAmount.toFixed(2)}</div>
                  </div>
                  <button
                    onClick={handleClaim}
                    disabled={claimableUSDCAmount <= 0 || isPending || isConfirming}
                    className="px-6 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg font-medium"
                  >
                    {isPending || isConfirming ? "Claiming..." : "Claim"}
                  </button>
                </div>
              </div>

              <div className="p-4 bg-gray-50 rounded-lg">
                <div className="text-sm text-sqd-text-secondary mb-2">Your Earnings Info</div>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span>Your Stake:</span>
                    <span className="font-medium">{myStake.toLocaleString()} SQD</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Your Share:</span>
                    <span className="font-medium">{mySharePercent.toFixed(2)}%</span>
                  </div>
                  {expectedRatePerDay > 0 && (
                    <div className="flex justify-between">
                      <span>Expected Daily:</span>
                      <span className="font-medium text-green-600">${myExpectedDaily.toFixed(2)}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Exit Tab */}
          {activeTab === "exit" && (
            <div className="space-y-4">
              {/* Show existing exit request if any */}
              {exitAmount_ > 0 && (
                <>
                  {canWithdraw ? (
                    <div className="p-4 bg-green-50 rounded-lg border border-green-200">
                      <div className="text-sm text-green-800 font-medium mb-2">Ready to Withdraw!</div>
                      <div className="text-sm text-green-700">
                        Amount: {exitAmount_.toLocaleString()} SQD
                      </div>
                      <div className="text-xs text-green-600 mt-1">
                        Unlock epoch {exitUnlockEpoch} reached (Current: {currentEpochNum})
                      </div>
                      <button
                        onClick={handleWithdraw}
                        disabled={isPending || isConfirming}
                        className="mt-3 w-full bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold py-2 rounded-lg transition-colors"
                      >
                        {isPending || isConfirming ? "Withdrawing..." : `Withdraw ${exitAmount_.toLocaleString()} SQD`}
                      </button>
                    </div>
                  ) : (
                    <div className="p-4 bg-yellow-50 rounded-lg border border-yellow-200">
                      <div className="text-sm text-yellow-800 font-medium mb-2">Exit Request Pending</div>
                      <div className="text-sm text-yellow-700">
                        Amount: {exitAmount_.toLocaleString()} SQD
                      </div>
                      <div className="text-sm text-yellow-700">
                        Epochs remaining: {epochsUntilUnlock}
                      </div>
                      <div className="text-xs text-yellow-600 mt-1">
                        Unlock at epoch {exitUnlockEpoch} (Current: {currentEpochNum})
                      </div>
                      <div className="mt-3 w-full bg-gray-200 rounded-full h-2">
                        <div
                          className="bg-yellow-500 h-2 rounded-full transition-all"
                          style={{
                            width: `${Math.min(100, ((currentEpochNum - Number(exitRequest?.requestEpoch || 0)) / (exitUnlockEpoch - Number(exitRequest?.requestEpoch || 0))) * 100)}%`
                          }}
                        />
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* Exit form if user has stake */}
              {myStake > 0 && (
                <div className={exitAmount_ > 0 ? "border-t border-sqd-divider pt-4" : ""}>
                  <label className="block text-sm font-medium text-sqd-text-secondary mb-2">
                    {exitAmount_ > 0 ? "Request Additional Exit (SQD)" : "Exit Amount (SQD)"}
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      value={exitAmount}
                      onChange={(e) => setExitAmount(e.target.value)}
                      placeholder="0.0"
                      max={myStake}
                      className="flex-1 bg-white border border-sqd-divider rounded-lg px-4 py-3 text-sqd-text-primary focus:outline-none focus:border-sqd-accent"
                    />
                    <button
                      onClick={() => setExitAmount(myStake.toString())}
                      className="px-4 py-2 bg-gray-100 text-sqd-text-secondary rounded-lg hover:bg-gray-200 text-sm"
                    >
                      MAX
                    </button>
                  </div>
                  <p className="text-xs text-sqd-text-secondary mt-1">
                    Staked: {myStake.toLocaleString()} SQD
                  </p>

                  {exitAmount && Number(exitAmount) > 0 && (
                    <div className="mt-3 p-4 bg-orange-50 rounded-lg border border-orange-200">
                      <div className="text-sm text-orange-800">
                        Exit delay: {Math.ceil(1 + (Number(exitAmount) / totalStaked) * 100)} epochs
                      </div>
                      <div className="text-xs text-orange-700 mt-1">
                        Formula: 1 base epoch + (exit% of total stake)
                      </div>
                    </div>
                  )}

                  <button
                    onClick={handleRequestExit}
                    disabled={!exitAmount || Number(exitAmount) <= 0 || Number(exitAmount) > myStake || isPending || isConfirming}
                    className="mt-4 w-full bg-orange-500 hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-lg transition-colors"
                  >
                    {isPending || isConfirming ? "Requesting..." : exitAmount_ > 0 ? "Add to Exit Request" : "Request Exit"}
                  </button>
                </div>
              )}

              {myStake === 0 && exitAmount_ === 0 && (
                <div className="text-center text-sqd-text-secondary py-4">
                  No stake to exit
                </div>
              )}
            </div>
          )}

          {/* Distribution Tab (Operator Only) */}
          {activeTab === "distribution" && isOperator && (
            <div className="space-y-4">
              <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                <div className="text-sm text-blue-800 font-medium">You are the operator of this portal</div>
                <div className="text-xs text-blue-700 mt-1">
                  Distribute USDC rewards to liquidity providers
                </div>
              </div>

              {/* USDC Approval */}
              {needsUsdcApproval && (
                <div className="p-4 bg-yellow-50 rounded-lg border border-yellow-200">
                  <div className="text-sm font-medium text-yellow-800 mb-2">Approval Required</div>
                  <p className="text-xs text-yellow-700 mb-3">
                    You need to approve the Portal to transfer USDC for distribution.
                  </p>
                  <button
                    onClick={handleApproveUSDC}
                    disabled={isPending || isConfirming}
                    className="w-full bg-yellow-600 hover:bg-yellow-700 disabled:opacity-50 text-white font-medium py-2 rounded-lg"
                  >
                    {isPending || isConfirming ? "Approving..." : "Approve USDC"}
                  </button>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-sqd-text-secondary mb-2">Distribution Amount (USDC)</label>
                <input
                  type="number"
                  value={distributeAmount}
                  onChange={(e) => setDistributeAmount(e.target.value)}
                  placeholder="100"
                  className="w-full bg-white border border-sqd-divider rounded-lg px-4 py-3 text-sqd-text-primary focus:outline-none focus:border-sqd-accent"
                />
                <p className="text-xs text-sqd-text-secondary mt-1">
                  Your USDC balance: {usdcBalanceNum.toLocaleString()} USDC
                </p>
              </div>

              <div className="p-4 bg-gray-50 rounded-lg">
                <div className="text-sm text-sqd-text-secondary mb-2">Distribution Preview</div>
                <div className="text-sm">
                  <div className="flex justify-between">
                    <span>To Providers (50%):</span>
                    <span className="font-medium">${(distributeAmountNum * 0.5).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>To Worker Pool (50%):</span>
                    <span className="font-medium">${(distributeAmountNum * 0.5).toFixed(2)}</span>
                  </div>
                </div>
              </div>

              <button
                onClick={handleDistribute}
                disabled={!distributeAmount || distributeAmountNum <= 0 || distributeAmountNum > usdcBalanceNum || needsUsdcApproval || isPending || isConfirming}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-lg transition-colors"
              >
                {isPending || isConfirming ? "Distributing..." : "Distribute USDC"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
