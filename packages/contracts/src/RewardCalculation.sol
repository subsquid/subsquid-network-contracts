// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "@openzeppelin/contracts/utils/math/SafeCast.sol";

import "./interfaces/IRouter.sol";

/**
 * @title Reward Calculation Contract
 * @dev Contract that calculates rewards for workers and stakers
 * For more info, see https://github.com/subsquid/subsquid-network-contracts/wiki/Whitepaper#appendix-ii----rewards
 */
contract RewardCalculation is IRewardCalculation {
  using SafeCast for uint256;
  using SafeCast for int256;

  IRouter public immutable router;

  constructor(IRouter _router) {
    router = _router;
  }

  /// @dev APY based on target and actual storages
  /// smoothed base_apr function from [here](https://github.com/subsquid/subsquid-network-contracts/wiki/Whitepaper#reward-rate)
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
  function currentApy() public view returns (uint256) {
    return apy(
      router.networkController().targetCapacityGb(),
      router.workerRegistration().getActiveWorkerCount() * router.networkController().storagePerWorkerInGb()
    );
  }

  /// @return reword for an epoch that lasted epochLengthInSeconds seconds
  function epochReward(uint256 epochLengthInSeconds) public view returns (uint256) {
    return currentApy() * router.workerRegistration().effectiveTVL() * epochLengthInSeconds / 365 days / 10000;
  }

  /// @return bonus to allocations for the tokens staked by gateway
  /// @notice result is in basis points
  function boostFactor(uint256 duration) public pure returns (uint256) {
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
