// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "./StakersRewardDistributorTest.sol";

contract StakersRewardDistributionWithdrawTest is StakersRewardDistributionTest {
  function jumpToMomentWhenCanWithdraw(address staker) public {
    (, uint256 whenCanWithdraw) = staking.getDeposit(staker, workers[0]);
    vm.roll(whenCanWithdraw);
  }

  function test_RevertsIf_WithdrawingWithoutDeposit() public {
    vm.expectRevert("Insufficient staked amount");
    staking.withdraw(workers[0], 100);
  }

  function test_RevertsIf_WithdrawingMoreThanStaked() public {
    staking.deposit(workers[0], 100);
    staking.distribute(workers[0], 100);
    vm.expectRevert("Insufficient staked amount");
    staking.withdraw(workers[0], 200);
  }

  function test_SingleStakerWithdrawsAll() public {
    staking.deposit(workers[0], 100);
    staking.distribute(workers[0], 100);
    jumpToMomentWhenCanWithdraw(address(this));
    staking.withdraw(workers[0], 100);
    staking.deposit(workers[0], 100);
    assertEq(staking.claimable(address(this)), 100);
    staking.distribute(workers[0], 0);
    staking.distribute(workers[0], 100);
    assertEq(staking.claimable(address(this)), 200);
  }

  function test_TwoStakersWithdrawAll() public {
    staking.deposit(workers[0], 100);
    hoax(address(1));
    staking.deposit(workers[0], 200);
    staking.distribute(workers[0], 100);
    jumpToMomentWhenCanWithdraw(address(this));
    staking.withdraw(workers[0], 100);
    hoax(address(1));
    staking.withdraw(workers[0], 200);
  }

  function test_FullWithdrawRemovesStakerFromDelegatedTo() public {
    staking.deposit(workers[0], 100);
    staking.deposit(1337, 100);
    jumpToMomentWhenCanWithdraw(address(this));
    staking.withdraw(workers[0], 50);
    assertEq(staking.delegates(address(this)).length, 2);
    staking.withdraw(workers[0], 50);
    assertEq(staking.delegates(address(this)).length, 1);
  }

  function test_MultipleDepositsAndWithdraws() public {
    staking.deposit(workers[0], 100);
    hoax(address(1));
    staking.deposit(workers[0], 200);
    staking.distribute(workers[0], 100);
    jumpToMomentWhenCanWithdraw(address(this));
    staking.withdraw(workers[0], 50);
    staking.distribute(workers[0], 100);
    staking.deposit(workers[0], 150);
    staking.distribute(workers[0], 100);
    jumpToMomentWhenCanWithdraw(address(this));
    staking.withdraw(workers[0], 150);
    assertEq(staking.claim(address(this)), 103);
    staking.distribute(workers[0], 100);
    assertPairClaimable(20, 276);
    assertEq(staking.claim(address(this)), 20);
    staking.distribute(workers[0], 100);
    assertPairClaimable(20, 356);
    staking.distribute(workers[0], 100);
    assertPairClaimable(40, 436);
  }

  function test_CannotWithdrawBeforeFullEpochEnds() public {
    network.setEpochLength(50);
    assertEq(network.nextEpoch(), 50);
    staking.deposit(workers[0], 100);
    (, uint256 whenCanWithdraw) = staking.getDeposit(address(this), workers[0]);
    assertEq(whenCanWithdraw, 100);
    staking.distribute(workers[0], 50);
    vm.expectRevert("Too early to withdraw");
    staking.withdraw(workers[0], 50);
    jumpToMomentWhenCanWithdraw(address(this));
    staking.withdraw(workers[0], 50);
    staking.deposit(workers[0], 100);
    assertEq(network.nextEpoch(), 150);
    (, whenCanWithdraw) = staking.getDeposit(address(this), workers[0]);
    assertEq(whenCanWithdraw, 200);
  }
}
