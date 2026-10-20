// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "../script/MigrateNetworkController.s.sol";
import "./BaseTest.sol";

contract MigrateNetworkControllerTest is BaseTest {
  NetworkController current;
  MigrateNetworkController script;

  function setUp() public {
    current = new NetworkController(5, 0, 0, 100 ether, new address[](0));
    script = new MigrateNetworkController();
  }

  function migrate() internal returns (NetworkController) {
    return script.deploy(current, 1_095_000, new address[](0), address(this), address(script));
  }

  function test_RevertsIf_AdminIsZero() public {
    vm.expectRevert("Admin cannot be zero");
    script.deploy(current, 1_095_000, new address[](0), address(0), address(script));
  }

  function test_HandsAdminRoleOver() public {
    NetworkController migrated = migrate();
    bytes32 adminRole = migrated.DEFAULT_ADMIN_ROLE();
    assertTrue(migrated.hasRole(adminRole, address(this)));
    assertTrue(migrated.hasRole(adminRole, address(script)));

    vm.prank(address(script));
    migrated.renounceRole(adminRole, address(script));
    assertFalse(migrated.hasRole(adminRole, address(script)));
  }

  function assertSameEpochs(NetworkController migrated, uint256 untilBlock) internal {
    for (uint256 b = block.number; b <= untilBlock; b++) {
      vm.roll(b);
      assertEq(migrated.epochNumber(), current.epochNumber());
      assertEq(migrated.nextEpoch(), current.nextEpoch());
    }
  }

  function test_MigratesBeforePendingEpochBoundary() public {
    vm.roll(27);
    current.setEpochLength(13);
    assertEq(current.firstEpochBlock(), 30);

    NetworkController migrated = migrate();
    assertSameEpochs(migrated, 60);
  }

  function test_MigratesAfterEpochBoundary() public {
    vm.roll(27);
    current.setEpochLength(13);
    vm.roll(44);

    NetworkController migrated = migrate();
    assertSameEpochs(migrated, 80);
  }

  function testFuzz_ContinuesEpochNumbering(uint256 changeAt, uint256 migrateAfter, uint128 newLength) public {
    changeAt = bound(changeAt, 1, 1_000);
    migrateAfter = bound(migrateAfter, 0, 300);
    newLength = uint128(bound(newLength, 2, 50));

    vm.roll(changeAt);
    current.setEpochLength(newLength);
    vm.roll(changeAt + migrateAfter);

    NetworkController migrated = migrate();
    assertSameEpochs(migrated, block.number + 2 * newLength);
  }
}
