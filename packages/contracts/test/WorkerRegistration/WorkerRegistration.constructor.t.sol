// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.19;

import "./WorkerRegistration.t.sol";

contract WorkerRegistrationConstructorTest is WorkerRegistrationTest {
  function testConstructor() public {
    assertEq(address(workerRegistration.tSQD()), address(token));
    assertEq(workerRegistration.epochLength(), EPOCH_LENGTH);
    assertEq(workerRegistration.lockPeriod(), EPOCH_LENGTH);
  }

  function test_CorrectlyCountsEpochStart() public {
    assertEq(workerRegistration.nextEpoch(), 2);
    vm.roll(block.number + 1);
    assertEq(workerRegistration.nextEpoch(), 4);
    vm.roll(block.number + 1);
    assertEq(workerRegistration.nextEpoch(), 4);
    vm.roll(block.number + 1);
    assertEq(workerRegistration.nextEpoch(), 6);
    vm.roll(block.number + 1);
    assertEq(workerRegistration.nextEpoch(), 6);
    vm.roll(block.number + 1);
    assertEq(workerRegistration.nextEpoch(), 8);
  }
}
