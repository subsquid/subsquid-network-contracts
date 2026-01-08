// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./BaseTest.sol";
import {PortalErrors} from "../src/libs/PortalErrors.sol";
import {PortalPoolImplementation} from "../src/PortalPoolImplementation.sol";

contract WhitelistTest is BaseTest {
    address public pool;

    function setUp() public override {
        super.setUp();
        factory.setDefaultWhitelistEnabled(true);
        pool = _createPortal(operator, MIN_STAKE_THRESHOLD, "WhitelistPool");
    }

    function test_Deposit_RevertsWhenNotWhitelisted() public {
        vm.startPrank(user1);
        sqd.approve(pool, MIN_STAKE_THRESHOLD);
        vm.expectRevert(PortalErrors.NotWhitelisted.selector);
        IPortalPool(pool).deposit(MIN_STAKE_THRESHOLD);
        vm.stopPrank();
    }

    function test_Deposit_SucceedsWhenWhitelisted() public {
        address[] memory users = new address[](1);
        users[0] = user1;

        vm.prank(operator);
        IPortalPool(pool).addToWhitelist(users);

        vm.startPrank(user1);
        sqd.approve(pool, MIN_STAKE_THRESHOLD);
        IPortalPool(pool).deposit(MIN_STAKE_THRESHOLD);
        vm.stopPrank();

        assertEq(IPortalPool(pool).getProviderStake(user1), MIN_STAKE_THRESHOLD);
    }

    function test_Deposit_SucceedsWhenWhitelistDisabled() public {
        vm.prank(operator);
        IPortalPool(pool).setWhitelistEnabled(false);

        vm.startPrank(user1);
        sqd.approve(pool, MIN_STAKE_THRESHOLD);
        IPortalPool(pool).deposit(MIN_STAKE_THRESHOLD);
        vm.stopPrank();

        assertEq(IPortalPool(pool).getProviderStake(user1), MIN_STAKE_THRESHOLD);
    }

    function test_AddToWhitelist_Success() public {
        address[] memory users = new address[](2);
        users[0] = user1;
        users[1] = user2;

        vm.prank(operator);
        IPortalPool(pool).addToWhitelist(users);

        assertTrue(IPortalPool(pool).isWhitelisted(user1));
        assertTrue(IPortalPool(pool).isWhitelisted(user2));
        assertFalse(IPortalPool(pool).isWhitelisted(user3));
    }

    function test_RemoveFromWhitelist_Success() public {
        address[] memory users = new address[](2);
        users[0] = user1;
        users[1] = user2;

        vm.startPrank(operator);
        IPortalPool(pool).addToWhitelist(users);
        assertTrue(IPortalPool(pool).isWhitelisted(user1));

        address[] memory toRemove = new address[](1);
        toRemove[0] = user1;
        IPortalPool(pool).removeFromWhitelist(toRemove);
        vm.stopPrank();

        assertFalse(IPortalPool(pool).isWhitelisted(user1));
        assertTrue(IPortalPool(pool).isWhitelisted(user2));
    }

    function test_SetWhitelistEnabled_OperatorCanDisable() public {
        assertTrue(PortalPoolImplementation(pool).whitelistEnabled());

        vm.prank(operator);
        IPortalPool(pool).setWhitelistEnabled(false);

        assertFalse(PortalPoolImplementation(pool).whitelistEnabled());
    }

    function test_SetWhitelistEnabled_OperatorCanEnable() public {
        vm.prank(operator);
        IPortalPool(pool).setWhitelistEnabled(false);
        assertFalse(PortalPoolImplementation(pool).whitelistEnabled());

        vm.prank(operator);
        IPortalPool(pool).setWhitelistEnabled(true);
        assertTrue(PortalPoolImplementation(pool).whitelistEnabled());
    }

    function test_SetWhitelistEnabled_RevertsWhenFeatureDisabledAndEnabling() public {
        vm.prank(operator);
        IPortalPool(pool).setWhitelistEnabled(false);

        factory.setWhitelistFeatureEnabled(false);

        vm.prank(operator);
        vm.expectRevert(PortalErrors.WhitelistFeatureDisabled.selector);
        IPortalPool(pool).setWhitelistEnabled(true);
    }

    function test_SetWhitelistEnabled_CanAlwaysDisableEvenWhenFeatureOff() public {
        factory.setWhitelistFeatureEnabled(false);

        vm.prank(operator);
        IPortalPool(pool).setWhitelistEnabled(false);

        assertFalse(PortalPoolImplementation(pool).whitelistEnabled());
    }

    function test_Factory_DefaultWhitelistEnabledAffectsNewPools() public {
        factory.setDefaultWhitelistEnabled(true);
        address pool1 = _createPortal(operator, MIN_STAKE_THRESHOLD, "Pool1");
        assertTrue(PortalPoolImplementation(pool1).whitelistEnabled());

        factory.setDefaultWhitelistEnabled(false);
        address pool2 = _createPortal(operator, MIN_STAKE_THRESHOLD, "Pool2");
        assertFalse(PortalPoolImplementation(pool2).whitelistEnabled());
    }

    function test_Factory_WhitelistFeatureEnabledGatesOperatorEnable() public {
        factory.setDefaultWhitelistEnabled(false);
        address newPool = _createPortal(operator, MIN_STAKE_THRESHOLD, "NewPool");
        assertFalse(PortalPoolImplementation(newPool).whitelistEnabled());

        factory.setWhitelistFeatureEnabled(false);

        vm.prank(operator);
        vm.expectRevert(PortalErrors.WhitelistFeatureDisabled.selector);
        IPortalPool(newPool).setWhitelistEnabled(true);
    }

    function test_AddToWhitelist_RevertsOnNonOperator() public {
        address[] memory users = new address[](1);
        users[0] = user1;

        vm.prank(user2);
        vm.expectRevert(PortalErrors.NotOperator.selector);
        IPortalPool(pool).addToWhitelist(users);
    }

    function test_RemoveFromWhitelist_RevertsOnNonOperator() public {
        address[] memory users = new address[](1);
        users[0] = user1;

        vm.prank(user2);
        vm.expectRevert(PortalErrors.NotOperator.selector);
        IPortalPool(pool).removeFromWhitelist(users);
    }

    function test_SetWhitelistEnabled_RevertsOnNonOperator() public {
        vm.prank(user1);
        vm.expectRevert(PortalErrors.NotOperator.selector);
        IPortalPool(pool).setWhitelistEnabled(false);
    }

    function test_WhitelistEnabledChanged_EmitsEvent() public {
        vm.prank(operator);
        vm.expectEmit(true, true, true, true);
        emit IPortalPool.WhitelistEnabledChanged(false);
        IPortalPool(pool).setWhitelistEnabled(false);
    }

    function test_WhitelistUpdated_EmitsEvent() public {
        address[] memory users = new address[](1);
        users[0] = user1;

        vm.prank(operator);
        vm.expectEmit(true, true, true, true);
        emit IPortalPool.WhitelistUpdated(user1, true);
        IPortalPool(pool).addToWhitelist(users);
    }
}
