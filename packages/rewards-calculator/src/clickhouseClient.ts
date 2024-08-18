import { ClickHouse } from 'clickhouse';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';

import { Workers } from './workers';
import { Context } from './logger';
import { config } from './config';
import { sum } from './utils';

dayjs.extend(utc);
const clickhouse = new ClickHouse({
  url: config.clickhouse.url,
  basicAuth: {
    username: config.clickhouse.username,
    password: config.clickhouse.password,
  },
  format: 'json',
});

function formatDate(date: Date) {
  return dayjs(date).utc().format('YYYY-MM-DD HH:mm:ss');
}

function toUnixTime(date: Date) {
  return date.getTime();
}

export class ClickhouseClient {
  private readonly workers: Workers;

  constructor(
    public ctx: Context,
    public from: Date,
    public to: Date,
  ) {
    this.workers = new Workers(this);
  }

  async getActiveWorkers(shouldSkipSignatureValidation = false) {
    const columns = [
      'client_id',
      'worker_id',
      'query_id',
      'dataset',
      'query',
      'profiling',
      'client_state_json',
      'lcase(hex(query_hash)) as query_hash',
      'exec_time_ms',
      'result',
      'num_read_chunks',
      'output_size',
      'lcase(hex(output_hash)) as output_hash',
      'error_msg',
      'seq_no',
      'lcase(hex(client_signature)) as client_signature',
      'lcase(hex(worker_signature)) as worker_signature',
      'toUnixTimestamp64Milli(worker_timestamp) as worker_timestamp',
      'toUnixTimestamp64Milli(collector_timestamp) as collector_timestamp',
      '(collector_timestamp - worker_timestamp) / 60000 as timeDiff',
    ];


    const query = `
      select ${columns.join(',')}
       from ${config.clickhouse.logsTableName}
       where worker_timestamp >= ${toUnixTime(this.from)}
        and worker_timestamp <= ${toUnixTime(this.to)}
        and timeDiff < 20 order by query_hash
    `;

    this.ctx.logger.trace(query);

    await this.logTotalQueries();

    const stream = clickhouse.query(query).stream();
    // FIXME: BUN do not catch stream async iterators errors, needs to be investigated why
    // stream.on('error', reject)

    let count = 0;
    try {
      for await (const row of stream) {
        const worker = this.workers.add(row.worker_id);
        await worker.processQuery(row, shouldSkipSignatureValidation);
        count++;
      }
    } catch (e) {
      /**
       * we do not reject the promise here because of legacy
       * TODO refactor to reject the promise
       */

      this.ctx.logger.error({
        message: 'failed to get active workers',
        err: e,
      });
    }

    this.ctx.logger.trace(`processed ${count} pings for ${this.workers.count()} workers`);

    return this.workers;
  }

  async getPings(from = this.from, to = this.to) {
    // const workerFilter = this.workers.count() ?
    //   `and worker_id in (${this.workers.getAllIds().map((w) => `'${w}'`).join(',')})` :
    //   '';

    const query = `select
       worker_id,
       arrayConcat(
         [toUnixTimestamp('${formatDate(from)}')],
         arraySort(groupArray(toUnixTimestamp(timestamp))),
         [toUnixTimestamp('${formatDate(to)}')]
       ) as timestamps 
       from ${config.clickhouse.pingsTableName} 
       where timestamp >= '${formatDate(from)}' and timestamp <= '${formatDate(to)}'
       group by worker_id
    `;

    this.ctx.logger.trace(query);

    let count = 0;
    const pings: Record<string, number[]> = {};
    for await (const row of clickhouse.query(query).stream()) {
      pings[row.worker_id] = row.timestamps;
      count++;
    }

    this.ctx.logger.trace(`processed ${count} pings`);

    return pings;
  }

  private async logTotalQueries() {
    const count = `
        select COUNT(*) as total 
        from ${config.clickhouse.logsTableName} 
        where worker_timestamp >= '${formatDate(this.from)}' and worker_timestamp <= '${formatDate(this.to)}'
    `;

    const res = await clickhouse.query(count).toPromise();
    const [{total}] = res as any;

    this.ctx.logger.debug(`processing queries: ${total}`);
  }
}

function secondDiffs(dates: number[]) {
  return dates
    .map((date, i) => {
      if (i === 0) return 0;
      return date - dates[i - 1];
    })
    .slice(1);
}

function totalOfflineSeconds(diffs: number[]) {
  return sum(diffs.filter((diff) => diff > config.workerOfflineThreshold));
}

export async function livenessFactor(clickhouseClient: ClickhouseClient) {
  clickhouseClient.ctx.logger.debug('calculating liveness factor...');

  const pings = await clickhouseClient.getPings();
  const totalPeriodSeconds = dayjs(clickhouseClient.to).diff(
    dayjs(clickhouseClient.from),
    'second',
  );

  const res: Record<string, NetworkStatsEntry> = {};
  for (const workersKey in pings) {
    res[workersKey] = networkStats(
      pings[workersKey],
      totalPeriodSeconds,
    );
  }

  clickhouseClient.ctx.logger.debug(`liveness factor calculated for ${Object.keys(pings).length}`);

  return res;
}

function networkStats(pingTimestamps: number[], epochLength: number) {
  const diffs = secondDiffs(pingTimestamps);
  const totalTimeOffline = totalOfflineSeconds(diffs);
  return {
    totalPings: diffs.length - 1,
    totalTimeOffline: totalTimeOffline,
    livenessFactor: 1 - totalTimeOffline / epochLength,
  };
}

export async function historicalLiveness(
  clickhouseClient: ClickhouseClient,
  epochRanges: Date[],
) {
  const sortedEpochRanges = epochRanges.sort(
    (a, b) => a.getTime() - b.getTime(),
  );
  const from = sortedEpochRanges[0];
  const to = sortedEpochRanges.at(-1);
  const pings = await clickhouseClient.getPings(from, to);
  const epochRangesTimestamps = sortedEpochRanges.map((date) =>
    dayjs(formatDate(date)).utc().unix(),
  );
  const splittedPings = Object.entries(pings).map(([workerId, timestamps]) => {
    return [workerId, splitLogs(timestamps, epochRangesTimestamps)] as const;
  });
  const _networkStats = splittedPings.map(
    ([workerId, splits]) =>
      [
        workerId,
        splits.map((split, i) => {
          return networkStats(
            split,
            epochRangesTimestamps[i + 1] - epochRangesTimestamps[i],
          ).livenessFactor;
        }),
      ] as const,
  );
  return Object.fromEntries(_networkStats);
}

function splitLogs(timestamps: number[], epochRanges: number[]) {
  const sortedTimestamps = timestamps.sort();
  const splits: number[][] = [[epochRanges[0]]];
  let index = 1;
  for (const timestamp of sortedTimestamps) {
    while (index < epochRanges.length && timestamp > epochRanges[index]) {
      splits.at(-1)!.push(epochRanges[index]);
      splits.push([epochRanges[index]]);
      index++;
    }
    const lastSplit = splits.at(-1)!;
    lastSplit.push(timestamp);
  }
  return splits;
}

export type NetworkStatsEntry = {
  totalPings: number;
  totalTimeOffline: number;
  livenessFactor: number;
};
