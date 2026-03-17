import { Injectable } from '@nestjs/common';
import {
  decodeErrorResult,
  BaseError,
  ContractFunctionRevertedError,
} from 'viem';
import { Context } from '../common';

const CONTRACT_ERRORS_ABI = [
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  { type: 'error', name: 'DistributorAlreadyAdded', inputs: [] },
  { type: 'error', name: 'DistributorDoesNotExist', inputs: [] },
  { type: 'error', name: 'NoDistributorsAdded', inputs: [] },
  { type: 'error', name: 'NotEnoughDistributorsToApprove', inputs: [] },
  { type: 'error', name: 'NotACommitter', inputs: [] },
  { type: 'error', name: 'ToBlockLessThanFromBlock', inputs: [] },
  { type: 'error', name: 'FutureBlock', inputs: [] },
  { type: 'error', name: 'InvalidMerkleRoot', inputs: [] },
  { type: 'error', name: 'NotAllBlocksCovered', inputs: [] },
  { type: 'error', name: 'ApprovesRequiredMustBeGreaterThanZero', inputs: [] },
  { type: 'error', name: 'ApprovesRequiredMustBeLessThanOrEqualToDistributorsCount', inputs: [] },
  { type: 'error', name: 'WindowSizeMustBeGreaterThanZero', inputs: [] },
  { type: 'error', name: 'WindowSizeMustBeLessThanOrEqualToDistributorsCount', inputs: [] },
  { type: 'error', name: 'RoundRobinBlocksMustBeGreaterThanZero', inputs: [] },
  { type: 'error', name: 'MerkleRootCannotBeZero', inputs: [] },
  { type: 'error', name: 'TotalLeavesCannotBeZero', inputs: [] },
  { type: 'error', name: 'MerkleRootAlreadyCommitted', inputs: [] },
  { type: 'error', name: 'MerkleRootNotCommitted', inputs: [] },
  { type: 'error', name: 'MerkleRootMismatch', inputs: [] },
  { type: 'error', name: 'AlreadyApproved', inputs: [] },
  { type: 'error', name: 'AlreadyFullyApproved', inputs: [] },
  { type: 'error', name: 'NotEnoughApprovals', inputs: [] },
  { type: 'error', name: 'ArrayLengthMismatch', inputs: [] },
  { type: 'error', name: 'InvalidBatchId', inputs: [] },
  { type: 'error', name: 'BatchAlreadyProcessed', inputs: [] },
  { type: 'error', name: 'InvalidMerkleProof', inputs: [] },
  { type: 'error', name: 'WorkerDoesNotExist', inputs: [] },
  { type: 'error', name: 'NoRewardsAvailable', inputs: [] },
  { type: 'error', name: 'RewardTransferFailed', inputs: [] },
  { type: 'error', name: 'CommitmentAlreadyCompleted', inputs: [] },
] as const;

const ERROR_DESCRIPTIONS: Record<string, string> = {
  ZeroAddress: 'Provided address is zero address',
  DistributorAlreadyAdded: 'Distributor already exists in the system',
  DistributorDoesNotExist: 'Distributor not found in the system',
  NoDistributorsAdded: 'No distributors have been added to the system',
  NotEnoughDistributorsToApprove: 'Not enough distributors to meet approval requirements',
  NotACommitter: 'Sender is not eligible to commit in current round-robin window',
  ToBlockLessThanFromBlock: 'End block must be greater than start block',
  FutureBlock: 'Cannot commit rewards for future blocks',
  InvalidMerkleRoot: 'Merkle root cannot be zero',
  NotAllBlocksCovered: 'Block range does not start from lastBlockRewarded + 1',
  ApprovesRequiredMustBeGreaterThanZero: 'At least one approval is required',
  ApprovesRequiredMustBeLessThanOrEqualToDistributorsCount: 'Cannot require more approvals than distributors',
  WindowSizeMustBeGreaterThanZero: 'Window size must be at least 1',
  WindowSizeMustBeLessThanOrEqualToDistributorsCount: 'Window size cannot exceed distributor count',
  RoundRobinBlocksMustBeGreaterThanZero: 'Round robin blocks must be positive',
  MerkleRootCannotBeZero: 'Merkle root cannot be zero',
  TotalLeavesCannotBeZero: 'Must have at least one batch',
  MerkleRootAlreadyCommitted: 'Merkle root already committed for this block range',
  MerkleRootNotCommitted: 'No merkle root committed for this block range',
  MerkleRootMismatch: 'Provided merkle root does not match committed root',
  AlreadyApproved: 'Distributor has already approved this root',
  AlreadyFullyApproved: 'Root already has all required approvals',
  NotEnoughApprovals: 'Not enough approvals to distribute',
  ArrayLengthMismatch: 'Arrays must have the same length',
  InvalidBatchId: 'Batch ID exceeds total batches',
  BatchAlreadyProcessed: 'Batch has already been distributed',
  InvalidMerkleProof: 'Merkle proof verification failed',
  WorkerDoesNotExist: 'Worker not found in registration',
  NoRewardsAvailable: 'No rewards available to claim',
  RewardTransferFailed: 'Reward transfer failed',
  CommitmentAlreadyCompleted: 'Cannot modify a completed commitment',
};

const ERROR_CONTEXT: Record<string, { hint: string; action: string }> = {
  NotAllBlocksCovered: {
    hint: 'Check lastBlockRewarded on the contract and ensure fromBlock = lastBlockRewarded + 1',
    action: 'Query contract.lastBlockRewarded() to get the correct starting block',
  },
  NotACommitter: {
    hint: 'Current distributor is not eligible in the round-robin window',
    action: 'Check canCommit(address) to verify eligibility',
  },
  MerkleRootAlreadyCommitted: {
    hint: 'This block range already has a committed merkle root',
    action: 'Check if distribution should continue from a different block range',
  },
  NotEnoughApprovals: {
    hint: 'Wait for more distributors to approve the root before distributing',
    action: 'Check commitment approval count and required approvals',
  },
  BatchAlreadyProcessed: {
    hint: 'This batch has already been distributed',
    action: 'Skip this batch and continue with remaining batches',
  },
};

const MANUAL_SIG_MAP: Record<string, { name: string; description: string }> = {
  '0x08c379a0': { name: 'Error(string)', description: 'reverted with reason string' },
  '0x4e487b71': { name: 'Panic(uint256)', description: 'panic' },
  '0xe2517d3f': { name: 'InvalidMerkleProof', description: 'merkle proof verification failed' },
};

export interface DecodedError {
  errorName: string;
  description: string;
  signature: string;
  args?: readonly unknown[];
}

@Injectable()
export class ErrorDecoderService {
  decodeContractError(error: BaseError, ctx?: Context): DecodedError | null {
    try {
      if (error instanceof ContractFunctionRevertedError && error.data?.errorName) {
        return {
          errorName: error.data.errorName,
          description: ERROR_DESCRIPTIONS[error.data.errorName] || 'Unknown error',
          signature: '',
          args: error.data.args,
        };
      }

      const signatureMatch = error.message.match(/0x[0-9a-fA-F]{8}/);
      if (!signatureMatch) return null;

      const signature = signatureMatch[0];
      const manual = MANUAL_SIG_MAP[signature];
      if (manual) {
        return { errorName: manual.name, description: manual.description, signature };
      }

      const decoded = decodeErrorResult({
        abi: CONTRACT_ERRORS_ABI,
        data: signature as `0x${string}`,
      });

      if (decoded) {
        return {
          errorName: decoded.errorName,
          description: ERROR_DESCRIPTIONS[decoded.errorName] || 'Unknown error',
          signature,
          args: decoded.args,
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  formatError(error: BaseError, ctx?: Context): string {
    const decoded = this.decodeContractError(error, ctx);

    if (decoded) {
      let message = `Contract Error: ${decoded.errorName} - ${decoded.description}`;
      if (decoded.args && decoded.args.length > 0) {
        message += ` (args: ${JSON.stringify(decoded.args)})`;
      }
      return message;
    }

    const signatureMatch = error.message.match(/0x[0-9a-fA-F]{8}/);
    if (signatureMatch) {
      return `Contract Error: Unknown error with signature ${signatureMatch[0]}. Check https://openchain.xyz/signatures?query=${signatureMatch[0]}`;
    }

    return error.message;
  }

  getErrorDetails(errorName: string): string {
    return ERROR_DESCRIPTIONS[errorName] || 'Unknown error';
  }

  isSpecificError(error: BaseError, errorName: string): boolean {
    return this.decodeContractError(error)?.errorName === errorName;
  }

  getErrorContext(error: BaseError, ctx?: Context): Record<string, any> {
    const decoded = this.decodeContractError(error, ctx);
    if (!decoded) return {};
    return ERROR_CONTEXT[decoded.errorName] || {};
  }
}
