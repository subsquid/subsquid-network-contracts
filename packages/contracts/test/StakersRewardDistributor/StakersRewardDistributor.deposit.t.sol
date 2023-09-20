// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.18;

import "./StakersRewardDistributorTest.sol";

contract StakersRewardDistributionDepositTest is StakersRewardDistributionTest {
  function test_RevertsWhen_NothingWasStakedInEpoch() public {
    vm.expectRevert("Nothing staked");
    rewards.distribute(workers[0], 100);
  }

  function test_DistributeForOneStakerAndAllPreviousEpochsWereRewarded() public {
    rewards.deposit(workers[0], 100);
    rewards.distribute(workers[0], 100);
    assertEq(rewards.claimable(address(this)), 100);
    rewards.distribute(workers[0], 200);
    assertEq(rewards.claimable(address(this)), 300);
  }

  function test_DistributeForTwoStakersAndAllPreviousEpochsWereRewarded() public {
    rewards.deposit(workers[0], 100);
    hoax(address(1));
    rewards.deposit(workers[0], 200);
    rewards.distribute(workers[0], 100);
    assertPairClaimable(33, 66);
    rewards.distribute(workers[0], 200);
    assertPairClaimable(99, 199);
  }

  function test_TwoDepositsFromSingleAccount() public {
    rewards.deposit(workers[0], 100);
    hoax(address(1));
    rewards.deposit(workers[0], 200);
    rewards.distribute(workers[0], 100);

    rewards.deposit(workers[0], 100);
    assertPairClaimable(33, 66);

    rewards.distribute(workers[0], 100);
    assertPairClaimable(33 + 50, 66 + 50);

    rewards.distribute(workers[0], 100);
    assertPairClaimable(33 + 100, 66 + 100);

    rewards.distribute(workers[0], 100);
    assertPairClaimable(33 + 150, 66 + 150);

    rewards.distribute(workers[0], 100);
    assertPairClaimable(33 + 200, 66 + 200);
  }

  function test_Claim() public {
    rewards.deposit(workers[0], 100);
    hoax(address(1));
    rewards.deposit(workers[0], 200);
    rewards.distribute(workers[0], 100);

    rewards.claim(address(this));
    assertPairClaimable(0, 66);
    rewards.distribute(workers[0], 100);
    assertPairClaimable(33, 133);
  }

  function test_MultipleDepositsAndDistributions() public {
    rewards.deposit(workers[0], 100);
    hoax(address(1));
    rewards.deposit(workers[0], 200);
    rewards.distribute(workers[0], 100);

    assertPairClaimable(33, 66);
    rewards.deposit(workers[0], 300);
    hoax(address(1));
    rewards.deposit(workers[0], 200);
    assertPairClaimable(33, 66);
    rewards.distribute(workers[0], 200);
    assertPairClaimable(133, 166);
    hoax(address(1));
    rewards.deposit(workers[0], 200);
    rewards.deposit(workers[0], 200);
    assertPairClaimable(133, 166);

    rewards.distribute(workers[0], 300);
    assertPairClaimable(283, 316);

    rewards.distribute(workers[0], 300);
    assertPairClaimable(433, 466);

    rewards.distribute(workers[0], 300);
    assertPairClaimable(583, 616);
  }
}
