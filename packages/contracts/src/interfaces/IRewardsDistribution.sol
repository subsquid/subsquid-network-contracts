// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.18;

interface IRewardsDistribution {
  function claim(address worker) external returns (uint256 reward);
}
