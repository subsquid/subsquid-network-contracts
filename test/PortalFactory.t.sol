// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {PortalFactory} from "../src/PortalFactory.sol";
import {PortalImplementation} from "../src/PortalImplementation.sol";
import {GatewayRegistry} from "../src/GatewayRegistry.sol";
import {FeeRouterModule} from "../src/FeeRouterModule.sol";
import {MockNetworkController} from "./mocks/MockNetworkController.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {FactoryErrors} from "../src/libs/FactoryErrors.sol";
import {IPortalFactory} from "../src/interfaces/IPortalFactory.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

contract PortalFactoryTest is Test {
    PortalFactory public factory;
    PortalImplementation public portalImpl;
    PortalImplementation public portalImplV2;
    GatewayRegistry public registry;
    FeeRouterModule public feeRouter;
    MockNetworkController public networkController;
    MockERC20 public sqd;
    MockERC20 public paymentToken;

    address public admin = address(this);
    address public operator = address(0x1);
    address public pauser = address(0x2);
    address public user = address(0x3);

    uint256 public constant MIN_STAKE = 100_000 ether;
    uint256 public constant MANA = 1000;
    address public workerRewardPool = address(0x4);

    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    function setUp() public {
        sqd = new MockERC20("SQD", "SQD", 18);
        paymentToken = new MockERC20("USDC", "USDC", 6);

        networkController = new MockNetworkController(7200, MIN_STAKE, workerRewardPool);
        registry = new GatewayRegistry(address(sqd), address(networkController), MIN_STAKE, MANA);
        feeRouter = new FeeRouterModule();
        portalImpl = new PortalImplementation();
        portalImplV2 = new PortalImplementation();

        factory = new PortalFactory(
            address(portalImpl),
            address(registry),
            address(feeRouter),
            address(networkController),
            address(sqd),
            MIN_STAKE
        );

        factory.grantRole(PAUSER_ROLE, pauser);

        sqd.mint(operator, 100_000_000 ether);
        paymentToken.mint(operator, 1_000_000 ether);

        vm.prank(operator);
        sqd.approve(address(registry), type(uint256).max);
    }

    function _tokens(address t) internal pure returns (address[] memory) {
        address[] memory arr = new address[](1);
        arr[0] = t;
        return arr;
    }

    function _tokens2(address t1, address t2) internal pure returns (address[] memory) {
        address[] memory arr = new address[](2);
        arr[0] = t1;
        arr[1] = t2;
        return arr;
    }

    function testConstructorSetsValues() public view {
        assertEq(factory.implementation(), address(portalImpl));
        assertEq(factory.gatewayRegistry(), address(registry));
        assertEq(factory.feeRouter(), address(feeRouter));
        assertEq(factory.networkController(), address(networkController));
        assertEq(factory.sqd(), address(sqd));
        assertEq(factory.minStakeThreshold(), MIN_STAKE);
    }

    function testConstructorGrantsRoles() public view {
        assertTrue(factory.hasRole(DEFAULT_ADMIN_ROLE, admin));
        assertTrue(factory.hasRole(PAUSER_ROLE, admin));
    }

    function testConstructorRevertsZeroImplementation() public {
        vm.expectRevert(FactoryErrors.InvalidAddress.selector);
        new PortalFactory(
            address(0), address(registry), address(feeRouter), address(networkController), address(sqd), MIN_STAKE
        );
    }

    function testConstructorRevertsZeroRegistry() public {
        vm.expectRevert(FactoryErrors.InvalidAddress.selector);
        new PortalFactory(
            address(portalImpl), address(0), address(feeRouter), address(networkController), address(sqd), MIN_STAKE
        );
    }

    function testConstructorRevertsZeroFeeRouter() public {
        vm.expectRevert(FactoryErrors.InvalidAddress.selector);
        new PortalFactory(
            address(portalImpl), address(registry), address(0), address(networkController), address(sqd), MIN_STAKE
        );
    }

    function testConstructorRevertsZeroNetworkController() public {
        vm.expectRevert(FactoryErrors.InvalidAddress.selector);
        new PortalFactory(
            address(portalImpl), address(registry), address(feeRouter), address(0), address(sqd), MIN_STAKE
        );
    }

    function testConstructorRevertsZeroSqd() public {
        vm.expectRevert(FactoryErrors.InvalidAddress.selector);
        new PortalFactory(
            address(portalImpl),
            address(registry),
            address(feeRouter),
            address(networkController),
            address(0),
            MIN_STAKE
        );
    }

    function testCreatePortal() public {
        address portal =
            factory.createPortal(operator, _tokens(address(paymentToken)), MIN_STAKE, block.number + 100, "peerId");

        assertTrue(portal != address(0));
        assertTrue(factory.isPortal(portal));
        assertEq(factory.getPortalCount(), 1);
        assertEq(factory.allPortals(0), portal);
    }

    function testCreatePortalEmitsEvents() public {
        vm.expectEmit(false, true, false, true);
        emit IPortalFactory.PortalCreated(address(0), operator, "peerId");

        factory.createPortal(operator, _tokens(address(paymentToken)), MIN_STAKE, block.number + 100, "peerId");
    }

    function testCreatePortalTracksOperatorPortals() public {
        address portal1 =
            factory.createPortal(operator, _tokens(address(paymentToken)), MIN_STAKE, block.number + 100, "peer1");
        address portal2 =
            factory.createPortal(operator, _tokens(address(paymentToken)), MIN_STAKE, block.number + 100, "peer2");

        address[] memory portals = factory.getOperatorPortals(operator);
        assertEq(portals.length, 2);
        assertEq(portals[0], portal1);
        assertEq(portals[1], portal2);
    }

    function testCreatePortalRevertsZeroOperator() public {
        vm.expectRevert(FactoryErrors.InvalidAddress.selector);
        factory.createPortal(address(0), _tokens(address(paymentToken)), MIN_STAKE, block.number + 100, "peerId");
    }

    function testCreatePortalRevertsNoPaymentTokens() public {
        address[] memory empty = new address[](0);
        vm.expectRevert(FactoryErrors.NoPaymentTokens.selector);
        factory.createPortal(operator, empty, MIN_STAKE, block.number + 100, "peerId");
    }

    function testCreatePortalRevertsBelowMinimum() public {
        vm.expectRevert(FactoryErrors.BelowMinimum.selector);
        factory.createPortal(operator, _tokens(address(paymentToken)), MIN_STAKE - 1, block.number + 100, "peerId");
    }

    function testCreatePortalRevertsInvalidDeadline() public {
        vm.expectRevert(FactoryErrors.InvalidDeadline.selector);
        factory.createPortal(operator, _tokens(address(paymentToken)), MIN_STAKE, block.number, "peerId");
    }

    function testCreatePortalRevertsEmptyPeerId() public {
        vm.expectRevert(FactoryErrors.EmptyPeerId.selector);
        factory.createPortal(operator, _tokens(address(paymentToken)), MIN_STAKE, block.number + 100, "");
    }

    function testCreatePortalRevertsZeroAddressToken() public {
        vm.expectRevert(FactoryErrors.InvalidAddress.selector);
        factory.createPortal(operator, _tokens(address(0)), MIN_STAKE, block.number + 100, "peerId");
    }

    function testCreatePortalRevertsZeroAddressInTokenArray() public {
        vm.expectRevert(FactoryErrors.InvalidAddress.selector);
        factory.createPortal(
            operator, _tokens2(address(paymentToken), address(0)), MIN_STAKE, block.number + 100, "peerId"
        );
    }

    function testCreatePortalRevertsWhenPaused() public {
        vm.prank(pauser);
        factory.pause();

        vm.expectRevert();
        factory.createPortal(operator, _tokens(address(paymentToken)), MIN_STAKE, block.number + 100, "peerId");
    }

    function testUpgradePortal() public {
        address portal =
            factory.createPortal(operator, _tokens(address(paymentToken)), MIN_STAKE, block.number + 100, "peerId");

        vm.expectRevert();
        factory.upgradePortal(portal, address(portalImplV2));
    }

    function testUpgradePortalRevertsInvalidPortal() public {
        vm.expectRevert(FactoryErrors.InvalidPortal.selector);
        factory.upgradePortal(address(0x999), address(portalImplV2));
    }

    function testUpgradePortalRevertsZeroImplementation() public {
        address portal =
            factory.createPortal(operator, _tokens(address(paymentToken)), MIN_STAKE, block.number + 100, "peerId");

        vm.expectRevert(FactoryErrors.InvalidAddress.selector);
        factory.upgradePortal(portal, address(0));
    }

    function testUpgradePortalRevertsNotAdmin() public {
        address portal =
            factory.createPortal(operator, _tokens(address(paymentToken)), MIN_STAKE, block.number + 100, "peerId");

        vm.prank(user);
        vm.expectRevert();
        factory.upgradePortal(portal, address(portalImplV2));
    }

    function testUpgradeAllPortals() public {
        factory.createPortal(operator, _tokens(address(paymentToken)), MIN_STAKE, block.number + 100, "peer1");
        factory.createPortal(operator, _tokens(address(paymentToken)), MIN_STAKE, block.number + 100, "peer2");
        factory.createPortal(operator, _tokens(address(paymentToken)), MIN_STAKE, block.number + 100, "peer3");

        vm.expectRevert();
        factory.upgradeAllPortals(address(portalImplV2));
    }

    function testUpgradeAllPortalsRevertsZeroImplementation() public {
        factory.createPortal(operator, _tokens(address(paymentToken)), MIN_STAKE, block.number + 100, "peerId");

        vm.expectRevert(FactoryErrors.InvalidAddress.selector);
        factory.upgradeAllPortals(address(0));
    }

    function testUpgradeAllPortalsRevertsNotAdmin() public {
        factory.createPortal(operator, _tokens(address(paymentToken)), MIN_STAKE, block.number + 100, "peerId");

        vm.prank(user);
        vm.expectRevert();
        factory.upgradeAllPortals(address(portalImplV2));
    }

    function testUpgradePortalsBatch() public {
        factory.createPortal(operator, _tokens(address(paymentToken)), MIN_STAKE, block.number + 100, "peer1");
        factory.createPortal(operator, _tokens(address(paymentToken)), MIN_STAKE, block.number + 100, "peer2");
        factory.createPortal(operator, _tokens(address(paymentToken)), MIN_STAKE, block.number + 100, "peer3");

        vm.expectRevert();
        factory.upgradePortalsBatch(address(portalImplV2), 0, 2);
    }

    function testUpgradePortalsBatchRevertsZeroImplementation() public {
        factory.createPortal(operator, _tokens(address(paymentToken)), MIN_STAKE, block.number + 100, "peerId");

        vm.expectRevert(FactoryErrors.InvalidAddress.selector);
        factory.upgradePortalsBatch(address(0), 0, 1);
    }

    function testUpgradePortalsBatchRevertsEndIndexTooLarge() public {
        factory.createPortal(operator, _tokens(address(paymentToken)), MIN_STAKE, block.number + 100, "peerId");

        vm.expectRevert(FactoryErrors.InvalidRange.selector);
        factory.upgradePortalsBatch(address(portalImplV2), 0, 10);
    }

    function testUpgradePortalsBatchRevertsStartGteEnd() public {
        factory.createPortal(operator, _tokens(address(paymentToken)), MIN_STAKE, block.number + 100, "peerId");

        vm.expectRevert(FactoryErrors.InvalidRange.selector);
        factory.upgradePortalsBatch(address(portalImplV2), 1, 1);
    }

    function testUpgradePortalsBatchRevertsStartGreaterThanEnd() public {
        factory.createPortal(operator, _tokens(address(paymentToken)), MIN_STAKE, block.number + 100, "peer1");
        factory.createPortal(operator, _tokens(address(paymentToken)), MIN_STAKE, block.number + 100, "peer2");

        vm.expectRevert(FactoryErrors.InvalidRange.selector);
        factory.upgradePortalsBatch(address(portalImplV2), 2, 1);
    }

    function testUpgradePortalsBatchRevertsNotAdmin() public {
        factory.createPortal(operator, _tokens(address(paymentToken)), MIN_STAKE, block.number + 100, "peerId");

        vm.prank(user);
        vm.expectRevert();
        factory.upgradePortalsBatch(address(portalImplV2), 0, 1);
    }

    function testPause() public {
        vm.prank(pauser);
        factory.pause();

        assertTrue(factory.paused());
    }

    function testPauseRevertsNotPauser() public {
        vm.prank(user);
        vm.expectRevert();
        factory.pause();
    }

    function testUnpause() public {
        vm.prank(pauser);
        factory.pause();

        vm.prank(pauser);
        factory.unpause();

        assertFalse(factory.paused());
    }

    function testUnpauseRevertsNotPauser() public {
        vm.prank(pauser);
        factory.pause();

        vm.prank(user);
        vm.expectRevert();
        factory.unpause();
    }

    function testSetImplementation() public {
        factory.setImplementation(address(portalImplV2));

        assertEq(factory.implementation(), address(portalImplV2));
    }

    function testSetImplementationRevertsZeroAddress() public {
        vm.expectRevert(FactoryErrors.InvalidAddress.selector);
        factory.setImplementation(address(0));
    }

    function testSetImplementationRevertsNotAdmin() public {
        vm.prank(user);
        vm.expectRevert();
        factory.setImplementation(address(portalImplV2));
    }

    function testSetMinStakeThreshold() public {
        uint256 newThreshold = 200_000 ether;

        factory.setMinStakeThreshold(newThreshold);

        assertEq(factory.minStakeThreshold(), newThreshold);
    }

    function testSetMinStakeThresholdRevertsNotAdmin() public {
        vm.prank(user);
        vm.expectRevert();
        factory.setMinStakeThreshold(200_000 ether);
    }

    function testGetPortalCount() public {
        assertEq(factory.getPortalCount(), 0);

        factory.createPortal(operator, _tokens(address(paymentToken)), MIN_STAKE, block.number + 100, "peer1");
        assertEq(factory.getPortalCount(), 1);

        factory.createPortal(operator, _tokens(address(paymentToken)), MIN_STAKE, block.number + 100, "peer2");
        assertEq(factory.getPortalCount(), 2);
    }

    function testGetOperatorPortalsEmpty() public view {
        address[] memory portals = factory.getOperatorPortals(user);
        assertEq(portals.length, 0);
    }

    function testIsPortalReturnsFalseForNonPortal() public view {
        assertFalse(factory.isPortal(address(0x999)));
    }

    function testMultipleTokensInCreatePortal() public {
        MockERC20 token2 = new MockERC20("DAI", "DAI", 18);

        address portal = factory.createPortal(
            operator, _tokens2(address(paymentToken), address(token2)), MIN_STAKE, block.number + 100, "peerId"
        );

        assertTrue(factory.isPortal(portal));
    }

    function testCreatePortalAfterUnpause() public {
        vm.prank(pauser);
        factory.pause();

        vm.prank(pauser);
        factory.unpause();

        address portal =
            factory.createPortal(operator, _tokens(address(paymentToken)), MIN_STAKE, block.number + 100, "peerId");

        assertTrue(factory.isPortal(portal));
    }
}
