// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.18;

interface IRewardsDistribution {
  event Claimed(address indexed by, uint256 amount);

  function claim(address worker) external returns (uint256 reward);
  function claimable(address worker) external view returns (uint256 reward);
}
