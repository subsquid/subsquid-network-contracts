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
        emit WorkerRegistered(1, creator, creator, workerId[0], workerId[1], nextEpoch());
        workerRegistration.register(workerId);
    }

    function testRevertsIfSameWorkedRegisteredTwice() public {
        workerRegistration.register(workerId);
        vm.expectRevert("Worker already registered");
        workerRegistration.register(workerId);
    }
}
