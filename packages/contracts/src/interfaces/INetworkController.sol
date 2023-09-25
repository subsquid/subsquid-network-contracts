// SPDX-License-Identifier: MIT
pragma solidity 0.8.18;

interface INetworkController {
  event EpochLengthUpdated(uint128 epochLength);
  event BondAmountUpdated(uint256 bondAmount);
  event StoragePerWorkerInGbUpdated(uint128 storagePerWorkerInGb);

  function epochLength() external view returns (uint128);

  function bondAmount() external view returns (uint256);

  function nextEpoch() external view returns (uint128);

  function epochNumber() external view returns (uint128);

  function storagePerWorkerInGb() external view returns (uint128);
}
