import { ClickhouseClient } from "./clickhouseClient.js";
import { logger } from "./logger.js";

export type Rewards = {
  [key in string]: { workerReward: bigint; stakerReward: bigint };
};

export async function epochStats(from: Date, to: Date): Promise<Rewards> {
  logger.log(from, "-", to);
  const clickhouse = new ClickhouseClient(from, to);
  const workers = await clickhouse.getActiveWorkers();
  if (workers.count() === 0) {
    return;
  }
  await workers.clearUnknownWorkers();
  await workers.getStakes();
  workers.getT();
  await workers.fetchCurrentBond();
  workers.getTTrraffic();
  await workers.getLiveness();
  await workers.calculateRewards();
  await workers.logStats();
  return workers.rewards();
}
