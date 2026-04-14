import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClickHouse } from 'clickhouse';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { Context } from '../common';

dayjs.extend(utc);

export interface WorkerPing {
  peer_id: string;
  worker_id: string;
  timestamp: string;
  block_number: number;
  query_id: string;
}

export interface WorkerQueryLog {
  peer_id: string;
  worker_id: string;
  timestamp: string;
  block_number: number;
  query_id: string;
  dataset: string;
  client_state_json: string;
  query: string;
  result: string;
  error?: string;
  exec_time_ms: number;
  output_bytes: number;
}

export interface WorkerStats {
  workerId: string;
  peerId: string;
  totalQueries: number;
  successfulQueries: number;
  avgResponseTime: number;
  totalBytes: number;
  lastSeen: Date;
  uptime: number;
  trafficWeight: number;
}

export interface WorkerQueryData {
  worker_id: string;
  num_read_chunks: number;
  output_size: number;
  totalRequests: number;
}

export interface NetworkStatsEntry {
  totalPings: number;
  totalTimeOffline: number;
  livenessFactor: number;
}

@Injectable()
export class ClickHouseService implements OnModuleInit {
  private client: any;
  private config: any;
  private logsTableName: string;
  private pingsTableName: string;

  constructor(private configService: ConfigService) {
    this.config = this.configService.get('database.clickhouse');
    this.logsTableName = this.config.tables.workerQueryLogs;
    this.pingsTableName = this.config.tables.workerPings;
  }

  async onModuleInit() {
    try {
      this.client = new ClickHouse({
        url: this.config.url,
        basicAuth: {
          username: this.config.username,
          password: this.config.password,
        },
        format: 'json',
      });

      await this.ping();
      console.log('ClickHouse connection established');
    } catch (error) {
      console.error(
        `Failed to initialize ClickHouse connection: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.query('SELECT 1').toPromise();
      return true;
    } catch (error) {
      console.error(
        `ClickHouse ping failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  private formatDate(date: Date): string {
    return dayjs(date).utc().format('YYYY-MM-DD HH:mm:ss');
  }

  async getWorkerStats(
    ctx: Context,
    fromTimestamp: Date,
    toTimestamp: Date,
    workerIds?: string[],
  ): Promise<WorkerStats[]> {
    const { workerQueryLogs, workerPings } = this.config.tables;

    let workerFilter = '';
    if (workerIds && workerIds.length > 0) {
      const workerList = workerIds.map((id) => `'${id}'`).join(',');
      workerFilter = `AND worker_id IN (${workerList})`;
    }

    const query = `
      WITH worker_queries AS (
        SELECT 
          worker_id,
          peer_id,
          COUNT(*) as total_queries,
          COUNT(CASE WHEN error = '' OR error IS NULL THEN 1 END) as successful_queries,
          AVG(exec_time_ms) as avg_response_time,
          SUM(output_bytes) as total_bytes
        FROM ${workerQueryLogs}
        WHERE timestamp >= '${fromTimestamp.toISOString()}'
          AND timestamp <= '${toTimestamp.toISOString()}'
          ${workerFilter}
        GROUP BY worker_id, peer_id
      ),
      worker_pings AS (
        SELECT 
          worker_id,
          peer_id,
          MIN(timestamp) as first_seen,
          MAX(timestamp) as last_seen,
          COUNT(DISTINCT date(timestamp)) as active_days
        FROM ${workerPings}
        WHERE timestamp >= '${fromTimestamp.toISOString()}'
          AND timestamp <= '${toTimestamp.toISOString()}'
          ${workerFilter}
        GROUP BY worker_id, peer_id
      )
      SELECT 
        COALESCE(q.worker_id, p.worker_id) as workerId,
        COALESCE(q.peer_id, p.peer_id) as peerId,
        COALESCE(q.total_queries, 0) as totalQueries,
        COALESCE(q.successful_queries, 0) as successfulQueries,
        COALESCE(q.avg_response_time, 0) as avgResponseTime,
        COALESCE(q.total_bytes, 0) as totalBytes,
        COALESCE(p.last_seen, '1970-01-01') as lastSeen,
        COALESCE(p.active_days, 0) as activeDays
      FROM worker_queries q
      FULL OUTER JOIN worker_pings p ON q.worker_id = p.worker_id AND q.peer_id = p.peer_id
      ORDER BY totalQueries DESC
    `;

    try {
      const results: WorkerStats[] = [];
      let processedRows = 0;

      for await (const row of this.client.query(query).stream()) {
        processedRows++;
        results.push({
          workerId: row.workerId,
          peerId: row.peerId,
          totalQueries: parseInt(row.totalQueries),
          successfulQueries: parseInt(row.successfulQueries),
          avgResponseTime: parseFloat(row.avgResponseTime),
          totalBytes: parseInt(row.totalBytes),
          lastSeen: new Date(row.lastSeen),
          uptime: parseInt(row.activeDays),
          trafficWeight: this.calculateTrafficWeight(row),
        });
      }

      ctx.logger.debug(
        `✅ Processed ${processedRows} worker stats via streaming`,
      );
      return results;
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to get worker stats');
      throw error;
    }
  }

  async getWorkerPings(
    ctx: Context,
    fromTimestamp: Date,
    toTimestamp: Date,
    workerId?: string,
  ): Promise<WorkerPing[]> {
    const { workerPings } = this.config.tables;

    let workerFilter = '';
    if (workerId) {
      workerFilter = `AND worker_id = '${workerId}'`;
    }

    const query = `
      SELECT 
        peer_id,
        worker_id,
        timestamp,
        block_number,
        query_id
      FROM ${workerPings}
      WHERE timestamp >= '${fromTimestamp.toISOString()}'
        AND timestamp <= '${toTimestamp.toISOString()}'
        ${workerFilter}
      ORDER BY timestamp DESC
      LIMIT 10000
    `;

    try {
      const results: WorkerPing[] = [];
      let processedRows = 0;

      for await (const row of this.client.query(query).stream()) {
        processedRows++;
        results.push(row as WorkerPing);
      }

      ctx.logger.debug(
        `✅ Processed ${processedRows} worker pings via streaming`,
      );
      return results;
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to get worker pings');
      throw error;
    }
  }

  async getWorkerLiveness(
    ctx: Context,
    fromTimestamp: Date,
    toTimestamp: Date,
    workerId: string,
  ): Promise<number> {
    const { workerPings } = this.config.tables;

    const query = `
      SELECT 
        COUNT(DISTINCT date(timestamp)) * 24 / 
        (toUnixTimestamp('${toTimestamp.toISOString()}') - toUnixTimestamp('${fromTimestamp.toISOString()}')) * 3600 as liveness_ratio
      FROM ${workerPings}
      WHERE worker_id = '${workerId}'
        AND timestamp >= '${fromTimestamp.toISOString()}'
        AND timestamp <= '${toTimestamp.toISOString()}'
    `;

    try {
      const rows = await this.client.query(query).toPromise();

      if (!Array.isArray(rows) || rows.length === 0) {
        return 0;
      }

      return rows[0]?.liveness_ratio || 0;
    } catch (error) {
      ctx.logger.error({ error }, 'Failed to get worker liveness');
      return 0;
    }
  }

  private calculateTrafficWeight(row: any): number {
    const queries = parseInt(row.totalQueries) || 0;
    const successRate = parseInt(row.successfulQueries) / Math.max(queries, 1);
    const responseTime = parseFloat(row.avgResponseTime) || 0;
    const bytes = parseInt(row.totalBytes) || 0;

    // Traffic weight calculation similar to old rewards-calculator
    const queryWeight = Math.log(queries + 1);
    const successWeight = successRate;
    const speedWeight = responseTime > 0 ? 1 / (responseTime / 1000 + 1) : 0;
    const volumeWeight = Math.log(bytes + 1);

    return queryWeight * successWeight * speedWeight * volumeWeight;
  }

  async getHealth(): Promise<{ status: string; clickhouse: boolean }> {
    const clickhouseHealthy = await this.ping();
    return {
      status: clickhouseHealthy ? 'healthy' : 'unhealthy',
      clickhouse: clickhouseHealthy,
    };
  }

  async getWorkerStatsForEpoch(
    ctx: Context,
    startTime: Date,
    endTime: Date,
  ): Promise<WorkerStats[]> {
    return this.getWorkerStats(ctx, startTime, endTime);
  }

  async getActiveWorkers(
    ctx: Context,
    startTime: Date,
    endTime: Date,
    skipSignatureValidation = false,
  ): Promise<WorkerQueryData[]> {
    if (skipSignatureValidation) {
      const columns = [
        'worker_id',
        'sum(num_read_chunks) as num_read_chunks',
        'sum(output_size) as output_size',
        'count(*) as totalRequests',
      ];

      const query = `
        SELECT ${columns.join(',')}
        FROM ${this.logsTableName}
        WHERE
          ${this.logsTableName}.worker_timestamp >= '${this.formatDate(startTime)}' AND  
          ${this.logsTableName}.worker_timestamp <= '${this.formatDate(endTime)}' AND
          (toUnixTimestamp64Micro(collector_timestamp) - toUnixTimestamp64Micro(worker_timestamp)) / 60000000 < 20
        GROUP BY worker_id
      `;

      try {
        ctx.logger.debug(`🔍 Executing ClickHouse Query:`);
        ctx.logger.debug(`   FROM: ${this.formatDate(startTime)}`);
        ctx.logger.debug(`   TO: ${this.formatDate(endTime)}`);
        ctx.logger.debug(`${query}`);

        const results: WorkerQueryData[] = [];
        let processedRows = 0;

        for await (const row of this.client.query(query).stream()) {
          processedRows++;
          results.push(row as WorkerQueryData);
        }

        ctx.logger.debug(`✅ Processed ${processedRows} workers via streaming`);
        return results;
      } catch (error) {
        ctx.logger.error({ error }, `Failed to fetch active workers`);
        throw error;
      }
    }

    throw new Error(
      'Signature validation is intentionally disabled in this backend. Use skipSignatureValidation=true or set SKIP_SIGNATURE_VALIDATION=true.',
    );
  }

  async getPings(
    ctx: Context,
    from: Date,
    to: Date,
  ): Promise<Record<string, number[]>> {
    const query = `select
       worker_id,
       arrayConcat(
         [toUnixTimestamp('${this.formatDate(from)}')],
         arraySort(groupArray(toUnixTimestamp(timestamp))),
         [toUnixTimestamp('${this.formatDate(to)}')]
       ) as timestamps 
       from ${this.pingsTableName} 
       where timestamp >= '${this.formatDate(from)}' and timestamp <= '${this.formatDate(to)}' 
       group by worker_id
    `;

    try {
      ctx.logger.debug(`🔍 Executing ClickHouse Pings Query: ${query}`);

      const pings: Record<string, number[]> = {};
      let processedRows = 0;

      for await (const row of this.client.query(query).stream()) {
        processedRows++;
        pings[row.worker_id] = row.timestamps;
      }

      ctx.logger.debug(
        `✅ Retrieved pings for ${processedRows} workers via streaming`,
      );
      return pings;
    } catch (error) {
      ctx.logger.error({ error }, `Failed to fetch pings`);
      throw error;
    }
  }

  async getTotalDelegation(ctx: Context): Promise<{
    totalDelegation: number;
    workerCount: number;
  }> {
    const query = `
      SELECT 
        SUM(stake) / 1e18 as totalDelegation,
        COUNT(*) as workerCount
      FROM mainnet.worker_stats 
      WHERE time >= NOW() - INTERVAL 1 HOUR
    `;

    try {
      const result = await this.client.query(query).toPromise();
      return Array.isArray(result) ? result[0] : result;
    } catch (error) {
      ctx.logger.error({ error }, `Failed to fetch total delegation`);
      throw error;
    }
  }

  async logTotalQueries(ctx: Context, from: Date, to: Date): Promise<number> {
    const query = `
      SELECT COUNT(*) as total 
      FROM ${this.logsTableName} 
      WHERE ${this.logsTableName}.worker_timestamp >= '${this.formatDate(from)}' AND 
            ${this.logsTableName}.worker_timestamp <= '${this.formatDate(to)}'
    `;

    try {
      ctx.logger.debug(`🔍 Executing ClickHouse Total Queries Count: ${query}`);

      const result = await this.client.query(query).toPromise();
      const resultArray = Array.isArray(result) ? result : [result];
      const total = resultArray[0]?.total || 0;
      ctx.logger.debug(`✅ Processing queries: ${total}`);
      return total;
    } catch (error) {
      ctx.logger.error({ error }, `Failed to count queries`);
      throw error;
    }
  }

  async calculateLivenessFactor(
    ctx: Context,
    from: Date,
    to: Date,
  ): Promise<Record<string, NetworkStatsEntry>> {
    const pings = await this.getPings(ctx, from, to);
    const totalPeriodSeconds = dayjs(to).diff(dayjs(from), 'second');
    const workerOfflineThreshold =
      this.configService.get('rewards.workerOfflineThreshold') || 65;

    const res: Record<string, NetworkStatsEntry> = {};

    for (const workerId in pings) {
      const pingTimestamps = pings[workerId];
      const diffs = this.calculateSecondDiffs(pingTimestamps);
      const totalTimeOffline = this.calculateTotalOfflineSeconds(
        diffs,
        workerOfflineThreshold,
      );

      res[workerId] = {
        totalPings: diffs.length - 1,
        totalTimeOffline,
        livenessFactor: 1 - totalTimeOffline / totalPeriodSeconds,
      };
    }

    return res;
  }

  private calculateSecondDiffs(dates: number[]): number[] {
    return dates
      .map((date, i) => {
        if (i === 0) return 0;
        return date - dates[i - 1];
      })
      .slice(1);
  }

  private calculateTotalOfflineSeconds(
    diffs: number[],
    threshold: number,
  ): number {
    return diffs
      .filter((diff) => diff > threshold)
      .reduce((sum, diff) => sum + diff, 0);
  }
}
