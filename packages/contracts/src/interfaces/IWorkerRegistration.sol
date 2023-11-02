// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.19;

interface IWorkerRegistration {
  /// @dev emitted when a worker is registered
  event WorkerRegistered(
    uint256 indexed workerId, bytes indexed peerId, address indexed registrar, uint256 registeredAt
  );

  /// @dev emitted when a worker is deregistered
  event WorkerDeregistered(uint256 indexed workerId, address indexed account, uint256 deregistedAt);

  /// @dev emitted when the bond is withdrawn
  event WorkerWithdrawn(uint256 indexed workerId, address indexed account);

  /// @dev emitted when a excessive bond is withdrawn
  event ExcessiveBondReturned(uint256 indexed workerId, uint256 amount);

  /// @return The number of active workers.
  function getActiveWorkerCount() external view returns (uint256);
  /// @return The effective TVL
  function effectiveTVL() external view returns (uint256);
  /// @return The ids of all worker created by the owner account
  function getOwnedWorkers(address who) external view returns (uint256[] memory);
}
