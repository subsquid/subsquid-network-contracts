// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import "./WorkerRegistration.sol";
import "hardhat/console.sol";

contract RewardCalculation {
    WorkerRegistration public workerRegistration;

    constructor(WorkerRegistration _workerRegistration) {
        workerRegistration = _workerRegistration;
    }

    function apy(int256 target, int256 actual) public view returns (int256) {
        console.logInt(target);
        console.logInt(actual);
        int256 def = (target - actual) * 10000 / target;
        if (def >= 9000) {
            return 7000;
        }
        if (def >= 0) {
            return 2500 + def / 2;
        }
        int resultApy = 2000 + def / 20;
        if (resultApy < 0) {
            return 0;
        }
        return resultApy;
    }

    function currentApy(int256 targetGb) public view returns (int256) {
        return apy(targetGb, int(workerRegistration.getActiveWorkerCount() * workerRegistration.storagePerWorkerInGb()));
    }

    function epochReward(int256 targetGb) public view returns (int256) {
        return currentApy(targetGb) * int(workerRegistration.effectiveTVL()) / 10000;
    }
}
