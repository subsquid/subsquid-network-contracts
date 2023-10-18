// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

interface INetworkController {
  event EpochLengthUpdated(uint128 epochLength);
  event BondAmountUpdated(uint256 bondAmount);
  event StoragePerWorkerInGbUpdated(uint128 storagePerWorkerInGb);

  /// @dev Amount of blocks in one epoch
  function epochLength() external view returns (uint128);

  /// @dev Amount of tokens required to register a worker
  function bondAmount() external view returns (uint256);

  /// @dev Block when next epoch starts
  function nextEpoch() external view returns (uint128);

  /// @dev Number of current epoch (starting from 0 when contract is deployed)
  function epochNumber() external view returns (uint128);

  /// @dev Amount of storage in GB each worker is expected to provide
  function storagePerWorkerInGb() external view returns (uint128);
}
