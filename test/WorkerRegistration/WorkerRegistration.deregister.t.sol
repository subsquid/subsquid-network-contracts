// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.16;

import "./WorkerRegistration.t.sol";

contract WorkerRegistrationDeregisterTest is WorkerRegistrationTest {
    function testRevertsIfWorkerIsNotRegistered() public {
        vm.expectRevert("Worker not registered");
        workerRegistration.deregister();
    }

    function testRevertsIfWorkerIsNotYetActive() public {
        workerRegistration.register(workerId);
        vm.expectRevert("Worker not active");
        workerRegistration.deregister();
    }

    function testRevertsIfWorkerDeregisteredTwice() public {
        workerRegistration.register(workerId);
        jumpEpoch();
        workerRegistration.deregister();

        jumpEpoch();
        vm.expectRevert("Worker not active");
        workerRegistration.deregister();
    }

    function testSetsDeregisteredBlock() public {
        workerRegistration.register(workerId);
        jumpEpoch();
        workerRegistration.deregister();
        (,,, uint128 deregisteredAt) = workerRegistration.workers(1);
        assertEq(deregisteredAt, nextEpoch());
    }

    function testRemovesLastWorkerIdFromActiveWorkerIds() public {
        workerRegistration.register(workerId);
        jumpEpoch();
        workerRegistration.deregister();
        assertEq(workerRegistration.getAllWorkersCount(), 0);
    }

    function testRemovesNotLastWorkerIdFromActiveWorkerIds() public {
        token.approve(address(workerRegistration), workerRegistration.BOND_AMOUNT() * 2);

        workerRegistration.register(workerId);
        workerRegistration.registerFrom(address(420), workerId);
        vm.roll(block.number + 1);
        workerRegistration.deregister();

        assertEq(workerRegistration.getAllWorkersCount(), 1);
        assertEq(workerRegistration.getWorkerByIndex(0).account, address(420));
    }

    function testEmitsDeregisteredEvent() public {
        workerRegistration.register(workerId);
        jumpEpoch();
        vm.expectEmit(address(workerRegistration));
        emit WorkerDeregistered(1, creator, nextEpoch());
        workerRegistration.deregister();
    }
}
