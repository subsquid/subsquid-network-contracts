// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.19;

interface IRewardsDistribution {
  /// @dev Emitted when rewards are distributed for the range [fromBlock, toBlock]
  event Distributed(uint256 fromBlock, uint256 toBlock);
  /// @dev Emitted when rewards are claimed
  event Claimed(address indexed by, uint256 amount);

  /// @dev claim rewards for worker
  function claim(address worker) external returns (uint256 reward);

  /// @dev get currently claimable rewards for worker
  function claimable(address worker) external view returns (uint256 reward);
}
