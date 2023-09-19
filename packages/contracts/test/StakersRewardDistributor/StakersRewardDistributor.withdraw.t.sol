// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.18;

import "./StakersRewardDistributorTest.sol";

contract StakersRewardDistributionWithdrawTest is StakersRewardDistributionTest {
  function test_RevertsIf_WithdrawingWithoutDeposit() public {
    vm.expectRevert("Insufficient staked amount");
    rewards.withdraw(100);
  }

  function test_RevertsIf_WithdrawingMoreThanStaked() public {
    rewards.deposit(100);
    rewards.distribute(100);
    vm.expectRevert("Insufficient staked amount");
    rewards.withdraw(200);
  }

  function test_SingleStakerWithdrawsAll() public {
    rewards.deposit(100);
    rewards.distribute(100);
    assertEq(rewards.withdraw(100), 100);
    assertEq(rewards.deposit(100), 0);
    assertEq(rewards.claimable(address(this)), 0);
    rewards.distribute(0);
    rewards.distribute(100);
    assertEq(rewards.claimable(address(this)), 100);
  }

  function test_TwoStakersWithdrawAll() public {
    rewards.deposit(100);
    hoax(address(1));
    rewards.deposit(200);
    rewards.distribute(100);
    assertEq(rewards.withdraw(100), 33);
    hoax(address(1));
    assertEq(rewards.withdraw(200), 66);
  }

  function test_MultipleDepositsAndWithdraws() public {
    rewards.deposit(100);
    hoax(address(1));
    rewards.deposit(200);
    rewards.distribute(100);
    assertEq(rewards.withdraw(50), 33);
    rewards.distribute(100);
    assertEq(rewards.deposit(150), 20);
    rewards.distribute(100);
    assertEq(rewards.withdraw(150), 50);
    rewards.distribute(100);
    assertPairClaimable(20, 276);
    rewards.distribute(100);
    assertPairClaimable(40, 356);
    rewards.distribute(100);
    assertPairClaimable(60, 436);
  }
}
