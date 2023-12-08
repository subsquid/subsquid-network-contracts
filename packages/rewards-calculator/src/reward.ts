import { ClickhouseClient } from "./clickhouseClient";
import { logger } from "./logger";
import { getBlockTimestamp } from "./chain";

export type Rewards = {
  [key in string]: { workerReward: bigint; stakerReward: bigint };
};

export async function epochStats(
  fromBlock: number,
  toBlock: number,
): Promise<Rewards> {
  const from = await getBlockTimestamp(fromBlock);
  const to = await getBlockTimestamp(toBlock);
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
  workers.getDTrraffic();
  await workers.getLiveness();
  await workers.getDTenure(fromBlock);
  await workers.calculateRewards();
  await workers.logStats();
  return workers.rewards();
}
