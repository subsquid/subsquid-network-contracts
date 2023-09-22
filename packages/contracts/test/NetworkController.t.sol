// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.18;

import "forge-std/Test.sol";
import "../src/NetworkController.sol";

contract NetworkControllerTest is Test {
  NetworkController controller;

  function setUp() public {
    controller = new NetworkController(5, 100);
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

  function test_RevertsIf_SettingBondAmountNotByAdmin() public {
    hoax(address(1));
    vm.expectRevert(
      "AccessControl: account 0x0000000000000000000000000000000000000001 is missing role 0x0000000000000000000000000000000000000000000000000000000000000000"
    );
    controller.setBondAmount(10);
  }
}
