// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.16;

import "./WorkerRegistration.t.sol";

contract WorkerRegistrationRegisterTest is WorkerRegistrationTest {
  function testRegisterWorkerTransfersToken() public {
    uint256 registrationBalanceBefore = token.balanceOf(address(workerRegistration));
    workerRegistration.register(workerId);
    uint256 registrationBalanceAfter = token.balanceOf(address(workerRegistration));
    assertEq(registrationBalanceAfter, registrationBalanceBefore + workerRegistration.BOND_AMOUNT());
  }

  function testRegisterWorkerEmitsEvent() public {
    vm.expectEmit(address(workerRegistration));
    emit WorkerRegistered(1, workerId, creator, nextEpoch());
    workerRegistration.register(workerId);
  }

  function testRevertsIfSameWorkedRegisteredTwice() public {
    workerRegistration.register(workerId);
    vm.expectRevert("Worker already registered");
    workerRegistration.register(workerId);
  }

  function testRevertsIfPeerIdIsOver64Bytes() public {
    bytes memory idWith64Bytes = abi.encodePacked(uint256(1), uint256(2));
    workerRegistration.register(idWith64Bytes);
    bytes memory idWith65Bytes = abi.encodePacked(uint256(1), uint256(2), true);
    vm.expectRevert("Peer ID too large");
    workerRegistration.register(idWith65Bytes);
  }

  function testIncrementsIdForNextWorker() public {
    token.approve(address(workerRegistration), workerRegistration.BOND_AMOUNT() * 2);

    workerRegistration.register(workerId);
    workerRegistration.register(workerId2);
    assertEq(workerRegistration.workerIds(creator, workerId2), 2);
  }

  function testCorrectlyCreatesWorkerStruct() public {
    workerRegistration.register(workerId);

    WorkerRegistration.Worker memory workerStruct = workerRegistration.getWorkerByIndex(0);
    assertEq(workerStruct.creator, creator);
    assertEq(workerStruct.peerId, workerId);
    assertEq(workerStruct.bond, workerRegistration.BOND_AMOUNT());
    assertEq(workerStruct.registeredAt, nextEpoch());
    assertEq(workerStruct.deregisteredAt, 0);
  }
}
