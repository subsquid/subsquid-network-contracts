// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import "./WorkerRegistration.sol";

contract RewardCalculation {
  WorkerRegistration public workerRegistration;
  uint256 year = 365 days;

  constructor(WorkerRegistration _workerRegistration) {
    workerRegistration = _workerRegistration;
  }

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

  function currentApy(uint256 targetGb) public view returns (uint256) {
    return apy(targetGb, workerRegistration.getActiveWorkerCount() * workerRegistration.storagePerWorkerInGb());
  }

  function epochReward(uint256 targetGb) public view returns (uint256) {
    return currentApy(targetGb) * workerRegistration.effectiveTVL() * workerRegistration.epochLength() / year / 10000;
  }
}
