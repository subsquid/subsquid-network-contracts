// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./BaseTest.sol";
import {PortalErrors} from "../src/libs/PortalErrors.sol";
import {Constants} from "../src/libs/Constants.sol";
import {PortalPoolImplementation} from "../src/PortalPoolImplementation.sol";

contract PortalPoolFactoryTest is BaseTest {
    function setUp() public override {
        super.setUp();
    }

    function test_Constructor_SetsCorrectValues() public view {
        assertEq(factory.portalRegistry(), address(registry));
        assertEq(factory.feeRouter(), address(feeRouter));
        assertEq(factory.networkController(), address(networkController));
        assertEq(factory.sqd(), address(sqd));
        assertEq(factory.usdc(), address(usdc));
        assertEq(factory.defaultMaxStakePerWallet(), DEFAULT_MAX_STAKE_PER_WALLET);
    }

    function test_Constructor_RevertOnZeroAddresses() public {
        vm.expectRevert(PortalErrors.InvalidAddress.selector);
        new PortalPoolFactory(
            address(0),
            address(registry),
            address(feeRouter),
            address(networkController),
            address(sqd),
            address(usdc),
            DEFAULT_MAX_STAKE_PER_WALLET
        );
    }

    function test_CreatePortal_Success() public {
        address portal = _createPortal(operator, MIN_STAKE_THRESHOLD, "TestPortal");

        assertTrue(portal != address(0));
        assertTrue(factory.isPortal(portal));
        assertEq(factory.portalCount(), 1);
        assertEq(factory.allPortals(0), portal);
    }

    function test_CreatePortal_EmitsEvent() public {
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: MIN_STAKE_THRESHOLD,
            peerId: "test-peer-id",
            tokenSuffix: "TestPortal",
            distributionRatePerSecond: 1 ether,
            metadata: ""
        });

        vm.expectEmit(true, true, false, false);
        emit IPortalFactory.PortalCreated(address(0), operator, MIN_STAKE_THRESHOLD, 1 ether, "TestPortal", "");

        factory.createPortalPool(params);
    }

    function test_CreatePortal_RevertOnZeroOperator() public {
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: address(0),
            capacity: MIN_STAKE_THRESHOLD,
            peerId: "test-peer-id",
            tokenSuffix: "TestPortal",
            distributionRatePerSecond: 1 ether,
            metadata: ""
        });

        vm.expectRevert(PortalErrors.InvalidAddress.selector);
        factory.createPortalPool(params);
    }

    function test_CreatePortal_RevertOnCapacityBelowMinimum() public {
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: MIN_STAKE_THRESHOLD - 1,
            peerId: "test-peer-id",
            tokenSuffix: "TestPortal",
            distributionRatePerSecond: 1 ether,
            metadata: ""
        });

        vm.expectRevert(PortalErrors.BelowMinimum.selector);
        factory.createPortalPool(params);
    }

    function test_CreatePortal_RevertOnEmptyPeerId() public {
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: MIN_STAKE_THRESHOLD,
            peerId: "",
            tokenSuffix: "TestPortal",
            distributionRatePerSecond: 1 ether,
            metadata: ""
        });

        vm.expectRevert(PortalErrors.EmptyPeerId.selector);
        factory.createPortalPool(params);
    }

    function test_CreatePortal_MultiplePortals() public {
        address portal1 = _createPortal(operator, MIN_STAKE_THRESHOLD, "Portal1");
        address portal2 = _createPortal(user1, MIN_STAKE_THRESHOLD * 2, "Portal2");
        address portal3 = _createPortal(user2, MIN_STAKE_THRESHOLD * 3, "Portal3");

        assertEq(factory.portalCount(), 3);
        assertEq(factory.allPortals(0), portal1);
        assertEq(factory.allPortals(1), portal2);
        assertEq(factory.allPortals(2), portal3);

        address[] memory operatorPortals = factory.getOperatorPortals(operator);
        assertEq(operatorPortals.length, 1);
        assertEq(operatorPortals[0], portal1);
    }

    function test_CreatePortal_SameOperatorMultiplePools() public {
        address portal1 = _createPortal(operator, MIN_STAKE_THRESHOLD, "OperatorPool1");
        address portal2 = _createPortal(operator, MIN_STAKE_THRESHOLD * 2, "OperatorPool2");
        address portal3 = _createPortal(operator, MIN_STAKE_THRESHOLD * 3, "OperatorPool3");

        assertEq(factory.portalCount(), 3);

        address[] memory operatorPortals = factory.getOperatorPortals(operator);
        assertEq(operatorPortals.length, 3);
        assertEq(operatorPortals[0], portal1);
        assertEq(operatorPortals[1], portal2);
        assertEq(operatorPortals[2], portal3);

        // Verify all are registered as portals
        assertTrue(factory.isPortal(portal1));
        assertTrue(factory.isPortal(portal2));
        assertTrue(factory.isPortal(portal3));
    }

    function test_CreatePortal_SameOperator100Pools() public {
        uint256 numPortals = 100;
        address[] memory createdPortals = new address[](numPortals);

        for (uint256 i = 0; i < numPortals; i++) {
            createdPortals[i] = _createPortal(operator, MIN_STAKE_THRESHOLD, string(abi.encodePacked("Pool", i)));
        }

        assertEq(factory.portalCount(), numPortals);
        assertEq(factory.operatorPortalCount(operator), numPortals);

        // Verify getOperatorPortals returns all 100
        address[] memory operatorPortals = factory.getOperatorPortals(operator);
        assertEq(operatorPortals.length, numPortals);

        // Spot check first, middle, and last
        assertEq(operatorPortals[0], createdPortals[0]);
        assertEq(operatorPortals[50], createdPortals[50]);
        assertEq(operatorPortals[99], createdPortals[99]);
    }

    function test_GetOperatorPortalsPaginated() public {
        // Create 10 portals
        address[] memory createdPortals = new address[](10);
        for (uint256 i = 0; i < 10; i++) {
            createdPortals[i] =
                _createPortal(operator, MIN_STAKE_THRESHOLD, string(abi.encodePacked("PaginatedPool", i)));
        }

        // Get first page (0-4)
        address[] memory page1 = factory.getOperatorPortalsPaginated(operator, 0, 5);
        assertEq(page1.length, 5);
        assertEq(page1[0], createdPortals[0]);
        assertEq(page1[4], createdPortals[4]);

        // Get second page (5-9)
        address[] memory page2 = factory.getOperatorPortalsPaginated(operator, 5, 5);
        assertEq(page2.length, 5);
        assertEq(page2[0], createdPortals[5]);
        assertEq(page2[4], createdPortals[9]);

        // Get partial page (request more than available)
        address[] memory page3 = factory.getOperatorPortalsPaginated(operator, 8, 5);
        assertEq(page3.length, 2); // Only 2 remaining
        assertEq(page3[0], createdPortals[8]);
        assertEq(page3[1], createdPortals[9]);

        // Get empty page (offset beyond total)
        address[] memory page4 = factory.getOperatorPortalsPaginated(operator, 100, 5);
        assertEq(page4.length, 0);
    }

    function test_CreatePortal_UsesDefaultMaxStakePerWallet() public {
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: MIN_STAKE_THRESHOLD,
            peerId: "test-peer-id",
            tokenSuffix: "TestPortal",
            distributionRatePerSecond: 1 ether,
            metadata: ""
        });

        address portal = factory.createPortalPool(params);
        // maxStakePerWallet is now a global value in factory, not per-portal
        assertEq(factory.defaultMaxStakePerWallet(), DEFAULT_MAX_STAKE_PER_WALLET);
    }

    function test_CreatePortal_RevertWhenPaused() public {
        factory.pause();

        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: MIN_STAKE_THRESHOLD,
            peerId: "test-peer-id",
            tokenSuffix: "TestPortal",
            distributionRatePerSecond: 1 ether,
            metadata: ""
        });

        vm.expectRevert();
        factory.createPortalPool(params);
    }

    function test_AddPaymentToken_Success() public {
        MockERC20 newToken = new MockERC20("New Token", "NEW", 18);

        vm.expectEmit(true, false, false, false);
        emit IPortalFactory.PaymentTokenAdded(address(newToken));

        factory.addPaymentToken(address(newToken));

        assertTrue(factory.isAllowedPaymentToken(address(newToken)));
    }

    function test_AddPaymentToken_RevertOnZeroAddress() public {
        vm.expectRevert(PortalErrors.InvalidAddress.selector);
        factory.addPaymentToken(address(0));
    }

    function test_AddPaymentToken_RevertOnDuplicate() public {
        vm.expectRevert(PortalErrors.TokenAlreadyAdded.selector);
        factory.addPaymentToken(address(usdc));
    }

    function test_AddPaymentToken_RevertOnTooManyTokens() public {
        for (uint256 i = 2; i < Constants.MAX_PAYMENT_TOKENS; i++) {
            MockERC20 token = new MockERC20("Token", "TKN", 18);
            factory.addPaymentToken(address(token));
        }

        MockERC20 extraToken = new MockERC20("Extra", "EXT", 18);
        vm.expectRevert(PortalErrors.TooManyTokens.selector);
        factory.addPaymentToken(address(extraToken));
    }

    function test_AddPaymentToken_RevertOnNonAdmin() public {
        MockERC20 newToken = new MockERC20("New Token", "NEW", 18);

        vm.prank(user1);
        vm.expectRevert();
        factory.addPaymentToken(address(newToken));
    }

    function test_RemovePaymentToken_Success() public {
        vm.expectEmit(true, false, false, false);
        emit IPortalFactory.PaymentTokenRemoved(address(dai));

        factory.removePaymentToken(address(dai));

        assertFalse(factory.isAllowedPaymentToken(address(dai)));
    }

    function test_RemovePaymentToken_RevertOnNotAllowed() public {
        MockERC20 unknownToken = new MockERC20("Unknown", "UNK", 18);

        vm.expectRevert(PortalErrors.TokenNotAllowed.selector);
        factory.removePaymentToken(address(unknownToken));
    }

    function test_GetAllowedPaymentTokens() public view {
        address[] memory tokens = factory.getAllowedPaymentTokens();

        assertEq(tokens.length, 2);
        assertEq(tokens[0], address(usdc));
        assertEq(tokens[1], address(dai));
    }

    function test_SetDefaultMaxStakePerWallet() public {
        uint256 newMaxStake = 2_000_000 ether;

        vm.expectEmit(true, true, false, false);
        emit IPortalFactory.DefaultMaxStakePerWalletUpdated(DEFAULT_MAX_STAKE_PER_WALLET, newMaxStake);

        factory.setDefaultMaxStakePerWallet(newMaxStake);

        assertEq(factory.defaultMaxStakePerWallet(), newMaxStake);
    }

    function test_SetUsdc() public {
        address newUsdc = address(new MockERC20("New USDC", "USDC2", 6));

        vm.expectEmit(true, true, false, false);
        emit IPortalFactory.UsdcUpdated(address(usdc), newUsdc);

        factory.setUsdc(newUsdc);

        assertEq(factory.usdc(), newUsdc);
    }

    function test_SetUsdc_RevertOnZeroAddress() public {
        vm.expectRevert(PortalErrors.InvalidAddress.selector);
        factory.setUsdc(address(0));
    }

    function test_Pause_Success() public {
        factory.pause();
        assertTrue(factory.paused());
    }

    function test_Unpause_Success() public {
        factory.pause();
        factory.unpause();
        assertFalse(factory.paused());
    }

    function test_Pause_RevertOnNonPauser() public {
        vm.prank(user1);
        vm.expectRevert();
        factory.pause();
    }

    function test_UpgradeBeacon_Success() public {
        PortalPoolImplementation newImpl = new PortalPoolImplementation();

        vm.expectEmit(true, false, false, false);
        emit IPortalFactory.BeaconUpgraded(address(newImpl));

        factory.upgradeBeacon(address(newImpl));
    }

    function test_UpgradeBeacon_RevertOnZeroAddress() public {
        vm.expectRevert(PortalErrors.InvalidAddress.selector);
        factory.upgradeBeacon(address(0));
    }

    function test_UpgradeBeacon_RevertOnNonAdmin() public {
        PortalPoolImplementation newImpl = new PortalPoolImplementation();

        vm.prank(user1);
        vm.expectRevert();
        factory.upgradeBeacon(address(newImpl));
    }

    function test_GetPortalCount() public {
        assertEq(factory.getPortalCount(), 0);

        _createPortal(operator, MIN_STAKE_THRESHOLD, "Portal1");
        assertEq(factory.getPortalCount(), 1);

        _createPortal(operator, MIN_STAKE_THRESHOLD, "Portal2");
        assertEq(factory.getPortalCount(), 2);
    }

    function test_GetOperatorPortals() public {
        address portal1 = _createPortal(operator, MIN_STAKE_THRESHOLD, "Portal1");
        address portal2 = _createPortal(operator, MIN_STAKE_THRESHOLD, "Portal2");
        _createPortal(user1, MIN_STAKE_THRESHOLD, "Portal3");

        address[] memory portals = factory.getOperatorPortals(operator);
        assertEq(portals.length, 2);
        assertEq(portals[0], portal1);
        assertEq(portals[1], portal2);
    }

    function test_IsPortal() public {
        address portal = _createPortal(operator, MIN_STAKE_THRESHOLD, "Portal1");

        assertTrue(factory.isPortal(portal));
        assertFalse(factory.isPortal(address(0x999)));
    }

    function test_SetMaxPaymentTokens_Success() public {
        uint256 newValue = 20;

        vm.expectEmit(true, true, false, false);
        emit IPortalFactory.MaxPaymentTokensUpdated(Constants.MAX_PAYMENT_TOKENS, newValue);

        factory.setMaxPaymentTokens(newValue);

        assertEq(factory.maxPaymentTokens(), newValue);
    }

    function test_SetMaxPaymentTokens_RevertOnNonAdmin() public {
        vm.prank(user1);
        vm.expectRevert();
        factory.setMaxPaymentTokens(20);
    }

    function test_SetExitUnlockRate_Success() public {
        uint256 newValue = 2e18;

        vm.expectEmit(true, true, false, false);
        emit IPortalFactory.ExitUnlockRateUpdated(Constants.EXIT_UNLOCK_RATE_PER_SECOND, newValue);

        factory.setExitUnlockRate(newValue);

        assertEq(factory.exitUnlockRatePerSecond(), newValue);
    }

    function test_SetExitUnlockRate_RevertOnNonAdmin() public {
        vm.prank(user1);
        vm.expectRevert();
        factory.setExitUnlockRate(2e18);
    }

    function test_SetCollectionDeadline_Success() public {
        uint256 newValue = 14 days;

        vm.expectEmit(true, true, false, false);
        emit IPortalFactory.CollectionDeadlineUpdated(Constants.COLLECTION_DEADLINE_SECONDS, newValue);

        factory.setCollectionDeadline(newValue);

        assertEq(factory.collectionDeadlineSeconds(), newValue);
    }

    function test_SetCollectionDeadline_RevertOnNonAdmin() public {
        vm.prank(user1);
        vm.expectRevert();
        factory.setCollectionDeadline(14 days);
    }

    function test_CreatePortal_RevertOnNoPaymentTokens() public {
        factory.removePaymentToken(address(usdc));
        factory.removePaymentToken(address(dai));

        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: MIN_STAKE_THRESHOLD,
            peerId: "test-peer-id",
            tokenSuffix: "TestPortal",
            distributionRatePerSecond: 1 ether,
            metadata: ""
        });

        vm.expectRevert(PortalErrors.NoPaymentTokens.selector);
        factory.createPortalPool(params);
    }

    function test_Unpause_RevertOnNonPauser() public {
        factory.pause();
        vm.prank(user1);
        vm.expectRevert();
        factory.unpause();
    }

    function test_SetDefaultMaxStakePerWallet_RevertOnNonAdmin() public {
        vm.prank(user1);
        vm.expectRevert();
        factory.setDefaultMaxStakePerWallet(2_000_000 ether);
    }

    function test_SetUsdc_RevertOnNonAdmin() public {
        vm.prank(user1);
        vm.expectRevert();
        factory.setUsdc(address(0x123));
    }
}
