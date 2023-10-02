// SPDX-License-Identifier: Unlicensed
pragma solidity 0.8.18;

interface IWorkerRegistration {
  /// @return The number of active workers.
  function getActiveWorkerCount() external view returns (uint256);
  /// @return The effective TVL
  function effectiveTVL() external view returns (uint256);
  /// @return The ids of all worker created by the owner account
  function getOwnedWorkers(address who) external view returns (uint256[] memory);
}
