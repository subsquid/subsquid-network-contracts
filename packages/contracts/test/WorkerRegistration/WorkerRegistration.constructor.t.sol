// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "./WorkerRegistration.sol";

contract WorkerRegistrationConstructorTest is WorkerRegistrationTest {
  function testConstructor() public {
    assertEq(address(workerRegistration.tSQD()), address(token));
    assertEq(workerRegistration.epochLength(), EPOCH_LENGTH);
    assertEq(workerRegistration.lockPeriod(), EPOCH_LENGTH);
  }

  function test_CorrectlyCountsEpochStart() public {
    assertEq(workerRegistration.nextEpoch(), 7);
    vm.roll(block.number + 1);
    assertEq(workerRegistration.nextEpoch(), 7);
    vm.roll(block.number + 1);
    assertEq(workerRegistration.nextEpoch(), 9);
    vm.roll(block.number + 1);
    assertEq(workerRegistration.nextEpoch(), 9);
    vm.roll(block.number + 1);
    assertEq(workerRegistration.nextEpoch(), 11);
    vm.roll(block.number + 1);
    assertEq(workerRegistration.nextEpoch(), 11);
  }
}
