import { ClickHouseService } from './clickhouse.service';
import { ClickHouse } from 'clickhouse';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Load .env from the package root
dotenv.config({
  path: path.resolve(__dirname, '../../.env'),
});

const clickhouseConfig = {
  url: process.env.CLICKHOUSE_URL,
  username: process.env.CLICKHOUSE_USERNAME,
  password: process.env.CLICKHOUSE_PASSWORD,
  database: process.env.CLICKHOUSE_DATABASE || 'testnet',
  tables: {
    workerQueryLogs:
      process.env.CLICKHOUSE_LOGS_TABLE ||
      `${process.env.CLICKHOUSE_DATABASE || 'testnet'}.worker_query_logs`,
    workerPings:
      process.env.CLICKHOUSE_PINGS_TABLE ||
      `${process.env.CLICKHOUSE_DATABASE || 'testnet'}.worker_pings_v2`,
  },
};

const hasClickHouseConfig = Boolean(
  clickhouseConfig.url &&
    clickhouseConfig.username &&
    clickhouseConfig.password,
);

function createMockCtx() {
  return {
    logger: {
      debug: jest.fn(),
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
    },
  } as any;
}

/**
 * Create ClickHouseService without NestJS module (avoids onModuleInit hanging).
 * Sets the client directly.
 */
function createService(): ClickHouseService {
  const mockConfigService = {
    get: (key: string, defaultValue?: any) => {
      const config: Record<string, any> = {
        'database.clickhouse': clickhouseConfig,
        'rewards.workerOfflineThreshold': 65,
      };
      return config[key] ?? defaultValue;
    },
  } as any;

  const service = new ClickHouseService(mockConfigService);

  // Set client directly, bypassing onModuleInit (which calls ping() and can hang)
  const client = new ClickHouse({
    url: clickhouseConfig.url,
    basicAuth: {
      username: clickhouseConfig.username,
      password: clickhouseConfig.password,
    },
    format: 'json',
  });
  (service as any).client = client;

  return service;
}

const describeClickHouseIntegration = hasClickHouseConfig ? describe : describe.skip;

describeClickHouseIntegration('ClickHouseService', () => {
  let service: ClickHouseService;

  beforeAll(() => {
    service = createService();
  });

  it('should connect to ClickHouse and query worker_pings_v2', async () => {
    expect(service).toBeDefined();

    const ctx = createMockCtx();
    const now = new Date();
    const oneDayAgo = new Date(now);
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);

    const pings = await service.getPings(ctx, oneDayAgo, now);
    expect(typeof pings).toBe('object');
  }, 30000);

  it('should query worker_query_logs within a time range', async () => {
    const now = new Date();
    const lastMonth = new Date(now);
    lastMonth.setMonth(lastMonth.getMonth() - 1);

    const from = new Date(lastMonth);
    from.setDate(from.getDate() - 2);
    const to = new Date(lastMonth);

    const ctx = createMockCtx();
    const totalQueries = await service.logTotalQueries(ctx, from, to);
    expect(typeof totalQueries).toBe('number');
    expect(totalQueries).toBeGreaterThanOrEqual(0);
  }, 30000);

  it('should handle ClickHouse timeout gracefully', async () => {
    const badClient = new ClickHouse({
      url: 'http://localhost:19999',
      basicAuth: { username: 'test', password: 'test' },
      format: 'json',
    });

    const startTime = Date.now();
    let caughtError: any = null;

    try {
      await new Promise<void>((resolve, reject) => {
        badClient.query('SELECT 1').exec((err: any) => {
          if (err) return reject(err);
          resolve();
        });
      });
    } catch (error) {
      caughtError = error;
    }

    const elapsed = Date.now() - startTime;
    expect(caughtError).toBeTruthy();
    expect(elapsed).toBeLessThan(5000);
  }, 10000);

  it('should return liveness data for known workers', async () => {
    const ctx = createMockCtx();

    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const pings = await service.getPings(ctx, thirtyDaysAgo, now);
    expect(typeof pings).toBe('object');

    const workerIds = Object.keys(pings);
    if (workerIds.length > 0) {
      const sampleWorkerId = workerIds[0];
      const liveness = await service.getWorkerLiveness(
        ctx,
        thirtyDaysAgo,
        now,
        sampleWorkerId,
      );
      expect(typeof liveness).toBe('number');
      expect(liveness).toBeGreaterThanOrEqual(0);
    }
  }, 30000);
});
