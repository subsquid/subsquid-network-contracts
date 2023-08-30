// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.16;

import "./WorkerRegistration.t.sol";

contract WorkerRegistrationDelegateTest is WorkerRegistrationTest {
  address delegator = address(123);
  uint256 stakeAmount = 1000;

  function testRevertsForNotRegisteredWorker() public {
    vm.expectRevert("Worker not registered");
    workerRegistration.delegate(workerId, 2);
  }

  function testRevertsForNotActiveWorker() public {
    workerRegistration.register(workerId);
    vm.expectRevert("Worker not active");
    workerRegistration.delegate(workerId, 2);
  }

  function testStakesTSqt() public {
    workerRegistration.register(workerId);
    jumpEpoch();
    token.transfer(delegator, stakeAmount);
    startHoax(delegator);
    token.approve(address(workerRegistration), stakeAmount);

    workerRegistration.delegate(workerId, stakeAmount);
    assertEq(token.balanceOf(address(workerRegistration)), stakeAmount + workerRegistration.BOND_AMOUNT());
    assertEq(workerRegistration.stakedAmounts(delegator, 1), stakeAmount);
  }

  function testIncreasesStakeIfStakedTwice() public {
    workerRegistration.register(workerId);
    jumpEpoch();
    token.transfer(delegator, stakeAmount);
    startHoax(delegator);
    token.approve(address(workerRegistration), stakeAmount);

    workerRegistration.delegate(workerId, stakeAmount / 2);
    workerRegistration.delegate(workerId, stakeAmount / 2);
    assertEq(workerRegistration.stakedAmounts(delegator, 1), stakeAmount);
  }

  function testIncreasesStakePerWorker() public {
    workerRegistration.register(workerId);
    jumpEpoch();
    token.transfer(delegator, stakeAmount);
    startHoax(delegator);
    token.approve(address(workerRegistration), stakeAmount);

    workerRegistration.delegate(workerId, stakeAmount / 2);
    workerRegistration.delegate(workerId, stakeAmount / 2);
    assertEq(workerRegistration.stakedAmountsPerWorker(1), stakeAmount);
  }

  function testEmitsDelegatedEvent() public {
    workerRegistration.register(workerId);
    jumpEpoch();
    token.transfer(delegator, stakeAmount);
    token.transfer(delegator, stakeAmount);
    startHoax(delegator);
    token.approve(address(workerRegistration), stakeAmount);

    vm.expectEmit(address(workerRegistration));
    emit Delegated(1, delegator, stakeAmount);
    workerRegistration.delegate(workerId, stakeAmount);
  }

  function testAddsStakersToTheList() public {
    address delegator2 = address(1337);
    workerRegistration.register(workerId);
    jumpEpoch();
    token.transfer(delegator, stakeAmount);
    startHoax(delegator);
    token.approve(address(workerRegistration), stakeAmount);

    workerRegistration.delegate(workerId, stakeAmount / 2);
    workerRegistration.delegate(workerId, stakeAmount / 2);
    startHoax(creator);
    token.transfer(delegator2, stakeAmount);
    startHoax(delegator2);
    token.approve(address(workerRegistration), stakeAmount);
    workerRegistration.delegate(workerId, stakeAmount);

    address[] memory stakers = workerRegistration.getStakers(workerId);
    assertEq(stakers.length, 2);
    assertEq(stakers[0], delegator);
    assertEq(stakers[1], delegator2);
  }
}
