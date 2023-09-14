// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.18;

import "../../src/StakersRewardDistributor.sol";
import "forge-std/Test.sol";

contract RewardsImplementation {
  using StakersRewardDistributor for StakerRewards;

  StakerRewards rewards;
  uint256 latestRewardEpoch;

  function distribute(uint256 amount) external {
    latestRewardEpoch++;
    rewards.distribute(amount, latestRewardEpoch);
  }

  function deposit(uint256 amount, uint256 currentEpoch) external returns (uint256) {
    return rewards.deposit(amount, currentEpoch, latestRewardEpoch);
  }

  function withdraw(uint256 amount, uint256 currentEpoch) external returns (uint256) {
    return rewards.withdraw(amount, currentEpoch, latestRewardEpoch);
  }

  function claimable(address staker) external view returns (uint256) {
    uint256 claimableReward = rewards.reward(staker, latestRewardEpoch);
    if (rewards.hasPendingTransitionRewards(staker)) {
      claimableReward += rewards.transitionReward(staker, latestRewardEpoch);
    }
    return claimableReward;
  }

  function claim() external returns (uint256) {
    return rewards.claim(latestRewardEpoch);
  }
}

contract StakersRewardDistributionTest is Test {
  RewardsImplementation rewards;

  function setUp() public {
    rewards = new RewardsImplementation();
  }

  function assertPairClaimable(uint256 rewardA, uint256 rewardB) internal {
    assertEq(rewards.claimable(address(this)), rewardA);
    assertEq(rewards.claimable(address(1)), rewardB);
  }
}
