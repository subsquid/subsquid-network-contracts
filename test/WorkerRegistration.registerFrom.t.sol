// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.16;

import "./WorkerRegistration.t.sol";

contract WorkerRegistrationRegisterFromTest is WorkerRegistrationTest {
    uint256 constant walletPrivateKey = 0xedfef;
    address worker = vm.addr(walletPrivateKey);

    function testRegisterFromTransfersToken() public {
        uint256 registrationBalanceBefore = token.balanceOf(address(workerRegistration));
        workerRegistration.registerFrom(worker, workerId);
        uint256 registrationBalanceAfter = token.balanceOf(address(workerRegistration));
        assertEq(registrationBalanceAfter, registrationBalanceBefore + workerRegistration.BOND_AMOUNT());
    }

    function testRegisterWorkerEmitsEvent() public {
        vm.expectEmit(address(workerRegistration));
        emit WorkerRegistered(1, worker, creator, workerId[0], workerId[1], block.number + block.number % 2);
        workerRegistration.registerFrom(worker, workerId);
    }

    function testRevertsIfSameWorkedRegisteredTwice() public {
        workerRegistration.registerFrom(worker, workerId);
        vm.expectRevert("Worker already registered");
        workerRegistration.registerFrom(worker, workerId);
    }

    function testIncrementsIdForNextWorker() public {
        token.approve(address(workerRegistration), workerRegistration.BOND_AMOUNT() * 2);

        workerRegistration.registerFrom(address(123), workerId);
        workerRegistration.registerFrom(worker, workerId);
        assertEq(workerRegistration.workerIds(worker), 2);
    }

    function testCorrectlyCreatesWorkerStruct() public {
        workerRegistration.registerFrom(worker, workerId);

        WorkerRegistration.Worker memory workerStruct = workerRegistration.getWorkerByIndex(0);
        assertEq(workerStruct.account, worker);
        assertEq(workerStruct.peerId[0], workerId[0]);
        assertEq(workerStruct.peerId[1], workerId[1]);
        assertEq(workerStruct.bond, workerRegistration.BOND_AMOUNT());
        assertEq(workerStruct.registeredAt, block.number + block.number % 2);
        assertEq(workerStruct.deregisteredAt, 0);
    }
}
