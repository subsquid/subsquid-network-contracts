"use client";

import { useState } from "react";
import { WalletConnect } from "@/components/WalletConnect";
import { ConfigPanel } from "@/components/ConfigPanel";
import { PortalDeployer } from "@/components/PortalDeployer";
import { PortalList } from "@/components/PortalList";
import { PortalInvestment } from "@/components/PortalInvestment";
import { MockPortalInvestment } from "@/components/MockPortalInvestment";
import { MintSQD } from "@/components/MintSQD";
import { MintUSDC } from "@/components/MintUSDC";
import { useMock } from "@/context/MockContext";

export default function Home() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedPortal, setSelectedPortal] = useState<string | null>(null);
  const { isMockMode, setMockMode, advanceEpochMock, mockCurrentEpoch } = useMock();

  const handlePortalCreated = () => {
    setRefreshKey((prev) => prev + 1);
  };

  const handlePortalSelect = (address: string) => {
    setSelectedPortal(address);
  };

  const handleClosePortal = () => {
    setSelectedPortal(null);
  };

  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-sqd-divider bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-2xl font-medium text-sqd-text-primary tracking-tight">
                SQD Portal Network
              </h1>
              <p className="text-sqd-text-secondary text-sm mt-1 font-normal">
                Create portals and stake SQD to earn rewards
              </p>
            </div>
            <div className="flex items-center gap-4">
              {/* Mock Mode Toggle */}
              <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 rounded-lg border border-gray-200">
                <span className="text-sm text-sqd-text-secondary">Mock Mode</span>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isMockMode}
                    onChange={(e) => setMockMode(e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-purple-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-purple-600"></div>
                </label>
              </div>
              {!isMockMode && <ConfigPanel />}
              {!isMockMode && <WalletConnect />}
            </div>
          </div>
        </div>
      </header>

      {/* Mock Mode Banner */}
      {isMockMode && (
        <div className="bg-purple-600 text-white py-3">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-lg">🧪</span>
                <span className="font-medium">Mock Mode Active</span>
                <span className="text-purple-200 text-sm">- No blockchain connection required</span>
              </div>
              <div className="flex items-center gap-4">
                <span className="text-sm text-purple-200">Epoch: {mockCurrentEpoch.toString()}</span>
                <button
                  onClick={advanceEpochMock}
                  className="px-3 py-1 bg-purple-500 hover:bg-purple-400 rounded-full text-sm font-medium transition-colors"
                >
                  Advance Epoch
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="space-y-8">
          {/* Mint Tokens Section - Only show in real mode */}
          {!isMockMode && (
            <>
              <div className="flex items-center gap-4">
                <MintSQD />
                <MintUSDC />
              </div>
              <div className="border-t border-sqd-divider" />
            </>
          )}

          {/* Mock Balances Display */}
          {isMockMode && (
            <>
              <div className="bg-purple-50 rounded-lg p-4 border border-purple-200">
                <h3 className="text-sm font-medium text-purple-800 mb-3">Mock Wallet</h3>
                <div className="grid grid-cols-3 gap-4">
                  <div className="bg-white rounded-lg p-3 border border-purple-200">
                    <div className="text-xs text-sqd-text-secondary">Address</div>
                    <div className="font-mono text-sm truncate">0xd409...7c34</div>
                  </div>
                  <div className="bg-white rounded-lg p-3 border border-purple-200">
                    <div className="text-xs text-sqd-text-secondary">SQD Balance</div>
                    <div className="font-semibold text-sqd-text-primary">10,000,000 SQD</div>
                  </div>
                  <div className="bg-white rounded-lg p-3 border border-purple-200">
                    <div className="text-xs text-sqd-text-secondary">USDC Balance</div>
                    <div className="font-semibold text-sqd-text-primary">100,000 USDC</div>
                  </div>
                </div>
              </div>
              <div className="border-t border-sqd-divider" />
            </>
          )}

          {/* Portal Deployment Section */}
          <PortalDeployer onPortalCreated={handlePortalCreated} />

          <div className="border-t border-sqd-divider" />

          {/* Portal List Section */}
          <PortalList onPortalSelect={handlePortalSelect} refreshKey={refreshKey} />
        </div>

        {/* Portal Investment Modal */}
        {selectedPortal && !isMockMode && (
          <PortalInvestment portalAddress={selectedPortal} onClose={handleClosePortal} />
        )}

        {/* Mock Portal Investment Modal */}
        {selectedPortal && isMockMode && (
          <MockPortalInvestment portalAddress={selectedPortal} onClose={handleClosePortal} />
        )}

        {/* How It Works Section */}
        <div className="bg-white rounded-lg p-6 border border-sqd-divider mt-8">
          <h3 className="text-lg font-medium mb-4 text-sqd-text-primary">How It Works</h3>
          <div className="space-y-4 text-sm text-sqd-text-secondary">
            <div className="flex items-start gap-3">
              <div className="bg-sqd-accent text-white rounded-full w-7 h-7 flex items-center justify-center flex-shrink-0 mt-0.5 text-xs font-semibold">
                1
              </div>
              <div>
                <p className="font-medium text-sqd-text-primary mb-1">Deploy a Portal</p>
                <p className="leading-relaxed">
                  Operators deploy portals with configurable capacity (1x-12x minimum threshold). Choose
                  collection period, optionally pre-deposit SQD, and configure payment tokens (USDC, DAI, etc.)
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="bg-sqd-accent text-white rounded-full w-7 h-7 flex items-center justify-center flex-shrink-0 mt-0.5 text-xs font-semibold">
                2
              </div>
              <div>
                <p className="font-medium text-sqd-text-primary mb-1">Stake & Earn CUs</p>
                <p className="leading-relaxed">
                  SQD holders stake tokens via GatewayRegistry during the Collecting phase. CUs (Compute Units)
                  are calculated as 10 SQD = 1 CU. More CUs = more network capacity
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="bg-sqd-accent text-white rounded-full w-7 h-7 flex items-center justify-center flex-shrink-0 mt-0.5 text-xs font-semibold">
                3
              </div>
              <div>
                <p className="font-medium text-sqd-text-primary mb-1">Distribute Fees</p>
                <p className="leading-relaxed">
                  Operators distribute fees in multiple tokens (USDC, DAI, USDT). Fee split: 50% to liquidity
                  providers, 50% to worker reward pool. No burn mechanism
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="bg-sqd-accent text-white rounded-full w-7 h-7 flex items-center justify-center flex-shrink-0 mt-0.5 text-xs font-semibold">
                4
              </div>
              <div>
                <p className="font-medium text-sqd-text-primary mb-1">Claim & Exit</p>
                <p className="leading-relaxed">
                  Claim rewards in any payment token anytime. Exit requests have a delay based on your
                  percentage of total stake (1 base epoch + % of stake in epochs)
                </p>
              </div>
            </div>
          </div>
        </div>
      </main>

      <footer className="border-t border-sqd-divider bg-white mt-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <p className="text-center text-sqd-text-secondary text-sm">
            SQD Portal Network - Built with Next.js and Wagmi
          </p>
        </div>
      </footer>
    </div>
  );
}
