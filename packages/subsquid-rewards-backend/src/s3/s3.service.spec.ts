import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3ServiceException,
  NoSuchBucket,
  NoSuchKey,
} from '@aws-sdk/client-s3';
import {
  S3Service,
  S3UploadError,
  S3ConfigurationError,
  EpochRewardsData,
} from './s3.service';

// ── Mock AWS SDK ────────────────────────────────────────────────────────
const mockSend = jest.fn();

jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: jest.fn().mockImplementation(() => ({
      send: mockSend,
    })),
  };
});

// ── Helpers ─────────────────────────────────────────────────────────────
const defaultS3Config = {
  enabled: true,
  endpoint: 'https://abc123.r2.cloudflarestorage.com',
  accessKeyId: 'test-key',
  accessKeySecret: 'test-secret',
  bucket: 'test-bucket',
  region: 'auto',
  pathPrefix: 'testnet',
  retryAttempts: 3,
  retryDelay: 100,
  maxRetryDelay: 1000,
  requestTimeout: 5000,
  forcePathStyle: false,
  debugMode: false,
};

function makeMockConfigService(overrides: Record<string, any> = {}) {
  const config = { ...defaultS3Config, ...overrides };
  return {
    get: jest.fn((key: string) => {
      if (key === 's3') return config;
      return undefined;
    }),
  };
}

function createService(configOverrides: Record<string, any> = {}): S3Service {
  return new S3Service(makeMockConfigService(configOverrides) as any);
}

function createEnabledService(
  configOverrides: Record<string, any> = {},
): S3Service {
  const service = createService(configOverrides);
  // Manually inject a mock client so methods that guard on s3Client work
  (service as any).s3Client = { send: mockSend };
  return service;
}

const sampleEpochData: EpochRewardsData = {
  epochInfo: {
    fromBlock: 100,
    toBlock: 200,
    startTime: '2024-01-01',
    endTime: '2024-01-02',
    epochDuration: 86400,
    timestamp: '2024-01-02',
    network: 'testnet',
  },
  merkleTree: {
    root: '0xabc',
    totalBatches: 2,
    batchSize: 10,
    leaves: [],
  },
  rawData: {
    totalWorkers: 5,
    workers: [],
  },
  networkMetrics: {
    totalRequests: 100,
    totalBytesServed: 1000,
    totalChunksRead: 50,
  },
  rewardSummary: {
    totalWorkerRewards: '1000',
    totalStakerRewards: '500',
    totalRewards: '1500',
    currency: 'SQD',
  },
  distribution: {
    uploadedAt: '2024-01-02',
  },
  verification: {
    dataHash: '0xhash',
    version: '2.0',
  },
};

// ── Tests ───────────────────────────────────────────────────────────────
describe('S3Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date.prototype, 'toISOString').mockReturnValue('2024-01-02T00:00:00.000Z');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Construction & Configuration
  // ──────────────────────────────────────────────────────────────────────
  describe('constructor', () => {
    it('should set enabled=true when config.enabled is true', () => {
      const service = createService();
      expect((service as any).enabled).toBe(true);
    });

    it('should set enabled=false when config.enabled is false', () => {
      const service = createService({ enabled: false });
      expect((service as any).enabled).toBe(false);
    });

    it('should log debug info when debugMode is true', () => {
      const service = createService({ debugMode: true });
      expect((service as any).config.debugMode).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // onModuleInit
  // ──────────────────────────────────────────────────────────────────────
  describe('onModuleInit', () => {
    it('should call initialize when enabled', async () => {
      const service = createService();
      // Stub initialize to avoid real S3 calls
      const initSpy = jest
        .spyOn(service as any, 'initialize')
        .mockResolvedValue(undefined);

      await service.onModuleInit();
      expect(initSpy).toHaveBeenCalled();
    });

    it('should NOT call initialize when disabled', async () => {
      const service = createService({ enabled: false });
      const initSpy = jest
        .spyOn(service as any, 'initialize')
        .mockResolvedValue(undefined);

      await service.onModuleInit();
      expect(initSpy).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // validateConfiguration
  // ──────────────────────────────────────────────────────────────────────
  describe('validateConfiguration', () => {
    it('should pass with valid config', () => {
      const service = createService();
      expect(() => (service as any).validateConfiguration()).not.toThrow();
    });

    it('should throw S3ConfigurationError when endpoint is missing', () => {
      const service = createService({ endpoint: '' });
      expect(() => (service as any).validateConfiguration()).toThrow(
        S3ConfigurationError,
      );
      expect(() => (service as any).validateConfiguration()).toThrow(
        'S3_ENDPOINT',
      );
    });

    it('should throw S3ConfigurationError when accessKeyId is missing', () => {
      const service = createService({ accessKeyId: '' });
      expect(() => (service as any).validateConfiguration()).toThrow(
        'S3_ACCESS_KEY_ID',
      );
    });

    it('should throw S3ConfigurationError when accessKeySecret is missing', () => {
      const service = createService({ accessKeySecret: '' });
      expect(() => (service as any).validateConfiguration()).toThrow(
        'S3_ACCESS_KEY_SECRET',
      );
    });

    it('should throw S3ConfigurationError when bucket is missing', () => {
      const service = createService({ bucket: '' });
      expect(() => (service as any).validateConfiguration()).toThrow(
        'S3_BUCKET',
      );
    });

    it('should list all missing fields in one error', () => {
      const service = createService({
        endpoint: '',
        accessKeyId: '',
        accessKeySecret: '',
        bucket: '',
      });
      expect(() => (service as any).validateConfiguration()).toThrow(
        /S3_ENDPOINT.*S3_ACCESS_KEY_ID.*S3_ACCESS_KEY_SECRET.*S3_BUCKET/,
      );
    });

    it('should throw when endpoint does not start with http(s)', () => {
      const service = createService({ endpoint: 'ftp://bad.endpoint.com' });
      expect(() => (service as any).validateConfiguration()).toThrow(
        'S3_ENDPOINT must start with http:// or https://',
      );
    });

    it('should accept http:// endpoint', () => {
      const service = createService({ endpoint: 'http://localhost:9000' });
      expect(() => (service as any).validateConfiguration()).not.toThrow();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // initializeS3Client
  // ──────────────────────────────────────────────────────────────────────
  describe('initializeS3Client', () => {
    it('should create an S3Client with correct config', () => {
      const service = createService();
      (service as any).initializeS3Client();
      expect(S3Client).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: defaultS3Config.endpoint,
          region: 'auto',
          forcePathStyle: true, // R2 detected
        }),
      );
    });

    it('should enable forcePathStyle for Cloudflare R2 endpoints', () => {
      const service = createService();
      (service as any).initializeS3Client();
      const call = (S3Client as jest.Mock).mock.calls[0][0];
      expect(call.forcePathStyle).toBe(true);
      expect(call.signatureVersion).toBe('v4');
    });

    it('should use forcePathStyle from config for non-R2 endpoints', () => {
      const service = createService({
        endpoint: 'https://s3.amazonaws.com',
        forcePathStyle: true,
      });
      (service as any).initializeS3Client();
      const call = (S3Client as jest.Mock).mock.calls[0][0];
      expect(call.forcePathStyle).toBe(true);
    });

    it('should NOT set forcePathStyle for non-R2 when config is false', () => {
      const service = createService({
        endpoint: 'https://s3.amazonaws.com',
        forcePathStyle: false,
      });
      (service as any).initializeS3Client();
      const call = (S3Client as jest.Mock).mock.calls[0][0];
      expect(call.forcePathStyle).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // isEnabled
  // ──────────────────────────────────────────────────────────────────────
  describe('isEnabled', () => {
    it('should return true when enabled and client is set', () => {
      const service = createEnabledService();
      expect(service.isEnabled()).toBe(true);
    });

    it('should return false when disabled', () => {
      const service = createService({ enabled: false });
      expect(service.isEnabled()).toBe(false);
    });

    it('should return false when enabled but client is null', () => {
      const service = createService(); // no injected client
      expect(service.isEnabled()).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // generateS3Key
  // ──────────────────────────────────────────────────────────────────────
  describe('generateS3Key', () => {
    it('should generate key with pathPrefix from config', () => {
      const service = createService({ pathPrefix: 'mainnet' });
      expect(service.generateS3Key('testnet', 100, 200)).toBe(
        'rewards/mainnet/distributions/100-200.json',
      );
    });

    it('should fall back to network when pathPrefix is empty', () => {
      const service = createService({ pathPrefix: '' });
      expect(service.generateS3Key('arbitrum', 0, 50)).toBe(
        'rewards/arbitrum/distributions/0-50.json',
      );
    });

    it('should fall back to "unknown" when both pathPrefix and network are empty', () => {
      const service = createService({ pathPrefix: '' });
      expect(service.generateS3Key('', 1, 2)).toBe(
        'rewards/unknown/distributions/1-2.json',
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // uploadEpochRewards
  // ──────────────────────────────────────────────────────────────────────
  describe('uploadEpochRewards', () => {
    it('should throw S3ConfigurationError when disabled', async () => {
      const service = createService({ enabled: false });
      await expect(service.uploadEpochRewards(sampleEpochData)).rejects.toThrow(
        S3ConfigurationError,
      );
      await expect(service.uploadEpochRewards(sampleEpochData)).rejects.toThrow(
        'S3 service is disabled',
      );
    });

    it('should throw S3ConfigurationError when client is null', async () => {
      const service = createService(); // enabled but no client
      await expect(service.uploadEpochRewards(sampleEpochData)).rejects.toThrow(
        'S3 client not initialized',
      );
    });

    it('should upload successfully when canonical file does NOT exist', async () => {
      const service = createEnabledService();
      // checkFileExists (HeadObject) -> 404
      mockSend
        .mockRejectedValueOnce(
          Object.assign(
            new (jest.requireActual('@aws-sdk/client-s3').NoSuchKey)({
              message: 'not found',
              $metadata: {},
            }),
          ),
        )
        // uploadWithRetry (PutObject) -> success
        .mockResolvedValueOnce({ ETag: '"etag123"', VersionId: 'v1' });

      const result = await service.uploadEpochRewards(sampleEpochData);

      expect(result.key).toBe(
        'rewards/testnet/distributions/100-200.json',
      );
      expect(result.bucket).toBe('test-bucket');
      expect(result.etag).toBe('"etag123"');
      expect(result.versionId).toBe('v1');
      expect(result.size).toBeGreaterThan(0);
      expect(result.url).toBeDefined();
    });

    it('should write to duplicate path when canonical file already exists', async () => {
      const service = createEnabledService();

      // checkFileExists -> file exists (HeadObject succeeds)
      mockSend
        .mockResolvedValueOnce({}) // HeadObject -> exists
        // listFiles for getNextDuplicateIteration
        .mockResolvedValueOnce({ Contents: [] })
        // PutObject
        .mockResolvedValueOnce({ ETag: '"dup-etag"' });

      const result = await service.uploadEpochRewards(sampleEpochData);

      expect(result.key).toContain('duplicates/100-200-');
      expect(result.key).toContain('.json');
    });

    it('should throw S3UploadError when upload fails', async () => {
      const service = createEnabledService();

      // checkFileExists -> not found
      mockSend
        .mockRejectedValueOnce(
          Object.assign(
            new (jest.requireActual('@aws-sdk/client-s3').NoSuchKey)({
              message: 'not found',
              $metadata: {},
            }),
          ),
        )
        // PutObject fails (non-retryable)
        .mockRejectedValueOnce(new Error('Access Denied'));

      await expect(
        service.uploadEpochRewards(sampleEpochData),
      ).rejects.toThrow(S3UploadError);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // downloadJson
  // ──────────────────────────────────────────────────────────────────────
  describe('downloadJson', () => {
    it('should throw when disabled', async () => {
      const service = createService({ enabled: false });
      await expect(service.downloadJson('some-key')).rejects.toThrow(
        'S3 service is disabled',
      );
    });

    it('should throw when client is null', async () => {
      const service = createService();
      await expect(service.downloadJson('some-key')).rejects.toThrow(
        'S3 client not initialized',
      );
    });

    it('should download and parse JSON successfully', async () => {
      const service = createEnabledService();
      const payload = { hello: 'world' };
      const body = Buffer.from(JSON.stringify(payload));

      mockSend.mockResolvedValueOnce({
        Body: (async function* () {
          yield body;
        })(),
      });

      const result = await service.downloadJson('test-key.json');
      expect(result).toEqual(payload);
    });

    it('should return null when key does not exist (NoSuchKey)', async () => {
      const service = createEnabledService();
      const noSuchKeyError = new (jest.requireActual('@aws-sdk/client-s3').NoSuchKey)({
        message: 'no such key',
        $metadata: {},
      });
      mockSend.mockRejectedValueOnce(noSuchKeyError);

      const result = await service.downloadJson('missing-key');
      expect(result).toBeNull();
    });

    it('should throw on other S3 errors', async () => {
      const service = createEnabledService();
      mockSend.mockRejectedValueOnce(new Error('Internal Server Error'));

      await expect(service.downloadJson('bad-key')).rejects.toThrow(
        /Failed to download from S3/,
      );
    });

    it('should throw when response body is empty', async () => {
      const service = createEnabledService();
      mockSend.mockResolvedValueOnce({ Body: null });

      await expect(service.downloadJson('empty-body')).rejects.toThrow(
        /No data in S3 response/,
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // checkFileExists
  // ──────────────────────────────────────────────────────────────────────
  describe('checkFileExists', () => {
    it('should return true when file exists', async () => {
      const service = createEnabledService();
      mockSend.mockResolvedValueOnce({});
      expect(await service.checkFileExists('exists.json')).toBe(true);
    });

    it('should return false when disabled', async () => {
      const service = createService({ enabled: false });
      expect(await service.checkFileExists('any')).toBe(false);
    });

    it('should return false when client is null', async () => {
      const service = createService();
      expect(await service.checkFileExists('any')).toBe(false);
    });

    it('should return false on NoSuchKey', async () => {
      const service = createEnabledService();
      const err = new (jest.requireActual('@aws-sdk/client-s3').NoSuchKey)({
        message: 'not found',
        $metadata: {},
      });
      mockSend.mockRejectedValueOnce(err);
      expect(await service.checkFileExists('missing.json')).toBe(false);
    });

    it('should return false on S3ServiceException with 404 status', async () => {
      const service = createEnabledService();
      const err = new (jest.requireActual('@aws-sdk/client-s3').S3ServiceException)({
        message: 'Not Found',
        name: 'NotFound',
        $fault: 'client' as const,
        $metadata: { httpStatusCode: 404 },
      });
      mockSend.mockRejectedValueOnce(err);
      expect(await service.checkFileExists('missing.json')).toBe(false);
    });

    it('should return false on S3ServiceException with status 400 and UnknownError', async () => {
      const service = createEnabledService();
      const err = new (jest.requireActual('@aws-sdk/client-s3').S3ServiceException)({
        message: 'Unknown',
        name: 'UnknownError',
        $fault: 'client' as const,
        $metadata: { httpStatusCode: 400 },
      });
      mockSend.mockRejectedValueOnce(err);
      expect(await service.checkFileExists('key')).toBe(false);
    });

    it('should return false on unexpected errors (catch-all)', async () => {
      const service = createEnabledService();
      mockSend.mockRejectedValueOnce(new Error('random error'));
      expect(await service.checkFileExists('key')).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Retry logic (uploadWithRetry, isRetryableError, calculateRetryDelay)
  // ──────────────────────────────────────────────────────────────────────
  describe('retry logic', () => {
    describe('isRetryableError', () => {
      let service: S3Service;
      beforeEach(() => {
        service = createService();
      });

      it('should return true for ECONNREFUSED', () => {
        const err: any = new Error('connect');
        err.code = 'ECONNREFUSED';
        expect((service as any).isRetryableError(err)).toBe(true);
      });

      it('should return true for ETIMEDOUT', () => {
        const err: any = new Error('timeout');
        err.code = 'ETIMEDOUT';
        expect((service as any).isRetryableError(err)).toBe(true);
      });

      it('should return true for S3 ServiceUnavailable', () => {
        const err = new (jest.requireActual('@aws-sdk/client-s3').S3ServiceException)({
          message: 'unavailable',
          name: 'ServiceUnavailable',
          $fault: 'server' as const,
          $metadata: {},
        });
        expect((service as any).isRetryableError(err)).toBe(true);
      });

      it('should return true for S3 ThrottlingException', () => {
        const err = new (jest.requireActual('@aws-sdk/client-s3').S3ServiceException)({
          message: 'throttle',
          name: 'ThrottlingException',
          $fault: 'client' as const,
          $metadata: {},
        });
        expect((service as any).isRetryableError(err)).toBe(true);
      });

      it('should return true for httpStatusCode 503', () => {
        const err: any = new Error('503');
        err.$metadata = { httpStatusCode: 503 };
        expect((service as any).isRetryableError(err)).toBe(true);
      });

      it('should return true for httpStatusCode 429', () => {
        const err: any = new Error('429');
        err.$metadata = { httpStatusCode: 429 };
        expect((service as any).isRetryableError(err)).toBe(true);
      });

      it('should return true for httpStatusCode >= 500', () => {
        const err: any = new Error('500');
        err.$metadata = { httpStatusCode: 500 };
        expect((service as any).isRetryableError(err)).toBe(true);
      });

      it('should return false for non-retryable errors', () => {
        expect((service as any).isRetryableError(new Error('nope'))).toBe(
          false,
        );
      });
    });

    describe('calculateRetryDelay', () => {
      it('should return base delay for attempt 1', () => {
        const service = createService({ retryDelay: 100, maxRetryDelay: 10000 });
        // With jitter the result is baseDelay + random*0.2*baseDelay
        jest.spyOn(Math, 'random').mockReturnValue(0);
        expect((service as any).calculateRetryDelay(1)).toBe(100);
      });

      it('should apply exponential backoff for subsequent attempts', () => {
        const service = createService({ retryDelay: 100, maxRetryDelay: 10000 });
        jest.spyOn(Math, 'random').mockReturnValue(0);
        // attempt 2: 100 * 2^1 = 200
        expect((service as any).calculateRetryDelay(2)).toBe(200);
        // attempt 3: 100 * 2^2 = 400
        expect((service as any).calculateRetryDelay(3)).toBe(400);
      });

      it('should cap delay at maxRetryDelay', () => {
        const service = createService({
          retryDelay: 100,
          maxRetryDelay: 300,
        });
        jest.spyOn(Math, 'random').mockReturnValue(0);
        // attempt 3: min(400, 300) = 300
        expect((service as any).calculateRetryDelay(3)).toBe(300);
      });

      it('should add jitter', () => {
        const service = createService({ retryDelay: 100, maxRetryDelay: 10000 });
        jest.spyOn(Math, 'random').mockReturnValue(1); // max jitter
        // attempt 1: 100 + 100*1*0.2 = 120
        expect((service as any).calculateRetryDelay(1)).toBe(120);
      });
    });

    describe('uploadWithRetry', () => {
      it('should succeed on first attempt', async () => {
        const service = createEnabledService({ retryAttempts: 3 });
        mockSend.mockResolvedValueOnce({ ETag: '"ok"' });

        const cmd = new PutObjectCommand({
          Bucket: 'b',
          Key: 'k',
          Body: Buffer.from('{}'),
        });

        const result = await (service as any).uploadWithRetry(cmd, {
          key: 'k',
        });
        expect(result.ETag).toBe('"ok"');
        expect(mockSend).toHaveBeenCalledTimes(1);
      });

      it('should retry on retryable errors and eventually succeed', async () => {
        const service = createEnabledService({
          retryAttempts: 3,
          retryDelay: 1,
          maxRetryDelay: 10,
        });
        jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

        const connErr: any = new Error('conn refused');
        connErr.code = 'ECONNREFUSED';

        mockSend
          .mockRejectedValueOnce(connErr)
          .mockRejectedValueOnce(connErr)
          .mockResolvedValueOnce({ ETag: '"ok"' });

        const cmd = new PutObjectCommand({
          Bucket: 'b',
          Key: 'k',
          Body: Buffer.from('{}'),
        });

        const result = await (service as any).uploadWithRetry(cmd, {
          key: 'k',
        });
        expect(result.ETag).toBe('"ok"');
        expect(mockSend).toHaveBeenCalledTimes(3);
      });

      it('should throw after exhausting all retry attempts', async () => {
        const service = createEnabledService({
          retryAttempts: 2,
          retryDelay: 1,
          maxRetryDelay: 10,
        });
        jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

        const connErr: any = new Error('conn refused');
        connErr.code = 'ECONNREFUSED';

        mockSend.mockRejectedValue(connErr);

        const cmd = new PutObjectCommand({
          Bucket: 'b',
          Key: 'k',
          Body: Buffer.from('{}'),
        });

        await expect(
          (service as any).uploadWithRetry(cmd, { key: 'k' }),
        ).rejects.toThrow('conn refused');
        expect(mockSend).toHaveBeenCalledTimes(2);
      });

      it('should NOT retry non-retryable errors', async () => {
        const service = createEnabledService({ retryAttempts: 3 });
        mockSend.mockRejectedValueOnce(new Error('Access Denied'));

        const cmd = new PutObjectCommand({
          Bucket: 'b',
          Key: 'k',
          Body: Buffer.from('{}'),
        });

        await expect(
          (service as any).uploadWithRetry(cmd, { key: 'k' }),
        ).rejects.toThrow('Access Denied');
        expect(mockSend).toHaveBeenCalledTimes(1);
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Private helpers tested indirectly
  // ──────────────────────────────────────────────────────────────────────
  describe('listFiles (private)', () => {
    it('should return keys from S3', async () => {
      const service = createEnabledService();
      mockSend.mockResolvedValueOnce({
        Contents: [{ Key: 'a.json' }, { Key: 'b.json' }],
      });

      const result = await (service as any).listFiles('prefix/');
      expect(result).toEqual(['a.json', 'b.json']);
    });

    it('should return empty array when Contents is empty', async () => {
      const service = createEnabledService();
      mockSend.mockResolvedValueOnce({ Contents: undefined });

      const result = await (service as any).listFiles('prefix/');
      expect(result).toEqual([]);
    });

    it('should return empty array when disabled', async () => {
      const service = createService({ enabled: false });
      const result = await (service as any).listFiles('prefix/');
      expect(result).toEqual([]);
    });

    it('should return empty array on error', async () => {
      const service = createEnabledService();
      mockSend.mockRejectedValueOnce(new Error('fail'));
      const result = await (service as any).listFiles('prefix/');
      expect(result).toEqual([]);
    });
  });

  describe('getNextDuplicateIteration (private)', () => {
    it('should return 2 when no existing duplicates', async () => {
      const service = createEnabledService();
      mockSend.mockResolvedValueOnce({ Contents: [] });

      const result = await (service as any).getNextDuplicateIteration(
        'prefix/100-200-',
      );
      expect(result).toBe(2);
    });

    it('should return max iteration + 1 for existing duplicates', async () => {
      const service = createEnabledService();
      mockSend.mockResolvedValueOnce({
        Contents: [
          { Key: 'prefix/100-200-2-timestamp.json' },
          { Key: 'prefix/100-200-5-timestamp.json' },
          { Key: 'prefix/100-200-3-timestamp.json' },
        ],
      });

      const result = await (service as any).getNextDuplicateIteration(
        'prefix/100-200-',
      );
      expect(result).toBe(6);
    });

    it('should return 2 on error', async () => {
      const service = createEnabledService();
      mockSend.mockRejectedValueOnce(new Error('fail'));

      const result = await (service as any).getNextDuplicateIteration(
        'prefix/',
      );
      expect(result).toBe(2);
    });
  });

  describe('generatePublicUrl (private)', () => {
    it('should generate Cloudflare R2 public URL', () => {
      const service = createService({
        endpoint: 'https://abc123.r2.cloudflarestorage.com',
      });
      const url = (service as any).generatePublicUrl('rewards/test/file.json');
      expect(url).toBe('https://pub-abc123.r2.dev/rewards/test/file.json');
    });

    it('should generate standard URL for non-R2 endpoints', () => {
      const service = createService({
        endpoint: 'https://s3.amazonaws.com',
        bucket: 'my-bucket',
      });
      const url = (service as any).generatePublicUrl('some/key.json');
      expect(url).toBe('https://s3.amazonaws.com/my-bucket/some/key.json');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // checkHealth (private, tested through initialize)
  // ──────────────────────────────────────────────────────────────────────
  describe('checkHealth (private)', () => {
    it('should return false when client is null', async () => {
      const service = createService();
      const result = await (service as any).checkHealth();
      expect(result).toBe(false);
    });

    it('should return true on successful HeadBucket', async () => {
      const service = createEnabledService();
      mockSend.mockResolvedValueOnce({});
      const result = await (service as any).checkHealth();
      expect(result).toBe(true);
    });

    it('should return false on NoSuchBucket', async () => {
      const service = createEnabledService();
      const err = new (jest.requireActual('@aws-sdk/client-s3').NoSuchBucket)({
        message: 'no bucket',
        $metadata: {},
      });
      mockSend.mockRejectedValueOnce(err);
      const result = await (service as any).checkHealth();
      expect(result).toBe(false);
    });

    it('should return false on generic error', async () => {
      const service = createEnabledService();
      mockSend.mockRejectedValueOnce(new Error('boom'));
      const result = await (service as any).checkHealth();
      expect(result).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Error classes
  // ──────────────────────────────────────────────────────────────────────
  describe('error classes', () => {
    it('S3UploadError should have correct name and properties', () => {
      const original = new Error('cause');
      const err = new S3UploadError('upload failed', 'my-key', original);
      expect(err.name).toBe('S3UploadError');
      expect(err.message).toBe('upload failed');
      expect(err.key).toBe('my-key');
      expect(err.originalError).toBe(original);
    });

    it('S3ConfigurationError should have correct name', () => {
      const err = new S3ConfigurationError('bad config');
      expect(err.name).toBe('S3ConfigurationError');
      expect(err.message).toBe('bad config');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // initialize (private) – integration of validate + client + health
  // ──────────────────────────────────────────────────────────────────────
  describe('initialize (private)', () => {
    it('should set s3Client even when health check fails', async () => {
      const service = createService();
      // Mock the health check to fail
      mockSend.mockRejectedValueOnce(new Error('health fail'));

      await (service as any).initialize();
      // Client should still be created
      expect((service as any).s3Client).toBeDefined();
    });

    it('should handle validation failure gracefully', async () => {
      const service = createService({ endpoint: '' });
      // validateConfiguration will throw
      await (service as any).initialize();
      // Should not crash; client stays null
      expect((service as any).s3Client).toBeNull();
    });
  });
});
