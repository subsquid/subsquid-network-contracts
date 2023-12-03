import { contracts } from "./config.js";
import { fromBase58 } from "./utils.js";
import { publicClient } from "./client.js";
import { getAllWorkers } from "./logs.js";

(async () => {
  const workers = await getAllWorkers();
  for (const worker of workers) {
    if (
      await contracts.workerRegistration.read.workerIds([fromBase58(worker)])
    ) {
      console.log("Worker already registered", worker);
      continue;
    }
    const tx = await contracts.workerRegistration.write.register(
      [fromBase58(worker)],
      {},
    );
    await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log("Worker registered", worker);
  }
})();
