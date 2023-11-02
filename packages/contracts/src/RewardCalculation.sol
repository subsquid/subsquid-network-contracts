// SPDX-License-Identifier: MIT
pragma solidity 0.8.18;

import "./interfaces/IRouter.sol";

/**
 * @title Reward Calculation Contract
 * @dev Contract that calculates rewards for workers and stakers
 * For more info, see https://github.com/subsquid/subsquid-network-contracts/wiki/Whitepaper#appendix-ii----rewards
 */
contract RewardCalculation {
  uint256 internal constant year = 365 days;

  IRouter public immutable router;

  constructor(IRouter _router) {
    router = _router;
  }

  /// @dev APY based on target and actual storages
  /// smothed base_apr function from [here](https://github.com/subsquid/subsquid-network-contracts/wiki/Whitepaper#reward-rate)
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
    return apy(targetGb, router.workerRegistration().getActiveWorkerCount() * router.networkController().storagePerWorkerInGb());
  }

  /// @return reword for an epoch that lasted epochLengthInSeconds seconds
  function epochReward(uint256 targetGb, uint256 epochLengthInSeconds) public view returns (uint256) {
    return currentApy(targetGb) * router.workerRegistration().effectiveTVL() * epochLengthInSeconds / year / 10000;
  }
}
