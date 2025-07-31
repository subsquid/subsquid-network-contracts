import { Injectable } from '@nestjs/common';
import { decodeErrorResult, BaseError, ContractFunctionRevertedError } from 'viem';
import { Context } from '../common';

// Define all contract errors based on Errors.sol
const CONTRACT_ERRORS_ABI = [
  // General errors
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  
  // Distributor related errors
  { type: 'error', name: 'DistributorAlreadyAdded', inputs: [] },
  { type: 'error', name: 'DistributorDoesNotExist', inputs: [] },
  { type: 'error', name: 'NoDistributorsAdded', inputs: [] },
  { type: 'error', name: 'NotEnoughDistributorsToApprove', inputs: [] },
  { type: 'error', name: 'NotACommitter', inputs: [] },
  { type: 'error', name: 'ToBlockLessThanFromBlock', inputs: [] },
  { type: 'error', name: 'FutureBlock', inputs: [] },
  { type: 'error', name: 'InvalidMerkleRoot', inputs: [] },
  { type: 'error', name: 'NotAllBlocksCovered', inputs: [] },
  
  // Configuration errors
  { type: 'error', name: 'ApprovesRequiredMustBeGreaterThanZero', inputs: [] },
  { type: 'error', name: 'ApprovesRequiredMustBeLessThanOrEqualToDistributorsCount', inputs: [] },
  { type: 'error', name: 'WindowSizeMustBeGreaterThanZero', inputs: [] },
  { type: 'error', name: 'WindowSizeMustBeLessThanOrEqualToDistributorsCount', inputs: [] },
  { type: 'error', name: 'RoundRobinBlocksMustBeGreaterThanZero', inputs: [] },
  
  // Merkle root related errors
  { type: 'error', name: 'MerkleRootCannotBeZero', inputs: [] },
  { type: 'error', name: 'TotalLeavesCannotBeZero', inputs: [] },
  { type: 'error', name: 'MerkleRootAlreadyCommitted', inputs: [] },
  { type: 'error', name: 'MerkleRootNotCommitted', inputs: [] },
  { type: 'error', name: 'MerkleRootMismatch', inputs: [] },
  { type: 'error', name: 'AlreadyApproved', inputs: [] },
  { type: 'error', name: 'AlreadyFullyApproved', inputs: [] },
  { type: 'error', name: 'NotEnoughApprovals', inputs: [] },
  
  // Batch related errors
  { type: 'error', name: 'ArrayLengthMismatch', inputs: [] },
  { type: 'error', name: 'InvalidBatchId', inputs: [] },
  { type: 'error', name: 'BatchAlreadyProcessed', inputs: [] },
  { type: 'error', name: 'InvalidMerkleProof', inputs: [] },
  
  // Reward related errors
  { type: 'error', name: 'WorkerDoesNotExist', inputs: [] },
  { type: 'error', name: 'NoRewardsAvailable', inputs: [] },
  { type: 'error', name: 'RewardTransferFailed', inputs: [] },
  { type: 'error', name: 'CommitmentAlreadyCompleted', inputs: [] },
];

// Error descriptions for better logging
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

export interface DecodedError {
  errorName: string;
  description: string;
  signature: string;
  args?: readonly unknown[];
}

@Injectable()
export class ErrorDecoderService {
  /**
   * Decode a contract error from a viem BaseError
   */
  decodeContractError(error: BaseError, ctx?: Context): DecodedError | null {
    try {
      // Check if it's a contract revert error
      if (error instanceof ContractFunctionRevertedError) {
        const revertError = error.data;
        
        if (revertError?.errorName) {
          return {
            errorName: revertError.errorName,
            description: ERROR_DESCRIPTIONS[revertError.errorName] || 'Unknown error',
            signature: '',
            args: revertError.args,
          };
        }
      }

      // Try to extract error signature from the error message
      const signatureMatch = error.message.match(/0x[0-9a-fA-F]{8}/);
      if (!signatureMatch) {
        return null;
      }

      const signature = signatureMatch[0];
      
      // Try to decode using the ABI
      const decodedError = decodeErrorResult({
        abi: CONTRACT_ERRORS_ABI,
        data: signature as `0x${string}`,
      });

      if (decodedError) {
        return {
          errorName: decodedError.errorName,
          description: ERROR_DESCRIPTIONS[decodedError.errorName] || 'Unknown error',
          signature,
          args: decodedError.args,
        };
      }

      return null;
    } catch (decodeError) {
      ctx?.logger.debug(
        { error: decodeError, originalError: error },
        'Failed to decode contract error',
      );
      return null;
    }
  }

  /**
   * Format error message for logging or display
   */
  formatError(error: BaseError, ctx?: Context): string {
    const decoded = this.decodeContractError(error, ctx);
    
    if (decoded) {
      let message = `Contract Error: ${decoded.errorName} - ${decoded.description}`;
      if (decoded.args && decoded.args.length > 0) {
        message += ` (args: ${JSON.stringify(decoded.args)})`;
      }
      return message;
    }

    // If we can't decode it, return a generic message
    const signatureMatch = error.message.match(/0x[0-9a-fA-F]{8}/);
    if (signatureMatch) {
      return `Contract Error: Unknown error with signature ${signatureMatch[0]}. Check https://openchain.xyz/signatures?query=${signatureMatch[0]}`;
    }

    return error.message;
  }

  /**
   * Get error details for a specific error name
   */
  getErrorDetails(errorName: string): string {
    return ERROR_DESCRIPTIONS[errorName] || 'Unknown error';
  }

  /**
   * Check if an error is a specific contract error
   */
  isSpecificError(error: BaseError, errorName: string): boolean {
    const decoded = this.decodeContractError(error);
    return decoded?.errorName === errorName;
  }

  /**
   * Extract additional context from specific errors
   */
  getErrorContext(error: BaseError, ctx?: Context): Record<string, any> {
    const decoded = this.decodeContractError(error, ctx);
    
    if (!decoded) {
      return {};
    }

    // Provide specific context based on error type
    switch (decoded.errorName) {
      case 'NotAllBlocksCovered':
        return {
          hint: 'Check lastBlockRewarded on the contract and ensure fromBlock = lastBlockRewarded + 1',
          action: 'Query contract.lastBlockRewarded() to get the correct starting block',
        };
      
      case 'NotACommitter':
        return {
          hint: 'Current distributor is not eligible in the round-robin window',
          action: 'Check canCommit(address) to verify eligibility',
        };
      
      case 'MerkleRootAlreadyCommitted':
        return {
          hint: 'This block range already has a committed merkle root',
          action: 'Check if distribution should continue from a different block range',
        };
      
      case 'NotEnoughApprovals':
        return {
          hint: 'Wait for more distributors to approve the root before distributing',
          action: 'Check commitment approval count and required approvals',
        };
      
      case 'BatchAlreadyProcessed':
        return {
          hint: 'This batch has already been distributed',
          action: 'Skip this batch and continue with remaining batches',
        };
      
      default:
        return {};
    }
  }
}