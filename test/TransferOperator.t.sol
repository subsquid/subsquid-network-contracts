// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./BaseTest.sol";
import {PoolErrors} from "../src/libs/PoolErrors.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

contract TransferOperatorTest is BaseTest {
    address public portal;
    address public newOperator = address(0x999);

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;

    function setUp() public override {
        super.setUp();
        portal = _createPortal(operator, MIN_STAKE_THRESHOLD, "TEST");
        vm.label(newOperator, "NewOperator");
    }

    function test_transferOperator_success() public {
        // Verify initial state
        IPortalPool.PoolInfo memory infoBefore = IPortalPool(portal).getPoolInfo();
        assertEq(infoBefore.operator, operator);
        assertTrue(IAccessControl(portal).hasRole(OPERATOR_ROLE, operator));

        // Transfer operator role
        vm.prank(operator);
        PortalPoolImplementation(portal).transferOperator(newOperator);

        // Verify new state
        IPortalPool.PoolInfo memory infoAfter = IPortalPool(portal).getPoolInfo();
        assertEq(infoAfter.operator, newOperator);
        assertTrue(IAccessControl(portal).hasRole(OPERATOR_ROLE, newOperator));
        assertFalse(IAccessControl(portal).hasRole(OPERATOR_ROLE, operator));
    }

    function test_transferOperator_emitsEvent() public {
        vm.expectEmit(true, true, false, false);
        emit IPortalPool.OperatorTransferred(operator, newOperator);

        vm.prank(operator);
        PortalPoolImplementation(portal).transferOperator(newOperator);
    }

    function test_transferOperator_newOperatorCanCallOperatorFunctions() public {
        // Transfer to new operator
        vm.prank(operator);
        PortalPoolImplementation(portal).transferOperator(newOperator);

        // Activate the pool first
        vm.startPrank(user1);
        sqd.approve(portal, MIN_STAKE_THRESHOLD);
        IPortalPool(portal).deposit(MIN_STAKE_THRESHOLD);
        vm.stopPrank();

        // New operator should be able to call operator functions
        vm.startPrank(newOperator);
        usdc.mint(newOperator, 1000e6);
        usdc.approve(portal, 1000e6);
        PortalPoolImplementation(portal).topUpRewards(1000e6);
        vm.stopPrank();
    }

    function test_transferOperator_oldOperatorCannotCallOperatorFunctions() public {
        // Transfer to new operator
        vm.prank(operator);
        PortalPoolImplementation(portal).transferOperator(newOperator);

        // Activate the pool
        vm.startPrank(user1);
        sqd.approve(portal, MIN_STAKE_THRESHOLD);
        IPortalPool(portal).deposit(MIN_STAKE_THRESHOLD);
        vm.stopPrank();

        // Old operator should NOT be able to call operator functions
        vm.startPrank(operator);
        usdc.approve(portal, 1000e6);
        vm.expectRevert(PoolErrors.NotOperator.selector);
        PortalPoolImplementation(portal).topUpRewards(1000e6);
        vm.stopPrank();
    }

    function test_transferOperator_revertIfNotOperator() public {
        vm.prank(user1);
        vm.expectRevert(PoolErrors.NotOperator.selector);
        PortalPoolImplementation(portal).transferOperator(newOperator);
    }

    function test_transferOperator_revertIfZeroAddress() public {
        vm.prank(operator);
        vm.expectRevert(PoolErrors.InvalidAddress.selector);
        PortalPoolImplementation(portal).transferOperator(address(0));
    }

    function test_transferOperator_revertIfSameOperator() public {
        vm.prank(operator);
        vm.expectRevert(PoolErrors.NoChange.selector);
        PortalPoolImplementation(portal).transferOperator(operator);
    }

    function test_transferOperator_operatorDoesNotHaveAdminRole() public {
        // Verify operator does not have DEFAULT_ADMIN_ROLE
        assertFalse(IAccessControl(portal).hasRole(DEFAULT_ADMIN_ROLE, operator));

        // Transfer operator
        vm.prank(operator);
        PortalPoolImplementation(portal).transferOperator(newOperator);

        // Verify new operator also does not have DEFAULT_ADMIN_ROLE
        assertFalse(IAccessControl(portal).hasRole(DEFAULT_ADMIN_ROLE, newOperator));
    }

    function test_transferOperator_operatorCannotPause() public {
        // Operator should NOT be able to pause (only factory admin can)
        vm.prank(operator);
        vm.expectRevert(PoolErrors.NotAdmin.selector);
        PortalPoolImplementation(portal).pause();
    }

    function test_transferOperator_operatorCannotClosePool() public {
        // Activate the pool first
        vm.startPrank(user1);
        sqd.approve(portal, MIN_STAKE_THRESHOLD);
        IPortalPool(portal).deposit(MIN_STAKE_THRESHOLD);
        vm.stopPrank();

        // Operator should NOT be able to close pool
        vm.prank(operator);
        vm.expectRevert(PoolErrors.NotAdmin.selector);
        PortalPoolImplementation(portal).closePool();
    }

    function test_factoryAdmin_canPausePool() public {
        // Factory admin (this contract) should be able to pause
        PortalPoolImplementation(portal).pause();
        assertTrue(PortalPoolImplementation(portal).paused());

        // And unpause
        PortalPoolImplementation(portal).unpause();
        assertFalse(PortalPoolImplementation(portal).paused());
    }

    function test_factoryAdmin_canClosePool() public {
        // Activate the pool first
        vm.startPrank(user1);
        sqd.approve(portal, MIN_STAKE_THRESHOLD);
        IPortalPool(portal).deposit(MIN_STAKE_THRESHOLD);
        vm.stopPrank();

        // Factory admin should be able to close pool
        PortalPoolImplementation(portal).closePool();
        assertEq(uint256(IPortalPool(portal).getState()), uint256(IPortalPool.PoolState.CLOSED));
    }

    function test_transferOperator_whitelistEnabled_addsNewOperator() public {
        // Enable whitelist
        vm.prank(operator);
        PortalPoolImplementation(portal).setWhitelistEnabled(true);

        // Transfer operator
        vm.prank(operator);
        vm.expectEmit(true, false, false, true);
        emit IPortalPool.WhitelistUpdated(newOperator, true);
        PortalPoolImplementation(portal).transferOperator(newOperator);

        // Verify new operator is whitelisted
        assertTrue(PortalPoolImplementation(portal).isWhitelisted(newOperator));
    }

    function test_transferOperator_whitelistDisabled_doesNotAddToWhitelist() public {
        // Whitelist is disabled by default
        assertFalse(PortalPoolImplementation(portal).whitelistEnabled());

        // Transfer operator
        vm.prank(operator);
        PortalPoolImplementation(portal).transferOperator(newOperator);

        // New operator should not be whitelisted (whitelist is disabled)
        assertFalse(PortalPoolImplementation(portal).isWhitelisted(newOperator));
    }

    function test_transferOperator_chainedTransfers() public {
        address secondNewOperator = address(0x888);
        vm.label(secondNewOperator, "SecondNewOperator");

        // First transfer
        vm.prank(operator);
        PortalPoolImplementation(portal).transferOperator(newOperator);

        // Second transfer by new operator
        vm.prank(newOperator);
        PortalPoolImplementation(portal).transferOperator(secondNewOperator);

        // Verify final state
        IPortalPool.PoolInfo memory info = IPortalPool(portal).getPoolInfo();
        assertEq(info.operator, secondNewOperator);
        assertTrue(IAccessControl(portal).hasRole(OPERATOR_ROLE, secondNewOperator));
        assertFalse(IAccessControl(portal).hasRole(OPERATOR_ROLE, newOperator));
        assertFalse(IAccessControl(portal).hasRole(OPERATOR_ROLE, operator));
    }

    function test_transferOperator_afterPoolActivation() public {
        // Activate the pool
        vm.startPrank(user1);
        sqd.approve(portal, MIN_STAKE_THRESHOLD);
        IPortalPool(portal).deposit(MIN_STAKE_THRESHOLD);
        vm.stopPrank();

        assertEq(uint256(IPortalPool(portal).getState()), uint256(IPortalPool.PoolState.ACTIVE));

        // Transfer should still work
        vm.prank(operator);
        PortalPoolImplementation(portal).transferOperator(newOperator);

        IPortalPool.PoolInfo memory info = IPortalPool(portal).getPoolInfo();
        assertEq(info.operator, newOperator);
    }

    // ============ setMetadata Tests ============

    function test_setMetadata_success() public {
        string memory newMetadata = "New pool metadata";

        vm.prank(operator);
        PortalPoolImplementation(portal).setMetadata(newMetadata);

        // Verify metadata updated in registry
        string memory storedMetadata = IPortalPool(portal).getMetadata();
        assertEq(storedMetadata, newMetadata);
    }

    function test_setMetadata_emitsEvent() public {
        string memory newMetadata = "Updated metadata";
        bytes32 clusterId = registry.getClusterIdByAddress(portal);

        vm.expectEmit(true, false, false, true);
        emit IPortalRegistry.ClusterMetadataUpdated(clusterId, newMetadata);

        vm.prank(operator);
        PortalPoolImplementation(portal).setMetadata(newMetadata);
    }

    function test_setMetadata_revertIfNotOperator() public {
        vm.prank(user1);
        vm.expectRevert(PoolErrors.NotOperator.selector);
        PortalPoolImplementation(portal).setMetadata("Should fail");
    }

    function test_setMetadata_newOperatorCanSetAfterTransfer() public {
        // Transfer operator
        vm.prank(operator);
        PortalPoolImplementation(portal).transferOperator(newOperator);

        // New operator can set metadata
        string memory newMetadata = "Metadata set by new operator";
        vm.prank(newOperator);
        PortalPoolImplementation(portal).setMetadata(newMetadata);

        assertEq(IPortalPool(portal).getMetadata(), newMetadata);
    }

    function test_setMetadata_oldOperatorCannotSetAfterTransfer() public {
        // Transfer operator
        vm.prank(operator);
        PortalPoolImplementation(portal).transferOperator(newOperator);

        // Old operator cannot set metadata
        vm.prank(operator);
        vm.expectRevert(PoolErrors.NotOperator.selector);
        PortalPoolImplementation(portal).setMetadata("Should fail");
    }

    function test_setMetadata_canUpdateMultipleTimes() public {
        vm.startPrank(operator);

        PortalPoolImplementation(portal).setMetadata("First update");
        assertEq(IPortalPool(portal).getMetadata(), "First update");

        PortalPoolImplementation(portal).setMetadata("Second update");
        assertEq(IPortalPool(portal).getMetadata(), "Second update");

        PortalPoolImplementation(portal).setMetadata("");
        assertEq(IPortalPool(portal).getMetadata(), "");

        vm.stopPrank();
    }

    function test_getOperator_returnsCurrentOperator() public {
        // Initially returns original operator
        assertEq(PortalPoolImplementation(portal).getOperator(), operator);

        // After transfer, returns new operator
        vm.prank(operator);
        PortalPoolImplementation(portal).transferOperator(newOperator);

        assertEq(PortalPoolImplementation(portal).getOperator(), newOperator);
    }

    function test_registryReadsOperatorFromPool() public {
        bytes32 clusterId = registry.getClusterIdByAddress(portal);

        // Original operator can call setClusterMetadata on registry
        vm.prank(operator);
        registry.setClusterMetadata(clusterId, "Set by original operator");

        // Transfer operator
        vm.prank(operator);
        PortalPoolImplementation(portal).transferOperator(newOperator);

        // New operator can call setClusterMetadata on registry
        vm.prank(newOperator);
        registry.setClusterMetadata(clusterId, "Set by new operator");

        assertEq(IPortalPool(portal).getMetadata(), "Set by new operator");

        // Old operator cannot call setClusterMetadata on registry anymore
        vm.prank(operator);
        vm.expectRevert();
        registry.setClusterMetadata(clusterId, "Should fail");
    }
}
