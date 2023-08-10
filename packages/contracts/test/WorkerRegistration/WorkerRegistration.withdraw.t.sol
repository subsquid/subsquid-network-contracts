// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.16;

import "./WorkerRegistration.t.sol";

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
    (address workerAddress,,,,) = workerRegistration.workers(0);
    assertEq(workerAddress, address(0));
    assertEq(workerRegistration.getAllWorkersCount(), 0);
    assertEq(workerRegistration.workerIds(workerId), 1);
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
