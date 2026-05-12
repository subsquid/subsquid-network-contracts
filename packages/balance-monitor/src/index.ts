import { startServer } from "./server.js";
import { hasWalletsToMonitor, updateWalletMetrics } from "./wallets.js";
import { hasPortalToMonitor, updatePortalMetrics } from "./portal.js";

if (!hasWalletsToMonitor && !hasPortalToMonitor) {
  throw new Error(
    "Nothing to monitor. Set ETH_HOLDERS, SQD_HOLDERS, or both PORTAL_REGISTRY and PORTAL_OPERATORS",
  );
}

const intervalMs = 1000 * 60 * Number(process.env.INTERVAL_MINUTES ?? 120);

startServer();

async function updateMetrics() {
  await updateWalletMetrics().catch(console.error);
  await updatePortalMetrics().catch(console.error);
  setTimeout(updateMetrics, intervalMs);
}

void updateMetrics();
