// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

interface INetworkController {
  /// @dev Emitted when epoch length is updated
  event EpochLengthUpdated(uint128 epochLength);
  /// @dev Emitted when bond amount is updated
  event BondAmountUpdated(uint256 bondAmount);
  /// @dev Emitted when storage per worker is updated
  event StoragePerWorkerInGbUpdated(uint128 storagePerWorkerInGb);
  event DelegationLimitCoefficientInBPUpdated(uint256 newDelegationLimitCoefficientInBP);
  event AllowedVestedTargetUpdated(address target, bool isAllowed);
  event TargetCapacityUpdated(uint256 target);

  /// @dev Amount of blocks in one epoch
  function epochLength() external view returns (uint128);

  /// @dev Max total worker delegation amount
  function delegationLimit() external view returns (uint256);

  /// @dev Amount of tokens required to register a worker
  function bondAmount() external view returns (uint256);

  /// @dev Block when next epoch starts
  function nextEpoch() external view returns (uint128);

  /// @dev Number of current epoch (starting from 0 when contract is deployed)
  function epochNumber() external view returns (uint128);

  /// @dev Number of current epoch (starting from 0 when contract is deployed)
  function targetCapacityGb() external view returns (uint256);

  /// @dev Amount of storage in GB each worker is expected to provide
  function storagePerWorkerInGb() external view returns (uint128);

  /// @dev Can the `target` be used as a called by the vesting contract
  function isAllowedVestedTarget(address target) external view returns (bool);
}
