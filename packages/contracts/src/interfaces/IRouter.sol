// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.18;

import "./IWorkerRegistration.sol";
import "./IStaking.sol";
import "./INetworkController.sol";

interface IRouter {
  function workerRegistration() external view returns (IWorkerRegistration);
  function staking() external view returns (IStaking);
  function rewardTreasury() external view returns (address);
  function networkController() external view returns (INetworkController);
}
