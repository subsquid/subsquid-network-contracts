// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.18;

import "../../src/StakersRewardDistributor.sol";
import "forge-std/Test.sol";

contract RewardsImplementation {
  using StakersRewardDistributor for StakerRewards;

  StakerRewards rewards;

  function distribute(uint256 amount) external {
    rewards.distribute(amount);
  }

  function deposit(uint256 amount) external returns (uint256) {
    return rewards.deposit(amount);
  }

  function withdraw(uint256 amount) external returns (uint256) {
    return rewards.withdraw(amount);
  }

  function claimable(address staker) external view returns (uint256) {
    return rewards.reward(staker);
  }

  function claim() external returns (uint256) {
    return rewards.claim();
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
