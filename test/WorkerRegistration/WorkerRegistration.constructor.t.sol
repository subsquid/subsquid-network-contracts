// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.16;

import "./WorkerRegistration.t.sol";

contract WorkerRegistrationConstructorTest is WorkerRegistrationTest {
    function testConstructor() public {
        assertEq(address(workerRegistration.tSQD()), address(token));
        assertEq(workerRegistration.epochLength(), EPOCH_LENGTH);
        assertEq(workerRegistration.lockPeriod(), EPOCH_LENGTH);
    }
}
