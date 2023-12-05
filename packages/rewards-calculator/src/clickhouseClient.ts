import { ClickHouse } from "clickhouse";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";

import { Workers } from "./workers.js";

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

  public async getPings() {
    const query = `select workerId, timestamp from testnet.worker_pings where timestamp >= '${formatDate(
      this.from,
    )}' and timestamp <= '${formatDate(this.to)}' order by timestamp`;
    const pings: Record<string, number[]> = {};
    for await (const row of clickhouse.query(query).stream()) {
      if (!pings[row.workerId])
        pings[row.workerId] = [dayjs(formatDate(this.from)).utc().unix()];
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
    const diffs = secondDiffs(pings[workersKey]);
    const totalTimeOffline = totalOfflineSeconds(diffs);
    netwotkStats[workersKey] = {
      totalPings: diffs.length - 1,
      totalTimeOffline: totalOfflineSeconds(diffs),
      livenessFactor: 1 - totalTimeOffline / totalPeriodSeconds,
    };
  }
  return netwotkStats;
}

export type NetworkStatsEntry = {
  totalPings: number;
  totalTimeOffline: number;
  livenessFactor: number;
};

export type NetworkStats = Record<string, NetworkStatsEntry>;
