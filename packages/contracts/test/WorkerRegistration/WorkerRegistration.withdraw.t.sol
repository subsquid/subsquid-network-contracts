// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "./WorkerRegistration.sol";

contract WorkerRegistrationWithdrawTest is WorkerRegistrationTest {
  function testRevertsIfWorkerIsNotRegistered() public {
    vm.expectRevert("Worker not registered");
    workerRegistration.withdraw(workerId);
  }

  function testRevertsIfWorkerIsNotActive() public {
    workerRegistration.register(workerId);
    vm.expectRevert("Worker is locked");
    workerRegistration.withdraw(workerId);
  }

  function testRevertsIfWorkerIsNotDeregistered() public {
    workerRegistration.register(workerId);
    jumpEpoch();
    workerRegistration.deregister(workerId);
    vm.expectRevert("Worker is active");
    workerRegistration.withdraw(workerId);
  }

  function testRevertsIfWorkerIsDeregisteredButBeforeUnlock() public {
    workerRegistration.register(workerId);
    jumpEpoch();
    workerRegistration.deregister(workerId);
    jumpEpoch();
    vm.expectRevert("Worker is locked");
    workerRegistration.withdraw(workerId);
  }

  function testRevertsIfNotCalledByCreator() public {
    workerRegistration.register(workerId);
    jumpEpoch();
    workerRegistration.deregister(workerId);
    jumpEpoch();
    jumpEpoch();
    startHoax(address(123));
    vm.expectRevert("Not worker creator");
    workerRegistration.withdraw(workerId);
  }

  function testRevertsIfCalledTwice() public {
    withdraw();
    vm.expectRevert("Not worker creator");
    workerRegistration.withdraw(workerId);
  }

  function withdraw() internal {
    workerRegistration.register(workerId);
    jumpEpoch();
    workerRegistration.deregister(workerId);
    jumpEpoch();
    jumpEpoch();
    workerRegistration.withdraw(workerId);
  }

  function testDeletesWorker() public {
    withdraw();
    (address workerAddress,,,,,) = workerRegistration.workers(0);
    assertEq(workerAddress, address(0));
    assertEq(workerRegistration.getAllWorkersCount(), 0);
    assertEq(workerRegistration.workerIds(workerId), 1);
  }

  function testCanRegisterAgain() public {
    withdraw();
    token.approve(address(workerRegistration), workerRegistration.bondAmount());
    workerRegistration.register(workerId);
    assertEq(workerRegistration.getAllWorkersCount(), 1);
    assertEq(workerRegistration.workerIds(workerId), 1);
  }

  function testRevertsIfReregisteredByDifferentAccount() public {
    withdraw();
    token.approve(address(workerRegistration), workerRegistration.bondAmount());
    startHoax(address(123));
    vm.expectRevert("Worker already registered by different account");
    workerRegistration.register(workerId);
  }

  function testTransfersBondBack() public {
    withdraw();
    assertEq(token.balanceOf(creator), token.totalSupply());
  }

  function testEmitsWithdrawnEvent() public {
    workerRegistration.register(workerId);
    jumpEpoch();
    workerRegistration.deregister(workerId);
    jumpEpoch();
    jumpEpoch();

    vm.expectEmit(address(workerRegistration));
    emit WorkerWithdrawn(1, creator);
    workerRegistration.withdraw(workerId);
  }
}
