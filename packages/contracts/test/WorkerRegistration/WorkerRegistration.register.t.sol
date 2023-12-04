// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.19;

import "./WorkerRegistration.sol";

contract WorkerRegistrationRegisterTest is WorkerRegistrationTest {
  function test_RegisterWorkerTransfersToken() public {
    uint256 registrationBalanceBefore = token.balanceOf(address(workerRegistration));
    workerRegistration.register(workerId);
    uint256 registrationBalanceAfter = token.balanceOf(address(workerRegistration));
    assertEq(registrationBalanceAfter, registrationBalanceBefore + workerRegistration.bondAmount());
  }

  function test_RegisterWorkerEmitsEvent() public {
    vm.expectEmit(address(workerRegistration));
    emit WorkerRegistered(1, workerId, creator, nextEpoch());
    workerRegistration.register(workerId);
  }

  function test_RevertsIfSameWorkedRegisteredTwice() public {
    workerRegistration.register(workerId);
    vm.expectRevert("Worker already registered");
    workerRegistration.register(workerId);
  }

  function test_RevertsIfPeerIdIsOver64Bytes() public {
    bytes memory idWith64Bytes = abi.encodePacked(uint256(1), uint256(2));
    workerRegistration.register(idWith64Bytes);
    bytes memory idWith65Bytes = abi.encodePacked(uint256(1), uint256(2), true);
    vm.expectRevert("Peer ID too large");
    workerRegistration.register(idWith65Bytes);
  }

  function test_IncrementsIdForNextWorker() public {
    token.approve(address(workerRegistration), workerRegistration.bondAmount() * 2);

    workerRegistration.register(workerId);
    workerRegistration.register(workerId2);
    assertEq(workerRegistration.workerIds(workerId2), 2);
  }

  function test_CorrectlyCreatesWorkerStruct() public {
    workerRegistration.register(workerId);

    WorkerRegistration.Worker memory workerStruct = workerRegistration.getWorkerByIndex(0);
    assertEq(workerStruct.creator, creator);
    assertEq(workerStruct.peerId, workerId);
    assertEq(workerStruct.bond, workerRegistration.bondAmount());
    assertEq(workerStruct.registeredAt, nextEpoch());
    assertEq(workerStruct.deregisteredAt, 0);
  }

  function test_RegisteredWorkerAppearsInActiveWorkersAfterNextEpochStart() public {
    workerRegistration.register(workerId);
    assertEq(workerRegistration.getActiveWorkerCount(), 0);
    jumpEpoch();
    assertEq(workerRegistration.getActiveWorkerCount(), 1);
    assertEq(workerRegistration.getActiveWorkerIds()[0], 1);
    assertEq(workerRegistration.getActiveWorkers()[0].peerId, workerId);
  }
}
