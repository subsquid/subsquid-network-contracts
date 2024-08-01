import { ClickhouseClient } from './clickhouseClient';
import { getBlockTimestamp } from './chain';
import { Workers } from './workers';
import { Context } from './logger';

export type Rewards = {
  [key in string]: {
    workerReward: bigint;
    stakerReward: bigint;
    computationUnitsUsed: number;
    id: bigint;
  };
};

export async function epochStats(
  ctx: Context,
  fromBlock: number,
  toBlock: number,
  shouldSkipSignatureValidation = false,
): Promise<Workers> {
  const from = await getBlockTimestamp(fromBlock);
  const to = await getBlockTimestamp(toBlock);
  const clickhouse = new ClickhouseClient(ctx, from, to);
  const workers = await clickhouse.getActiveWorkers(shouldSkipSignatureValidation);
  if (workers.count() === 0) {
    return workers;
  }
  await workers.getNextDistributionStartBlockNumber();
  await workers.clearUnknownWorkers();
  await workers.getStakes();
  workers.getT();
  await workers.fetchCurrentBond();
  workers.getDTrraffic();
  await workers.getLiveness();
  await workers.getDTenure(fromBlock);
  await workers.calculateRewards();
  await workers.logStats(ctx);
  return workers;
}
