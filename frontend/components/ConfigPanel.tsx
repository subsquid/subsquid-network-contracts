"use client";

import { useState, useEffect } from "react";

interface Config {
  rpcUrl: string;
  portalFactoryAddress: string;
  sqdTokenAddress: string;
  usdcTokenAddress: string;
  gatewayRegistryAddress: string;
  networkControllerAddress: string;
}

const DEFAULT_CONFIG: Config = {
  rpcUrl: "",
  portalFactoryAddress: "0x0000000000000000000000000000000000000000",
  sqdTokenAddress: "0x0000000000000000000000000000000000000000",
  usdcTokenAddress: "0x0000000000000000000000000000000000000000",
  gatewayRegistryAddress: "0x0000000000000000000000000000000000000000",
  networkControllerAddress: "0x0000000000000000000000000000000000000000",
};

export function ConfigPanel() {
  const [showConfig, setShowConfig] = useState(false);
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);

  useEffect(() => {
    // Load from localStorage
    const saved = localStorage.getItem("portal-config");
    if (saved) {
      try {
        setConfig({ ...DEFAULT_CONFIG, ...JSON.parse(saved) });
      } catch (e) {
        console.error("Failed to load config:", e);
      }
    }
  }, []);

  const handleSave = () => {
    localStorage.setItem("portal-config", JSON.stringify(config));
    // Reload page to apply new config
    window.location.reload();
  };

  const handleReset = () => {
    localStorage.removeItem("portal-config");
    setConfig(DEFAULT_CONFIG);
  };

  // Quick fill with latest deployment addresses
  const handleFillLatestDeployment = () => {
    setConfig({
      ...config,
      portalFactoryAddress: "0xf8F8eAb7BF83fd23A87070A1f445840c0bF2e16F",
      sqdTokenAddress: "0x330E8eF0d0eD2f9Dcb1a30A139598AB2531fd9AD",
      usdcTokenAddress: "0xE8C38fF9c5B37e202Fa1d456C59b12a1e7FD87Da",
      gatewayRegistryAddress: "0x41FceF68E56E07FAFF1cc87bA4aA52059ea8A4Ef",
      networkControllerAddress: "0x2368B049a4a0CF0e12628F7664Cf7c7C537917e5",
    });
  };

  if (!showConfig) {
    return (
      <button
        onClick={() => setShowConfig(true)}
        className="text-sm text-sqd-text-secondary hover:text-sqd-text-primary transition-colors"
      >
        Configuration
      </button>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6 border-b border-sqd-divider">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold text-sqd-text-primary">Configuration</h2>
            <button
              onClick={() => setShowConfig(false)}
              className="text-sqd-text-secondary hover:text-sqd-text-primary"
            >
              X
            </button>
          </div>
          <p className="text-sm text-sqd-text-secondary mt-1">
            Configure RPC and contract addresses
          </p>
        </div>

        <div className="p-6 space-y-5">
          {/* Quick Fill Button */}
          <div className="bg-green-50 border border-green-200 rounded-lg p-4">
            <div className="text-sm font-medium text-green-800 mb-2">
              Quick Fill - Latest Deployment (Nov 25, 2024)
            </div>
            <button
              onClick={handleFillLatestDeployment}
              className="w-full bg-green-600 hover:bg-green-700 text-white text-sm font-medium py-2 rounded-full transition-colors"
            >
              Fill with Latest Deployed Addresses
            </button>
          </div>

          {/* RPC URL */}
          <div>
            <label className="block text-sm font-medium text-sqd-text-primary mb-2">
              RPC URL
            </label>
            <input
              type="text"
              value={config.rpcUrl}
              onChange={(e) => setConfig({ ...config, rpcUrl: e.target.value })}
              placeholder="https://sepolia-rollup.arbitrum.io/rpc"
              className="w-full bg-white border border-sqd-divider rounded-lg px-3.5 py-2.5 text-sqd-text-primary placeholder-sqd-text-disabled focus:outline-none focus:border-sqd-secondary font-mono text-sm"
            />
            <p className="text-xs text-sqd-text-secondary mt-1">
              Custom RPC endpoint (leave empty for default)
            </p>
          </div>

          {/* Portal Factory Address */}
          <div>
            <label className="block text-sm font-medium text-sqd-text-primary mb-2">
              Portal Factory Address
            </label>
            <input
              type="text"
              value={config.portalFactoryAddress}
              onChange={(e) =>
                setConfig({ ...config, portalFactoryAddress: e.target.value })
              }
              placeholder="0x..."
              className="w-full bg-white border border-sqd-divider rounded-lg px-3.5 py-2.5 text-sqd-text-primary placeholder-sqd-text-disabled focus:outline-none focus:border-sqd-secondary font-mono text-sm"
            />
            <p className="text-xs text-sqd-text-secondary mt-1">
              Address of the PortalFactory contract
            </p>
          </div>

          {/* Gateway Registry Address */}
          <div>
            <label className="block text-sm font-medium text-sqd-text-primary mb-2">
              Gateway Registry Address
            </label>
            <input
              type="text"
              value={config.gatewayRegistryAddress}
              onChange={(e) =>
                setConfig({ ...config, gatewayRegistryAddress: e.target.value })
              }
              placeholder="0x..."
              className="w-full bg-white border border-sqd-divider rounded-lg px-3.5 py-2.5 text-sqd-text-primary placeholder-sqd-text-disabled focus:outline-none focus:border-sqd-secondary font-mono text-sm"
            />
            <p className="text-xs text-sqd-text-secondary mt-1">
              Address of the GatewayRegistry contract (IMPORTANT: approvals go here!)
            </p>
          </div>

          {/* Network Controller Address */}
          <div>
            <label className="block text-sm font-medium text-sqd-text-primary mb-2">
              Network Controller Address
            </label>
            <input
              type="text"
              value={config.networkControllerAddress}
              onChange={(e) =>
                setConfig({ ...config, networkControllerAddress: e.target.value })
              }
              placeholder="0x..."
              className="w-full bg-white border border-sqd-divider rounded-lg px-3.5 py-2.5 text-sqd-text-primary placeholder-sqd-text-disabled focus:outline-none focus:border-sqd-secondary font-mono text-sm"
            />
            <p className="text-xs text-sqd-text-secondary mt-1">
              Address of the NetworkController contract (for epoch info)
            </p>
          </div>

          {/* SQD Token Address */}
          <div>
            <label className="block text-sm font-medium text-sqd-text-primary mb-2">
              SQD Token Address
            </label>
            <input
              type="text"
              value={config.sqdTokenAddress}
              onChange={(e) => setConfig({ ...config, sqdTokenAddress: e.target.value })}
              placeholder="0x..."
              className="w-full bg-white border border-sqd-divider rounded-lg px-3.5 py-2.5 text-sqd-text-primary placeholder-sqd-text-disabled focus:outline-none focus:border-sqd-secondary font-mono text-sm"
            />
            <p className="text-xs text-sqd-text-secondary mt-1">Address of the SQD token</p>
          </div>

          {/* USDC Token Address */}
          <div>
            <label className="block text-sm font-medium text-sqd-text-primary mb-2">
              USDC Token Address
            </label>
            <input
              type="text"
              value={config.usdcTokenAddress}
              onChange={(e) => setConfig({ ...config, usdcTokenAddress: e.target.value })}
              placeholder="0x..."
              className="w-full bg-white border border-sqd-divider rounded-lg px-3.5 py-2.5 text-sqd-text-primary placeholder-sqd-text-disabled focus:outline-none focus:border-sqd-secondary font-mono text-sm"
            />
            <p className="text-xs text-sqd-text-secondary mt-1">
              Address of the USDC token (payment token)
            </p>
          </div>

          {/* Info Box */}
          <div className="bg-sqd-primary rounded-lg p-4">
            <h4 className="text-sm font-medium text-sqd-text-primary mb-2">
              Configuration Tips
            </h4>
            <ul className="space-y-1 text-xs text-sqd-text-secondary">
              <li>* Changes are saved to browser localStorage</li>
              <li>* Page will reload after saving to apply new settings</li>
              <li>* Use &quot;Reset to Defaults&quot; to clear all custom values</li>
              <li>* GatewayRegistry is where SQD approvals need to go for staking!</li>
            </ul>
          </div>

          {/* Current Config Display */}
          <div className="bg-gray-50 rounded-lg p-4">
            <h4 className="text-sm font-medium text-sqd-text-primary mb-2">
              Current Saved Config
            </h4>
            <pre className="text-xs text-sqd-text-secondary overflow-x-auto">
              {JSON.stringify(config, null, 2)}
            </pre>
          </div>
        </div>

        {/* Actions */}
        <div className="p-6 border-t border-sqd-divider flex gap-3">
          <button
            onClick={handleReset}
            className="flex-1 bg-sqd-primary hover:bg-sqd-divider text-sqd-text-primary py-2.5 rounded-full text-sm font-medium transition-colors"
          >
            Reset to Defaults
          </button>
          <button
            onClick={handleSave}
            className="flex-1 bg-sqd-accent hover:bg-sqd-accent/90 text-white py-2.5 rounded-full text-sm font-semibold transition-colors"
          >
            Save & Reload
          </button>
        </div>
      </div>
    </div>
  );
}
