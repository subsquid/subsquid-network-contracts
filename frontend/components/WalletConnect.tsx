"use client";

import { useState, useEffect } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";

export function WalletConnect() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Prevent hydration mismatch - connectors differ between server/client
  if (!mounted) {
    return (
      <div className="flex gap-2">
        <button className="bg-sqd-accent hover:bg-sqd-accent/90 text-white text-xs font-semibold px-4 py-2 rounded-full transition-all">
          Connect Wallet
        </button>
      </div>
    );
  }

  if (isConnected) {
    return (
      <div className="flex items-center gap-3">
        <div className="bg-sqd-primary px-3 py-1.5 rounded-lg border border-sqd-divider">
          <span className="text-xs text-sqd-text-secondary font-medium">
            {address?.slice(0, 6)}...{address?.slice(-4)}
          </span>
        </div>
        <button
          onClick={() => disconnect()}
          className="text-xs font-medium text-sqd-error hover:text-sqd-error/80 transition-colors px-3 py-1.5 rounded-lg border border-sqd-error hover:bg-sqd-error/5"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div className="flex gap-2">
      {connectors.map((connector) => (
        <button
          key={connector.id}
          onClick={() => connect({ connector })}
          className="bg-sqd-accent hover:bg-sqd-accent/90 text-white text-xs font-semibold px-4 py-2 rounded-full transition-all"
        >
          Connect Wallet
        </button>
      ))}
    </div>
  );
}
