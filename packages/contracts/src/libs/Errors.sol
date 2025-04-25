pragma solidity 0.8.20;

/**
 * @title Errors
 * @notice Library containing all custom errors used throughout the contract system
 */
library Errors {
  // General errors
  error ZeroAddress();

  // Distributor related errors
  error DistributorAlreadyAdded();
  error DistributorDoesNotExist();
  error NoDistributorsAdded();
  error NotEnoughDistributorsToApprove();
  error NotACommitter();

  // Configuration errors
  error ApprovesRequiredMustBeGreaterThanZero();
  error ApprovesRequiredMustBeLessThanOrEqualToDistributorsCount();
  error WindowSizeMustBeGreaterThanZero();
  error WindowSizeMustBeLessThanOrEqualToDistributorsCount();
  error RoundRobinBlocksMustBeGreaterThanZero();

  // Merkle root related errors
  error MerkleRootCannotBeZero();
  error TotalLeavesCannotBeZero();
  error MerkleRootAlreadyCommitted();
  error MerkleRootNotCommitted();
  error MerkleRootMismatch();
  error AlreadyApproved();
  error AlreadyFullyApproved();
  error NotEnoughApprovals();

  // Batch related errors
  error ArrayLengthMismatch();
  error InvalidBatchId();
  error BatchAlreadyProcessed();
  error InvalidMerkleProof();

  // Reward related errors
  error WorkerDoesNotExist();
  error NoRewardsAvailable();
  error RewardTransferFailed();
}
