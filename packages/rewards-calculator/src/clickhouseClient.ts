import { ClickHouse } from "clickhouse";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";

import { Workers } from "./workers";
import { logger } from "./logger";
import { config } from "./config";
import { sum } from "./utils";

dayjs.extend(utc);
const clickhouse = new ClickHouse({
  url: config.clickhouse.url,
  basicAuth: {
    username: config.clickhouse.username,
    password: config.clickhouse.password,
  },
  format: "json",
});

function formatDate(date: Date) {
  return dayjs(date).utc().format("YYYY-MM-DD HH:mm:ss");
}

export class ClickhouseClient {
  private readonly workers: Workers;

  constructor(
    public from: Date,
    public to: Date,
  ) {
    this.workers = new Workers(this);
  }

  public async getActiveWorkers() {
    const columns = [
      "client_id",
      "worker_id",
      "query_id",
      "dataset",
      "query",
      "profiling",
      "client_state_json",
      "lcase(hex(query_hash)) as query_hash",
      "exec_time_ms",
      "result",
      "num_read_chunks",
      "output_size",
      "lcase(hex(output_hash)) as output_hash",
      "error_msg",
      "seq_no",
      "lcase(hex(client_signature)) as client_signature",
      "lcase(hex(worker_signature)) as worker_signature",
      "toUnixTimestamp64Milli(worker_timestamp) as worker_timestamp",
      "toUnixTimestamp64Milli(collector_timestamp) as collector_timestamp",
    ];
    await this.logTotalQueries();
    const query = `select ${columns.join(",")} from ${
      config.clickhouse.logsTableName
    } where ${
      config.clickhouse.logsTableName
    }.worker_timestamp >= '${formatDate(this.from)}' and ${
      config.clickhouse.logsTableName
    }.worker_timestamp <= '${formatDate(this.to)}' order by query_hash`;
    for await (const row of clickhouse.query(query).stream()) {
      const worker = this.workers.add(row.worker_id);
      await worker.processQuery(row);
    }
    return this.workers;
  }
  public async getPings(from = this.from, to = this.to) {
    const query = `select workerId, timestamp from ${
      config.clickhouse.pingsTableName
    } where timestamp >= '${formatDate(from)}' and timestamp <= '${formatDate(
      to,
    )}' order by timestamp`;
    const pings: Record<string, number[]> = {};
    for await (const row of clickhouse.query(query).stream()) {
      if (!pings[row.workerId])
        pings[row.workerId] = [dayjs(formatDate(from)).utc().unix()];
      pings[row.workerId].push(dayjs(row.timestamp).utc().unix());
    }
    return pings;
  }

  private async logTotalQueries() {
    const count = `select COUNT(*) as total from ${
      config.clickhouse.logsTableName
    } where ${
      config.clickhouse.logsTableName
    }.worker_timestamp >= '${formatDate(this.from)}' and ${
      config.clickhouse.logsTableName
    }.worker_timestamp <= '${formatDate(this.to)}'`;
    const [{ total }] = (await clickhouse.query(count).toPromise()) as any;
    logger.log("Processing queries:", total);
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
  const pings = await clickhouseClient.getPings();
  const totalPeriodSeconds = dayjs(clickhouseClient.to).diff(
    dayjs(clickhouseClient.from),
    "second",
  );
  const netwotkStats: Record<string, NetworkStatsEntry> = {};
  for (const workersKey in pings) {
    pings[workersKey].push(dayjs(formatDate(clickhouseClient.to)).utc().unix());
    netwotkStats[workersKey] = networkStats(
      pings[workersKey],
      totalPeriodSeconds,
    );
  }
  return netwotkStats;
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
