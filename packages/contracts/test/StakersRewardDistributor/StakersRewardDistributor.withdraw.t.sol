// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.18;

import "./StakersRewardDistributorTest.sol";

contract StakersRewardDistributionWithdrawTest is StakersRewardDistributionTest {
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
    rewards.withdraw(workers[0], 100);
    hoax(address(1));
    rewards.withdraw(workers[0], 200);
  }

  function test_MultipleDepositsAndWithdraws() public {
    rewards.deposit(workers[0], 100);
    hoax(address(1));
    rewards.deposit(workers[0], 200);
    rewards.distribute(workers[0], 100);
    rewards.withdraw(workers[0], 50);
    rewards.distribute(workers[0], 100);
    rewards.deposit(workers[0], 150);
    rewards.distribute(workers[0], 100);
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
}
