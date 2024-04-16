// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "./WorkerRegistration.sol";

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
    startHoax(address(123));
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
    (,,,, uint128 deregisteredAt,) = workerRegistration.workers(1);
    assertEq(deregisteredAt, nextEpoch());
  }

  function testEmitsDeregisteredEvent() public {
    workerRegistration.register(workerId);
    jumpEpoch();
    vm.expectEmit(address(workerRegistration));
    emit WorkerDeregistered(1, creator, nextEpoch());
    workerRegistration.deregister(workerId);
  }
}
