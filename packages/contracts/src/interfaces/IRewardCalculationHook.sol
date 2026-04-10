// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

interface IRewardCalculationHook {
  function onWorkerRegistered(uint256 workerId, uint128 activationBlock) external;

  function onWorkerDeregistered(uint256 workerId, uint128 deactivationBlock) external;

  function onDelegationWillChange(uint256 workerId, int256 delegationDelta) external;

  function syncWorkerLifecycle() external;
}
