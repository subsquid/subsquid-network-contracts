// SPDX-License-Identifier: UNLICENSED

pragma solidity 0.8.19;

interface IRewardCalculation {
  function currentApy(uint256 targetGb) external view returns (uint256);

  function boostFactor(uint256 duration) external pure returns (uint256);
}
