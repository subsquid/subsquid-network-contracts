// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.19;

import "./StakersRewardDistributorTest.sol";

contract StakersRewardDistributionWithdrawTest is StakersRewardDistributionTest {
  function jumpToMomentWhenCanWithdraw(address staker) public {
    (, uint256 whenCanWithdraw) = rewards.getDeposit(staker, workers[0]);
    vm.roll(whenCanWithdraw);
  }

  function test_RevertsIf_WithdrawingWithoutDeposit() public {
    vm.expectRevert("Insufficient staked amount");
    rewards.withdraw(workers[0], 100);
  }

  function test_RevertsIf_WithdrawingMoreThanStaked() public {
    rewards.deposit(workers[0], 100);
    rewards.distribute(workers[0], 100);
    vm.expectRevert("Insufficient staked amount");
    rewards.withdraw(workers[0], 200);
  }

  function test_SingleStakerWithdrawsAll() public {
    rewards.deposit(workers[0], 100);
    rewards.distribute(workers[0], 100);
    jumpToMomentWhenCanWithdraw(address(this));
    rewards.withdraw(workers[0], 100);
    rewards.deposit(workers[0], 100);
    assertEq(rewards.claimable(address(this)), 100);
    rewards.distribute(workers[0], 0);
    rewards.distribute(workers[0], 100);
    assertEq(rewards.claimable(address(this)), 200);
  }

  function test_TwoStakersWithdrawAll() public {
    rewards.deposit(workers[0], 100);
    hoax(address(1));
    rewards.deposit(workers[0], 200);
    rewards.distribute(workers[0], 100);
    jumpToMomentWhenCanWithdraw(address(this));
    rewards.withdraw(workers[0], 100);
    hoax(address(1));
    rewards.withdraw(workers[0], 200);
  }

  function test_FullWithdrawRemovesStakerFromDelegatedTo() public {
    rewards.deposit(workers[0], 100);
    rewards.deposit(1337, 100);
    jumpToMomentWhenCanWithdraw(address(this));
    rewards.withdraw(workers[0], 50);
    assertEq(rewards.delegates(address(this)).length, 2);
    rewards.withdraw(workers[0], 50);
    assertEq(rewards.delegates(address(this)).length, 1);
  }

  function test_MultipleDepositsAndWithdraws() public {
    rewards.deposit(workers[0], 100);
    hoax(address(1));
    rewards.deposit(workers[0], 200);
    rewards.distribute(workers[0], 100);
    jumpToMomentWhenCanWithdraw(address(this));
    rewards.withdraw(workers[0], 50);
    rewards.distribute(workers[0], 100);
    rewards.deposit(workers[0], 150);
    rewards.distribute(workers[0], 100);
    jumpToMomentWhenCanWithdraw(address(this));
    rewards.withdraw(workers[0], 150);
    assertEq(rewards.claim(address(this)), 103);
    rewards.distribute(workers[0], 100);
    assertPairClaimable(20, 276);
    assertEq(rewards.claim(address(this)), 20);
    rewards.distribute(workers[0], 100);
    assertPairClaimable(20, 356);
    rewards.distribute(workers[0], 100);
    assertPairClaimable(40, 436);
  }

  function test_CannotWithdrawBeforeFullEpochEnds() public {
    network.setEpochLength(50);
    assertEq(network.nextEpoch(), 50);
    rewards.deposit(workers[0], 100);
    (, uint256 whenCanWithdraw) = rewards.getDeposit(address(this), workers[0]);
    assertEq(whenCanWithdraw, 100);
    rewards.distribute(workers[0], 50);
    vm.expectRevert("Too early to withdraw");
    rewards.withdraw(workers[0], 50);
    jumpToMomentWhenCanWithdraw(address(this));
    rewards.withdraw(workers[0], 50);
    rewards.deposit(workers[0], 100);
    assertEq(network.nextEpoch(), 150);
    (, whenCanWithdraw) = rewards.getDeposit(address(this), workers[0]);
    assertEq(whenCanWithdraw, 200);
  }
}
