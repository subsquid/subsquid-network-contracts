// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.16;

import "./WorkerRegistration.t.sol";

contract WorkerRegistrationUnstakeTest is WorkerRegistrationTest {
  address delegator = address(876);
  uint256 stakeAmount = 1000;

  function testRevertsForNotRegisteredWorker() public {
    vm.expectRevert("Worker not registered");
    workerRegistration.unstake(workerId, 2);
  }

  function delegate() internal {
    workerRegistration.register(workerId);
    jumpEpoch();
    token.transfer(delegator, stakeAmount);
    startHoax(delegator);
    token.approve(address(workerRegistration), stakeAmount);
    workerRegistration.delegate(workerId, stakeAmount);
  }

  function testWorksForNotActiveWorker() public {
    delegate();
    hoax(creator);
    workerRegistration.deregister(workerId);
    jumpEpoch();
    hoax(delegator);
    workerRegistration.unstake(workerId, stakeAmount);
  }

  function testTransfersTSqdBack() public {
    delegate();
    workerRegistration.unstake(workerId, stakeAmount / 2);
    assertEq(token.balanceOf(address(workerRegistration)), stakeAmount / 2 + workerRegistration.BOND_AMOUNT());
    assertEq(workerRegistration.stakedAmounts(delegator, 1), stakeAmount / 2);
  }

  function testCannotUnstakeMoreThanStaked() public {
    delegate();
    vm.expectRevert("Insufficient staked amount");
    workerRegistration.unstake(workerId, stakeAmount + 1);
  }

  function testCannotUnstakeSameStakeTwice() public {
    delegate();
    workerRegistration.unstake(workerId, stakeAmount);
    vm.expectRevert("Insufficient staked amount");
    workerRegistration.unstake(workerId, 1);
  }

  function testCanUnstakeFromRetiredWorker() public {
    delegate();
    startHoax(creator);
    workerRegistration.deregister(workerId);
    jumpEpoch();
    jumpEpoch();
    workerRegistration.withdraw(workerId);
    hoax(delegator);
    workerRegistration.unstake(workerId, stakeAmount);
  }

  function testEmitsUnstakedEvent() public {
    delegate();

    vm.expectEmit(address(workerRegistration));
    emit Unstaked(1, delegator, stakeAmount);
    workerRegistration.unstake(workerId, stakeAmount);
  }
}
