import { ClickHouse } from "clickhouse";
import dayjs, { Dayjs } from "dayjs";
import fs from "fs";
import utc from "dayjs/plugin/utc.js";

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

export interface Work {
  bytesSent: number;
  chunksRead: number;
  t?: number;
}

export type Workers = Awaited<ReturnType<typeof bytesSent>>;

export async function getAllWorkers() {
  const query = "select distinct workerId from testnet.queries";
  const workerIds: string[] = [];
  for await (const row of clickhouse.query(query).stream()) {
    workerIds.push(row.workerId);
  }
  return workerIds;
}

export async function clickhouseBytesSent(from: Date, to: Date) {
  const query = `select workerId, sum(responseBytes), sum(readChunks) from testnet.queries where timestamp >= '${formatDate(
    from,
  )}' and timestamp <= '${formatDate(to)}' group by workerId`;
  const workers: Record<string, Work> = {};
  for await (const row of clickhouse.query(query).stream()) {
    workers[row.workerId] = {
      bytesSent: row["sum(responseBytes)"],
      chunksRead: row["sum(readChunks)"],
    };
  }
  return workers;
}

export async function bytesSent(from: Date, to: Date) {
  const queries = (await fs.promises.readFile("queries.csv"))
    .toString()
    .split("\n")
    .slice(1)
    .map((line) => {
      const [timestamp, workerId, readChunks, responseBytes] = line.split(",");
      return {
        timestamp: new Date(timestamp).getTime(),
        workerId,
        readChunks: parseInt(readChunks),
        responseBytes: parseInt(responseBytes),
      };
    })
    .filter(
      ({ timestamp }) =>
        timestamp && timestamp >= from.getTime() && timestamp <= to.getTime(),
    );
  const workers: Record<string, Work> = {};
  for (const query of queries) {
    if (!workers[query.workerId])
      workers[query.workerId] = { bytesSent: 0, chunksRead: 0 };
    workers[query.workerId].bytesSent += query.responseBytes;
    workers[query.workerId].chunksRead += query.readChunks;
  }
  return workers;
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

async function clickhouseGetPings(from: Date, to: Date) {
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

async function getPings(from: Date, to: Date) {
  const pings: Record<string, Dayjs[]> = {};

  (await fs.promises.readFile("pings.csv"))
    .toString()
    .split("\n")
    .slice(1)
    .forEach((line) => {
      const [timestamp, workerId] = line.split(",");
      const time = new Date(timestamp).getTime();
      if (!time || time < from.getTime() || time > to.getTime()) return;
      if (!pings[workerId]) pings[workerId] = [dayjs(from)];
      pings[workerId].push(dayjs(timestamp));
    });
  return pings;
}

export async function livenessFactor(from: Date, to: Date) {
  const pings = await clickhouseGetPings(from, to);
  const totalPeriodSeconds = dayjs(to).diff(dayjs(from), "second");
  const netwotkStats: Record<
    string,
    {
      totalPings: number;
      totalTimeOffline: number;
      livenessFactor: number;
    }
  > = {};
  for (const workersKey in pings) {
    pings[workersKey].push(dayjs(formatDate(to)).utc().unix());
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

export type NetworkStats = Awaited<ReturnType<typeof livenessFactor>>;
