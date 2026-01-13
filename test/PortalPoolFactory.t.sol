// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./BaseTest.sol";
import {PoolErrors} from "../src/libs/PoolErrors.sol";
import {Constants} from "../src/libs/Constants.sol";
import {PortalPoolImplementation} from "../src/PortalPoolImplementation.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract PortalPoolFactoryTest is BaseTest {
    function setUp() public override {
        super.setUp();
    }

    /// @dev Calculate minimum rate to satisfy precision requirement: rate >= capacity / 1e12
    function _minRateForCapacity(uint256 capacity) internal pure returns (uint256) {
        uint256 minRate = capacity / 1e12;
        return minRate < 1000 ? 1000 : minRate;
    }

    function test_Constructor_SetsCorrectValues() public view {
        assertEq(factory.portalRegistry(), address(registry));
        assertEq(factory.feeRouter(), address(feeRouter));
        assertEq(factory.sqd(), address(sqd));
        assertEq(factory.defaultMaxStakePerWallet(), DEFAULT_MAX_STAKE_PER_WALLET);
        assertEq(factory.minStakeThreshold(), MIN_STAKE_THRESHOLD);
        assertEq(factory.workerEpochLength(), WORKER_EPOCH_LENGTH);
    }

    function test_Initialize_RevertOnZeroAddresses() public {
        PortalPoolFactory newFactoryImpl = new PortalPoolFactory();
        vm.expectRevert(PoolErrors.InvalidAddress.selector);
        new ERC1967Proxy(
            address(newFactoryImpl),
            abi.encodeWithSelector(
                PortalPoolFactory.initialize.selector,
                address(0),
                address(registry),
                address(feeRouter),
                address(sqd),
                DEFAULT_MAX_STAKE_PER_WALLET,
                MIN_STAKE_THRESHOLD,
                WORKER_EPOCH_LENGTH
            )
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
        uint256 rate = _minRateForCapacity(MIN_STAKE_THRESHOLD);
        uint256 initialDeposit = rate * 1 days / 1000;

        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: MIN_STAKE_THRESHOLD,
            tokenSuffix: "TestPortal",
            distributionRatePerSecond: rate,
            initialDeposit: initialDeposit,
            metadata: "",
            rewardToken: address(usdc)
        });

        usdc.approve(address(factory), initialDeposit);

        vm.expectEmit(false, true, true, false);
        emit IPortalFactory.PoolCreated(address(0), operator, address(usdc), MIN_STAKE_THRESHOLD, rate, initialDeposit, "TestPortal", "");

        factory.createPortalPool(params);
    }

    function test_CreatePortal_RevertOnZeroOperator() public {
        uint256 rate = 1000 * 1000;
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: address(0),
            capacity: MIN_STAKE_THRESHOLD,
            tokenSuffix: "TestPortal",
            distributionRatePerSecond: rate,
            initialDeposit: rate * 1 days / 1000,
            metadata: "",
            rewardToken: address(usdc)
        });

        vm.expectRevert(PoolErrors.InvalidAddress.selector);
        factory.createPortalPool(params);
    }

    function test_CreatePortal_RevertOnCapacityBelowMinimum() public {
        uint256 rate = 1000 * 1000;
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: MIN_STAKE_THRESHOLD - 1,
            tokenSuffix: "TestPortal",
            distributionRatePerSecond: rate,
            initialDeposit: rate * 1 days / 1000,
            metadata: "",
            rewardToken: address(usdc)
        });

        vm.expectRevert(PoolErrors.BelowMinimum.selector);
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

    function test_CreatePortal_RevertWhenPaused() public {
        factory.pause();

        uint256 rate = 1000 * 1000;
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: MIN_STAKE_THRESHOLD,
            tokenSuffix: "TestPortal",
            distributionRatePerSecond: rate,
            initialDeposit: rate * 1 days / 1000,
            metadata: "",
            rewardToken: address(usdc)
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
        vm.expectRevert(PoolErrors.InvalidAddress.selector);
        factory.addPaymentToken(address(0));
    }

    function test_AddPaymentToken_RevertOnDuplicate() public {
        vm.expectRevert(PoolErrors.TokenAlreadyAdded.selector);
        factory.addPaymentToken(address(usdc));
    }

    function test_AddPaymentToken_RevertOnTooManyTokens() public {
        for (uint256 i = 2; i < Constants.MAX_PAYMENT_TOKENS; i++) {
            MockERC20 token = new MockERC20("Token", "TKN", 18);
            factory.addPaymentToken(address(token));
        }

        MockERC20 extraToken = new MockERC20("Extra", "EXT", 18);
        vm.expectRevert(PoolErrors.TooManyTokens.selector);
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

        vm.expectRevert(PoolErrors.TokenNotAllowed.selector);
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
        vm.expectRevert(PoolErrors.InvalidAddress.selector);
        factory.upgradeBeacon(address(0));
    }

    function test_UpgradeBeacon_RevertOnNonAdmin() public {
        PortalPoolImplementation newImpl = new PortalPoolImplementation();

        vm.prank(user1);
        vm.expectRevert();
        factory.upgradeBeacon(address(newImpl));
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
        uint256 oldValue = factory.exitUnlockRatePerSecond();
        uint256 newValue = 2e18;

        vm.expectEmit(true, true, false, false);
        emit IPortalFactory.ExitUnlockRateUpdated(oldValue, newValue);

        factory.setExitUnlockRate(newValue);

        assertEq(factory.exitUnlockRatePerSecond(), newValue);
    }

    function test_SetExitUnlockRate_RevertOnNonAdmin() public {
        vm.prank(user1);
        vm.expectRevert();
        factory.setExitUnlockRate(2e18);
    }

    function test_SetCollectionDeadline_Success() public {
        uint256 oldValue = factory.collectionDeadlineSeconds();
        uint256 newValue = 14 days;

        vm.expectEmit(true, true, false, false);
        emit IPortalFactory.CollectionDeadlineUpdated(oldValue, newValue);

        factory.setCollectionDeadline(newValue);

        assertEq(factory.collectionDeadlineSeconds(), newValue);
    }

    function test_SetCollectionDeadline_RevertOnNonAdmin() public {
        vm.prank(user1);
        vm.expectRevert();
        factory.setCollectionDeadline(14 days);
    }

    function test_CreatePortal_RevertOnDisallowedRewardToken() public {
        MockERC20 unknownToken = new MockERC20("Unknown", "UNK", 18);

        uint256 rate = 1000 * 1000;
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: MIN_STAKE_THRESHOLD,
            tokenSuffix: "TestPortal",
            distributionRatePerSecond: rate,
            initialDeposit: rate * 1 days / 1000,
            metadata: "",
            rewardToken: address(unknownToken)
        });

        vm.expectRevert(PoolErrors.TokenNotAllowed.selector);
        factory.createPortalPool(params);
    }

    function test_CreatePortal_RevertOnZeroRewardToken() public {
        uint256 rate = 1000 * 1000;
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: MIN_STAKE_THRESHOLD,
            tokenSuffix: "TestPortal",
            distributionRatePerSecond: rate,
            initialDeposit: rate * 1 days / 1000,
            metadata: "",
            rewardToken: address(0)
        });

        vm.expectRevert(PoolErrors.InvalidAddress.selector);
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
}
