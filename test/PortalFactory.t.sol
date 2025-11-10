// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {PortalFactory} from "../src/PortalFactory.sol";
import {PortalPool} from "../src/PortalPool.sol";
import {GatewayRegistry} from "../src/GatewayRegistry.sol";
import {FeeRouterModule} from "../src/FeeRouterModule.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {Errors} from "../src/libs/Errors.sol";

contract PortalFactoryTest is Test {
    PortalFactory public factory;
    GatewayRegistry public gatewayRegistry;
    FeeRouterModule public feeRouter;
    MockERC20 public sqdToken;
    MockERC20 public usdcToken;

    address public owner;
    address public consumer;
    address public workerPool;

    uint256 constant MIN_STAKE = 1_000_000e18;

    function setUp() public {
        owner = address(this);
        consumer = makeAddr("consumer");
        workerPool = makeAddr("workerPool");

        sqdToken = new MockERC20("SQD Token", "SQD", 18);
        usdcToken = new MockERC20("USDC", "USDC", 6);

        gatewayRegistry = new GatewayRegistry(address(sqdToken), address(this));
        feeRouter = new FeeRouterModule(5000, 5000, workerPool);

        address[] memory supportedTokens = new address[](1);
        supportedTokens[0] = address(usdcToken);

        factory = new PortalFactory(supportedTokens, address(sqdToken), address(feeRouter), address(gatewayRegistry));

        gatewayRegistry.setPortalFactory(address(factory));

        sqdToken.mint(consumer, 100_000_000e18);
        usdcToken.mint(consumer, 1_000_000e6);

        vm.startPrank(consumer);
        sqdToken.approve(address(factory), type(uint256).max);
        usdcToken.approve(address(factory), type(uint256).max);
        vm.stopPrank();
    }

    function testConstructor() public view {
        assertTrue(factory.supportedPaymentTokens(address(usdcToken)));
        assertEq(address(factory.SQD()), address(sqdToken));
        assertEq(address(factory.gatewayRegistry()), address(gatewayRegistry));
        assertEq(address(factory.feeRouter()), address(feeRouter));
    }

    function testConstructorZeroSQDAddress() public {
        address[] memory supportedTokens = new address[](0);
        vm.expectRevert(Errors.ZeroAddress.selector);
        new PortalFactory(supportedTokens, address(0), address(feeRouter), address(gatewayRegistry));
    }

    function testConstructorZeroFeeRouterAddress() public {
        address[] memory supportedTokens = new address[](0);
        vm.expectRevert(Errors.ZeroAddress.selector);
        new PortalFactory(supportedTokens, address(sqdToken), address(0), address(gatewayRegistry));
    }

    function testConstructorZeroGatewayRegistryAddress() public {
        address[] memory supportedTokens = new address[](0);
        vm.expectRevert(Errors.ZeroAddress.selector);
        new PortalFactory(supportedTokens, address(sqdToken), address(feeRouter), address(0));
    }

    function testCreatePortal() public {
        uint256 targetSQD = 10_000_000e18;
        uint256 minimumSQD = MIN_STAKE;
        uint64 deadline = uint64(block.timestamp + 7 days);
        uint256 budget = 10_000e6;

        vm.prank(consumer);
        address portalAddr = factory.createPortal(consumer, targetSQD, minimumSQD, deadline, address(usdcToken), budget);

        assertTrue(factory.isPortal(portalAddr));
        assertEq(factory.getPortalCount(), 1);
        assertEq(factory.getPortalAt(0), portalAddr);
    }

    function testCreatePortalEvent() public {
        uint256 targetSQD = 10_000_000e18;
        uint256 minimumSQD = MIN_STAKE;
        uint64 deadline = uint64(block.timestamp + 7 days);
        uint256 budget = 10_000e6;

        vm.expectEmit(false, true, false, true);
        emit PortalFactory.PortalCreated(address(0), consumer, targetSQD, minimumSQD, address(usdcToken), budget);

        vm.prank(consumer);
        factory.createPortal(consumer, targetSQD, minimumSQD, deadline, address(usdcToken), budget);
    }

    function testCreatePortalZeroConsumer() public {
        vm.prank(consumer);
        vm.expectRevert(Errors.ZeroAddress.selector);
        factory.createPortal(
            address(0), 10_000_000e18, MIN_STAKE, uint64(block.timestamp + 7 days), address(usdcToken), 10_000e6
        );
    }

    function testCreatePortalUnsupportedToken() public {
        address unsupportedToken = makeAddr("unsupported");

        vm.prank(consumer);
        vm.expectRevert(Errors.UnsupportedPaymentToken.selector);
        factory.createPortal(
            consumer, 10_000_000e18, MIN_STAKE, uint64(block.timestamp + 7 days), unsupportedToken, 10_000e6
        );
    }

    function testCreatePortalInvalidDeadline() public {
        vm.prank(consumer);
        vm.expectRevert(Errors.InvalidDeadline.selector);
        factory.createPortal(
            consumer, 10_000_000e18, MIN_STAKE, uint64(block.timestamp - 1), address(usdcToken), 10_000e6
        );
    }

    function testCreatePortalZeroBudget() public {
        vm.prank(consumer);
        vm.expectRevert(Errors.ZeroAmount.selector);
        factory.createPortal(consumer, 10_000_000e18, MIN_STAKE, uint64(block.timestamp + 7 days), address(usdcToken), 0);
    }

    function testCreatePortalMinimumBelowMinStake() public {
        vm.prank(consumer);
        vm.expectRevert(Errors.BelowMinimumDeposit.selector);
        factory.createPortal(
            consumer, 10_000_000e18, MIN_STAKE - 1, uint64(block.timestamp + 7 days), address(usdcToken), 10_000e6
        );
    }

    function testCreatePortalTargetBelowMinimum() public {
        vm.prank(consumer);
        vm.expectRevert(Errors.InvalidParameters.selector);
        factory.createPortal(
            consumer, MIN_STAKE - 1, MIN_STAKE, uint64(block.timestamp + 7 days), address(usdcToken), 10_000e6
        );
    }

    function testCreatePortalWhenPaused() public {
        factory.pause();

        vm.prank(consumer);
        vm.expectRevert();
        factory.createPortal(
            consumer, 10_000_000e18, MIN_STAKE, uint64(block.timestamp + 7 days), address(usdcToken), 10_000e6
        );
    }

    function testAddPaymentToken() public {
        address newToken = makeAddr("newToken");

        factory.addPaymentToken(newToken);
        assertTrue(factory.supportedPaymentTokens(newToken));
    }

    function testAddPaymentTokenZeroAddress() public {
        vm.expectRevert(Errors.ZeroAddress.selector);
        factory.addPaymentToken(address(0));
    }

    function testAddPaymentTokenAlreadySupported() public {
        vm.expectRevert(Errors.AlreadyInitialized.selector);
        factory.addPaymentToken(address(usdcToken));
    }

    function testAddPaymentTokenOnlyOwner() public {
        vm.prank(consumer);
        vm.expectRevert();
        factory.addPaymentToken(makeAddr("newToken"));
    }

    function testRemovePaymentToken() public {
        factory.removePaymentToken(address(usdcToken));
        assertFalse(factory.supportedPaymentTokens(address(usdcToken)));
    }

    function testRemovePaymentTokenNotSupported() public {
        vm.expectRevert(Errors.InvalidAddress.selector);
        factory.removePaymentToken(makeAddr("notSupported"));
    }

    function testRemovePaymentTokenOnlyOwner() public {
        vm.prank(consumer);
        vm.expectRevert();
        factory.removePaymentToken(address(usdcToken));
    }

    function testPausePortal() public {
        vm.prank(consumer);
        address portalAddr = factory.createPortal(
            consumer, 10_000_000e18, MIN_STAKE, uint64(block.timestamp + 7 days), address(usdcToken), 10_000e6
        );

        factory.pausePortal(portalAddr);

        assertTrue(PortalPool(portalAddr).paused());
    }

    function testPausePortalInvalidAddress() public {
        vm.expectRevert(Errors.InvalidAddress.selector);
        factory.pausePortal(makeAddr("notPortal"));
    }

    function testUnpausePortal() public {
        vm.prank(consumer);
        address portalAddr = factory.createPortal(
            consumer, 10_000_000e18, MIN_STAKE, uint64(block.timestamp + 7 days), address(usdcToken), 10_000e6
        );

        factory.pausePortal(portalAddr);
        factory.unpausePortal(portalAddr);

        assertFalse(PortalPool(portalAddr).paused());
    }

    function testPause() public {
        factory.pause();
        assertTrue(factory.paused());
    }

    function testUnpause() public {
        factory.pause();
        factory.unpause();
        assertFalse(factory.paused());
    }

    function testPauseOnlyOwner() public {
        vm.prank(consumer);
        vm.expectRevert();
        factory.pause();
    }

    function testUnpauseOnlyOwner() public {
        factory.pause();

        vm.prank(consumer);
        vm.expectRevert();
        factory.unpause();
    }

    function testGetPortalCount() public {
        assertEq(factory.getPortalCount(), 0);

        vm.startPrank(consumer);
        factory.createPortal(
            consumer, 10_000_000e18, MIN_STAKE, uint64(block.timestamp + 7 days), address(usdcToken), 10_000e6
        );
        factory.createPortal(
            consumer, 10_000_000e18, MIN_STAKE, uint64(block.timestamp + 7 days), address(usdcToken), 10_000e6
        );
        vm.stopPrank();

        assertEq(factory.getPortalCount(), 2);
    }

    function testGetPortalAtInvalidIndex() public {
        vm.expectRevert(Errors.InvalidParameters.selector);
        factory.getPortalAt(0);
    }

    function testGetAllPortals() public {
        vm.startPrank(consumer);
        address portal1 = factory.createPortal(
            consumer, 10_000_000e18, MIN_STAKE, uint64(block.timestamp + 7 days), address(usdcToken), 10_000e6
        );
        address portal2 = factory.createPortal(
            consumer, 10_000_000e18, MIN_STAKE, uint64(block.timestamp + 7 days), address(usdcToken), 10_000e6
        );
        vm.stopPrank();

        address[] memory allPortals = factory.getAllPortals();
        assertEq(allPortals.length, 2);
        assertEq(allPortals[0], portal1);
        assertEq(allPortals[1], portal2);
    }

    function testCreateMultiplePortals() public {
        vm.startPrank(consumer);

        for (uint256 i = 0; i < 5; i++) {
            factory.createPortal(
                consumer, 10_000_000e18, MIN_STAKE, uint64(block.timestamp + 7 days), address(usdcToken), 10_000e6
            );
        }

        vm.stopPrank();

        assertEq(factory.getPortalCount(), 5);
    }

    function testFuzzCreatePortal(uint256 targetSQD, uint256 budget) public {
        vm.assume(targetSQD >= MIN_STAKE && targetSQD <= 100_000_000e18);
        vm.assume(budget > 0 && budget <= 1_000_000e6);

        usdcToken.mint(consumer, budget);

        vm.prank(consumer);
        address portalAddr = factory.createPortal(
            consumer, targetSQD, MIN_STAKE, uint64(block.timestamp + 7 days), address(usdcToken), budget
        );

        assertTrue(factory.isPortal(portalAddr));
    }
}
