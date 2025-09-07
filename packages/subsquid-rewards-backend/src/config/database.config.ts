import { registerAs } from '@nestjs/config';

export default registerAs('database', () => {
  const database = process.env.CLICKHOUSE_DATABASE || 'testnet';
  return {
    clickhouse: {
      url: process.env.CLICKHOUSE_URL,
      username: process.env.CLICKHOUSE_USERNAME,
      password: process.env.CLICKHOUSE_PASSWORD,
      database,
      tables: {
        workerQueryLogs:
          process.env.CLICKHOUSE_LOGS_TABLE || `${database}.worker_query_logs`,
        workerPings:
          process.env.CLICKHOUSE_PINGS_TABLE || `${database}.worker_pings_v2`,
      },
      options: {
        clickhouse_settings: {
          connect_timeout: 180000,
          send_timeout: 180000,
          receive_timeout: 180000,
        },
      },
    },
    redis: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD,
    },
  };
});
