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

  function deposit(uint256 amount, uint256 currentEpoch) external {
    rewards.deposit(amount, currentEpoch, latestRewardEpoch);
  }

  function claimable(address staker) external view returns (uint256) {
    uint256 claimableReward = rewards.reward(staker, latestRewardEpoch);
    if (rewards.hasPendingTransitionRewards(staker)) {
      claimableReward += rewards.transitionReward(staker, latestRewardEpoch);
    }
    return claimableReward;
  }

  function claim() external returns (uint) {
    return rewards.claim(latestRewardEpoch);
  }
}

contract StakersRewardDistributionTest is Test {
  RewardsImplementation rewards;

  function setUp() public {
    rewards = new RewardsImplementation();
  }

  function assertPairClaimable(uint rewardA, uint rewardB) internal {
    assertEq(rewards.claimable(address(this)), rewardA);
    assertEq(rewards.claimable(address(1)), rewardB);
  }

  function test_RevertsWhen_NothingWasStakedInEpoch() public {
    vm.expectRevert("Nothing staked in this epoch");
    rewards.distribute(100);
  }

  function test_DistributeForOneStakerAndAllPreviousEpochsWereRewarded() public {
    rewards.deposit(100, 1);
    rewards.distribute(100);
    assertEq(rewards.claimable(address(this)), 100);
    rewards.distribute(200);
    assertEq(rewards.claimable(address(this)), 300);
  }

  function test_DistributeForTwoStakersAndAllPreviousEpochsWereRewarded() public {
    rewards.deposit(100, 1);
    hoax(address(1));
    rewards.deposit(200, 1);
    rewards.distribute(100);
    assertPairClaimable(33, 66);
    rewards.distribute(200);
    assertPairClaimable(99, 199);
  }

  function test_TwoDepositsFromSingleAccount() public {
    rewards.deposit(100, 1);
    hoax(address(1));
    rewards.deposit(200, 1);
    rewards.distribute(100);
    rewards.deposit(100, 2);

    assertPairClaimable(33, 66);
    rewards.distribute(100);
    assertPairClaimable(33 + 50, 66 + 50);
    rewards.distribute(100);
    assertPairClaimable(33 + 100, 66 + 100);
    rewards.distribute(100);
    assertPairClaimable(33 + 150, 66 + 150);
    rewards.distribute(100);
    assertPairClaimable(33 + 200, 66 + 200);
  }

  function test_SecondDepositForFutureEpoch() public {
    rewards.deposit(100, 1);
    hoax(address(1));
    rewards.deposit(200, 1);
    rewards.distribute(100);
    rewards.deposit(100, 5);
    assertPairClaimable(33, 66);
    rewards.distribute(100);
    assertPairClaimable(66, 133);
    rewards.distribute(100);
    assertPairClaimable(99, 199);
    rewards.distribute(100);
    assertPairClaimable(133, 266);
    // First reward since transition is completed
    rewards.distribute(100);
    assertPairClaimable(183, 316);
  }

  function test_RevertsWhen_DepositDuringTransition() public {
    rewards.deposit(100, 1);
    hoax(address(1));
    rewards.deposit(200, 1);
    rewards.distribute(100);
    rewards.deposit(100, 5);
    rewards.distribute(100);
    rewards.distribute(100);

    vm.expectRevert("Cannot deposit with pending transition");
    rewards.deposit(100, 7);

    rewards.distribute(100);

    vm.expectRevert("Cannot deposit with pending transition");
    rewards.deposit(100, 7);

    rewards.distribute(100);
    assertPairClaimable(183, 316);

    rewards.deposit(100, 7);
  }

  function test_ClaimsDuringTransition() public {
    rewards.deposit(100, 1);
    hoax(address(1));
    rewards.deposit(200, 1);
    rewards.distribute(100);
    rewards.deposit(100, 5);
    assertEq(rewards.claim(), 33);
    assertPairClaimable(0, 66);
    rewards.distribute(100);
    assertEq(rewards.claim(), 33);
    assertPairClaimable(0, 133);
    rewards.distribute(100);
    assertEq(rewards.claim(), 33);
    assertPairClaimable(0, 199);
    rewards.distribute(100);
    assertEq(rewards.claim(), 33);
    assertPairClaimable(0, 266);
    // First reward since transition is completed
    rewards.distribute(100);
    assertEq(rewards.claim(), 50);
    assertPairClaimable(0, 316);
    rewards.distribute(100);
    assertEq(rewards.claim(), 50);
    assertPairClaimable(0, 366);
  }

  function test_Claim() public {
    rewards.deposit(100, 1);
    hoax(address(1));
    rewards.deposit(200, 1);
    rewards.distribute(100);
    rewards.claim();
    assertEq(rewards.claimable(address(this)), 0);
    assertEq(rewards.claimable(address(1)), 66);
    rewards.distribute(100);
    assertEq(rewards.claimable(address(this)), 33);
    assertEq(rewards.claimable(address(1)), 133);
  }
}
