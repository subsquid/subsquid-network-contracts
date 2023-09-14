// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.18;

import "./StakersRewardDistributorTest.sol";

contract StakersRewardDistributionDepositTest is StakersRewardDistributionTest {
  function test_RevertsWhen_NothingWasStakedInEpoch() public {
    vm.expectRevert("Nothing staked in this epoch");
    rewards.distribute(100);
  }

  function test_firstDepositReturnsZero() public {
    assertEq(rewards.deposit(100, 1), 0);
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

    assertEq(rewards.deposit(100, 2), 33);
    assertPairClaimable(0, 66);

    rewards.distribute(100);
    assertPairClaimable(50, 66 + 50);

    rewards.distribute(100);
    assertPairClaimable(100, 66 + 100);

    rewards.distribute(100);
    assertPairClaimable(150, 66 + 150);

    rewards.distribute(100);
    assertPairClaimable(200, 66 + 200);
  }

  function test_SecondDepositForFutureEpoch() public {
    rewards.deposit(100, 1);
    hoax(address(1));
    rewards.deposit(200, 1);

    rewards.distribute(100);
    assertEq(rewards.deposit(100, 5), 33);
    assertPairClaimable(0, 66);

    rewards.distribute(100);
    assertPairClaimable(33, 133);

    rewards.distribute(100);
    assertPairClaimable(66, 199);

    rewards.distribute(100);
    assertPairClaimable(99, 266);

    // First reward since transition is completed
    rewards.distribute(100);
    assertPairClaimable(149, 316);
  }

  function test_RevertsWhen_DepositDuringTransition() public {
    rewards.deposit(100, 1);
    hoax(address(1));
    rewards.deposit(200, 1);
    rewards.distribute(100);

    assertEq(rewards.deposit(100, 5), 33);
    rewards.distribute(100);
    rewards.distribute(100);

    vm.expectRevert("Cannot deposit with pending transition");
    rewards.deposit(100, 7);

    rewards.distribute(100);

    vm.expectRevert("Cannot deposit with pending transition");
    rewards.deposit(100, 7);

    rewards.distribute(100);
    assertPairClaimable(149, 316);

    rewards.deposit(100, 7);
  }

  function test_Claim() public {
    rewards.deposit(100, 1);
    hoax(address(1));
    rewards.deposit(200, 1);
    rewards.distribute(100);

    rewards.claim();
    assertPairClaimable(0, 66);
    rewards.distribute(100);
    assertPairClaimable(33, 133);
  }

  function test_ClaimsDuringTransition() public {
    rewards.deposit(100, 1);
    hoax(address(1));
    rewards.deposit(200, 1);
    rewards.distribute(100);

    assertEq(rewards.deposit(100, 5), 33);
    assertEq(rewards.claim(), 0);
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

  function test_MultipleDepositsAndDistributions() public {
    rewards.deposit(100, 1);
    hoax(address(1));
    rewards.deposit(200, 1);
    rewards.distribute(100);

    assertPairClaimable(33, 66);
    assertEq(rewards.deposit(300, 2), 33);
    hoax(address(1));
    assertEq(rewards.deposit(200, 2), 66);
    assertPairClaimable(0, 0);
    rewards.distribute(200);
    assertPairClaimable(100, 100);
    assertEq(rewards.deposit(200, 5), 100);
    hoax(address(1));
    assertEq(rewards.deposit(200, 4), 100);
    assertPairClaimable(0, 0);

    rewards.distribute(300);
    assertPairClaimable(150, 150);

    rewards.distribute(300);
    assertPairClaimable(270, 330);

    rewards.distribute(300);
    assertPairClaimable(420, 480);
  }
}
