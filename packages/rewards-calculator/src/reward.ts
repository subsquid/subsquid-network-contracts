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
  ctx.logger.trace('getting block timestamps...');
  const from = await getBlockTimestamp(fromBlock);
  const to = await getBlockTimestamp(toBlock);

  const clickhouse = new ClickhouseClient(ctx, from, to);
  ctx.logger.trace('getting active workers...');
  const workers = await clickhouse.getActiveWorkers(shouldSkipSignatureValidation);
  if (workers.count() === 0) {
    return workers;
  }

  ctx.logger.trace('finding next distribution start block number...');
  await workers.getNextDistributionStartBlockNumber();

  ctx.logger.trace('clearing unknown workers...');
  await workers.clearUnknownWorkers();

  ctx.logger.trace('fetching stakes...');
  await workers.getStakes();
  workers.getT();

  ctx.logger.trace('fetching current bond...');
  await workers.fetchCurrentBond();
  workers.getDTrraffic();

  ctx.logger.trace('calculating liveness...');
  await workers.getLiveness();

  ctx.logger.trace('calculating D tenure...');
  await workers.getDTenure(fromBlock);

  ctx.logger.trace('calculating rewards...');
  await workers.calculateRewards();

  ctx.logger.trace('printing stats...');
  await workers.logStats(ctx);

  return workers;
}
