"use client";

import { useState, useEffect } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContract, useChainId } from "wagmi";
import { PORTAL_ABI, GATEWAY_REGISTRY_ABI, NETWORK_CONTROLLER_ABI, ERC20_ABI, contractAddresses, targetChainId } from "@/config/contracts";
import { parseUnits, formatUnits } from "viem";

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

export function PortalInvestment({ portalAddress, onClose }: { portalAddress: string; onClose: () => void }) {
  const { address } = useAccount();
  const chainId = useChainId();
  const [stakeAmount, setStakeAmount] = useState("");
  const [exitAmount, setExitAmount] = useState("");
  const [distributionToken, setDistributionToken] = useState("");
  const [distributionAmount, setDistributionAmount] = useState("");
  const [activeTab, setActiveTab] = useState<"stake" | "rewards" | "exit" | "distribution">("stake");

  const { writeContract, data: hash, isPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  // Read portal info
  const { data: portalInfo } = useReadContract({
    address: portalAddress as `0x${string}`,
    abi: PORTAL_ABI,
    functionName: "getPortalInfo",
  }) as { data: PortalInfo | undefined };

  // Read user's stake
  const { data: userStake } = useReadContract({
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
  const { data: sqdAllowance } = useReadContract({
    address: contractAddresses.sqdToken,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: address ? [address, contractAddresses.gatewayRegistry] : undefined,
  });

  // Read SQD allowance for Portal (for display/debugging - Portal doesn't actually need it)
  const { data: portalAllowance } = useReadContract({
    address: contractAddresses.sqdToken,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: address ? [address, portalAddress as `0x${string}`] : undefined,
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

  // Read minimum stake threshold
  const { data: minStakeThreshold } = useReadContract({
    address: contractAddresses.networkController,
    abi: NETWORK_CONTROLLER_ABI,
    functionName: "minStakeThreshold",
  });

  // Read active stake (total staked minus pending exits)
  const { data: activeStake } = useReadContract({
    address: portalAddress as `0x${string}`,
    abi: PORTAL_ABI,
    functionName: "getActiveStake",
  });

  // Read current epoch number
  const { data: currentEpoch } = useReadContract({
    address: contractAddresses.networkController,
    abi: NETWORK_CONTROLLER_ABI,
    functionName: "epochNumber",
  });

  // Read exit request from Portal
  const { data: portalExitRequest, refetch: refetchPortalExitRequest, error: exitRequestError } = useReadContract({
    address: portalAddress as `0x${string}`,
    abi: PORTAL_ABI,
    functionName: "getExitRequest",
    args: address ? [address] : undefined,
    query: {
      enabled: !!address, // only query when address is available
      refetchInterval: 10000, // refetch every 10 seconds
    },
  }) as { data: { amount: bigint; requestEpoch: bigint; unlockEpoch: bigint } | undefined; refetch: () => void; error: Error | null };
  
  // Debug logging
  useEffect(() => {
    if (exitRequestError) {
      console.error("Error fetching exit request:", exitRequestError);
    }
    if (portalExitRequest) {
      console.log("Portal exit request data:", {
        amount: portalExitRequest.amount.toString(),
        requestEpoch: portalExitRequest.requestEpoch.toString(),
        unlockEpoch: portalExitRequest.unlockEpoch.toString(),
      });
    }
  }, [portalExitRequest, exitRequestError]);

  // Read unlock request from GatewayRegistry
  const { data: unlockRequest, refetch: refetchUnlockRequest } = useReadContract({
    address: contractAddresses.gatewayRegistry,
    abi: GATEWAY_REGISTRY_ABI,
    functionName: "unlockRequests",
    args: address ? [address] : undefined,
  }) as { data: [bigint, bigint, bigint] | undefined; refetch: () => void };

  // Read total allocation
  const { data: totalAllocation, refetch: refetchTotalAllocation } = useReadContract({
    address: contractAddresses.gatewayRegistry,
    abi: GATEWAY_REGISTRY_ABI,
    functionName: "getTotalAllocation",
    args: address ? [address] : undefined,
  });

  if (!portalInfo) {
    return (
      <div className="bg-white rounded-lg p-6 border border-sqd-divider">
        <div className="animate-pulse">
          <div className="h-4 bg-gray-200 rounded w-3/4 mb-4"></div>
          <div className="h-4 bg-gray-200 rounded w-1/2"></div>
        </div>
      </div>
    );
  }

  const maxCapacity = Number(formatUnits(portalInfo.maxCapacity, 18));
  const totalStaked = Number(formatUnits(portalInfo.totalStaked, 18));
  const activeStakeAmount = activeStake ? Number(formatUnits(activeStake, 18)) : totalStaked;
  const pendingExitsAmount = totalStaked - activeStakeAmount;
  const myStake = userStake ? Number(formatUnits(userStake, 18)) : 0;
  const minStake = minStakeThreshold ? Number(formatUnits(minStakeThreshold, 18)) : 100000;
  const cus = Math.floor(activeStakeAmount / 10); // 10 SQD = 1 CU
  const progressPercent = maxCapacity > 0 ? (totalStaked / maxCapacity) * 100 : 0;
  const balance = sqdBalance ? Number(formatUnits(sqdBalance, 18)) : 0;

  // check if approval is needed for the entered stake amount (GatewayRegistry is what actually needs it)
  const needsGatewayApproval =
    stakeAmount && (!sqdAllowance || sqdAllowance < parseUnits(stakeAmount, 18));
  
  // check if user has any GatewayRegistry approval (for display purposes)
  const hasGatewayApproval = sqdAllowance && sqdAllowance > 0n;
  
  // Portal allowance (for display - Portal doesn't actually need approval)
  const hasPortalApproval = portalAllowance && portalAllowance > 0n;

  const handleApproveGatewayRegistry = async (approveMax: boolean = false) => {
    // check if on correct chain
    if (chainId !== targetChainId) {
      alert("Please switch to Arbitrum Sepolia network");
      return;
    }

    let approveAmount: bigint;
    if (approveMax) {
      // approve max uint256 for unlimited approval
      approveAmount = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
    } else {
      if (!stakeAmount) {
        alert("Please enter a stake amount first");
        return;
      }
      // validate stake amount
      const amount = parseFloat(stakeAmount);
      if (isNaN(amount) || amount <= 0) {
        alert("Please enter a valid stake amount");
        return;
      }
      approveAmount = parseUnits(stakeAmount, 18);
    }

    console.log("Approving GatewayRegistry:", contractAddresses.gatewayRegistry, "Amount:", approveAmount.toString());
    writeContract({
      address: contractAddresses.sqdToken,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [contractAddresses.gatewayRegistry, approveAmount],
      chainId: targetChainId,
    });
  };

  const handleApprovePortal = async (approveMax: boolean = false) => {
    // check if on correct chain
    if (chainId !== targetChainId) {
      alert("Please switch to Arbitrum Sepolia network");
      return;
    }

    let approveAmount: bigint;
    if (approveMax) {
      // approve max uint256 for unlimited approval
      approveAmount = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
    } else {
      if (!stakeAmount) {
        alert("Please enter a stake amount first");
        return;
      }
      // validate stake amount
      const amount = parseFloat(stakeAmount);
      if (isNaN(amount) || amount <= 0) {
        alert("Please enter a valid stake amount");
        return;
      }
      approveAmount = parseUnits(stakeAmount, 18);
    }

    console.log("Approving Portal:", portalAddress, "Amount:", approveAmount.toString());
    writeContract({
      address: contractAddresses.sqdToken,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [portalAddress as `0x${string}`, approveAmount],
      chainId: targetChainId,
    });
  };

  const handleStake = async () => {
    if (!address || !stakeAmount) return;

    // validate stake amount
    const amount = parseFloat(stakeAmount);
    if (isNaN(amount) || amount <= 0) {
      alert("Please enter a valid stake amount");
      return;
    }

    // check if amount exceeds balance
    if (amount > balance) {
      alert(`Insufficient balance. You have ${balance.toLocaleString()} SQD`);
      return;
    }

    // check if amount exceeds portal capacity
    if (portalInfo && amount > maxCapacity - totalStaked) {
      const available = maxCapacity - totalStaked;
      alert(`Amount exceeds portal capacity. Maximum you can stake: ${available.toLocaleString()} SQD (Portal capacity: ${maxCapacity.toLocaleString()} SQD, Already staked: ${totalStaked.toLocaleString()} SQD)`);
      return;
    }

    // check if on correct chain
    if (chainId !== targetChainId) {
      alert("Please switch to Arbitrum Sepolia network");
      return;
    }

    // check GatewayRegistry approval
    const stakeAmountWei = parseUnits(stakeAmount, 18);
    if (!sqdAllowance || sqdAllowance < stakeAmountWei) {
      alert(`Insufficient approval. You need to approve GatewayRegistry for at least ${stakeAmount} SQD. Current approval: ${sqdAllowance ? Number(formatUnits(sqdAllowance, 18)).toLocaleString() : 0} SQD`);
      return;
    }

    // Debug logging
    console.log("Staking details:", {
      portalAddress,
      stakeAmount: stakeAmount,
      stakeAmountWei: stakeAmountWei.toString(),
      gatewayRegistryApproval: sqdAllowance ? sqdAllowance.toString() : "0",
      portalApproval: portalAllowance ? portalAllowance.toString() : "0",
      balance: balance.toString(),
      maxCapacity,
      totalStaked,
    });

    // Important: Staking goes through Portal.stake(), which calls GatewayRegistry
    try {
      writeContract({
        address: portalAddress as `0x${string}`,
        abi: PORTAL_ABI,
        functionName: "stake",
        args: [stakeAmountWei],
        chainId: targetChainId,
      });
    } catch (error) {
      console.error("Stake error:", error);
      alert(`Failed to stake: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  };

  const handleClaimFees = async (token: string) => {
    if (!address) return;

    writeContract({
      address: portalAddress as `0x${string}`,
      abi: PORTAL_ABI,
      functionName: "claimFees",
      args: [token as `0x${string}`],
      chainId: targetChainId,
    });
  };

  const handleDistributeFees = async () => {
    if (!address || !distributionToken || !distributionAmount) return;

    // validate distribution amount
    const amount = parseFloat(distributionAmount);
    if (isNaN(amount) || amount <= 0) {
      alert("Please enter a valid distribution amount");
      return;
    }

    // check if on correct chain
    if (chainId !== targetChainId) {
      alert("Please switch to Arbitrum Sepolia network");
      return;
    }

    // Get token decimals
    const tokenDecimals = distributionToken === contractAddresses.usdcToken ? 6 : 18;
    const amountWei = parseUnits(distributionAmount, tokenDecimals);

    writeContract({
      address: portalAddress as `0x${string}`,
      abi: PORTAL_ABI,
      functionName: "distributeFees",
      args: [distributionToken as `0x${string}`, amountWei],
      chainId: targetChainId,
    });
  };

  const handleRequestExit = async () => {
    if (!address || !exitAmount) return;

    // validate exit amount
    const amount = parseFloat(exitAmount);
    if (isNaN(amount) || amount <= 0) {
      alert("Please enter a valid exit amount");
      return;
    }

    // check if amount exceeds stake
    if (amount > myStake) {
      alert(`Insufficient stake. You have ${myStake.toLocaleString()} SQD staked`);
      return;
    }

    // check if on correct chain
    if (chainId !== targetChainId) {
      alert("Please switch to Arbitrum Sepolia network");
      return;
    }

    writeContract({
      address: portalAddress as `0x${string}`,
      abi: PORTAL_ABI,
      functionName: "requestExit",
      args: [parseUnits(exitAmount, 18)],
      chainId: targetChainId,
    });
  };

  const handleWithdrawUnlocked = async () => {
    if (!address) return;

    if (chainId !== targetChainId) {
      alert("Please switch to Arbitrum Sepolia network");
      return;
    }

    writeContract({
      address: contractAddresses.gatewayRegistry,
      abi: GATEWAY_REGISTRY_ABI,
      functionName: "withdrawUnlocked",
      chainId: targetChainId,
    });
  };

  // Calculate exit delay and withdrawable amounts
  const portalExitAmount = portalExitRequest ? Number(formatUnits(portalExitRequest.amount, 18)) : 0;
  const portalRequestEpoch = portalExitRequest ? Number(portalExitRequest.requestEpoch) : 0;
  const portalUnlockEpoch = portalExitRequest ? Number(portalExitRequest.unlockEpoch) : 0;
  
  const unlockRequestAmount = unlockRequest ? Number(formatUnits(unlockRequest[0], 18)) : 0;
  const unlockRequestEpoch = unlockRequest ? Number(unlockRequest[1]) : 0;
  const unlockWithdrawn = unlockRequest ? Number(formatUnits(unlockRequest[2], 18)) : 0;
  const totalAlloc = totalAllocation ? Number(formatUnits(totalAllocation, 18)) : 0;
  const maxPerEpoch = totalAlloc * 0.01; // 1% per epoch
  const epochsPassed = currentEpoch && unlockRequestEpoch ? Number(currentEpoch) - Number(unlockRequestEpoch) : 0;
  const totalUnlocked = epochsPassed > 0 ? Math.min(epochsPassed * maxPerEpoch, unlockRequestAmount) : 0;
  const withdrawableNow = Math.max(0, totalUnlocked - unlockWithdrawn);
  const remainingToWithdraw = unlockRequestAmount - unlockWithdrawn;
  
  // Calculate exit delay for new exit request
  const exitPercentage = exitAmount && totalStaked > 0 ? (parseFloat(exitAmount) / totalStaked) * 100 : 0;
  const exitDelayEpochs = exitPercentage > 0 ? 1 + Math.floor(exitPercentage) : 0;
  
  // Calculate epochs until unlock for existing exit request
  const epochsUntilUnlock = currentEpoch && portalUnlockEpoch > 0 
    ? Math.max(0, portalUnlockEpoch - Number(currentEpoch)) 
    : 0;
  
  // Check if we can withdraw from GatewayRegistry (gradual withdrawal after unlock epoch)
  const canWithdrawFromGateway = unlockRequestAmount > 0 && withdrawableNow > 0;
  
  // Check if portal unlock epoch has passed (for display purposes)
  const portalUnlockEpochPassed = currentEpoch && portalUnlockEpoch > 0 && Number(currentEpoch) >= portalUnlockEpoch;
  
  // Check if there's an active exit request for THIS portal (portal-specific)
  // Only show exit status if this portal has an exit request
  const hasActiveExitRequest = portalExitAmount > 0;
  
  // GatewayRegistry unlock request is global (across all portals)
  // Only show GatewayRegistry withdrawal if there's a portal exit request for this portal
  const showGatewayWithdrawal = hasActiveExitRequest && unlockRequestAmount > 0;

  // Refresh data after successful transactions
  useEffect(() => {
    if (isSuccess) {
      // Add small delay to ensure transaction is fully processed
      const timer = setTimeout(() => {
        refetchPortalExitRequest();
        refetchUnlockRequest();
        refetchTotalAllocation();
      }, 2000); // 2 second delay to ensure block is processed
      
      return () => clearTimeout(timer);
    }
  }, [isSuccess, refetchPortalExitRequest, refetchUnlockRequest, refetchTotalAllocation]);
  
  // Reset exit amount input when exit request is successfully created
  useEffect(() => {
    if (isSuccess && portalExitAmount > 0) {
      setExitAmount("");
    }
  }, [isSuccess, portalExitAmount]);

  // Reset distribution amount after successful distribution
  useEffect(() => {
    if (isSuccess && activeTab === "distribution") {
      setDistributionAmount("");
      setDistributionToken("");
    }
  }, [isSuccess, activeTab]);
  
  // Auto-refresh exit request data periodically
  useEffect(() => {
    const interval = setInterval(() => {
      refetchPortalExitRequest();
      refetchUnlockRequest();
    }, 10000); // Refresh every 10 seconds
    
    return () => clearInterval(interval);
  }, [refetchPortalExitRequest, refetchUnlockRequest]);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-sqd-divider p-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-semibold text-sqd-text-primary mb-1">Portal Details</h2>
              <p className="text-sm font-mono text-sqd-text-secondary">
                {portalAddress.slice(0, 10)}...{portalAddress.slice(-8)}
              </p>
            </div>
            <button
              onClick={onClose}
              className="text-sqd-text-secondary hover:text-sqd-text-primary text-2xl"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Portal Stats */}
        <div className="p-6 border-b border-sqd-divider">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <div className="text-xs text-sqd-text-secondary mb-1">Status</div>
              <div className="text-lg font-semibold text-sqd-text-primary">{STATE_NAMES[portalInfo.state]}</div>
            </div>
            <div>
              <div className="text-xs text-sqd-text-secondary mb-1">Compute Units</div>
              <div className="text-lg font-semibold text-sqd-accent">{cus} CUs</div>
            </div>
            <div>
              <div className="text-xs text-sqd-text-secondary mb-1">Active Stake</div>
              <div className="text-lg font-semibold text-sqd-accent">{activeStakeAmount.toLocaleString()} SQD</div>
              {pendingExitsAmount > 0 && (
                <div className="text-xs text-sqd-text-secondary">
                  ({pendingExitsAmount.toLocaleString()} pending exit)
                </div>
              )}
            </div>
            <div>
              <div className="text-xs text-sqd-text-secondary mb-1">Total / Capacity</div>
              <div className="text-lg font-semibold text-sqd-text-primary">
                {totalStaked.toLocaleString()} / {maxCapacity.toLocaleString()}
              </div>
            </div>
          </div>

          {/* Progress Bar */}
          <div className="mt-4">
            <div className="flex justify-between text-sm mb-2">
              <span className="text-sqd-text-secondary">Collection Progress</span>
              <span className="font-medium text-sqd-text-primary">{progressPercent.toFixed(1)}%</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2.5">
              <div
                className="bg-sqd-accent h-2.5 rounded-full transition-all"
                style={{ width: `${Math.min(progressPercent, 100)}%` }}
              ></div>
            </div>
          </div>

          {/* My Stake */}
          {myStake > 0 && (
            <div className="mt-4 p-3 bg-sqd-primary rounded-lg">
              <div className="flex justify-between items-center">
                <span className="text-sm text-sqd-text-secondary">Your Stake</span>
                <span className="text-lg font-semibold text-sqd-accent">{myStake.toLocaleString()} SQD</span>
              </div>
            </div>
          )}
        </div>

        {/* Tabs */}
        <div className="border-b border-sqd-divider">
          <div className="flex">
            <button
              onClick={() => setActiveTab("stake")}
              className={`flex-1 px-6 py-3 text-sm font-medium transition-colors ${
                activeTab === "stake"
                  ? "text-sqd-accent border-b-2 border-sqd-accent"
                  : "text-sqd-text-secondary hover:text-sqd-text-primary"
              }`}
            >
              Stake SQD
            </button>
            <button
              onClick={() => setActiveTab("rewards")}
              className={`flex-1 px-6 py-3 text-sm font-medium transition-colors ${
                activeTab === "rewards"
                  ? "text-sqd-accent border-b-2 border-sqd-accent"
                  : "text-sqd-text-secondary hover:text-sqd-text-primary"
              }`}
            >
              Claim Rewards
            </button>
            <button
              onClick={() => setActiveTab("exit")}
              className={`flex-1 px-6 py-3 text-sm font-medium transition-colors ${
                activeTab === "exit"
                  ? "text-sqd-accent border-b-2 border-sqd-accent"
                  : "text-sqd-text-secondary hover:text-sqd-text-primary"
              }`}
            >
              Exit / Unstake
            </button>
            <button
              onClick={() => setActiveTab("distribution")}
              className={`flex-1 px-6 py-3 text-sm font-medium transition-colors ${
                activeTab === "distribution"
                  ? "text-sqd-accent border-b-2 border-sqd-accent"
                  : "text-sqd-text-secondary hover:text-sqd-text-primary"
              }`}
            >
              Distribution
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-6">
          {activeTab === "stake" ? (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-sqd-text-secondary mb-2">
                  Amount to Stake (SQD)
                </label>
                <input
                  type="number"
                  value={stakeAmount}
                  onChange={(e) => {
                    const value = e.target.value;
                    // prevent extremely large values that could cause gas estimation issues
                    if (value === "" || (parseFloat(value) >= 0 && parseFloat(value) <= 1000000000)) {
                      setStakeAmount(value);
                    }
                  }}
                  placeholder="0.0"
                  min="0"
                  max={balance}
                  step="0.1"
                  className="w-full bg-white border border-sqd-divider rounded-lg px-4 py-3 text-sqd-text-primary placeholder-sqd-text-disabled focus:outline-none focus:border-sqd-accent"
                />
                <div className="flex justify-between text-xs text-sqd-text-secondary mt-1">
                  <span>Balance: {balance.toLocaleString()} SQD</span>
                  <button
                    onClick={() => setStakeAmount(balance.toString())}
                    className="text-sqd-accent hover:underline"
                  >
                    Max
                  </button>
                </div>
              </div>

              {address ? (
                <div className="space-y-2">
                  {/* Approval Status Display */}
                  <div className="p-3 bg-sqd-primary rounded-lg border border-sqd-divider">
                    <div className="text-xs font-medium text-sqd-text-primary mb-2">Approval Status</div>
                    <div className="space-y-1 text-xs">
                      <div className={`flex justify-between ${hasGatewayApproval ? 'text-green-700' : 'text-red-700'}`}>
                        <span>GatewayRegistry ({contractAddresses.gatewayRegistry.slice(0,6)}...{contractAddresses.gatewayRegistry.slice(-4)}):</span>
                        <span className="font-medium">
                          {hasGatewayApproval
                            ? `✓ ${Number(formatUnits(sqdAllowance!, 18)).toLocaleString()} SQD`
                            : '✗ Not Approved'}
                        </span>
                      </div>
                      <div className={`flex justify-between ${hasPortalApproval ? 'text-green-700' : 'text-red-700'}`}>
                        <span>Portal ({portalAddress.slice(0,6)}...{portalAddress.slice(-4)}):</span>
                        <span className="font-medium">
                          {hasPortalApproval
                            ? `✓ ${Number(formatUnits(portalAllowance!, 18)).toLocaleString()} SQD`
                            : '✗ Not Approved'}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Separate Approval Buttons */}
                  <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                    <div className="text-sm font-medium text-blue-800 mb-3">
                      Approve SQD Spending
                    </div>

                    {/* GatewayRegistry Approval */}
                    <div className="mb-4">
                      <div className="text-xs text-blue-700 mb-2 font-medium">
                        1. GatewayRegistry (Required for staking)
                      </div>
                      <div className="text-xs text-blue-600 mb-2">
                        Address: {contractAddresses.gatewayRegistry}
                      </div>
                      <div className="space-y-2">
                        <button
                          onClick={() => handleApproveGatewayRegistry(true)}
                          disabled={isPending || isConfirming}
                          className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium py-2 rounded-full transition-colors"
                        >
                          {isPending || isConfirming ? "Approving..." : "Approve Max to GatewayRegistry"}
                        </button>
                      </div>
                    </div>

                    {/* Portal Approval */}
                    <div>
                      <div className="text-xs text-blue-700 mb-2 font-medium">
                        2. Portal (Optional - for direct transfers)
                      </div>
                      <div className="text-xs text-blue-600 mb-2">
                        Address: {portalAddress}
                      </div>
                      <div className="space-y-2">
                        <button
                          onClick={() => handleApprovePortal(true)}
                          disabled={isPending || isConfirming}
                          className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium py-2 rounded-full transition-colors"
                        >
                          {isPending || isConfirming ? "Approving..." : "Approve Max to Portal"}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Stake Button */}
                  <button
                    onClick={handleStake}
                    disabled={!stakeAmount || !hasGatewayApproval || isPending || isConfirming}
                    className="w-full bg-sqd-accent hover:bg-sqd-accent/90 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold py-3 rounded-full transition-colors"
                  >
                    {isPending || isConfirming ? "Staking..." : "Stake SQD"}
                  </button>
                </div>
              ) : (
                <button
                  disabled
                  className="w-full bg-sqd-primary text-sqd-text-disabled text-sm font-medium py-3 rounded-full cursor-not-allowed"
                >
                  Connect Wallet to Stake
                </button>
              )}

              <div className="mt-6 p-4 bg-sqd-primary rounded-lg">
                <h4 className="text-sm font-medium text-sqd-text-primary mb-2">How staking works</h4>
                <ul className="space-y-1.5 text-xs text-sqd-text-secondary">
                  <li>• Your SQD is staked via GatewayRegistry for security</li>
                  <li>• You earn fees in multiple tokens (USDC, DAI, etc.)</li>
                  <li>• CUs increase as more SQD is staked</li>
                  <li>• Exit requests have a delay based on % of total stake</li>
                </ul>
              </div>
            </div>
          ) : activeTab === "exit" ? (
            <div className="space-y-4">
              {/* Debug info - remove in production */}
              {process.env.NODE_ENV === 'development' && exitRequestError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded text-xs text-red-800">
                  Error loading exit request: {exitRequestError.message}
                </div>
              )}
              
              {/* Existing Exit Request */}
              {hasActiveExitRequest && (
                <div className="p-4 bg-sqd-primary rounded-lg border border-sqd-divider">
                  <div className="flex justify-between items-center mb-3">
                    <h4 className="text-sm font-medium text-sqd-text-primary">Exit Request Status</h4>
                    <button
                      onClick={() => {
                        refetchPortalExitRequest();
                        refetchUnlockRequest();
                      }}
                      className="text-xs text-sqd-accent hover:underline"
                    >
                      Refresh
                    </button>
                  </div>
                  
                  {/* Portal Exit Request Info */}
                  {portalExitAmount > 0 && (
                    <div className="space-y-2 text-sm mb-4 pb-4 border-b border-sqd-divider">
                      <div className="text-xs text-sqd-text-secondary mb-2">Portal Exit Request</div>
                      <div className="flex justify-between">
                        <span className="text-sqd-text-secondary">Exit Amount:</span>
                        <span className="font-medium text-sqd-text-primary">{portalExitAmount.toLocaleString()} SQD</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-sqd-text-secondary">Requested Epoch:</span>
                        <span className="font-medium text-sqd-text-primary">{portalRequestEpoch}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-sqd-text-secondary">Unlock Epoch:</span>
                        <span className="font-medium text-sqd-text-primary">{portalUnlockEpoch}</span>
                      </div>
                      {currentEpoch && (
                        <div className="flex justify-between">
                          <span className="text-sqd-text-secondary">Epochs Until Unlock:</span>
                          <span className={`font-medium ${epochsUntilUnlock === 0 ? "text-green-600" : "text-sqd-accent"}`}>
                            {epochsUntilUnlock === 0 ? "Unlocked" : `${epochsUntilUnlock} epochs remaining`}
                          </span>
                        </div>
                      )}
                      {currentEpoch && (
                        <div className="flex justify-between">
                          <span className="text-sqd-text-secondary">Current Epoch:</span>
                          <span className="font-medium text-sqd-text-primary">{Number(currentEpoch)}</span>
                        </div>
                      )}
                    </div>
                  )}
                  
                  {/* GatewayRegistry Withdrawal Info */}
                  {/* Note: GatewayRegistry unlock request is global across all portals */}
                  {/* Only show if this portal has an exit request */}
                  {showGatewayWithdrawal && (
                    <div className="space-y-2 text-sm">
                      <div className="text-xs text-sqd-text-secondary mb-2">
                        Withdrawal Progress (GatewayRegistry)
                        {unlockRequestAmount !== portalExitAmount && (
                          <span className="text-yellow-600 ml-1">*Global across all portals</span>
                        )}
                      </div>
                      <div className="flex justify-between">
                        <span className="text-sqd-text-secondary">Total Exit Amount:</span>
                        <span className="font-medium text-sqd-text-primary">{unlockRequestAmount.toLocaleString()} SQD</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-sqd-text-secondary">Already Withdrawn:</span>
                        <span className="font-medium text-sqd-text-primary">{unlockWithdrawn.toLocaleString()} SQD</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-sqd-text-secondary">Remaining:</span>
                        <span className="font-medium text-sqd-text-primary">{remainingToWithdraw.toLocaleString()} SQD</span>
                      </div>
                      {withdrawableNow > 0 && (
                        <div className="flex justify-between">
                          <span className="text-sqd-text-secondary">Withdrawable Now:</span>
                          <span className="font-medium text-green-600">{withdrawableNow.toLocaleString()} SQD</span>
                        </div>
                      )}
                      {unlockRequestEpoch > 0 && currentEpoch && (
                        <div className="flex justify-between">
                          <span className="text-sqd-text-secondary">Requested At Epoch:</span>
                          <span className="font-medium text-sqd-text-primary">{unlockRequestEpoch}</span>
                        </div>
                      )}
                      {unlockRequestEpoch > 0 && currentEpoch && (
                        <div className="flex justify-between">
                          <span className="text-sqd-text-secondary">Epochs Passed:</span>
                          <span className="font-medium text-sqd-text-primary">{epochsPassed}</span>
                        </div>
                      )}
                      {maxPerEpoch > 0 && (
                        <div className="flex justify-between">
                          <span className="text-sqd-text-secondary">Max Per Epoch:</span>
                          <span className="font-medium text-sqd-text-primary">{maxPerEpoch.toLocaleString()} SQD (1%)</span>
                        </div>
                      )}
                      
                      {/* Withdrawal Progress Bar */}
                      {unlockRequestAmount > 0 && (
                        <div className="mt-3 pt-3 border-t border-sqd-divider">
                          <div className="flex justify-between text-xs mb-1">
                            <span className="text-sqd-text-secondary">Withdrawal Progress</span>
                            <span className="font-medium text-sqd-text-primary">
                              {((unlockWithdrawn / unlockRequestAmount) * 100).toFixed(1)}%
                            </span>
                          </div>
                          <div className="w-full bg-gray-200 rounded-full h-2">
                            <div
                              className="bg-sqd-accent h-2 rounded-full transition-all"
                              style={{ width: `${Math.min((unlockWithdrawn / unlockRequestAmount) * 100, 100)}%` }}
                            ></div>
                          </div>
                        </div>
                      )}
                      
                      {/* Withdraw Button */}
                      {canWithdrawFromGateway && (
                        <button
                          onClick={handleWithdrawUnlocked}
                          disabled={isPending || isConfirming || withdrawableNow === 0}
                          className="w-full mt-3 bg-sqd-accent hover:bg-sqd-accent/90 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold py-2 rounded-full transition-colors"
                        >
                          {isPending || isConfirming 
                            ? "Withdrawing..." 
                            : `Withdraw ${withdrawableNow.toLocaleString()} SQD`}
                        </button>
                      )}
                      {!canWithdrawFromGateway && unlockRequestAmount > 0 && portalUnlockEpochPassed && (
                        <div className="mt-3 p-2 bg-yellow-50 border border-yellow-200 rounded text-xs text-yellow-800">
                          Waiting for gradual unlock. You can withdraw 1% per epoch after unlock epoch.
                          {unlockRequestAmount !== portalExitAmount && " Note: Amount includes exits from other portals."}
                        </div>
                      )}
                      {!canWithdrawFromGateway && unlockRequestAmount > 0 && !portalUnlockEpochPassed && (
                        <div className="mt-3 p-2 bg-blue-50 border border-blue-200 rounded text-xs text-blue-800">
                          Waiting for unlock epoch ({portalUnlockEpoch}). After unlock, withdrawal happens gradually (1% per epoch).
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* New Exit Request Form */}
              {!hasActiveExitRequest && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-sqd-text-secondary mb-2">
                      Amount to Exit (SQD)
                    </label>
                    <input
                      type="number"
                      value={exitAmount}
                      onChange={(e) => {
                        const value = e.target.value;
                        if (value === "" || (parseFloat(value) >= 0 && parseFloat(value) <= myStake)) {
                          setExitAmount(value);
                        }
                      }}
                      placeholder="0.0"
                      min="0"
                      max={myStake}
                      step="0.1"
                      className="w-full bg-white border border-sqd-divider rounded-lg px-4 py-3 text-sqd-text-primary placeholder-sqd-text-disabled focus:outline-none focus:border-sqd-accent"
                    />
                    <div className="flex justify-between text-xs text-sqd-text-secondary mt-1">
                      <span>Your Stake: {myStake.toLocaleString()} SQD</span>
                      <button
                        onClick={() => setExitAmount(myStake.toString())}
                        className="text-sqd-accent hover:underline"
                      >
                        Max
                      </button>
                    </div>
                  </div>

                  {/* Exit Delay Info */}
                  {exitAmount && parseFloat(exitAmount) > 0 && (
                    <div className="p-4 bg-sqd-primary rounded-lg border border-sqd-divider">
                      <h4 className="text-sm font-medium text-sqd-text-primary mb-2">Exit Delay Information</h4>
                      <div className="space-y-2 text-sm">
                        <div className="flex justify-between">
                          <span className="text-sqd-text-secondary">Exit Percentage:</span>
                          <span className="font-medium text-sqd-text-primary">{exitPercentage.toFixed(2)}%</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-sqd-text-secondary">Required Epochs:</span>
                          <span className="font-medium text-sqd-accent">{exitDelayEpochs} epochs</span>
                        </div>
                        <div className="text-xs text-sqd-text-secondary mt-2 pt-2 border-t border-sqd-divider">
                          Formula: 1 base epoch + {exitPercentage.toFixed(2)}% = {exitDelayEpochs} epochs
                        </div>
                      </div>
                    </div>
                  )}

                  {address ? (
                    <button
                      onClick={handleRequestExit}
                      disabled={!exitAmount || parseFloat(exitAmount) <= 0 || parseFloat(exitAmount) > myStake || isPending || isConfirming}
                      className="w-full bg-sqd-accent hover:bg-sqd-accent/90 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold py-3 rounded-full transition-colors"
                    >
                      {isPending || isConfirming ? "Requesting Exit..." : "Request Exit"}
                    </button>
                  ) : (
                    <button
                      disabled
                      className="w-full bg-sqd-primary text-sqd-text-disabled text-sm font-medium py-3 rounded-full cursor-not-allowed"
                    >
                      Connect Wallet to Exit
                    </button>
                  )}
                </>
              )}

              <div className="mt-6 p-4 bg-sqd-primary rounded-lg">
                <h4 className="text-sm font-medium text-sqd-text-primary mb-2">How exit/unstake works</h4>
                <ul className="space-y-1.5 text-xs text-sqd-text-secondary">
                  <li>• Exit delay = 1 base epoch + (exit % of total stake)</li>
                  <li>• Example: 10% exit = 1 + 10 = 11 epochs delay</li>
                  <li>• Your stake stops earning rewards once exit is requested</li>
                  <li>• After unlock epoch, withdraw via GatewayRegistry</li>
                  <li>• Withdrawal happens gradually: 1% per epoch from GatewayRegistry</li>
                </ul>
              </div>
            </div>
          ) : activeTab === "distribution" ? (
            <div className="space-y-6">
              {/* Token Balances Section */}
              {address && (
                <div className="p-4 bg-sqd-primary rounded-lg border border-sqd-divider">
                  <h3 className="text-sm font-semibold text-sqd-text-primary mb-3">Your Token Balances</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {usdcBalance !== undefined && (
                      <div className="flex justify-between items-center p-2 bg-white rounded border border-sqd-divider">
                        <span className="text-sm text-sqd-text-secondary">USDC</span>
                        <span className="text-sm font-semibold text-sqd-text-primary">
                          {formatUnits(usdcBalance, 6).replace(/\.?0+$/, "")} USDC
                        </span>
                      </div>
                    )}
                    {paymentTokens?.map((token) => {
                      if (token === contractAddresses.usdcToken) return null; // Already shown above
                      const tokenName = token.slice(0, 6) + "..." + token.slice(-4);
                      return (
                        <TokenBalanceDisplay
                          key={token}
                          tokenAddress={token}
                          tokenName={tokenName}
                          userAddress={address}
                        />
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Distribution Section (for operators) */}
              {portalInfo && address && address.toLowerCase() === portalInfo.operator.toLowerCase() ? (
                <div className="space-y-4 p-4 bg-sqd-primary rounded-lg border border-sqd-divider">
                  <h3 className="text-lg font-semibold text-sqd-text-primary mb-4">Distribute Tokens</h3>
                  
                  <div>
                    <label className="block text-sm font-medium text-sqd-text-secondary mb-2">
                      Select Token
                    </label>
                    <select
                      value={distributionToken}
                      onChange={(e) => setDistributionToken(e.target.value)}
                      className="w-full bg-white border border-sqd-divider rounded-lg px-4 py-3 text-sqd-text-primary focus:outline-none focus:border-sqd-accent"
                    >
                      <option value="">Select a token</option>
                      {paymentTokens?.map((token) => (
                        <option key={token} value={token}>
                          {token === contractAddresses.usdcToken ? "USDC" : token.slice(0, 6) + "..." + token.slice(-4)}
                        </option>
                      ))}
                    </select>
                  </div>

                  {distributionToken && (
                    <DistributionTokenInfo
                      tokenAddress={distributionToken}
                      portalAddress={portalAddress}
                      userAddress={address}
                      distributionAmount={distributionAmount}
                      setDistributionAmount={setDistributionAmount}
                      onDistribute={handleDistributeFees}
                      isPending={isPending}
                      isConfirming={isConfirming}
                    />
                  )}
                </div>
              ) : (
                <div className="p-4 bg-sqd-primary rounded-lg border border-sqd-divider">
                  <p className="text-sm text-sqd-text-secondary">
                    Only the portal operator can distribute tokens. You can claim your rewards below.
                  </p>
                </div>
              )}

              {/* Claim Section (for all users) */}
              <div className="space-y-4">
                <h3 className="text-lg font-semibold text-sqd-text-primary">Claimable Rewards</h3>
                {paymentTokens && paymentTokens.length > 0 ? (
                  paymentTokens.map((token) => (
                    <TokenRewardCard
                      key={token}
                      portalAddress={portalAddress}
                      tokenAddress={token}
                      userAddress={address}
                      onClaim={() => handleClaimFees(token)}
                      isPending={isPending}
                      isConfirming={isConfirming}
                    />
                  ))
                ) : (
                  <div className="text-center py-8 text-sqd-text-secondary">
                    No payment tokens configured for this portal
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {paymentTokens && paymentTokens.length > 0 ? (
                paymentTokens.map((token) => (
                  <TokenRewardCard
                    key={token}
                    portalAddress={portalAddress}
                    tokenAddress={token}
                    userAddress={address}
                    onClaim={() => handleClaimFees(token)}
                    isPending={isPending}
                    isConfirming={isConfirming}
                  />
                ))
              ) : (
                <div className="text-center py-8 text-sqd-text-secondary">
                  No payment tokens configured for this portal
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DistributionTokenInfo({
  tokenAddress,
  portalAddress,
  userAddress,
  distributionAmount,
  setDistributionAmount,
  onDistribute,
  isPending,
  isConfirming,
}: {
  tokenAddress: string;
  portalAddress: string;
  userAddress: `0x${string}` | undefined;
  distributionAmount: string;
  setDistributionAmount: (amount: string) => void;
  onDistribute: () => void;
  isPending: boolean;
  isConfirming: boolean;
}) {
  const tokenName = tokenAddress === contractAddresses.usdcToken ? "USDC" : "Token";
  const decimals = tokenAddress === contractAddresses.usdcToken ? 6 : 18;

  // Read token balance
  const { data: tokenBalance } = useReadContract({
    address: tokenAddress as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: userAddress ? [userAddress] : undefined,
  });

  // Read token allowance for portal
  const { data: tokenAllowance } = useReadContract({
    address: tokenAddress as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: userAddress ? [userAddress, portalAddress as `0x${string}`] : undefined,
  });

  const { writeContract: writeContractApprove, isPending: isApproving, data: approveHash } = useWriteContract();
  const { isLoading: isConfirmingApproval } = useWaitForTransactionReceipt({ 
    hash: approveHash
  });

  const balance = tokenBalance ? Number(formatUnits(tokenBalance, decimals)) : 0;
  const allowance = tokenAllowance ? Number(formatUnits(tokenAllowance, decimals)) : 0;
  const distributionAmountNum = distributionAmount ? parseFloat(distributionAmount) : 0;
  const needsApproval = distributionAmountNum > 0 && (!tokenAllowance || tokenAllowance < parseUnits(distributionAmount, decimals));
  const isApprovalPending = isApproving || isConfirmingApproval;

  const handleApproveToken = async (approveMax: boolean = false) => {
    if (!userAddress) return;

    let approveAmount: bigint;
    if (approveMax) {
      approveAmount = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
    } else {
      if (!distributionAmount) {
        alert("Please enter a distribution amount first");
        return;
      }
      approveAmount = parseUnits(distributionAmount, decimals);
    }

    writeContractApprove({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [portalAddress as `0x${string}`, approveAmount],
      chainId: targetChainId,
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-sqd-text-secondary mb-2">
          Amount to Distribute ({tokenName})
        </label>
        <input
          type="number"
          value={distributionAmount}
          onChange={(e) => {
            const value = e.target.value;
            if (value === "" || (parseFloat(value) >= 0 && parseFloat(value) <= 1000000000)) {
              setDistributionAmount(value);
            }
          }}
          placeholder="0.0"
          min="0"
          max={balance}
          step="0.1"
          className="w-full bg-white border border-sqd-divider rounded-lg px-4 py-3 text-sqd-text-primary placeholder-sqd-text-disabled focus:outline-none focus:border-sqd-accent"
        />
        <div className="flex justify-between text-xs text-sqd-text-secondary mt-1">
          <span>Balance: {balance.toLocaleString()} {tokenName}</span>
          <button
            onClick={() => setDistributionAmount(balance.toString())}
            className="text-sqd-accent hover:underline"
          >
            Max
          </button>
        </div>
      </div>

      {/* Approval Status */}
      <div className="p-3 bg-sqd-primary rounded-lg border border-sqd-divider">
        <div className="text-xs font-medium text-sqd-text-primary mb-2">Approval Status</div>
        <div className="flex justify-between text-xs">
          <span className="text-sqd-text-secondary">Portal Allowance:</span>
          <span className={`font-medium ${allowance > 0 ? 'text-green-700' : 'text-red-700'}`}>
            {allowance > 0 
              ? `✓ ${allowance.toLocaleString()} ${tokenName}`
              : '✗ Not Approved'}
          </span>
        </div>
      </div>

      {/* Approval Section */}
      {needsApproval && (
        <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
          <div className="text-sm font-medium text-yellow-800 mb-2">
            ⚠️ Approval Required
          </div>
          <div className="text-xs text-yellow-700 mb-3">
            The portal needs approval to transfer your {tokenName} tokens for distribution.
          </div>
          <div className="space-y-2">
            {distributionAmount && (
              <button
                onClick={() => handleApproveToken(false)}
                disabled={!distributionAmount || isApprovalPending || isPending || isConfirming}
                className="w-full bg-yellow-600 hover:bg-yellow-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium py-2 rounded-full transition-colors"
              >
                {isApprovalPending ? "Approving..." : `Approve ${distributionAmount} ${tokenName}`}
              </button>
            )}
            <button
              onClick={() => handleApproveToken(true)}
              disabled={isApprovalPending || isPending || isConfirming}
              className="w-full bg-sqd-primary hover:bg-sqd-divider disabled:opacity-50 disabled:cursor-not-allowed text-sqd-text-primary text-sm font-medium py-2 rounded-full transition-colors border border-sqd-divider"
            >
              {isApprovalPending ? "Approving..." : `Approve Max (Unlimited) ${tokenName}`}
            </button>
          </div>
        </div>
      )}

      {/* Distribute Button */}
      <button
        onClick={onDistribute}
        disabled={!distributionAmount || distributionAmountNum <= 0 || distributionAmountNum > balance || needsApproval || isPending || isConfirming}
        className="w-full bg-sqd-accent hover:bg-sqd-accent/90 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold py-3 rounded-full transition-colors"
      >
        {isPending || isConfirming ? "Distributing..." : `Distribute ${tokenName}`}
      </button>

      <div className="mt-4 p-3 bg-sqd-primary rounded-lg">
        <h4 className="text-sm font-medium text-sqd-text-primary mb-2">How distribution works</h4>
        <ul className="space-y-1.5 text-xs text-sqd-text-secondary">
          <li>• Only the portal operator can distribute tokens</li>
          <li>• Fees are split: providers, worker pool, and burn</li>
          <li>• Providers can claim their share based on stake</li>
          <li>• Distribution increases cumulative fees per share</li>
        </ul>
      </div>
    </div>
  );
}

function TokenBalanceDisplay({
  tokenAddress,
  tokenName,
  userAddress,
}: {
  tokenAddress: string;
  tokenName: string;
  userAddress: `0x${string}` | undefined;
}) {
  // Read token decimals
  const { data: decimals } = useReadContract({
    address: tokenAddress as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "decimals",
  });
  
  const { data: balance } = useReadContract({
    address: tokenAddress as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: userAddress ? [userAddress] : undefined,
  });

  if (balance === undefined || decimals === undefined) return null;

  const balanceFormatted = formatUnits(balance, Number(decimals)).replace(/\.?0+$/, "");
  const displayName = tokenAddress === contractAddresses.usdcToken ? "USDC" : tokenName;

  return (
    <div className="flex justify-between items-center p-2 bg-white rounded border border-sqd-divider">
      <span className="text-sm text-sqd-text-secondary">{displayName}</span>
      <span className="text-sm font-semibold text-sqd-text-primary">
        {balanceFormatted} {displayName}
      </span>
    </div>
  );
}

function TokenRewardCard({
  portalAddress,
  tokenAddress,
  userAddress,
  onClaim,
  isPending,
  isConfirming,
}: {
  portalAddress: string;
  tokenAddress: string;
  userAddress: `0x${string}` | undefined;
  onClaim: () => void;
  isPending: boolean;
  isConfirming: boolean;
}) {
  const { data: claimable } = useReadContract({
    address: portalAddress as `0x${string}`,
    abi: PORTAL_ABI,
    functionName: "getClaimableFees",
    args: userAddress ? [userAddress, tokenAddress as `0x${string}`] : undefined,
  });

  const tokenName = tokenAddress === contractAddresses.usdcToken ? "USDC" : "Token";
  const decimals = tokenAddress === contractAddresses.usdcToken ? 6 : 18;
  const claimableAmount = claimable ? Number(formatUnits(claimable, decimals)) : 0;

  return (
    <div className="border border-sqd-divider rounded-lg p-4">
      <div className="flex justify-between items-center mb-3">
        <div>
          <div className="font-medium text-sqd-text-primary">{tokenName}</div>
          <div className="text-xs text-sqd-text-secondary font-mono">
            {tokenAddress.slice(0, 6)}...{tokenAddress.slice(-4)}
          </div>
        </div>
        <div className="text-right">
          <div className="text-sm text-sqd-text-secondary">Claimable</div>
          <div className="text-lg font-semibold text-sqd-accent">{claimableAmount.toFixed(4)} {tokenName}</div>
        </div>
      </div>
      <button
        onClick={onClaim}
        disabled={claimableAmount === 0 || !userAddress || isPending || isConfirming}
        className="w-full bg-sqd-accent hover:bg-sqd-accent/90 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold py-2 rounded-full transition-colors"
      >
        {isPending || isConfirming ? "Claiming..." : `Claim ${tokenName}`}
      </button>
    </div>
  );
}
