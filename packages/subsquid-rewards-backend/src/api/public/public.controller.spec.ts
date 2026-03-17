/**
 * Unit tests for PublicController.
 *
 * Strategy:
 *  - Mock the logger so pino never writes to stdout.
 *  - Instantiate PublicController directly (no NestJS TestingModule) to avoid
 *    onModuleInit lifecycle hooks in ContractService.
 *  - Mock RewardsCalculatorService and ContractService with jest.fn() stubs.
 *  - Access private helpers via (controller as any).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Logger mock - suppress pino output in tests
// ---------------------------------------------------------------------------
jest.mock('../../common/logger', () => ({
  Logger: {
    get: () => ({
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      child: jest.fn().mockReturnThis(),
    }),
  },
}));

import { HttpException, HttpStatus } from '@nestjs/common';
import { PublicController } from './public.controller';

// ---------------------------------------------------------------------------
// Mock services
// ---------------------------------------------------------------------------
function createMockRewardsCalculatorService() {
  return {
    calculateRewardsFormatted: jest.fn(),
  };
}

function createMockContractService() {
  return {
    getL1Block: jest.fn(),
    getBlock: jest.fn(),
    getFirstBlockForL1Block: jest.fn(),
    getCurrentApy: jest.fn(),
    getL1BlockNumber: jest.fn(),
  };
}

describe('PublicController', () => {
  let controller: PublicController;
  let rewardsService: ReturnType<typeof createMockRewardsCalculatorService>;
  let contractService: ReturnType<typeof createMockContractService>;

  beforeEach(() => {
    rewardsService = createMockRewardsCalculatorService();
    contractService = createMockContractService();
    controller = new PublicController(rewardsService as any, contractService as any);
  });

  // =========================================================================
  // Private helper: isInteger
  // =========================================================================
  describe('isInteger (private)', () => {
    const isInteger = (value: string) => (controller as any).isInteger(value);

    it('should return true for positive integers', () => {
      expect(isInteger('0')).toBe(true);
      expect(isInteger('1')).toBe(true);
      expect(isInteger('100')).toBe(true);
      expect(isInteger('999999')).toBe(true);
    });

    it('should return true for negative integers', () => {
      expect(isInteger('-1')).toBe(true);
      expect(isInteger('-100')).toBe(true);
    });

    it('should return false for decimal numbers', () => {
      expect(isInteger('1.5')).toBe(false);
      expect(isInteger('0.1')).toBe(false);
      expect(isInteger('-3.14')).toBe(false);
    });

    it('should return false for non-numeric strings', () => {
      expect(isInteger('abc')).toBe(false);
      expect(isInteger('12abc')).toBe(false);
      expect(isInteger('hello')).toBe(false);
    });

    it('should return true for empty string (Number("") === 0)', () => {
      // Note: this is a quirk of the implementation -- Number('') is 0
      expect(isInteger('')).toBe(true);
    });

    it('should return false for special numeric values', () => {
      expect(isInteger('NaN')).toBe(false);
      expect(isInteger('Infinity')).toBe(false);
      expect(isInteger('-Infinity')).toBe(false);
    });
  });

  // =========================================================================
  // Private helper: bn
  // =========================================================================
  describe('bn (private)', () => {
    const bn = (value: any) => (controller as any).bn(value);

    it('should handle plain integer strings', () => {
      expect(bn('0')).toBe('0');
      expect(bn('123')).toBe('123');
      expect(bn('999999999999999999')).toBe('999999999999999999');
    });

    it('should truncate decimal strings (floor toward zero)', () => {
      expect(bn('123.456')).toBe('123');
      expect(bn('0.999')).toBe('0');
      expect(bn('100.0')).toBe('100');
    });

    it('should handle scientific notation strings', () => {
      expect(bn('1e18')).toBe('1000000000000000000');
      expect(bn('5E10')).toBe('50000000000');
      expect(bn('1.5e3')).toBe('1500');
    });

    it('should handle objects with toString()', () => {
      const obj = { toString: () => '42' };
      expect(bn(obj)).toBe('42');
    });

    it('should handle objects with toString() returning decimals', () => {
      const obj = { toString: () => '99.99' };
      expect(bn(obj)).toBe('99');
    });

    it('should handle objects with toString() returning scientific notation', () => {
      const obj = { toString: () => '2.5e4' };
      expect(bn(obj)).toBe('25000');
    });
  });

  // =========================================================================
  // calculateRewards
  // =========================================================================
  describe('calculateRewards', () => {
    const sampleWorker = {
      id: 'worker-1',
      workerReward: '1000000000000000000',
      stakerReward: '500000000000000000',
      apr: { worker_apr: '0.15', delegator_apr: '0.10' },
      traffic: { bytesSent: 1024, chunksRead: 50, trafficWeight: 0.5, dTraffic: 0.8, validRequests: 100, totalRequests: 110, requestErrorRate: 0.09 },
      delegation: { totalDelegated: '200000000000000000000', effectiveStake: '150000000000000000000' },
      liveness: { livenessCoefficient: 0.95, tenure: 0.7 },
    };

    beforeEach(() => {
      rewardsService.calculateRewardsFormatted.mockResolvedValue({
        totalRewards: { worker: '1000000000000000000', staker: '500000000000000000' },
        workers: [sampleWorker],
      });
      contractService.getL1Block.mockImplementation((_ctx: any, blockNumber: bigint) => {
        if (blockNumber === 100n) return Promise.resolve({ timestamp: 1000n, number: 100n });
        if (blockNumber === 200n) return Promise.resolve({ timestamp: 2000n, number: 200n });
        return Promise.resolve({ timestamp: 0n, number: blockNumber });
      });
    });

    it('should return formatted rewards on success', async () => {
      const result = await controller.calculateRewards('100', '200');

      expect(rewardsService.calculateRewardsFormatted).toHaveBeenCalledWith(
        expect.anything(), // TaskContext
        100,
        200,
        true,
      );
      expect(contractService.getL1Block).toHaveBeenCalledTimes(2);

      expect(result.totalRewards.worker).toBe('1000000000000000000');
      expect(result.totalRewards.staker).toBe('500000000000000000');
      expect(result.workers).toHaveLength(1);
      expect(result.workers[0].id).toBe('worker-1');
      expect(result.workers[0].workerReward).toBe('1000000000000000000');
      expect(result.workers[0].stakerReward).toBe('500000000000000000');
      expect(result.workers[0].apr).toBe('0.15');
      expect(result.workers[0].traffic).toEqual(sampleWorker.traffic);
      expect(result.workers[0].delegation).toEqual(sampleWorker.delegation);
      expect(result.workers[0].liveness).toEqual(sampleWorker.liveness);
    });

    it('should aggregate totals from multiple workers', async () => {
      const worker2 = {
        ...sampleWorker,
        id: 'worker-2',
        workerReward: '2000000000000000000',
        stakerReward: '1000000000000000000',
      };
      rewardsService.calculateRewardsFormatted.mockResolvedValue({
        totalRewards: { worker: '3000000000000000000', staker: '1500000000000000000' },
        workers: [sampleWorker, worker2],
      });

      const result = await controller.calculateRewards('100', '200');

      expect(result.totalRewards.worker).toBe('3000000000000000000');
      expect(result.totalRewards.staker).toBe('1500000000000000000');
      expect(result.workers).toHaveLength(2);
    });

    it('should handle workers with decimal/scientific notation rewards via bn()', async () => {
      rewardsService.calculateRewardsFormatted.mockResolvedValue({
        totalRewards: { worker: '0', staker: '0' },
        workers: [{
          ...sampleWorker,
          workerReward: '123.789',
          stakerReward: '4.5e2',
        }],
      });

      const result = await controller.calculateRewards('100', '200');

      expect(result.workers[0].workerReward).toBe('123');
      expect(result.workers[0].stakerReward).toBe('450');
      // totalRewards is re-computed from the bn-converted values
      expect(result.totalRewards.worker).toBe('123');
      expect(result.totalRewards.staker).toBe('450');
    });

    it('should throw BAD_REQUEST when fromBlock is not an integer', async () => {
      await expect(controller.calculateRewards('abc', '200')).rejects.toThrow(
        new HttpException('fromBlock is not an integer', HttpStatus.BAD_REQUEST),
      );
      expect(rewardsService.calculateRewardsFormatted).not.toHaveBeenCalled();
    });

    it('should throw BAD_REQUEST when fromBlock is a decimal', async () => {
      await expect(controller.calculateRewards('1.5', '200')).rejects.toThrow(
        new HttpException('fromBlock is not an integer', HttpStatus.BAD_REQUEST),
      );
    });

    it('should throw BAD_REQUEST when toBlock is not an integer', async () => {
      await expect(controller.calculateRewards('100', 'xyz')).rejects.toThrow(
        new HttpException('toBlock is not an integer', HttpStatus.BAD_REQUEST),
      );
    });

    it('should throw BAD_REQUEST when toBlock is a decimal', async () => {
      await expect(controller.calculateRewards('100', '200.5')).rejects.toThrow(
        new HttpException('toBlock is not an integer', HttpStatus.BAD_REQUEST),
      );
    });

    it('should throw BAD_REQUEST when fromBlock >= toBlock (equal)', async () => {
      await expect(controller.calculateRewards('200', '200')).rejects.toThrow(
        new HttpException('fromBlock should be less than toBlock', HttpStatus.BAD_REQUEST),
      );
    });

    it('should throw BAD_REQUEST when fromBlock > toBlock', async () => {
      await expect(controller.calculateRewards('300', '200')).rejects.toThrow(
        new HttpException('fromBlock should be less than toBlock', HttpStatus.BAD_REQUEST),
      );
    });

    it('should throw INTERNAL_SERVER_ERROR when calculation fails', async () => {
      rewardsService.calculateRewardsFormatted.mockRejectedValue(new Error('calc failure'));

      await expect(controller.calculateRewards('100', '200')).rejects.toThrow(
        new HttpException('calc failure', HttpStatus.INTERNAL_SERVER_ERROR),
      );
    });

    it('should throw INTERNAL_SERVER_ERROR when getL1Block fails', async () => {
      contractService.getL1Block.mockRejectedValue(new Error('L1 block fetch failed'));

      await expect(controller.calculateRewards('100', '200')).rejects.toThrow(
        new HttpException('L1 block fetch failed', HttpStatus.INTERNAL_SERVER_ERROR),
      );
    });

    it('should handle empty workers array', async () => {
      rewardsService.calculateRewardsFormatted.mockResolvedValue({
        totalRewards: { worker: '0', staker: '0' },
        workers: [],
      });

      const result = await controller.calculateRewards('100', '200');

      expect(result.totalRewards.worker).toBe('0');
      expect(result.totalRewards.staker).toBe('0');
      expect(result.workers).toHaveLength(0);
    });
  });

  // =========================================================================
  // getCurrentApy
  // =========================================================================
  describe('getCurrentApy', () => {
    it('should return APY for the latest block', async () => {
      contractService.getBlock.mockResolvedValue({
        number: 5000n,
        l1BlockNumber: 12345n,
      });
      contractService.getCurrentApy.mockResolvedValue(1500n);

      const result = await controller.getCurrentApy();

      expect(contractService.getBlock).toHaveBeenCalled();
      expect(contractService.getFirstBlockForL1Block).not.toHaveBeenCalled();
      expect(contractService.getCurrentApy).toHaveBeenCalledWith(expect.anything(), 5000n);
      expect(result).toEqual({
        blockNumber: '5000',
        l1BlockNumber: '12345',
        apy: '1500',
      });
    });

    it('should throw INTERNAL_SERVER_ERROR when getBlock fails', async () => {
      contractService.getBlock.mockRejectedValue(new Error('block fetch error'));

      await expect(controller.getCurrentApy()).rejects.toThrow(
        new HttpException('block fetch error', HttpStatus.INTERNAL_SERVER_ERROR),
      );
    });

    it('should throw INTERNAL_SERVER_ERROR when getCurrentApy fails', async () => {
      contractService.getBlock.mockResolvedValue({
        number: 5000n,
        l1BlockNumber: 12345n,
      });
      contractService.getCurrentApy.mockRejectedValue(new Error('apy error'));

      await expect(controller.getCurrentApy()).rejects.toThrow(
        new HttpException('apy error', HttpStatus.INTERNAL_SERVER_ERROR),
      );
    });
  });

  // =========================================================================
  // getCurrentApyAtBlock
  // =========================================================================
  describe('getCurrentApyAtBlock', () => {
    it('should return APY for a specific L1 block', async () => {
      contractService.getFirstBlockForL1Block.mockResolvedValue(8000n);
      contractService.getCurrentApy.mockResolvedValue(1200n);

      const result = await controller.getCurrentApyAtBlock('50000');

      expect(contractService.getBlock).not.toHaveBeenCalled();
      expect(contractService.getFirstBlockForL1Block).toHaveBeenCalledWith(50000n);
      expect(contractService.getCurrentApy).toHaveBeenCalledWith(expect.anything(), 8000n);
      expect(result).toEqual({
        blockNumber: '8000',
        l1BlockNumber: '50000',
        apy: '1200',
      });
    });

    it('should fall back to latest block when atBlock is not an integer', async () => {
      contractService.getBlock.mockResolvedValue({
        number: 5000n,
        l1BlockNumber: 12345n,
      });
      contractService.getCurrentApy.mockResolvedValue(1500n);

      const result = await controller.getCurrentApyAtBlock('abc');

      // non-integer atBlock => uses getBlock (latest)
      expect(contractService.getBlock).toHaveBeenCalled();
      expect(contractService.getFirstBlockForL1Block).not.toHaveBeenCalled();
      expect(result).toEqual({
        blockNumber: '5000',
        l1BlockNumber: '12345',
        apy: '1500',
      });
    });

    it('should fall back to latest block when atBlock is a decimal', async () => {
      contractService.getBlock.mockResolvedValue({
        number: 5000n,
        l1BlockNumber: 12345n,
      });
      contractService.getCurrentApy.mockResolvedValue(1500n);

      const result = await controller.getCurrentApyAtBlock('100.5');

      expect(contractService.getBlock).toHaveBeenCalled();
      expect(contractService.getFirstBlockForL1Block).not.toHaveBeenCalled();
      expect(result.blockNumber).toBe('5000');
    });

    it('should throw INTERNAL_SERVER_ERROR when getFirstBlockForL1Block fails', async () => {
      contractService.getFirstBlockForL1Block.mockRejectedValue(new Error('l2 lookup failed'));

      await expect(controller.getCurrentApyAtBlock('50000')).rejects.toThrow(
        new HttpException('l2 lookup failed', HttpStatus.INTERNAL_SERVER_ERROR),
      );
    });

    it('should throw INTERNAL_SERVER_ERROR when getCurrentApy fails', async () => {
      contractService.getFirstBlockForL1Block.mockResolvedValue(8000n);
      contractService.getCurrentApy.mockRejectedValue(new Error('apy error'));

      await expect(controller.getCurrentApyAtBlock('50000')).rejects.toThrow(
        new HttpException('apy error', HttpStatus.INTERNAL_SERVER_ERROR),
      );
    });
  });

  // =========================================================================
  // getCurrentApyWithBlock (private, exercised indirectly + directly)
  // =========================================================================
  describe('getCurrentApyWithBlock (private)', () => {
    it('should handle undefined atBlock (latest)', async () => {
      contractService.getBlock.mockResolvedValue({
        number: 3000n,
        l1BlockNumber: 9999n,
      });
      contractService.getCurrentApy.mockResolvedValue(2000n);

      const result = await (controller as any).getCurrentApyWithBlock(undefined);

      expect(contractService.getBlock).toHaveBeenCalled();
      expect(result.blockNumber).toBe('3000');
      expect(result.l1BlockNumber).toBe('9999');
      expect(result.apy).toBe('2000');
    });

    it('should handle empty string atBlock (falls to latest)', async () => {
      contractService.getBlock.mockResolvedValue({
        number: 3000n,
        l1BlockNumber: 9999n,
      });
      contractService.getCurrentApy.mockResolvedValue(2000n);

      const result = await (controller as any).getCurrentApyWithBlock('');

      // empty string is falsy => goes to latest block path
      expect(contractService.getBlock).toHaveBeenCalled();
      expect(result.blockNumber).toBe('3000');
    });
  });

  // =========================================================================
  // calculateRewardsForLastNBlocks
  // =========================================================================
  describe('calculateRewardsForLastNBlocks', () => {
    const sampleWorker = {
      id: 'worker-1',
      workerReward: '500000000000000000',
      stakerReward: '250000000000000000',
      apr: { worker_apr: '0.10', delegator_apr: '0.05' },
      traffic: { bytesSent: 512, chunksRead: 25 },
      delegation: { totalDelegated: '100000000000000000000', effectiveStake: '80000000000000000000' },
      liveness: { livenessCoefficient: 1.0, tenure: 0.5 },
    };

    beforeEach(() => {
      contractService.getL1BlockNumber.mockResolvedValue(21000);
      rewardsService.calculateRewardsFormatted.mockResolvedValue({
        totalRewards: { worker: '500000000000000000', staker: '250000000000000000' },
        workers: [sampleWorker],
      });
      contractService.getL1Block.mockImplementation((_ctx: any, blockNumber: bigint) => {
        return Promise.resolve({ timestamp: BigInt(blockNumber) * 12n, number: blockNumber });
      });
    });

    it('should calculate rewards for the last N blocks', async () => {
      const result = await controller.calculateRewardsForLastNBlocks('1000');

      // Should call getL1BlockNumber to get the current block
      expect(contractService.getL1BlockNumber).toHaveBeenCalled();

      // Should delegate to calculateRewards with fromBlock = 21000 - 1000 = 20000
      expect(rewardsService.calculateRewardsFormatted).toHaveBeenCalledWith(
        expect.anything(),
        20000,
        21000,
        true,
      );

      expect(result.totalRewards.worker).toBe('500000000000000000');
      expect(result.workers).toHaveLength(1);
    });

    it('should throw BAD_REQUEST when lastNBlocks is not an integer', async () => {
      await expect(controller.calculateRewardsForLastNBlocks('abc')).rejects.toThrow(
        new HttpException('lastNBlocks is not an integer', HttpStatus.BAD_REQUEST),
      );
      expect(contractService.getL1BlockNumber).not.toHaveBeenCalled();
    });

    it('should throw BAD_REQUEST when lastNBlocks is a decimal', async () => {
      await expect(controller.calculateRewardsForLastNBlocks('10.5')).rejects.toThrow(
        new HttpException('lastNBlocks is not an integer', HttpStatus.BAD_REQUEST),
      );
    });

    it('should throw INTERNAL_SERVER_ERROR when getL1BlockNumber fails', async () => {
      contractService.getL1BlockNumber.mockRejectedValue(new Error('L1 block number error'));

      await expect(controller.calculateRewardsForLastNBlocks('1000')).rejects.toThrow(
        new HttpException('L1 block number error', HttpStatus.INTERNAL_SERVER_ERROR),
      );
    });

    it('should throw INTERNAL_SERVER_ERROR when downstream calculateRewards fails', async () => {
      rewardsService.calculateRewardsFormatted.mockRejectedValue(new Error('rewards calc error'));

      await expect(controller.calculateRewardsForLastNBlocks('1000')).rejects.toThrow(HttpException);
    });

    it('should handle zero as a valid integer for lastNBlocks', async () => {
      // lastNBlocks = 0 means fromBlock = toBlock, which should trigger
      // fromBlock >= toBlock validation in the delegated calculateRewards call
      await expect(controller.calculateRewardsForLastNBlocks('0')).rejects.toThrow(
        new HttpException('fromBlock should be less than toBlock', HttpStatus.BAD_REQUEST),
      );
    });
  });
});
