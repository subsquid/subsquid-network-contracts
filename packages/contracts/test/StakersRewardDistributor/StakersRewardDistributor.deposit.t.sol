// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.18;

import "./StakersRewardDistributorTest.sol";

contract StakersRewardDistributionDepositTest is StakersRewardDistributionTest {
  function test_RevertsWhen_NothingWasStakedInEpoch() public {
    vm.expectRevert("Nothing staked");
    rewards.distribute(100);
  }

  function test_firstDepositReturnsZero() public {
    assertEq(rewards.deposit(100), 0);
  }

  function test_DistributeForOneStakerAndAllPreviousEpochsWereRewarded() public {
    rewards.deposit(100);
    rewards.distribute(100);
    assertEq(rewards.claimable(address(this)), 100);
    rewards.distribute(200);
    assertEq(rewards.claimable(address(this)), 300);
  }

  function test_DistributeForTwoStakersAndAllPreviousEpochsWereRewarded() public {
    rewards.deposit(100);
    hoax(address(1));
    rewards.deposit(200);
    rewards.distribute(100);
    assertPairClaimable(33, 66);
    rewards.distribute(200);
    assertPairClaimable(99, 199);
  }

  function test_TwoDepositsFromSingleAccount() public {
    rewards.deposit(100);
    hoax(address(1));
    rewards.deposit(200);
    rewards.distribute(100);

    assertEq(rewards.deposit(100), 33);
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
    rewards.deposit(100);
    hoax(address(1));
    rewards.deposit(200);

    rewards.distribute(100);
    assertEq(rewards.deposit(100), 33);
    assertPairClaimable(0, 66);

    rewards.distribute(100);
    assertPairClaimable(50, 116);

    rewards.distribute(100);
    assertPairClaimable(100, 166);

    rewards.distribute(100);
    assertPairClaimable(150, 216);

    rewards.distribute(100);
    assertPairClaimable(200, 266);
  }

  function test_Claim() public {
    rewards.deposit(100);
    hoax(address(1));
    rewards.deposit(200);
    rewards.distribute(100);

    rewards.claim();
    assertPairClaimable(0, 66);
    rewards.distribute(100);
    assertPairClaimable(33, 133);
  }

  function test_MultipleDepositsAndDistributions() public {
    rewards.deposit(100);
    hoax(address(1));
    rewards.deposit(200);
    rewards.distribute(100);

    assertPairClaimable(33, 66);
    assertEq(rewards.deposit(300), 33);
    hoax(address(1));
    assertEq(rewards.deposit(200), 66);
    assertPairClaimable(0, 0);
    rewards.distribute(200);
    assertPairClaimable(100, 100);
    hoax(address(1));
    assertEq(rewards.deposit(200), 100);
    assertEq(rewards.deposit(200), 100);
    assertPairClaimable(0, 0);

    rewards.distribute(300);
    assertPairClaimable(150, 150);

    rewards.distribute(300);
    assertPairClaimable(300, 300);

    rewards.distribute(300);
    assertPairClaimable(450, 450);
  }
}
