import { ConfigService } from '@nestjs/config';
import { ContractService } from '../../blockchain/contract.service';
import { EpochMetricsService } from './epoch-metrics.service';

describe('EpochMetricsService', () => {
  let service: EpochMetricsService;
  let configService: { get: jest.Mock };
  let contractService: {
    getActiveWorkerCount: jest.Mock;
    getTargetCapacity: jest.Mock;
    getStoragePerWorkerInGb: jest.Mock;
    getCurrentApy: jest.Mock;
  };
  let ctx: { logger: { debug: jest.Mock; info: jest.Mock; warn: jest.Mock; error: jest.Mock } };

  beforeEach(() => {
    configService = { get: jest.fn() };
    contractService = {
      getActiveWorkerCount: jest.fn(),
      getTargetCapacity: jest.fn(),
      getStoragePerWorkerInGb: jest.fn(),
      getCurrentApy: jest.fn(),
    };
    ctx = {
      logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
    };
    service = new EpochMetricsService(
      configService as unknown as ConfigService,
      contractService as unknown as ContractService,
    );
  });

  describe('collectNetworkMetrics', () => {
    it('should collect all network metrics successfully', async () => {
      contractService.getActiveWorkerCount.mockResolvedValue(10);
      contractService.getTargetCapacity.mockResolvedValue(5_000_000_000_000);
      contractService.getStoragePerWorkerInGb.mockResolvedValue(500);
      contractService.getCurrentApy.mockResolvedValue(3000);

      const result = await service.collectNetworkMetrics(ctx as any);

      expect(result).toEqual({
        activeWorkerCount: 10,
        storagePerWorker: 500,
        currentCapacity: 10 * 500,
        targetCapacity: 5_000_000_000_000 / 1e9,
        baseAprBasisPoints: 3000,
      });
      expect(ctx.logger.debug).toHaveBeenCalledWith('Storage per worker: 500 GB');
      expect(ctx.logger.debug).toHaveBeenCalledWith(
        'Using APR from rewards calculation: 3000 basis points',
      );
    });

    it('should fall back to default storage per worker on error', async () => {
      contractService.getActiveWorkerCount.mockResolvedValue(5);
      contractService.getTargetCapacity.mockResolvedValue(2_000_000_000_000);
      contractService.getStoragePerWorkerInGb.mockRejectedValue(
        new Error('storage contract error'),
      );
      contractService.getCurrentApy.mockResolvedValue(1500);

      const result = await service.collectNetworkMetrics(ctx as any);

      expect(result.storagePerWorker).toBe(200);
      expect(result.currentCapacity).toBe(5 * 200);
      expect(ctx.logger.warn).toHaveBeenCalledWith(
        'Failed to get storage per worker, using default: storage contract error',
      );
    });

    it('should fall back to default APR on error', async () => {
      contractService.getActiveWorkerCount.mockResolvedValue(8);
      contractService.getTargetCapacity.mockResolvedValue(1_000_000_000_000);
      contractService.getStoragePerWorkerInGb.mockResolvedValue(300);
      contractService.getCurrentApy.mockRejectedValue(new Error('apr contract error'));

      const result = await service.collectNetworkMetrics(ctx as any);

      expect(result.baseAprBasisPoints).toBe(2000);
      expect(ctx.logger.warn).toHaveBeenCalledWith(
        'Failed to get APR, using default: apr contract error',
      );
    });

    it('should fall back to defaults for both storage and APR on errors', async () => {
      contractService.getActiveWorkerCount.mockResolvedValue(3);
      contractService.getTargetCapacity.mockResolvedValue(500_000_000_000);
      contractService.getStoragePerWorkerInGb.mockRejectedValue(new Error('storage fail'));
      contractService.getCurrentApy.mockRejectedValue(new Error('apr fail'));

      const result = await service.collectNetworkMetrics(ctx as any);

      expect(result).toEqual({
        activeWorkerCount: 3,
        storagePerWorker: 200,
        currentCapacity: 3 * 200,
        targetCapacity: 500_000_000_000 / 1e9,
        baseAprBasisPoints: 2000,
      });
      expect(ctx.logger.warn).toHaveBeenCalledTimes(2);
    });
  });

  describe('extractRewardMetrics', () => {
    it('should extract metrics using totalRewards field', () => {
      const input = {
        workers: [
          { traffic: { bytesSent: 100, chunksRead: 10, totalRequests: 5, validRequests: 4 } },
          { traffic: { bytesSent: 200, chunksRead: 20, totalRequests: 15, validRequests: 12 } },
        ],
        totalRewards: { worker: '1000000', staker: '500000' },
      };

      const result = service.extractRewardMetrics(input);

      expect(result).toEqual({
        totalReward: 1_500_000n,
        totalBytesSent: 300,
        totalChunksRead: 30,
        totalRequests: 20,
        validRequests: 16,
      });
    });

    it('should sum worker rewards when totalRewards is absent', () => {
      const input = {
        workers: [
          {
            workerReward: '700000',
            stakerReward: '300000',
            traffic: { bytesSent: 50, chunksRead: 5, totalRequests: 3, validRequests: 2 },
          },
          {
            workerReward: '400000',
            stakerReward: '200000',
            traffic: { bytesSent: 80, chunksRead: 8, totalRequests: 6, validRequests: 5 },
          },
        ],
      };

      const result = service.extractRewardMetrics(input);

      expect(result.totalReward).toBe(1_600_000n);
      expect(result.totalBytesSent).toBe(130);
      expect(result.totalChunksRead).toBe(13);
    });

    it('should return zeros for null input', () => {
      const result = service.extractRewardMetrics(null);

      expect(result).toEqual({
        totalReward: 0n,
        totalBytesSent: 0,
        totalChunksRead: 0,
        totalRequests: 0,
        validRequests: 0,
      });
    });

    it('should return zeros for undefined input', () => {
      const result = service.extractRewardMetrics(undefined);

      expect(result).toEqual({
        totalReward: 0n,
        totalBytesSent: 0,
        totalChunksRead: 0,
        totalRequests: 0,
        validRequests: 0,
      });
    });

    it('should return zeros for empty workers array', () => {
      const result = service.extractRewardMetrics({ workers: [] });

      expect(result).toEqual({
        totalReward: 0n,
        totalBytesSent: 0,
        totalChunksRead: 0,
        totalRequests: 0,
        validRequests: 0,
      });
    });

    it('should extract metrics from flat fields (no traffic object)', () => {
      const input = {
        workers: [
          { bytesSent: 111, chunksRead: 22, totalRequests: 7, validRequests: 6 },
          { bytesSent: 222, chunksRead: 33, totalRequests: 14, validRequests: 11 },
        ],
        totalRewards: { worker: '100', staker: '50' },
      };

      const result = service.extractRewardMetrics(input);

      expect(result.totalBytesSent).toBe(333);
      expect(result.totalChunksRead).toBe(55);
      expect(result.totalRequests).toBe(21);
      expect(result.validRequests).toBe(17);
    });

    it('should prefer traffic object fields over flat fields', () => {
      const input = {
        workers: [
          {
            bytesSent: 999,
            chunksRead: 999,
            traffic: { bytesSent: 50, chunksRead: 5, totalRequests: 3, validRequests: 2 },
          },
        ],
        totalRewards: { worker: '0', staker: '0' },
      };

      const result = service.extractRewardMetrics(input);

      expect(result.totalBytesSent).toBe(50);
      expect(result.totalChunksRead).toBe(5);
    });

    it('should handle alternative field names: requests and requestsProcessed', () => {
      const input = {
        workers: [
          { bytesSent: 10, chunksRead: 1, requests: 42, requestsProcessed: 40 },
        ],
        totalRewards: { worker: '0', staker: '0' },
      };

      const result = service.extractRewardMetrics(input);

      expect(result.totalRequests).toBe(42);
      expect(result.validRequests).toBe(40);
    });

    it('should handle mixed worker formats', () => {
      const input = {
        workers: [
          { traffic: { bytesSent: 100, chunksRead: 10, totalRequests: 5, validRequests: 4 } },
          { bytesSent: 200, chunksRead: 20, requests: 15, requestsProcessed: 12 },
        ],
        totalRewards: { worker: '500', staker: '250' },
      };

      const result = service.extractRewardMetrics(input);

      expect(result.totalBytesSent).toBe(300);
      expect(result.totalChunksRead).toBe(30);
      expect(result.totalRequests).toBe(20);
      expect(result.validRequests).toBe(16);
      expect(result.totalReward).toBe(750n);
    });
  });
});
