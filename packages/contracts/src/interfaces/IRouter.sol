// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "./IWorkerRegistration.sol";
import "./IStaking.sol";
import "./INetworkController.sol";
import "./IRewardCalculation.sol";

interface IRouter {
  function workerRegistration() external view returns (IWorkerRegistration);
  function staking() external view returns (IStaking);
  function rewardTreasury() external view returns (address);
  function networkController() external view returns (INetworkController);
  function rewardCalculation() external view returns (IRewardCalculation);
}
