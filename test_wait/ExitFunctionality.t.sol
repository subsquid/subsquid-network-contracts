// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {PortalFactory} from "../src/PortalFactory.sol";
import {PortalImplementation} from "../src/PortalImplementation.sol";
import {GatewayRegistry} from "../src/GatewayRegistry.sol";
import {FeeRouterModule} from "../src/FeeRouterModule.sol";
import {MockNetworkController} from "./mocks/MockNetworkController.sol";
import {IPortal} from "../src/interfaces/IPortal.sol";
import {PortalErrors} from "../src/libs/PortalErrors.sol";

contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "Insufficient balance");
        require(allowance[from][msg.sender] >= amount, "Insufficient allowance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        allowance[from][msg.sender] -= amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "Insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract ExitFunctionalityTest is Test {
    PortalFactory public factory;
    GatewayRegistry public registry;
    FeeRouterModule public feeRouter;
    MockNetworkController public networkController;
    MockERC20 public sqd;
    MockERC20 public paymentToken;
    PortalImplementation public portalImpl;

    address public operator = address(0x1);
    address public provider = address(0x2);
    address public provider2 = address(0x3);
    uint256 public constant MIN_STAKE = 100_000 ether;
    uint256 public constant MANA = 1000;
    address public workerRewardPool = address(0x4);

    function _makeTokenArray(address token) internal pure returns (address[] memory) {
        address[] memory tokens = new address[](1);
        tokens[0] = token;
        return tokens;
    }

    function setUp() public {
        sqd = new MockERC20();
        paymentToken = new MockERC20();

        networkController = new MockNetworkController(7200, MIN_STAKE, workerRewardPool);

        registry = new GatewayRegistry(address(sqd), address(networkController), MIN_STAKE, MANA);

        feeRouter = new FeeRouterModule();
        portalImpl = new PortalImplementation();

        factory = new PortalFactory(
            address(portalImpl),
            address(registry),
            address(feeRouter),
            address(networkController),
            address(sqd),
            MIN_STAKE
        );

        sqd.mint(provider, 100_000_000 ether);
        sqd.mint(provider2, 100_000_000 ether);
        paymentToken.mint(operator, 1_000_000 ether);

        vm.prank(provider);
        sqd.approve(address(registry), type(uint256).max);
        vm.prank(provider2);
        sqd.approve(address(registry), type(uint256).max);
        vm.prank(operator);
        paymentToken.approve(address(factory), type(uint256).max);
    }

    function testGetExitRequest() public {
        console.log("=== Test: getExitRequest() Function ===");

        vm.prank(operator);
        address portal = factory.createPortal(
            operator, _makeTokenArray(address(paymentToken)), MIN_STAKE * 2, block.number + 100, "exit test portal"
        );
        console.log("Portal created at:", portal);

        vm.prank(provider);
        PortalImplementation(portal).stake(MIN_STAKE * 2);
        console.log("Staked:", MIN_STAKE * 2);
        console.log("Portal auto-activated (capacity reached)");

        networkController.setEpochNumber(100);
        uint256 exitAmount = MIN_STAKE;
        console.log("Current epoch: 100");
        console.log("Requesting exit amount:", exitAmount);
        console.log("Exit percentage:", (exitAmount * 100) / (MIN_STAKE * 2));

        vm.prank(provider);
        PortalImplementation(portal).requestExit(exitAmount);

        IPortal.ExitRequest memory exitRequest = PortalImplementation(portal).getExitRequest(provider);

        console.log("Exit request retrieved:");
        console.log("  Amount:", exitRequest.amount);
        console.log("  Request epoch:", exitRequest.requestEpoch);
        console.log("  Unlock epoch:", exitRequest.unlockEpoch);

        assertEq(exitRequest.amount, exitAmount, "Exit amount should match");
        assertEq(exitRequest.requestEpoch, 100, "Request epoch should be 100");
        assertEq(exitRequest.unlockEpoch, 151, "Unlock epoch should be 151 (100 + 1 + 50)");

        console.log("PASS: getExitRequest() returns correct data");
    }

    function testGetExitRequestNoRequest() public {
        emit log_string("=== Test: getExitRequest() with No Request ===");

        vm.prank(operator);
        address portal = factory.createPortal(
            operator, _makeTokenArray(address(paymentToken)), MIN_STAKE, block.number + 100, "no exit portal"
        );

        vm.prank(provider);
        PortalImplementation(portal).stake(MIN_STAKE);

        IPortal.ExitRequest memory exitRequest = PortalImplementation(portal).getExitRequest(provider);

        assertEq(exitRequest.amount, 0, "Exit amount should be 0");
        assertEq(exitRequest.requestEpoch, 0, "Request epoch should be 0");
        assertEq(exitRequest.unlockEpoch, 0, "Unlock epoch should be 0");

        emit log_string("PASS: getExitRequest() returns zero struct for no request");
    }

    function testMultipleExitRequests() public {
        console.log("=== Test: Multiple Exit Requests (Accumulating) ===");

        vm.prank(operator);
        address portal = factory.createPortal(
            operator, _makeTokenArray(address(paymentToken)), MIN_STAKE * 2, block.number + 100, "multi exit portal"
        );

        vm.prank(provider);
        PortalImplementation(portal).stake(MIN_STAKE * 2);
        console.log("Total staked:", MIN_STAKE * 2);
        console.log("Portal auto-activated (capacity reached)");

        networkController.setEpochNumber(100);
        console.log("Epoch set to: 100");

        uint256 firstExit = MIN_STAKE / 2;
        console.log("First exit request:", firstExit);
        vm.prank(provider);
        PortalImplementation(portal).requestExit(firstExit);

        IPortal.ExitRequest memory exitRequest1 = PortalImplementation(portal).getExitRequest(provider);
        console.log("After first exit:");
        console.log("  Amount:", exitRequest1.amount);
        console.log("  Request epoch:", exitRequest1.requestEpoch);
        console.log("  Unlock epoch:", exitRequest1.unlockEpoch);
        assertEq(exitRequest1.amount, firstExit, "First exit amount should match");

        networkController.setEpochNumber(101);
        console.log("Epoch advanced to: 101");

        uint256 secondExit = MIN_STAKE / 4;
        console.log("Second exit request:", secondExit);
        vm.prank(provider);
        PortalImplementation(portal).requestExit(secondExit);

        IPortal.ExitRequest memory exitRequest2 = PortalImplementation(portal).getExitRequest(provider);
        console.log("After second exit:");
        console.log("  Total amount:", exitRequest2.amount);
        console.log("  Request epoch:", exitRequest2.requestEpoch);
        console.log("  Unlock epoch:", exitRequest2.unlockEpoch);
        assertEq(exitRequest2.amount, firstExit + secondExit, "Total exit amount should accumulate");
        assertEq(exitRequest2.requestEpoch, 101, "Request epoch should update to latest");

        console.log("PASS: Multiple exit requests accumulate correctly");
    }

    function testExitRequestInsufficientStake() public {
        emit log_string("=== Test: Exit Request with Insufficient Stake ===");

        vm.prank(operator);
        address portal = factory.createPortal(
            operator, _makeTokenArray(address(paymentToken)), MIN_STAKE, block.number + 100, "insufficient stake portal"
        );

        vm.prank(provider);
        PortalImplementation(portal).stake(MIN_STAKE);

        uint256 exitAmount = MIN_STAKE + 1;

        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(PortalErrors.InsufficientStake.selector));
        PortalImplementation(portal).requestExit(exitAmount);

        emit log_string("PASS: Cannot exit more than staked");
    }

    function testExitRequestZeroAmount() public {
        emit log_string("=== Test: Exit Request with Zero Amount ===");

        vm.prank(operator);
        address portal = factory.createPortal(
            operator, _makeTokenArray(address(paymentToken)), MIN_STAKE, block.number + 100, "zero exit portal"
        );

        vm.prank(provider);
        PortalImplementation(portal).stake(MIN_STAKE);

        // Zero amount should revert with InvalidAmount
        vm.prank(provider);
        vm.expectRevert(PortalErrors.InvalidAmount.selector);
        PortalImplementation(portal).requestExit(0);

        emit log_string("PASS: Zero amount exit request reverts correctly");
    }

    function testExitRequestUnlockEpochCalculation() public {
        console.log("=== Test: Exit Request Unlock Epoch Calculation ===");

        vm.prank(operator);
        address portal = factory.createPortal(
            operator, _makeTokenArray(address(paymentToken)), MIN_STAKE * 10, block.number + 100, "epoch calc portal"
        );

        vm.prank(provider);
        PortalImplementation(portal).stake(MIN_STAKE * 10);
        console.log("Total staked:", MIN_STAKE * 10);
        console.log("Portal auto-activated (capacity reached)");

        networkController.setEpochNumber(1000);
        console.log("Epoch set to: 1000");

        uint256 exitAmount1Percent = MIN_STAKE / 10;
        uint256 percentage1 = (exitAmount1Percent * 100) / (MIN_STAKE * 10);
        console.log("Exit amount (1%%):", exitAmount1Percent);
        console.log("Exit percentage:", percentage1);
        vm.prank(provider);
        PortalImplementation(portal).requestExit(exitAmount1Percent);

        IPortal.ExitRequest memory exitRequest1 = PortalImplementation(portal).getExitRequest(provider);
        uint256 expectedUnlock1 = 1000 + 1 + 1;
        console.log("1% exit unlock epoch:", exitRequest1.unlockEpoch);
        console.log("Expected unlock epoch:", expectedUnlock1);
        assertEq(exitRequest1.unlockEpoch, expectedUnlock1, "1% exit should unlock at epoch 1002");

        networkController.setEpochNumber(2000);
        console.log("Epoch set to: 2000");

        uint256 exitAmount10Percent = MIN_STAKE;
        uint256 totalExitPercentage = ((exitAmount1Percent + exitAmount10Percent) * 100) / (MIN_STAKE * 10);
        console.log("Exit amount (10%%):", exitAmount10Percent);
        console.log("Total exit percentage (cumulative):", totalExitPercentage);
        vm.prank(provider);
        PortalImplementation(portal).requestExit(exitAmount10Percent);

        IPortal.ExitRequest memory exitRequest2 = PortalImplementation(portal).getExitRequest(provider);
        uint256 expectedUnlock2 = 2000 + 1 + totalExitPercentage;
        console.log("Total exit unlock epoch:", exitRequest2.unlockEpoch);
        console.log("Expected unlock epoch:", expectedUnlock2);
        assertEq(exitRequest2.unlockEpoch, expectedUnlock2, "Cumulative exit should unlock based on total exit amount");

        console.log("PASS: Unlock epoch calculation is correct");
    }

    function testExitRequestPersists() public {
        emit log_string("=== Test: Exit Request Persists Across Operations ===");

        vm.prank(operator);
        address portal = factory.createPortal(
            operator, _makeTokenArray(address(paymentToken)), MIN_STAKE * 2, block.number + 100, "persist portal"
        );

        vm.prank(provider);
        PortalImplementation(portal).stake(MIN_STAKE * 2);

        networkController.setEpochNumber(100);
        uint256 exitAmount = MIN_STAKE;

        vm.prank(provider);
        PortalImplementation(portal).requestExit(exitAmount);

        IPortal.ExitRequest memory exitRequest1 = PortalImplementation(portal).getExitRequest(provider);

        vm.prank(operator);
        paymentToken.approve(portal, type(uint256).max);

        vm.prank(operator);
        PortalImplementation(portal).distributeFees(address(paymentToken), 100 ether);

        IPortal.ExitRequest memory exitRequest2 = PortalImplementation(portal).getExitRequest(provider);

        assertEq(exitRequest1.amount, exitRequest2.amount, "Exit amount should persist");
        assertEq(exitRequest1.requestEpoch, exitRequest2.requestEpoch, "Request epoch should persist");
        assertEq(exitRequest1.unlockEpoch, exitRequest2.unlockEpoch, "Unlock epoch should persist");

        emit log_string("PASS: Exit request persists across operations");
    }

    function testExitRequestDifferentProviders() public {
        console.log("=== Test: Exit Requests for Different Providers ===");

        vm.prank(operator);
        address portal = factory.createPortal(
            operator, _makeTokenArray(address(paymentToken)), MIN_STAKE * 4, block.number + 100, "multi provider portal"
        );

        vm.prank(provider);
        PortalImplementation(portal).stake(MIN_STAKE * 2);
        console.log("Provider1 staked:", MIN_STAKE * 2);

        vm.prank(provider2);
        PortalImplementation(portal).stake(MIN_STAKE * 2);
        console.log("Provider2 staked:", MIN_STAKE * 2);
        console.log("Total staked:", MIN_STAKE * 4);
        console.log("Portal auto-activated (capacity reached)");

        networkController.setEpochNumber(100);
        console.log("Epoch set to: 100");

        uint256 provider1Exit = MIN_STAKE;
        uint256 provider1Percentage = (provider1Exit * 100) / (MIN_STAKE * 4);
        console.log("Provider1 exit amount:", provider1Exit);
        console.log("Provider1 exit percentage:", provider1Percentage);
        vm.prank(provider);
        PortalImplementation(portal).requestExit(provider1Exit);

        uint256 provider2Exit = MIN_STAKE / 2;
        uint256 provider2Percentage = (provider2Exit * 100) / (MIN_STAKE * 4);
        console.log("Provider2 exit amount:", provider2Exit);
        console.log("Provider2 exit percentage:", provider2Percentage);
        vm.prank(provider2);
        PortalImplementation(portal).requestExit(provider2Exit);

        IPortal.ExitRequest memory exitRequest1 = PortalImplementation(portal).getExitRequest(provider);
        IPortal.ExitRequest memory exitRequest2 = PortalImplementation(portal).getExitRequest(provider2);

        console.log("Provider1 exit request:");
        console.log("  Amount:", exitRequest1.amount);
        console.log("  Request epoch:", exitRequest1.requestEpoch);
        console.log("  Unlock epoch:", exitRequest1.unlockEpoch);

        console.log("Provider2 exit request:");
        console.log("  Amount:", exitRequest2.amount);
        console.log("  Request epoch:", exitRequest2.requestEpoch);
        console.log("  Unlock epoch:", exitRequest2.unlockEpoch);

        assertEq(exitRequest1.amount, provider1Exit, "Provider1 exit amount should match");
        assertEq(exitRequest2.amount, provider2Exit, "Provider2 exit amount should match");
        assertEq(exitRequest1.requestEpoch, 100, "Provider1 request epoch should be 100");
        assertEq(exitRequest2.requestEpoch, 100, "Provider2 request epoch should be 100");

        uint256 expectedUnlock1 = 100 + 1 + 25;
        uint256 expectedUnlock2 = 100 + 1 + 12;

        console.log("Expected Provider1 unlock epoch:", expectedUnlock1);
        console.log("Expected Provider2 unlock epoch:", expectedUnlock2);

        assertEq(exitRequest1.unlockEpoch, expectedUnlock1, "Provider1 unlock epoch should be correct");
        assertEq(exitRequest2.unlockEpoch, expectedUnlock2, "Provider2 unlock epoch should be correct");

        console.log("PASS: Different providers can have independent exit requests");
    }

    function testExitRequestFullStake() public {
        emit log_string("=== Test: Exit Request for Full Stake ===");

        vm.prank(operator);
        address portal = factory.createPortal(
            operator, _makeTokenArray(address(paymentToken)), MIN_STAKE, block.number + 100, "full exit portal"
        );

        vm.prank(provider);
        PortalImplementation(portal).stake(MIN_STAKE);

        networkController.setEpochNumber(100);

        vm.prank(provider);
        PortalImplementation(portal).requestExit(MIN_STAKE);

        IPortal.ExitRequest memory exitRequest = PortalImplementation(portal).getExitRequest(provider);

        assertEq(exitRequest.amount, MIN_STAKE, "Exit amount should be full stake");
        uint256 expectedUnlock = 100 + 1 + 100;
        assertEq(exitRequest.unlockEpoch, expectedUnlock, "Unlock epoch should be 201");

        emit log_named_uint("Full exit amount", exitRequest.amount);
        emit log_named_uint("Unlock epoch", exitRequest.unlockEpoch);
        emit log_string("PASS: Can exit full stake");
    }

    function testExitRequestSmallPercentage() public {
        emit log_string("=== Test: Exit Request with Small Percentage ===");

        vm.prank(operator);
        address portal = factory.createPortal(
            operator, _makeTokenArray(address(paymentToken)), MIN_STAKE * 100, block.number + 100, "small exit portal"
        );

        vm.prank(provider);
        PortalImplementation(portal).stake(MIN_STAKE * 100);

        networkController.setEpochNumber(500);

        uint256 exitAmount = MIN_STAKE;
        vm.prank(provider);
        PortalImplementation(portal).requestExit(exitAmount);

        IPortal.ExitRequest memory exitRequest = PortalImplementation(portal).getExitRequest(provider);

        assertEq(exitRequest.amount, exitAmount, "Exit amount should match");
        uint256 expectedUnlock = 500 + 1 + 1;
        assertEq(exitRequest.unlockEpoch, expectedUnlock, "Unlock epoch should be 502 (1 base + 1%)");

        emit log_named_uint("Small exit amount", exitRequest.amount);
        emit log_named_uint("Unlock epoch", exitRequest.unlockEpoch);
        emit log_string("PASS: Small percentage exit works correctly");
    }
}
