"use client";

import { useState } from "react";
import { WalletConnect } from "@/components/WalletConnect";
import { ConfigPanel } from "@/components/ConfigPanel";
import { PortalDeployer } from "@/components/PortalDeployer";
import { PortalList } from "@/components/PortalList";
import { PortalInvestment } from "@/components/PortalInvestment";
import { MintSQD } from "@/components/MintSQD";
import { MintUSDC } from "@/components/MintUSDC";

export default function Home() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedPortal, setSelectedPortal] = useState<string | null>(null);

  const handlePortalCreated = () => {
    // Trigger refresh of portal list
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
              <ConfigPanel />
              <WalletConnect />
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="space-y-8">
          {/* Mint Tokens Section */}
          <div className="flex items-center gap-4">
            <MintSQD />
            <MintUSDC />
          </div>

          {/* Divider */}
          <div className="border-t border-sqd-divider" />

          {/* Portal Deployment Section */}
          <PortalDeployer onPortalCreated={handlePortalCreated} />

          {/* Divider */}
          <div className="border-t border-sqd-divider" />

          {/* Portal List Section */}
          <PortalList onPortalSelect={handlePortalSelect} refreshKey={refreshKey} />
        </div>

        {/* Portal Investment Modal */}
        {selectedPortal && (
          <PortalInvestment portalAddress={selectedPortal} onClose={handleClosePortal} />
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
                  are calculated as floor(totalStaked / minThreshold). More CUs = more network capacity
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
