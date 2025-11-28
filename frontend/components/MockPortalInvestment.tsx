"use client";

import { useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { useMock } from "@/context/MockContext";

const STATE_NAMES = ["Collecting", "Active", "Failed"];

export function MockPortalInvestment({ portalAddress, onClose }: { portalAddress: string; onClose: () => void }) {
  const {
    mockPortals,
    mockProviders,
    mockUserAddress,
    mockMinStakeThreshold,
    mockCurrentEpoch,
    mockSqdBalance,
    mockUsdcBalance,
    stakeMock,
    requestExitMock,
    withdrawExitMock,
    claimFeesMock,
    distributeFeesMock,
  } = useMock();

  const [activeTab, setActiveTab] = useState<"stake" | "rewards" | "exit" | "distribution">("stake");
  const [stakeAmount, setStakeAmount] = useState("");
  const [exitAmount, setExitAmount] = useState("");
  const [distributeAmount, setDistributeAmount] = useState("");

  const portal = mockPortals.find((p) => p.address.toLowerCase() === portalAddress.toLowerCase());
  const provider = mockProviders.find((p) => p.address === mockUserAddress);

  if (!portal) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
          <p className="text-center text-sqd-text-secondary">Portal not found</p>
          <button onClick={onClose} className="mt-4 w-full bg-sqd-primary text-sqd-text-primary py-2 rounded-lg">
            Close
          </button>
        </div>
      </div>
    );
  }

  const maxCapacity = Number(formatUnits(portal.maxCapacity, 18));
  const totalStaked = Number(formatUnits(portal.totalStaked, 18));
  const minStake = Number(formatUnits(mockMinStakeThreshold, 18));
  const userStake = provider?.stakes[portalAddress] ? Number(formatUnits(provider.stakes[portalAddress], 18)) : 0;
  const availableCapacity = maxCapacity - totalStaked;
  const expectedRatePerDay = Number(formatUnits(portal.expectedRatePerDay, 6));
  const claimableUSDC = provider?.claimable[portalAddress]?.["0xA911Abb691d1F09DF1063cE28D78Ba5f9E1E66A2"]
    ? Number(formatUnits(provider.claimable[portalAddress]["0xA911Abb691d1F09DF1063cE28D78Ba5f9E1E66A2"], 6))
    : 0;
  const exitRequest = provider?.exitRequests[portalAddress];
  const isOperator = portal.operator.toLowerCase() === mockUserAddress.toLowerCase();

  const handleStake = () => {
    if (!stakeAmount) return;
    const amount = parseUnits(stakeAmount, 18);
    stakeMock(portalAddress, amount);
    setStakeAmount("");
  };

  const handleExit = () => {
    if (!exitAmount) return;
    const amount = parseUnits(exitAmount, 18);
    requestExitMock(portalAddress, amount);
    setExitAmount("");
  };

  const handleClaim = () => {
    claimFeesMock(portalAddress, "0xA911Abb691d1F09DF1063cE28D78Ba5f9E1E66A2");
  };

  const handleDistribute = () => {
    if (!distributeAmount) return;
    const amount = parseUnits(distributeAmount, 6);
    distributeFeesMock(portalAddress, "0xA911Abb691d1F09DF1063cE28D78Ba5f9E1E66A2", amount);
    setDistributeAmount("");
  };

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
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-semibold text-sqd-text-primary">Mock Portal</h2>
                <span className="px-2 py-0.5 bg-purple-100 text-purple-700 text-xs rounded-full">MOCK</span>
              </div>
              <p className="text-sm text-sqd-text-secondary font-mono mt-1">
                {portalAddress.slice(0, 10)}...{portalAddress.slice(-8)}
              </p>
            </div>
            <button onClick={onClose} className="text-sqd-text-secondary hover:text-sqd-text-primary text-2xl">
              x
            </button>
          </div>
        </div>

        {/* Portal Stats */}
        <div className="p-6 bg-gray-50 border-b border-sqd-divider">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <div className="text-xs text-sqd-text-secondary">Status</div>
              <div className="font-semibold text-sqd-text-primary">{STATE_NAMES[portal.state]}</div>
            </div>
            <div>
              <div className="text-xs text-sqd-text-secondary">Total Staked</div>
              <div className="font-semibold text-sqd-text-primary">{totalStaked.toLocaleString()} SQD</div>
            </div>
            <div>
              <div className="text-xs text-sqd-text-secondary">Your Stake</div>
              <div className="font-semibold text-sqd-accent">{userStake.toLocaleString()} SQD</div>
            </div>
            <div>
              <div className="text-xs text-sqd-text-secondary">Expected Rate</div>
              <div className="font-semibold text-green-600">${expectedRatePerDay.toFixed(2)}/day</div>
            </div>
          </div>

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
                    onClick={() => setStakeAmount(Math.min(availableCapacity, Number(formatUnits(mockSqdBalance, 18))).toString())}
                    className="px-4 py-2 bg-gray-100 text-sqd-text-secondary rounded-lg hover:bg-gray-200 text-sm"
                  >
                    MAX
                  </button>
                </div>
                <p className="text-xs text-sqd-text-secondary mt-1">
                  Available: {Number(formatUnits(mockSqdBalance, 18)).toLocaleString()} SQD |
                  Capacity remaining: {availableCapacity.toLocaleString()} SQD
                </p>
              </div>

              {stakeAmount && Number(stakeAmount) > 0 && (
                <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                  <div className="text-sm text-blue-800">
                    Your share after staking: {(((userStake + Number(stakeAmount)) / (totalStaked + Number(stakeAmount))) * 100).toFixed(2)}%
                  </div>
                  <div className="text-sm text-blue-700 mt-1">
                    Expected daily earnings: ${((expectedRatePerDay * (userStake + Number(stakeAmount))) / (totalStaked + Number(stakeAmount))).toFixed(2)}
                  </div>
                </div>
              )}

              <button
                onClick={handleStake}
                disabled={!stakeAmount || Number(stakeAmount) <= 0}
                className="w-full bg-sqd-accent hover:bg-sqd-accent/90 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-lg transition-colors"
              >
                Stake (Mock)
              </button>
            </div>
          )}

          {/* Rewards Tab */}
          {activeTab === "rewards" && (
            <div className="space-y-4">
              <div className="p-4 bg-green-50 rounded-lg border border-green-200">
                <div className="flex justify-between items-center">
                  <div>
                    <div className="text-sm text-green-700">Claimable USDC</div>
                    <div className="text-2xl font-bold text-green-800">${claimableUSDC.toFixed(2)}</div>
                  </div>
                  <button
                    onClick={handleClaim}
                    disabled={claimableUSDC <= 0}
                    className="px-6 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg font-medium"
                  >
                    Claim
                  </button>
                </div>
              </div>

              <div className="p-4 bg-gray-50 rounded-lg">
                <div className="text-sm text-sqd-text-secondary mb-2">Your Earnings Info</div>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span>Your Stake:</span>
                    <span className="font-medium">{userStake.toLocaleString()} SQD</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Your Share:</span>
                    <span className="font-medium">{totalStaked > 0 ? ((userStake / totalStaked) * 100).toFixed(2) : 0}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Expected Daily:</span>
                    <span className="font-medium text-green-600">
                      ${totalStaked > 0 ? ((expectedRatePerDay * userStake) / totalStaked).toFixed(2) : "0.00"}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Exit Tab */}
          {activeTab === "exit" && (
            <div className="space-y-4">
              {/* Show existing exit request if any */}
              {exitRequest && (
                <>
                  {mockCurrentEpoch >= exitRequest.unlockEpoch ? (
                    /* Ready to withdraw */
                    <div className="p-4 bg-green-50 rounded-lg border border-green-200">
                      <div className="text-sm text-green-800 font-medium mb-2">Ready to Withdraw!</div>
                      <div className="text-sm text-green-700">
                        Amount: {Number(formatUnits(exitRequest.amount, 18)).toLocaleString()} SQD
                      </div>
                      <div className="text-xs text-green-600 mt-1">
                        Unlock epoch {exitRequest.unlockEpoch.toString()} reached (Current: {mockCurrentEpoch.toString()})
                      </div>
                      <button
                        onClick={() => withdrawExitMock(portalAddress)}
                        className="mt-3 w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-2 rounded-lg transition-colors"
                      >
                        Withdraw {Number(formatUnits(exitRequest.amount, 18)).toLocaleString()} SQD
                      </button>
                    </div>
                  ) : (
                    /* Pending - show epochs remaining */
                    <div className="p-4 bg-yellow-50 rounded-lg border border-yellow-200">
                      <div className="text-sm text-yellow-800 font-medium mb-2">Exit Request Pending</div>
                      <div className="text-sm text-yellow-700">
                        Amount: {Number(formatUnits(exitRequest.amount, 18)).toLocaleString()} SQD
                      </div>
                      <div className="text-sm text-yellow-700">
                        Epochs remaining: {(exitRequest.unlockEpoch - mockCurrentEpoch).toString()}
                      </div>
                      <div className="text-xs text-yellow-600 mt-1">
                        Unlock at epoch {exitRequest.unlockEpoch.toString()} (Current: {mockCurrentEpoch.toString()})
                      </div>
                      <div className="mt-3 w-full bg-gray-200 rounded-full h-2">
                        <div
                          className="bg-yellow-500 h-2 rounded-full transition-all"
                          style={{
                            width: `${Math.min(100, ((Number(mockCurrentEpoch) - Number(exitRequest.requestEpoch)) / (Number(exitRequest.unlockEpoch) - Number(exitRequest.requestEpoch))) * 100)}%`
                          }}
                        />
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* Always show the exit form if user has remaining stake */}
              {userStake > 0 && (
                <>
                  <div className="border-t border-sqd-divider pt-4">
                    <label className="block text-sm font-medium text-sqd-text-secondary mb-2">
                      {exitRequest ? "Request Additional Exit (SQD)" : "Exit Amount (SQD)"}
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="number"
                        value={exitAmount}
                        onChange={(e) => setExitAmount(e.target.value)}
                        placeholder="0.0"
                        max={userStake}
                        className="flex-1 bg-white border border-sqd-divider rounded-lg px-4 py-3 text-sqd-text-primary focus:outline-none focus:border-sqd-accent"
                      />
                      <button
                        onClick={() => setExitAmount(userStake.toString())}
                        className="px-4 py-2 bg-gray-100 text-sqd-text-secondary rounded-lg hover:bg-gray-200 text-sm"
                      >
                        MAX
                      </button>
                    </div>
                    <p className="text-xs text-sqd-text-secondary mt-1">
                      Staked: {userStake.toLocaleString()} SQD
                    </p>
                  </div>

                  {exitAmount && Number(exitAmount) > 0 && (
                    <div className="p-4 bg-orange-50 rounded-lg border border-orange-200">
                      <div className="text-sm text-orange-800">
                        Exit delay: {Math.ceil(1 + (Number(exitAmount) / totalStaked) * 100)} epochs
                      </div>
                      <div className="text-xs text-orange-700 mt-1">
                        Formula: 1 base epoch + (exit% of total stake)
                      </div>
                    </div>
                  )}

                  <button
                    onClick={handleExit}
                    disabled={!exitAmount || Number(exitAmount) <= 0 || Number(exitAmount) > userStake}
                    className="w-full bg-orange-500 hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-lg transition-colors"
                  >
                    {exitRequest ? "Add to Exit Request (Mock)" : "Request Exit (Mock)"}
                  </button>
                </>
              )}

              {userStake === 0 && !exitRequest && (
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
                  Your USDC balance: {Number(formatUnits(mockUsdcBalance, 6)).toLocaleString()} USDC
                </p>
              </div>

              <div className="p-4 bg-gray-50 rounded-lg">
                <div className="text-sm text-sqd-text-secondary mb-2">Distribution Preview</div>
                <div className="text-sm">
                  <div className="flex justify-between">
                    <span>To Providers (50%):</span>
                    <span className="font-medium">${(Number(distributeAmount || 0) * 0.5).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>To Worker Pool (50%):</span>
                    <span className="font-medium">${(Number(distributeAmount || 0) * 0.5).toFixed(2)}</span>
                  </div>
                </div>
              </div>

              <button
                onClick={handleDistribute}
                disabled={!distributeAmount || Number(distributeAmount) <= 0}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-lg transition-colors"
              >
                Distribute (Mock)
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
