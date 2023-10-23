// SPDX-License-Identifier: MIT
pragma solidity 0.8.18;

import "./interfaces/IWorkerRegistration.sol";
import "./interfaces/INetworkController.sol";

/**
 * @title Reward Calculation Contract
 * @dev Contract that calculates rewards for workers and stakers
 * For more info, see https://github.com/subsquid/subsquid-network-contracts/wiki/Whitepaper#appendix-ii----rewards
 */
contract RewardCalculation {
  uint256 internal constant year = 365 days;

  IWorkerRegistration public immutable workerRegistration;
  INetworkController public immutable networkController;


  constructor(IWorkerRegistration _workerRegistration, INetworkController _networkController) {
    workerRegistration = _workerRegistration;
    networkController = _networkController;
  }

  /// @dev APY based on target and actual storages
  /// smoothed base_apr function from [here](https://github.com/subsquid/subsquid-network-contracts/wiki/Whitepaper#reward-rate)
  function apy(uint256 target, uint256 actual) public pure returns (uint256) {
    int256 def = (int256(target) - int256(actual)) * 10000 / int256(target);
    if (def >= 9000) {
      return 7000;
    }
    if (def >= 0) {
      return 2500 + uint256(def) / 2;
    }
    int256 resultApy = 2000 + def / 20;
    if (resultApy < 0) {
      return 0;
    }
    return uint256(resultApy);
  }

  /// @return current APY for a worker with targetGb storage
  function currentApy(uint256 targetGb) public view returns (uint256) {
    return apy(targetGb, workerRegistration.getActiveWorkerCount() * networkController.storagePerWorkerInGb());
  }

  /// @return reword for an epoch that lasted epochLengthInSeconds seconds
  function epochReward(uint256 targetGb, uint256 epochLengthInSeconds) public view returns (uint256) {
    return currentApy(targetGb) * workerRegistration.effectiveTVL() * epochLengthInSeconds / year / 10000;
  }

  function boostFactor(uint256 duration) public pure returns (uint) {
    if (duration < 60 days) {
      return 10000;
    }
    if (duration < 180 days) {
      return 10000 + (duration - 30 days) / 30 days * 2000;
    }
    if (duration < 360 days) {
      return 20000;
    }
    if (duration < 720 days) {
      return 25000;
    }
    return 30000;
  }
}
