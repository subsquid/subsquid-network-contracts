import { Test, TestingModule } from '@nestjs/testing';
import { ErrorDecoderService } from './error-decoder.service';
import { ContractFunctionRevertedError, BaseError } from 'viem';
import { Context } from '../common';

describe('ErrorDecoderService', () => {
  let service: ErrorDecoderService;
  let mockContext: Context;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ErrorDecoderService],
    }).compile();

    service = module.get<ErrorDecoderService>(ErrorDecoderService);

    // Mock context
    mockContext = {
      logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
    } as any;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('decodeContractError', () => {
    it('should decode NotAllBlocksCovered error', () => {
      const error = new BaseError(
        'The contract function "commitRoot" reverted with the following signature:\n0x1608bdd2',
      );
      const decoded = service.decodeContractError(error, mockContext);

      expect(decoded).toBeDefined();
      expect(decoded?.errorName).toBe('NotAllBlocksCovered');
      expect(decoded?.description).toBe(
        'Block range does not start from lastBlockRewarded + 1',
      );
    });

    it('should return null for non-contract errors', () => {
      const error = new Error('Regular error');
      const decoded = service.decodeContractError(
        error as BaseError,
        mockContext,
      );

      expect(decoded).toBeNull();
    });

    it('should decode multiple error types', () => {
      const errorSignatures = {
        '0x1608bdd2': 'NotAllBlocksCovered',
        '0x377c94a9': 'NotACommitter',
        '0x17741a47': 'MerkleRootAlreadyCommitted',
        '0xe2b1f194': 'BatchAlreadyProcessed',
      };

      Object.entries(errorSignatures).forEach(([signature, expectedError]) => {
        const error = new BaseError(
          `Contract reverted with signature:\n${signature}`,
        );
        const decoded = service.decodeContractError(error, mockContext);
        expect(decoded?.errorName).toBe(expectedError);
      });
    });
  });

  describe('formatError', () => {
    it('should format NotAllBlocksCovered error', () => {
      const error = new BaseError(
        'The contract function "commitRoot" reverted with the following signature:\n0x1608bdd2',
      );
      const formatted = service.formatError(error, mockContext);

      expect(formatted).toBe(
        'Contract Error: NotAllBlocksCovered - Block range does not start from lastBlockRewarded + 1',
      );
    });

    it('should return original message for non-decodable errors', () => {
      const error = new BaseError('Some other error');
      const formatted = service.formatError(error, mockContext);

      expect(formatted).toContain('Some other error');
    });

    it('should handle unknown signatures', () => {
      const error = new BaseError(
        'Contract reverted with signature:\n0xdeadbeef',
      );
      const formatted = service.formatError(error, mockContext);

      expect(formatted).toContain('Unknown error with signature 0xdeadbeef');
      expect(formatted).toContain(
        'https://openchain.xyz/signatures?query=0xdeadbeef',
      );
    });
  });

  describe('isSpecificError', () => {
    it('should correctly identify specific errors', () => {
      const error = new BaseError(
        'The contract function "commitRoot" reverted with the following signature:\n0x1608bdd2',
      );

      expect(service.isSpecificError(error, 'NotAllBlocksCovered')).toBe(true);
      expect(service.isSpecificError(error, 'NotACommitter')).toBe(false);
    });
  });

  describe('getErrorContext', () => {
    it('should provide context for NotAllBlocksCovered', () => {
      const error = new BaseError(
        'The contract function "commitRoot" reverted with the following signature:\n0x1608bdd2',
      );
      const context = service.getErrorContext(error, mockContext);

      expect(context.hint).toBe(
        'Check lastBlockRewarded on the contract and ensure fromBlock = lastBlockRewarded + 1',
      );
      expect(context.action).toBe(
        'Query contract.lastBlockRewarded() to get the correct starting block',
      );
    });

    it('should provide context for BatchAlreadyProcessed', () => {
      const error = new BaseError(
        'Contract reverted with signature:\n0xe2b1f194',
      );
      const context = service.getErrorContext(error, mockContext);

      expect(context.hint).toBe('This batch has already been distributed');
      expect(context.action).toBe(
        'Skip this batch and continue with remaining batches',
      );
    });

    it('should return empty context for unknown errors', () => {
      const error = new BaseError('Some random error');
      const context = service.getErrorContext(error, mockContext);

      expect(context).toEqual({});
    });
  });

  describe('getErrorDetails', () => {
    it('should return details for known errors', () => {
      expect(service.getErrorDetails('NotAllBlocksCovered')).toBe(
        'Block range does not start from lastBlockRewarded + 1',
      );
      expect(service.getErrorDetails('MerkleRootNotCommitted')).toBe(
        'No merkle root committed for this block range',
      );
    });

    it('should return unknown error for undefined errors', () => {
      expect(service.getErrorDetails('NonExistentError')).toBe('Unknown error');
    });
  });
});
