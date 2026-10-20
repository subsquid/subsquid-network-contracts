// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "../src/NetworkController.sol";
import "./BaseTest.sol";

contract NetworkControllerTest is BaseTest {
  NetworkController controller;

  function setUp() public {
    controller = new NetworkController(5, 0, 0, 100 ether, new address[](0));
  }

  function test_NextEpoch() public {
    assertEq(controller.nextEpoch(), 5);
    vm.roll(4);
    assertEq(controller.nextEpoch(), 5);
    vm.roll(5);
    assertEq(controller.nextEpoch(), 10);
  }

  function test_EpochNumber() public {
    assertEq(controller.epochNumber(), 0);
    vm.roll(4);
    assertEq(controller.epochNumber(), 0);
    vm.roll(5);
    assertEq(controller.epochNumber(), 1);
    vm.roll(14);
    assertEq(controller.epochNumber(), 2);
    vm.roll(15);
    assertEq(controller.epochNumber(), 3);
  }

  function test_EpochNumberAfterEpochLengthChange() public {
    vm.roll(27);
    assertEq(controller.epochNumber(), 5);
    assertEq(controller.nextEpoch(), 30);
    controller.setEpochLength(13);
    assertEq(controller.nextEpoch(), 30);
    assertEq(controller.epochNumber(), 5);
    vm.roll(29);
    assertEq(controller.epochNumber(), 5);
    vm.roll(30);
    assertEq(controller.epochNumber(), 6);
    assertEq(controller.nextEpoch(), 43);
    vm.roll(42);
    assertEq(controller.epochNumber(), 6);
    vm.roll(43);
    assertEq(controller.epochNumber(), 7);
    assertEq(controller.nextEpoch(), 56);
  }

  function test_RevertsIf_SettingEpochLengthNotByAdmin() public {
    hoax(address(1));
    expectNotAdminRevert();
    controller.setEpochLength(10);
  }

  function test_RevertsIf_SettingEpochLengthTo1() public {
    vm.expectRevert("Epoch length too short");
    controller.setEpochLength(1);
  }

  function test_RevertsIf_SettingBondAmountNotByAdmin() public {
    hoax(address(1));
    expectNotAdminRevert();
    controller.setBondAmount(10);
  }

  function test_RevertsIf_SettingBondAmountTo0() public {
    vm.expectRevert("Bond cannot be 0");
    controller.setBondAmount(0);
  }

  function test_RevertsIf_SettingBondAmountToOver1M() public {
    vm.expectRevert("Bond too large");
    controller.setBondAmount(1_000_001 ether);
  }

  function test_RevertsIf_SettingStorageAmountNotByAdmin() public {
    hoax(address(1));
    expectNotAdminRevert();
    controller.setStoragePerWorkerInGb(10);
  }

  function test_RevertsIf_SettingStorageAmountTo0() public {
    vm.expectRevert("Storage cannot be 0");
    controller.setStoragePerWorkerInGb(0);
  }

  function test_changesBondAmount() public {
    assertEq(controller.bondAmount(), 100 ether);
    controller.setBondAmount(10);
    assertEq(controller.bondAmount(), 10);
  }

  function test_changesStorageAmount() public {
    assertEq(controller.storagePerWorkerInGb(), 1000);
    controller.setStoragePerWorkerInGb(10);
    assertEq(controller.storagePerWorkerInGb(), 10);
  }

  function test_SetsLockPeriodAboveOldLimit() public {
    uint128 lockPeriod = 1_095_000;
    controller.setLockPeriod(lockPeriod);
    assertEq(controller.lockPeriod(), lockPeriod);
    assertEq(controller.epochLength(), lockPeriod);
  }

  function test_SetsLockPeriodToMax() public {
    uint128 max = controller.MAX_LOCK_PERIOD();
    controller.setLockPeriod(max);
    assertEq(controller.lockPeriod(), max);
  }

  function test_RevertsIf_SettingLockPeriodAboveMax() public {
    uint128 max = controller.MAX_LOCK_PERIOD();
    vm.expectRevert("Lock period too long");
    controller.setLockPeriod(max + 1);
  }

  function test_RevertsIf_SettingLockPeriodTo1() public {
    vm.expectRevert("Lock period too short");
    controller.setLockPeriod(1);
  }

  function test_RevertsIf_SettingLockPeriodNotByAdmin() public {
    hoax(address(1));
    expectNotAdminRevert();
    controller.setLockPeriod(1_095_000);
  }

  function test_LockPeriodDoesNotMoveEpochs() public {
    vm.roll(27);
    controller.setLockPeriod(controller.MAX_LOCK_PERIOD());
    assertEq(controller.workerEpochLength(), 5);
    assertEq(controller.epochNumber(), 5);
    assertEq(controller.nextEpoch(), 30);
  }
}
