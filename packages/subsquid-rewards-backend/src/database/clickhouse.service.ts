import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClickHouseClient, createClient } from '@clickhouse/client';
import * as dayjs from 'dayjs';
import * as utc from 'dayjs/plugin/utc';

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
  private readonly logger = new Logger(ClickHouseService.name);
  private client: ClickHouseClient;
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
      this.client = createClient({
        host: this.config.host,
        username: this.config.username,
        password: this.config.password,
        database: this.config.database,
        ...this.config.options,
      });

      await this.ping();
      this.logger.log('ClickHouse connection established');
    } catch (error) {
      this.logger.error('Failed to initialize ClickHouse connection', error);
      throw error;
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.query({ query: 'SELECT 1' });
      return true;
    } catch (error) {
      this.logger.error('ClickHouse ping failed', error);
      return false;
    }
  }

  private formatDate(date: Date): string {
    return dayjs(date).utc().format('YYYY-MM-DD HH:mm:ss');
  }

  async getWorkerStats(
    fromTimestamp: Date,
    toTimestamp: Date,
    workerIds?: string[],
  ): Promise<WorkerStats[]> {
    const { workerQueryLogs, workerPings } = this.config.tables;
    
    let workerFilter = '';
    if (workerIds && workerIds.length > 0) {
      const workerList = workerIds.map(id => `'${id}'`).join(',');
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
      const result = await this.client.query({ query, format: 'JSONEachRow' });
      const rows = await result.json();
      
      if (!Array.isArray(rows)) {
        throw new Error('Unexpected response format from ClickHouse');
      }

      return rows.map((row: any) => ({
        workerId: row.workerId,
        peerId: row.peerId,
        totalQueries: parseInt(row.totalQueries),
        successfulQueries: parseInt(row.successfulQueries),
        avgResponseTime: parseFloat(row.avgResponseTime),
        totalBytes: parseInt(row.totalBytes),
        lastSeen: new Date(row.lastSeen),
        uptime: parseInt(row.activeDays),
        trafficWeight: this.calculateTrafficWeight(row),
      }));
    } catch (error) {
      this.logger.error('Failed to get worker stats', error);
      throw error;
    }
  }

  async getWorkerPings(
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
      const result = await this.client.query({ query, format: 'JSONEachRow' });
      const rows = await result.json();
      
      if (!Array.isArray(rows)) {
        throw new Error('Unexpected response format from ClickHouse');
      }

      return rows as WorkerPing[];
    } catch (error) {
      this.logger.error('Failed to get worker pings', error);
      throw error;
    }
  }

  async getWorkerLiveness(
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
      const result = await this.client.query({ query, format: 'JSONEachRow' });
      const rows = await result.json();
      
      if (!Array.isArray(rows) || rows.length === 0) {
        return 0;
      }

      return (rows[0] as any)?.liveness_ratio || 0;
    } catch (error) {
      this.logger.error('Failed to get worker liveness', error);
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

  async getWorkerStatsForEpoch(startTime: Date, endTime: Date): Promise<WorkerStats[]> {
    return this.getWorkerStats(startTime, endTime);
  }

  async getActiveWorkers(fromBlock: number, toBlock: number, skipSignatureValidation = false): Promise<WorkerQueryData[]> {
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
          from_block >= ${fromBlock} AND
          to_block <= ${toBlock}
        GROUP BY worker_id
      `;

      try {
        this.logger.log(`🔍 Executing ClickHouse Query:`);
        this.logger.log(`${query}`);
        
        const resultSet = await this.client.query({
          query,
          format: 'JSONEachRow',
        });

        const results = await resultSet.json<WorkerQueryData>();
        this.logger.log(`✅ Processed ${Array.isArray(results) ? results.length : 1} workers with signature validation skipped`);
        return Array.isArray(results) ? results : [results];
      } catch (error) {
        this.logger.error(`Failed to fetch active workers: ${error.message}`);
        throw error;
      }
    }

    // Full validation logic would go here
    throw new Error('Full signature validation not yet implemented');
  }

  async getPings(from: Date, to: Date): Promise<Record<string, number[]>> {
    const query = `
      SELECT
        worker_id,
        arrayConcat(
          [toUnixTimestamp('${this.formatDate(from)}')],
          arraySort(groupArray(toUnixTimestamp(timestamp))),
          [toUnixTimestamp('${this.formatDate(to)}')]
        ) as timestamps 
      FROM ${this.pingsTableName} 
      WHERE timestamp >= '${this.formatDate(from)}' AND timestamp <= '${this.formatDate(to)}' 
      GROUP BY worker_id
    `;

    try {
      this.logger.log(`🔍 Executing ClickHouse Pings Query:`);
      this.logger.log(`${query}`);
      
      const resultSet = await this.client.query({
        query,
        format: 'JSONEachRow',
      });

      const results = await resultSet.json<{ worker_id: string; timestamps: number[] }>();
      
      const pings: Record<string, number[]> = {};
      const resultArray = Array.isArray(results) ? results : [results];
      
      for (const row of resultArray) {
        pings[row.worker_id] = row.timestamps;
      }

      this.logger.log(`✅ Retrieved pings for ${Object.keys(pings).length} workers`);
      return pings;
    } catch (error) {
      this.logger.error(`Failed to fetch pings: ${error.message}`);
      throw error;
    }
  }

  async getTotalDelegation(): Promise<{ totalDelegation: number; workerCount: number }> {
    const query = `
      SELECT 
        SUM(stake) / 1e18 as totalDelegation,
        COUNT(*) as workerCount
      FROM mainnet.worker_stats 
      WHERE time >= NOW() - INTERVAL 1 HOUR
    `;

    try {
      const resultSet = await this.client.query({ query, format: 'JSON' });
      const result = await resultSet.json<any>();
      return result.data[0];
    } catch (error) {
      this.logger.error(`Failed to fetch total delegation: ${error.message}`);
      throw error;
    }
  }

  async logTotalQueries(from: Date, to: Date): Promise<number> {
    const query = `
      SELECT COUNT(*) as total 
      FROM ${this.logsTableName} 
      WHERE ${this.logsTableName}.worker_timestamp >= '${this.formatDate(from)}' AND 
            ${this.logsTableName}.worker_timestamp <= '${this.formatDate(to)}'
    `;

    try {
      this.logger.log(`🔍 Executing ClickHouse Total Queries Count:`);
      this.logger.log(`${query}`);
      
      const resultSet = await this.client.query({
        query,
        format: 'JSONEachRow',
      });

      const result = await resultSet.json<{ total: number }>();
      const resultArray = Array.isArray(result) ? result : [result];
      const total = resultArray[0]?.total || 0;
      this.logger.log(`✅ Processing queries: ${total}`);
      return total;
    } catch (error) {
      this.logger.error(`Failed to count queries: ${error.message}`);
      throw error;
    }
  }

  async calculateLivenessFactor(from: Date, to: Date): Promise<Record<string, NetworkStatsEntry>> {
    const pings = await this.getPings(from, to);
    const totalPeriodSeconds = dayjs(to).diff(dayjs(from), 'second');
    const workerOfflineThreshold = this.configService.get('rewards.workerOfflineThreshold') || 65;
    
    const res: Record<string, NetworkStatsEntry> = {};
    
    for (const workerId in pings) {
      const pingTimestamps = pings[workerId];
      const diffs = this.calculateSecondDiffs(pingTimestamps);
      const totalTimeOffline = this.calculateTotalOfflineSeconds(diffs, workerOfflineThreshold);

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

  private calculateTotalOfflineSeconds(diffs: number[], threshold: number): number {
    return diffs
      .filter((diff) => diff > threshold)
      .reduce((sum, diff) => sum + diff, 0);
  }
} 