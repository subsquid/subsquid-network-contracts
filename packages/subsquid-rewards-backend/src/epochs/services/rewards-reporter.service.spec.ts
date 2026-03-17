import { ConfigService } from '@nestjs/config';
import { ContractService } from '../../blockchain/contract.service';
import { RewardsReporterService } from './rewards-reporter.service';
import { NetworkMetrics, RewardMetrics } from './epoch-metrics.service';

describe('RewardsReporterService', () => {
  let service: RewardsReporterService;
  let configService: { get: jest.Mock };
  let contractService: {
    getActiveWorkerCount: jest.Mock;
    getTargetCapacity: jest.Mock;
    getStoragePerWorkerInGb: jest.Mock;
    getCurrentApy: jest.Mock;
  };
  let ctx: { logger: { debug: jest.Mock; info: jest.Mock; warn: jest.Mock; error: jest.Mock } };
  let consoleSpy: jest.SpyInstance;

  const makeNetworkMetrics = (overrides?: Partial<NetworkMetrics>): NetworkMetrics => ({
    activeWorkerCount: 10,
    storagePerWorker: 200,
    currentCapacity: 2000,
    targetCapacity: 5000,
    baseAprBasisPoints: 2000,
    ...overrides,
  });

  const makeRewardMetrics = (overrides?: Partial<RewardMetrics>): RewardMetrics => ({
    totalReward: 1_000_000n,
    totalBytesSent: 500,
    totalChunksRead: 50,
    totalRequests: 30,
    validRequests: 25,
    ...overrides,
  });

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
    service = new RewardsReporterService(
      configService as unknown as ConfigService,
      contractService as unknown as ContractService,
    );
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    delete process.env.BOT_NAME;
  });

  describe('logSuccessfulRewardsReport', () => {
    it('should log a basic rewards report without workers', async () => {
      configService.get.mockImplementation((key: string) => {
        if (key === 'blockchain.network.networkName') return 'testnet';
        if (key === 'blockchain.distributor.address') return '0xABC123';
        return undefined;
      });

      await service.logSuccessfulRewardsReport({
        epochStart: new Date('2026-01-01'),
        epochEnd: new Date('2026-01-02'),
        isCommitSuccess: true,
        commitTxHash: '0xdeadbeef',
        networkMetrics: makeNetworkMetrics(),
        rewardMetrics: makeRewardMetrics(),
      });

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(logged.type).toBe('rewards_report');
      expect(logged.bot_id).toBe('testnet');
      expect(logged.bot_wallet).toBe('0xabc123');
      expect(logged.is_commit_success).toBe(true);
      expect(logged.commit_tx_hash).toBe('0xdeadbeef');
      expect(logged.commit_error_message).toBe('');
      expect(logged.target_capacity).toBe(5000);
      expect(logged.current_capacity).toBe(2000);
      expect(logged.active_workers_count).toBe(10);
      expect(logged.base_apr).toBe('2000');
      expect(logged.stake_factor).toBe('1');
      expect(logged.r_apr).toBe('2000');
      expect(logged.total_reward).toBe('1000000');
      expect(logged.total_bytes_sent).toBe(500);
      expect(logged.total_chunks_read).toBe(50);
      expect(logged.total_requests).toBe(30);
      expect(logged.valid_requests).toBe(25);
    });

    it('should use BOT_NAME env var when set', async () => {
      process.env.BOT_NAME = 'my-bot';
      configService.get.mockReturnValue(undefined);

      await service.logSuccessfulRewardsReport({
        epochStart: new Date('2026-01-01'),
        epochEnd: new Date('2026-01-02'),
        isCommitSuccess: true,
        commitTxHash: '0xaaa',
        networkMetrics: makeNetworkMetrics(),
        rewardMetrics: makeRewardMetrics(),
      });

      const logged = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(logged.bot_id).toBe('my-bot');
    });

    it('should log worker_report entries when commit succeeds and workers are present', async () => {
      configService.get.mockImplementation((key: string) => {
        if (key === 'blockchain.network.networkName') return 'mainnet';
        if (key === 'blockchain.distributor.address') return '0xDISTRIBUTOR';
        return undefined;
      });

      const workers = [
        {
          id: 'worker-1',
          workerReward: 100n,
          stakerReward: 50n,
          delegation: { effectiveStake: '1000' },
          apr: { worker_apr: '500', delegator_apr: '300' },
          traffic: {
            bytesSent: 100,
            chunksRead: 10,
            totalRequests: 5,
            validRequests: 4,
            trafficWeight: 0.75,
            dTraffic: 0.6,
          },
        },
        {
          id: 'worker-2',
          workerReward: 200n,
          stakerReward: 100n,
          delegation: { effectiveStake: '3000' },
          apr: { worker_apr: '600', delegator_apr: '400' },
          traffic: {
            bytesSent: 200,
            chunksRead: 20,
            totalRequests: 15,
            validRequests: 12,
            trafficWeight: 0.25,
            dTraffic: 0.4,
          },
        },
      ];

      await service.logSuccessfulRewardsReport({
        epochStart: new Date('2026-01-01'),
        epochEnd: new Date('2026-01-02'),
        isCommitSuccess: true,
        commitTxHash: '0xbbb',
        networkMetrics: makeNetworkMetrics(),
        rewardMetrics: makeRewardMetrics(),
        workerRewards: workers,
      });

      // 1 rewards_report + 2 worker_report
      expect(consoleSpy).toHaveBeenCalledTimes(3);

      const workerLog1 = JSON.parse(consoleSpy.mock.calls[1][0]);
      expect(workerLog1.type).toBe('worker_report');
      expect(workerLog1.worker_id).toBe('worker-1');
      expect(workerLog1.bot_id).toBe('mainnet');
      expect(workerLog1.bot_wallet).toBe('0xdistributor');
      expect(workerLog1.worker_apr).toBe('500');
      expect(workerLog1.delegator_apr).toBe('300');
      expect(workerLog1.worker_reward).toBe('100');
      expect(workerLog1.staker_reward).toBe('50');
      expect(workerLog1.stake).toBe('1000');
      expect(workerLog1.bytes_sent).toBe(100);
      expect(workerLog1.chunks_read).toBe(10);
      expect(workerLog1.requests).toBe(5);
      expect(workerLog1.valid_requests).toBe(4);
      expect(workerLog1.t_i).toBe('0.750000');
      expect(workerLog1.r_i).toBe('0.600000');

      const workerLog2 = JSON.parse(consoleSpy.mock.calls[2][0]);
      expect(workerLog2.worker_id).toBe('worker-2');
      expect(workerLog2.stake).toBe('3000');

      // s_i should reflect stake proportions: worker-1 has 1000/4000 = 0.25
      expect(workerLog1.s_i).toBe((1000 / 4000).toFixed(6));
      expect(workerLog2.s_i).toBe((3000 / 4000).toFixed(6));
    });

    it('should not log worker reports when commit fails', async () => {
      configService.get.mockReturnValue(undefined);

      await service.logSuccessfulRewardsReport({
        epochStart: new Date('2026-01-01'),
        epochEnd: new Date('2026-01-02'),
        isCommitSuccess: false,
        commitTxHash: '0xccc',
        commitErrorMessage: 'tx reverted',
        networkMetrics: makeNetworkMetrics(),
        rewardMetrics: makeRewardMetrics(),
        workerRewards: [{ id: 'w1', workerReward: 100n, stakerReward: 50n }],
      });

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(logged.type).toBe('rewards_report');
      expect(logged.is_commit_success).toBe(false);
      expect(logged.commit_error_message).toBe('tx reverted');
    });

    it('should use delegation.effectiveStake over flat stake', async () => {
      configService.get.mockReturnValue(undefined);

      const workers = [
        {
          id: 'w1',
          delegation: { effectiveStake: '5000' },
          stake: '9999',
          workerReward: 0n,
          stakerReward: 0n,
        },
      ];

      await service.logSuccessfulRewardsReport({
        epochStart: new Date('2026-01-01'),
        epochEnd: new Date('2026-01-02'),
        isCommitSuccess: true,
        commitTxHash: '0xddd',
        networkMetrics: makeNetworkMetrics(),
        rewardMetrics: makeRewardMetrics(),
        workerRewards: workers,
      });

      const workerLog = JSON.parse(consoleSpy.mock.calls[1][0]);
      expect(workerLog.stake).toBe('5000');
    });

    it('should fall back to flat stake when delegation is absent', async () => {
      configService.get.mockReturnValue(undefined);

      const workers = [
        {
          id: 'w1',
          stake: '7777',
          workerReward: 0n,
          stakerReward: 0n,
        },
      ];

      await service.logSuccessfulRewardsReport({
        epochStart: new Date('2026-01-01'),
        epochEnd: new Date('2026-01-02'),
        isCommitSuccess: true,
        commitTxHash: '0xeee',
        networkMetrics: makeNetworkMetrics(),
        rewardMetrics: makeRewardMetrics(),
        workerRewards: workers,
      });

      const workerLog = JSON.parse(consoleSpy.mock.calls[1][0]);
      expect(workerLog.stake).toBe('7777');
    });

    it('should resolve worker ID from peerId when id is missing', async () => {
      configService.get.mockReturnValue(undefined);

      const workers = [
        { peerId: 'peer-abc', workerReward: 0n, stakerReward: 0n },
      ];

      await service.logSuccessfulRewardsReport({
        epochStart: new Date('2026-01-01'),
        epochEnd: new Date('2026-01-02'),
        isCommitSuccess: true,
        commitTxHash: '0xfff',
        networkMetrics: makeNetworkMetrics(),
        rewardMetrics: makeRewardMetrics(),
        workerRewards: workers,
      });

      const workerLog = JSON.parse(consoleSpy.mock.calls[1][0]);
      expect(workerLog.worker_id).toBe('peer-abc');
    });

    it('should resolve worker ID from workerId when id and peerId are missing', async () => {
      configService.get.mockReturnValue(undefined);

      const workers = [
        { workerId: 42, workerReward: 0n, stakerReward: 0n },
      ];

      await service.logSuccessfulRewardsReport({
        epochStart: new Date('2026-01-01'),
        epochEnd: new Date('2026-01-02'),
        isCommitSuccess: true,
        commitTxHash: '0x111',
        networkMetrics: makeNetworkMetrics(),
        rewardMetrics: makeRewardMetrics(),
        workerRewards: workers,
      });

      const workerLog = JSON.parse(consoleSpy.mock.calls[1][0]);
      expect(workerLog.worker_id).toBe('42');
    });

    it('should handle trafficWeight as a string', async () => {
      configService.get.mockReturnValue(undefined);

      const workers = [
        {
          id: 'w1',
          workerReward: 0n,
          stakerReward: 0n,
          trafficWeight: '0.123456',
          dTraffic: '0.654321',
        },
      ];

      await service.logSuccessfulRewardsReport({
        epochStart: new Date('2026-01-01'),
        epochEnd: new Date('2026-01-02'),
        isCommitSuccess: true,
        commitTxHash: '0x222',
        networkMetrics: makeNetworkMetrics(),
        rewardMetrics: makeRewardMetrics(),
        workerRewards: workers,
      });

      const workerLog = JSON.parse(consoleSpy.mock.calls[1][0]);
      expect(workerLog.t_i).toBe('0.123456');
      expect(workerLog.r_i).toBe('0.654321');
    });

    it('should format trafficWeight as number with 6 decimal places', async () => {
      configService.get.mockReturnValue(undefined);

      const workers = [
        {
          id: 'w1',
          workerReward: 0n,
          stakerReward: 0n,
          traffic: { trafficWeight: 0.5, dTraffic: 0.3 },
        },
      ];

      await service.logSuccessfulRewardsReport({
        epochStart: new Date('2026-01-01'),
        epochEnd: new Date('2026-01-02'),
        isCommitSuccess: true,
        commitTxHash: '0x333',
        networkMetrics: makeNetworkMetrics(),
        rewardMetrics: makeRewardMetrics(),
        workerRewards: workers,
      });

      const workerLog = JSON.parse(consoleSpy.mock.calls[1][0]);
      expect(workerLog.t_i).toBe('0.500000');
      expect(workerLog.r_i).toBe('0.300000');
    });

    it('should use flat traffic fields when traffic object is absent', async () => {
      configService.get.mockReturnValue(undefined);

      const workers = [
        {
          id: 'w1',
          workerReward: 0n,
          stakerReward: 0n,
          bytesSent: 999,
          chunksRead: 88,
          totalRequests: 77,
          requestsProcessed: 66,
        },
      ];

      await service.logSuccessfulRewardsReport({
        epochStart: new Date('2026-01-01'),
        epochEnd: new Date('2026-01-02'),
        isCommitSuccess: true,
        commitTxHash: '0x444',
        networkMetrics: makeNetworkMetrics(),
        rewardMetrics: makeRewardMetrics(),
        workerRewards: workers,
      });

      const workerLog = JSON.parse(consoleSpy.mock.calls[1][0]);
      expect(workerLog.bytes_sent).toBe(999);
      expect(workerLog.chunks_read).toBe(88);
      expect(workerLog.requests).toBe(77);
      expect(workerLog.valid_requests).toBe(66);
    });

    it('should default bot_wallet to 0x0 when distributor address is not configured', async () => {
      configService.get.mockReturnValue(undefined);

      await service.logSuccessfulRewardsReport({
        epochStart: new Date('2026-01-01'),
        epochEnd: new Date('2026-01-02'),
        isCommitSuccess: true,
        commitTxHash: '0x555',
        networkMetrics: makeNetworkMetrics(),
        rewardMetrics: makeRewardMetrics(),
      });

      const logged = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(logged.bot_wallet).toBe('0x0');
    });
  });

  describe('logFailedRewardsReport', () => {
    it('should log a failed rewards report with contract metrics', async () => {
      configService.get.mockImplementation((key: string) => {
        if (key === 'blockchain.network.networkName') return 'testnet';
        if (key === 'blockchain.distributor.address') return '0xWALLET';
        return undefined;
      });
      contractService.getActiveWorkerCount.mockResolvedValue(10);
      contractService.getTargetCapacity.mockResolvedValue(5_000_000_000_000);
      contractService.getStoragePerWorkerInGb.mockResolvedValue(400);
      contractService.getCurrentApy.mockResolvedValue(2500);

      await service.logFailedRewardsReport(
        ctx as any,
        new Date('2026-01-01'),
        new Date('2026-01-02'),
        '0xfailedtx',
        new Error('out of gas'),
      );

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(logged.type).toBe('rewards_report');
      expect(logged.is_commit_success).toBe(false);
      expect(logged.commit_tx_hash).toBe('0xfailedtx');
      expect(logged.commit_error_message).toBe('out of gas');
      expect(logged.active_workers_count).toBe(10);
      expect(logged.current_capacity).toBe(Math.round(10 * 400));
      expect(logged.target_capacity).toBe(Math.round(5_000_000_000_000 / 1e9));
      expect(logged.base_apr).toBe('2500');
      expect(logged.total_reward).toBe('0');
      expect(logged.total_chunks_read).toBe(0);
      expect(logged.total_bytes_sent).toBe(0);
      expect(logged.total_requests).toBe(0);
      expect(logged.valid_requests).toBe(0);
      expect(logged.bot_id).toBe('testnet');
      expect(logged.bot_wallet).toBe('0xwallet');
    });

    it('should fall back to default storage per worker on error', async () => {
      configService.get.mockReturnValue(undefined);
      contractService.getActiveWorkerCount.mockResolvedValue(5);
      contractService.getTargetCapacity.mockResolvedValue(1_000_000_000_000);
      contractService.getStoragePerWorkerInGb.mockRejectedValue(new Error('storage err'));
      contractService.getCurrentApy.mockResolvedValue(1800);

      await service.logFailedRewardsReport(
        ctx as any,
        new Date('2026-01-01'),
        new Date('2026-01-02'),
        '0xaaa',
        new Error('fail'),
      );

      const logged = JSON.parse(consoleSpy.mock.calls[0][0]);
      // Default storage = 200, so capacity = 5 * 200 = 1000
      expect(logged.current_capacity).toBe(Math.round(5 * 200));
    });

    it('should fall back to default APR on error', async () => {
      configService.get.mockReturnValue(undefined);
      contractService.getActiveWorkerCount.mockResolvedValue(7);
      contractService.getTargetCapacity.mockResolvedValue(2_000_000_000_000);
      contractService.getStoragePerWorkerInGb.mockResolvedValue(300);
      contractService.getCurrentApy.mockRejectedValue(new Error('apr err'));

      await service.logFailedRewardsReport(
        ctx as any,
        new Date('2026-01-01'),
        new Date('2026-01-02'),
        '0xbbb',
        new Error('fail'),
      );

      const logged = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(logged.base_apr).toBe('2000');
      expect(logged.r_apr).toBe('2000');
    });

    it('should catch outer errors and log to ctx.logger.error', async () => {
      configService.get.mockReturnValue(undefined);
      contractService.getActiveWorkerCount.mockRejectedValue(
        new Error('network down'),
      );

      await service.logFailedRewardsReport(
        ctx as any,
        new Date('2026-01-01'),
        new Date('2026-01-02'),
        '0xccc',
        new Error('original error'),
      );

      expect(consoleSpy).not.toHaveBeenCalled();
      expect(ctx.logger.error).toHaveBeenCalledWith(
        { error: expect.any(Error) },
        'Failed to log error metrics',
      );
    });

    it('should use BOT_NAME env var when available', async () => {
      process.env.BOT_NAME = 'error-bot';
      configService.get.mockReturnValue(undefined);
      contractService.getActiveWorkerCount.mockResolvedValue(1);
      contractService.getTargetCapacity.mockResolvedValue(1_000_000_000);
      contractService.getStoragePerWorkerInGb.mockResolvedValue(100);
      contractService.getCurrentApy.mockResolvedValue(1000);

      await service.logFailedRewardsReport(
        ctx as any,
        new Date('2026-01-01'),
        new Date('2026-01-02'),
        '',
        new Error('something broke'),
      );

      const logged = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(logged.bot_id).toBe('error-bot');
      expect(logged.commit_tx_hash).toBe('');
    });

    it('should default bot_id to nestjs-backend-0-0 when no env or config', async () => {
      configService.get.mockReturnValue(undefined);
      contractService.getActiveWorkerCount.mockResolvedValue(2);
      contractService.getTargetCapacity.mockResolvedValue(500_000_000_000);
      contractService.getStoragePerWorkerInGb.mockResolvedValue(200);
      contractService.getCurrentApy.mockResolvedValue(2000);

      await service.logFailedRewardsReport(
        ctx as any,
        new Date('2026-01-01'),
        new Date('2026-01-02'),
        '0xddd',
        new Error('err'),
      );

      const logged = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(logged.bot_id).toBe('nestjs-backend-0-0');
    });
  });
});
