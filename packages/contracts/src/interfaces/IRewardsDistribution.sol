// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

interface IRewardsDistribution {
  /// @dev Emitted when rewards are claimed
  event Claimed(address indexed by, uint256 indexed worker, uint256 amount);

  /// @dev claim rewards for worker
  function claim(address worker) external returns (uint256 reward);

  /// @dev get currently claimable rewards for worker
  function claimable(address worker) external view returns (uint256 reward);
}
