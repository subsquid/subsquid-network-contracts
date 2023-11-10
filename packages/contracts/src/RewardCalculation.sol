// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.19;

import "@openzeppelin/contracts/utils/Math/SafeCast.sol";

import "./interfaces/IWorkerRegistration.sol";
import "./interfaces/INetworkController.sol";

/**
 * @title Reward Calculation Contract
 * @dev Contract that calculates rewards for workers and stakers
 * For more info, see https://github.com/subsquid/subsquid-network-contracts/wiki/Whitepaper#appendix-ii----rewards
 */
contract RewardCalculation {
  using SafeCast for uint256;
  using SafeCast for int256;

  IWorkerRegistration public immutable workerRegistration;
  INetworkController public immutable networkController;

  constructor(IWorkerRegistration _workerRegistration, INetworkController _networkController) {
    workerRegistration = _workerRegistration;
    networkController = _networkController;
  }

  /// @dev APY based on target and actual storages
  /// smothed base_apr function from [here](https://github.com/subsquid/subsquid-network-contracts/wiki/Whitepaper#reward-rate)
  function apy(uint256 target, uint256 actual) public pure returns (uint256) {
    int256 uRate = (target.toInt256() - actual.toInt256()) * 10000 / target.toInt256();
    if (uRate >= 9000) {
      return 7000;
    }
    if (uRate >= 0) {
      return 2500 + uRate.toUint256() / 2;
    }
    int256 resultApy = 2000 + uRate / 20;
    if (resultApy < 0) {
      return 0;
    }
    return resultApy.toUint256();
  }

  /// @return current APY for a worker with targetGb storage
  function currentApy(uint256 targetGb) public view returns (uint256) {
    return apy(targetGb, workerRegistration.getActiveWorkerCount() * networkController.storagePerWorkerInGb());
  }

  /// @return reword for an epoch that lasted epochLengthInSeconds seconds
  function epochReward(uint256 targetGb, uint256 epochLengthInSeconds) public view returns (uint256) {
    return currentApy(targetGb) * workerRegistration.effectiveTVL() * epochLengthInSeconds / 365 days / 10000;
  }
}
