"use client";

import { useState, useEffect } from "react";

interface Config {
  rpcUrl: string;
  portalFactoryAddress: string;
  sqdTokenAddress: string;
  usdcTokenAddress: string;
}

const DEFAULT_CONFIG: Config = {
  rpcUrl: "",
  portalFactoryAddress: "0x0000000000000000000000000000000000000000",
  sqdTokenAddress: "0x0000000000000000000000000000000000000000",
  usdcTokenAddress: "0x0000000000000000000000000000000000000000",
};

export function ConfigPanel() {
  const [showConfig, setShowConfig] = useState(false);
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);

  useEffect(() => {
    // Load from localStorage
    const saved = localStorage.getItem("portal-config");
    if (saved) {
      try {
        setConfig(JSON.parse(saved));
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

  if (!showConfig) {
    return (
      <button
        onClick={() => setShowConfig(true)}
        className="text-sm text-sqd-text-secondary hover:text-sqd-text-primary transition-colors"
      >
        ⚙️ Configuration
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
              ✕
            </button>
          </div>
          <p className="text-sm text-sqd-text-secondary mt-1">
            Configure RPC and contract addresses
          </p>
        </div>

        <div className="p-6 space-y-5">
          {/* RPC URL */}
          <div>
            <label className="block text-sm font-medium text-sqd-text-primary mb-2">
              RPC URL
            </label>
            <input
              type="text"
              value={config.rpcUrl}
              onChange={(e) => setConfig({ ...config, rpcUrl: e.target.value })}
              placeholder="https://arb1.arbitrum.io/rpc"
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
              💡 Configuration Tips
            </h4>
            <ul className="space-y-1 text-xs text-sqd-text-secondary">
              <li>• Changes are saved to browser localStorage</li>
              <li>• Page will reload after saving to apply new settings</li>
              <li>• Use &quot;Reset to Defaults&quot; to clear all custom values</li>
              <li>
                • Get Portal Pool addresses from PortalCreated events after factory deployment
              </li>
            </ul>
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
