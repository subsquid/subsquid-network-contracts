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

  function test_CanClaimAfterWithdrawAll() public {
    staking.deposit(workers[0], 100);
    staking.distribute(workers[0], 100);
    jumpToMomentWhenCanWithdraw(address(this));
    staking.withdraw(workers[0], 100);
    assertEq(staking.claimable(address(this)), 100);
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
    network.setLockPeriod(50);
    assertEq(network.nextEpoch(), 5);
    staking.deposit(workers[0], 100);
    (, uint256 whenCanWithdraw) = staking.getDeposit(address(this), workers[0]);
    assertEq(whenCanWithdraw, 55);
    staking.distribute(workers[0], 50);
    vm.expectRevert("Too early to withdraw");
    staking.withdraw(workers[0], 50);
    jumpToMomentWhenCanWithdraw(address(this));
    staking.withdraw(workers[0], 50);
    staking.deposit(workers[0], 100);
    (, whenCanWithdraw) = staking.getDeposit(address(this), workers[0]);
    assertEq(network.nextEpoch(), 57);
    assertEq(whenCanWithdraw, 107);
  }

  // 2.5M gas for 100 distinct deposits
  function test_ClaimGasUsage() public {
    vm.mockCall(
      address(staking.router().workerRegistration()),
      abi.encodeWithSelector(IWorkerRegistration.isWorkerActive.selector),
      abi.encode(true)
    );

    staking.setMaxDelegations(100);
    for (uint256 i = 0; i < 100; i++) {
      staking.deposit(i, 100);
    }
    for (uint256 i = 0; i < 100; i++) {
      staking.distribute(i, 100 * i);
    }
    uint256 gasBefore = gasleft();
    staking.claim(address(this));
    uint256 gasAfter = gasleft();
    uint256 gasUsed = gasBefore - gasAfter;
    emit log_named_uint("gasUsed", gasUsed);
  }
}
