// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.18;

import "forge-std/Test.sol";
import "./StakersRewardDistributorTest.sol";

contract StakersRewardDistributionWithdrawTest is StakersRewardDistributionTest {
  function test_RevertsIf_WithdrawingWithoutDeposit() public {
    vm.expectRevert("Insufficient staked amount");
    rewards.withdraw(100, 1);
  }

  function test_RevertsIf_WithdrawingMoreThanStaked() public {
    rewards.deposit(100, 1);
    rewards.distribute(100);
    vm.expectRevert("Insufficient staked amount");
    rewards.withdraw(200, 2);
  }

  function test_RevertsIf_WithdrawingDuringTransition() public {
    rewards.deposit(100, 2);
    vm.expectRevert("Cannot withdraw with pending transition");
    rewards.withdraw(100, 2);
    vm.expectRevert("Cannot withdraw with pending transition");
    rewards.withdraw(100, 3);
  }

  function test_SingleStakerWithdrawsAll() public {
    rewards.deposit(100, 1);
    rewards.distribute(100);
    assertEq(rewards.withdraw(100, 2), 100);
    assertEq(rewards.deposit(100, 3), 0);
    assertEq(rewards.claimable(address(this)), 0);
    rewards.distribute(0);
    rewards.distribute(100);
    assertEq(rewards.claimable(address(this)), 100);
  }

  function test_WithdrawFurtherInFuture() public {
    assertEq(rewards.claimable(address(this)), 0);
    rewards.deposit(100, 1);
    hoax(address(1));
    rewards.deposit(200, 1);
    rewards.distribute(100);
    assertEq(rewards.withdraw(100, 4), 33);
    assertEq(rewards.claimable(address(this)), 0);
    rewards.distribute(100);
    assertPairClaimable(33, 133);
    rewards.distribute(100);
    assertPairClaimable(66, 199);
    rewards.distribute(100);
    assertPairClaimable(66, 299);
    rewards.distribute(100);
    assertPairClaimable(66, 399);
  }

  function test_RevertsIfDepositAfterWithdraw() public {
    rewards.deposit(100, 1);
    rewards.distribute(100);
    assertEq(rewards.withdraw(100, 6), 100);
    vm.expectRevert("Current epoch is in the past");
    rewards.deposit(100, 3);
  }

  function test_TwoStakersWithdrawAll() public {
    rewards.deposit(100, 1);
    hoax(address(1));
    rewards.deposit(200, 1);
    rewards.distribute(100);
    assertEq(rewards.withdraw(100, 2), 33);
    hoax(address(1));
    assertEq(rewards.withdraw(200, 2), 66);
  }

  function test_MultipleDepositsAndWithdraws() public {
    rewards.deposit(100, 1);
    hoax(address(1));
    rewards.deposit(200, 1);
    rewards.distribute(100);
    assertEq(rewards.withdraw(50, 2), 33);
    rewards.distribute(100);
    assertEq(rewards.deposit(150, 3), 20);
    rewards.distribute(100);
    assertEq(rewards.withdraw(150, 6), 50);
    rewards.distribute(100);
    assertEq(rewards.claimable(address(this)), 50);
    rewards.distribute(100);
    assertEq(rewards.claimable(address(this)), 100);

    vm.expectRevert("Cannot withdraw with pending transition");
    rewards.withdraw(10, 7);

    rewards.distribute(100);
    assertEq(rewards.claimable(address(this)), 120);
  }
}
