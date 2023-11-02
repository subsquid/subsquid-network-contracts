// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.19;

interface IRewardsDistribution {
  event Distributed(uint256 fromBlock, uint256 toBlock);
  event Claimed(address indexed by, uint256 amount);

  /// @dev claim rewards for worker
  function claim(address worker) external returns (uint256 reward);

  /// @dev get currently claimable rewards for worker
  function claimable(address worker) external view returns (uint256 reward);
}
