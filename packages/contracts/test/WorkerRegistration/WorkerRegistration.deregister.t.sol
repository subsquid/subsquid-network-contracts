// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.16;

import "./WorkerRegistration.t.sol";

contract WorkerRegistrationDeregisterTest is WorkerRegistrationTest {
  function testRevertsIfWorkerIsNotRegistered() public {
    vm.expectRevert("Worker not registered");
    workerRegistration.deregister(workerId);
  }

  function testRevertsIfWorkerIsNotYetActive() public {
    workerRegistration.register(workerId);
    vm.expectRevert("Worker not active");
    workerRegistration.deregister(workerId);
  }

  function testRevertsIfNotCalledByCreator() public {
    workerRegistration.register(workerId);
    jumpEpoch();
    startHoax(address(this));
    vm.expectRevert("Not worker creator");
    workerRegistration.deregister(workerId);
  }

  function testRevertsIfWorkerDeregisteredTwice() public {
    workerRegistration.register(workerId);
    jumpEpoch();
    workerRegistration.deregister(workerId);

    jumpEpoch();
    vm.expectRevert("Worker not active");
    workerRegistration.deregister(workerId);
  }

  function testSetsDeregisteredBlock() public {
    workerRegistration.register(workerId);
    jumpEpoch();
    workerRegistration.deregister(workerId);
    (,,,, uint128 deregisteredAt) = workerRegistration.workers(1);
    assertEq(deregisteredAt, nextEpoch());
  }

  function testRemovesLastWorkerIdFromActiveWorkerIds() public {
    workerRegistration.register(workerId);
    jumpEpoch();
    workerRegistration.deregister(workerId);
    assertEq(workerRegistration.getAllWorkersCount(), 0);
  }

  function testRemovesNotLastWorkerIdFromActiveWorkerIds() public {
    token.approve(address(workerRegistration), workerRegistration.BOND_AMOUNT() * 2);

    workerRegistration.register(workerId);
    workerRegistration.register(workerId2);
    jumpEpoch();
    workerRegistration.deregister(workerId);

    assertEq(workerRegistration.getAllWorkersCount(), 1);
    assertEq(workerRegistration.getWorkerByIndex(0).peerId, workerId2);
  }

  function testExcludesInactiveWorkerStakeFromTVL() public {
    token.approve(address(workerRegistration), workerRegistration.BOND_AMOUNT() * 2 + 300);

    workerRegistration.register(workerId);
    workerRegistration.register(workerId2);
    jumpEpoch();

    token.approve(address(staking), 300);
    staking.deposit(1, 100);
    staking.deposit(2, 200);
    assertEq(workerRegistration.effectiveTVL(), workerRegistration.BOND_AMOUNT() * 2 + 300);

    workerRegistration.deregister(workerId);
    assertEq(workerRegistration.effectiveTVL(), workerRegistration.BOND_AMOUNT() + 200);
    workerRegistration.deregister(workerId2);
    assertEq(workerRegistration.effectiveTVL(), 0);
  }

  function testEmitsDeregisteredEvent() public {
    workerRegistration.register(workerId);
    jumpEpoch();
    vm.expectEmit(address(workerRegistration));
    emit WorkerDeregistered(1, creator, nextEpoch());
    workerRegistration.deregister(workerId);
  }
}
