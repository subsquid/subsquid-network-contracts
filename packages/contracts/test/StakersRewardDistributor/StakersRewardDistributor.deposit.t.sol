// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "./StakersRewardDistributorTest.sol";

contract StakersRewardDistributionDepositTest is StakersRewardDistributionTest {
  function test_NothingWasStakedInEpoch() public {
    // should not revert
    staking.distribute(workers[0], 100);
  }

  function test_RevertsIf_NoDistributionsFor2Epochs() public {
    vm.roll(10);
    staking.deposit(workers[0], 100);
    staking.distribute(workers[0], 100);
    vm.roll(20);
    vm.expectRevert("Rewards out of date");
    staking.deposit(workers[0], 100);
  }

  function test_RevertsIf_StakingMoreThanLimit() public {
    staking.deposit(workers[0], 10);
    uint256 limit = network.delegationLimit();
    vm.expectRevert("Delegation limit exceeded");
    staking.deposit(workers[0], limit);
  }

  function test_DistributeForOneStakerAndAllPreviousEpochsWereRewarded() public {
    staking.deposit(workers[0], 100);
    staking.distribute(workers[0], 100);
    assertEq(staking.claimable(address(this)), 100);
    staking.distribute(workers[0], 200);
    assertEq(staking.claimable(address(this)), 300);
  }

  function test_DistributeForTwoStakersAndAllPreviousEpochsWereRewarded() public {
    staking.deposit(workers[0], 100);
    hoax(address(1));
    staking.deposit(workers[0], 200);
    staking.distribute(workers[0], 100);
    assertPairClaimable(33, 66);
    staking.distribute(workers[0], 200);
    assertPairClaimable(99, 199);
  }

  function test_TwoDepositsFromSingleAccount() public {
    staking.deposit(workers[0], 100);
    hoax(address(1));
    staking.deposit(workers[0], 200);
    staking.distribute(workers[0], 100);

    staking.deposit(workers[0], 100);
    assertPairClaimable(33, 66);

    staking.distribute(workers[0], 100);
    assertPairClaimable(33 + 50, 66 + 50);

    staking.distribute(workers[0], 100);
    assertPairClaimable(33 + 100, 66 + 100);

    staking.distribute(workers[0], 100);
    assertPairClaimable(33 + 150, 66 + 150);

    staking.distribute(workers[0], 100);
    assertPairClaimable(33 + 200, 66 + 200);
  }

  function test_DepositAddsWorkedToDelegatedList() public {
    assertEq(staking.delegates(address(this)).length, 0);
    staking.deposit(workers[0], 200);
    assertEq(staking.delegates(address(this)).length, 1);
    assertEq(staking.delegates(address(this))[0], workers[0]);
    staking.deposit(1337, 200);
    assertEq(staking.delegates(address(this)).length, 2);
    assertEq(staking.delegates(address(this))[0], workers[0]);
    assertEq(staking.delegates(address(this))[1], 1337);

    staking.deposit(workers[0], 200);
    assertEq(staking.delegates(address(this)).length, 2);
    assertEq(staking.delegates(address(this))[0], workers[0]);
    assertEq(staking.delegates(address(this))[1], 1337);
  }

  function test_Claim() public {
    staking.deposit(workers[0], 100);
    hoax(address(1));
    staking.deposit(workers[0], 200);
    staking.distribute(workers[0], 100);

    staking.claim(address(this));
    assertPairClaimable(0, 66);
    staking.distribute(workers[0], 100);
    assertPairClaimable(33, 133);
  }

  function test_MultipleDepositsAndDistributions() public {
    staking.deposit(workers[0], 100);
    hoax(address(1));
    staking.deposit(workers[0], 200);
    staking.distribute(workers[0], 100);

    assertPairClaimable(33, 66);
    staking.deposit(workers[0], 300);
    hoax(address(1));
    staking.deposit(workers[0], 200);
    assertPairClaimable(33, 66);
    staking.distribute(workers[0], 200);
    assertPairClaimable(133, 166);
    hoax(address(1));
    staking.deposit(workers[0], 200);
    staking.deposit(workers[0], 200);
    assertPairClaimable(133, 166);

    staking.distribute(workers[0], 300);
    assertPairClaimable(283, 316);

    staking.distribute(workers[0], 300);
    assertPairClaimable(433, 466);

    staking.distribute(workers[0], 300);
    assertPairClaimable(583, 616);
  }
}
