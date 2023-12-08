import { ClickHouse } from "clickhouse";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";

import { Workers } from "./workers";

dayjs.extend(utc);
const clickhouse = new ClickHouse({
  url: "https://clickhouse.subsquid.io/",
  basicAuth: {
    username: "sqd_read",
    password: process.env.CLICKHOUSE_PASSWORD,
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
    const query = `select workerId, sum(responseBytes), sum(readChunks) from testnet.queries where timestamp >= '${formatDate(
      this.from,
    )}' and timestamp <= '${formatDate(this.to)}' group by workerId`;
    for await (const row of clickhouse.query(query).stream()) {
      const worker = this.workers.add(row.workerId);
      worker.bytesSent = row["sum(responseBytes)"];
      worker.chunksRead = row["sum(readChunks)"];
    }
    return this.workers;
  }

  public async getPings(from = this.from, to = this.to) {
    const query = `select workerId, timestamp from testnet.worker_pings where timestamp >= '${formatDate(
      from,
    )}' and timestamp <= '${formatDate(to)}' order by timestamp`;
    const pings: Record<string, number[]> = {};
    for await (const row of clickhouse.query(query).stream()) {
      if (!pings[row.workerId])
        pings[row.workerId] = [dayjs(formatDate(from)).utc().unix()];
      pings[row.workerId].push(dayjs(row.timestamp).utc().unix());
    }
    return pings;
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
  const THRESHOLD = 65;
  return diffs
    .filter((diff) => diff > THRESHOLD)
    .reduce((acc, diff) => acc + diff, 0);
}

export async function hasNewerPings(from: Date) {
  const query = `select count() as count from testnet.worker_pings where timestamp >= '${formatDate(
    from,
  )}'`;
  const [{ count }] = (await clickhouse.query(query).toPromise()) as [
    { count: number },
  ];
  return count > 0;
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
      splits.at(-1).push(epochRanges[index]);
      splits.push([epochRanges[index]]);
      index++;
    }
    const lastSplit = splits.at(-1);
    lastSplit.push(timestamp);
  }
  return splits;
}

export type NetworkStatsEntry = {
  totalPings: number;
  totalTimeOffline: number;
  livenessFactor: number;
};

export type NetworkStats = Record<string, NetworkStatsEntry>;
