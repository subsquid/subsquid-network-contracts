// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "forge-std/Test.sol";
import "../src/NetworkController.sol";

contract NetworkControllerTest is Test {
  NetworkController controller;

  function setUp() public {
    controller = new NetworkController(5, 100 ether, new address[](0));
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
    controller.setEpochLength(10);
    assertEq(controller.epochNumber(), 5);
    vm.roll(29);
    assertEq(controller.epochNumber(), 5);
    vm.roll(30);
    assertEq(controller.epochNumber(), 6);
    vm.roll(39);
    assertEq(controller.epochNumber(), 6);
    vm.roll(40);
    assertEq(controller.epochNumber(), 7);
  }

  function test_RevertsIf_SettingEpochLengthNotByAdmin() public {
    hoax(address(1));
    vm.expectRevert(
      "AccessControl: account 0x0000000000000000000000000000000000000001 is missing role 0x0000000000000000000000000000000000000000000000000000000000000000"
    );
    controller.setEpochLength(10);
  }

  function test_RevertsIf_SettingEpochLengthTo1() public {
    vm.expectRevert("Epoch length too short");
    controller.setEpochLength(1);
  }

  function test_RevertsIf_SettingBondAmountNotByAdmin() public {
    hoax(address(1));
    vm.expectRevert(
      "AccessControl: account 0x0000000000000000000000000000000000000001 is missing role 0x0000000000000000000000000000000000000000000000000000000000000000"
    );
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
    vm.expectRevert(
      "AccessControl: account 0x0000000000000000000000000000000000000001 is missing role 0x0000000000000000000000000000000000000000000000000000000000000000"
    );
    controller.setStoragePerWorkerInGb(10);
  }

  function test_RevertsIf_SettingDelegationCoefficientNotByAdmin() public {
    hoax(address(1));
    vm.expectRevert(
      "AccessControl: account 0x0000000000000000000000000000000000000001 is missing role 0x0000000000000000000000000000000000000000000000000000000000000000"
    );
    controller.setDelegationLimitCoefficient(10);
  }

  function test_ChangingDelegationCoefficientChangesMaxDelegation() public {
    assertEq(controller.delegationLimit(), 20 ether);
    controller.setDelegationLimitCoefficient(1000);
    assertEq(controller.delegationLimit(), 10 ether);
  }

  function test_ChangingBondAmountChangesMaxDelegation() public {
    assertEq(controller.delegationLimit(), 20 ether);
    controller.setBondAmount(200 ether);
    assertEq(controller.delegationLimit(), 40 ether);
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
}
