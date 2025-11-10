// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {FeeRouterModule} from "../src/FeeRouterModule.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Errors} from "../src/libs/Errors.sol";

contract FeeRouterModuleTest is Test {
    FeeRouterModule public feeRouter;
    MockERC20 public paymentToken;
    address public owner;
    address public portal;
    address public workerPool;

    function setUp() public {
        owner = address(this);
        portal = makeAddr("portal");
        workerPool = makeAddr("workerPool");

        paymentToken = new MockERC20("USDC", "USDC", 6);

        feeRouter = new FeeRouterModule(5000, 5000, workerPool);

        paymentToken.mint(portal, 1_000_000e6);

        vm.prank(portal);
        paymentToken.approve(address(feeRouter), type(uint256).max);
    }

    function testConstructor() public view {
        (uint16 sqdProvidersBps, uint16 workerPoolBps, address workerPoolAddress) = feeRouter.feeConfig();

        assertEq(sqdProvidersBps, 5000);
        assertEq(workerPoolBps, 5000);
        assertEq(workerPoolAddress, workerPool);
    }

    function testConstructorInvalidSplit() public {
        vm.expectRevert(Errors.InvalidSplit.selector);
        new FeeRouterModule(6000, 5000, workerPool);
    }

    function testConstructorZeroAddress() public {
        vm.expectRevert(Errors.InvalidAddress.selector);
        new FeeRouterModule(5000, 5000, address(0));
    }

    function testRouteFees50_50Split() public {
        uint256 totalAmount = 1000e6;

        vm.prank(portal);
        (uint256 toProviders, uint256 toWorkers, uint256 toBurn) =
            feeRouter.routeFees(portal, IERC20(paymentToken), totalAmount);

        assertEq(toProviders, 500e6);
        assertEq(toWorkers, 500e6);
        assertEq(toBurn, 0);
        assertEq(paymentToken.balanceOf(workerPool), 500e6);
    }

    function testRouteFeesZeroAmount() public {
        vm.prank(portal);
        vm.expectRevert(Errors.ZeroAmount.selector);
        feeRouter.routeFees(portal, IERC20(paymentToken), 0);
    }

    function testSetFeeConfig() public {
        address newWorkerPoolAddr = makeAddr("newWorkerPool");
        FeeRouterModule.FeeConfig memory newConfig = FeeRouterModule.FeeConfig({
            sqdProvidersBps: 6000,
            workerPoolBps: 4000,
            workerPoolAddress: newWorkerPoolAddr
        });

        feeRouter.setFeeConfig(newConfig);

        (uint16 sqdProvidersBps, uint16 workerPoolBps, address workerPoolAddress) = feeRouter.feeConfig();
        assertEq(sqdProvidersBps, 6000);
        assertEq(workerPoolBps, 4000);
        assertEq(workerPoolAddress, newWorkerPoolAddr);
    }

    function testSetFeeConfigInvalidSplit() public {
        FeeRouterModule.FeeConfig memory newConfig = FeeRouterModule.FeeConfig({
            sqdProvidersBps: 7000,
            workerPoolBps: 4000,
            workerPoolAddress: workerPool
        });

        vm.expectRevert(Errors.InvalidSplit.selector);
        feeRouter.setFeeConfig(newConfig);
    }

    function testSetFeeConfigZeroAddress() public {
        FeeRouterModule.FeeConfig memory newConfig =
            FeeRouterModule.FeeConfig({sqdProvidersBps: 5000, workerPoolBps: 5000, workerPoolAddress: address(0)});

        vm.expectRevert(Errors.InvalidAddress.selector);
        feeRouter.setFeeConfig(newConfig);
    }

    function testSetFeeConfigOnlyOwner() public {
        FeeRouterModule.FeeConfig memory newConfig =
            FeeRouterModule.FeeConfig({sqdProvidersBps: 6000, workerPoolBps: 4000, workerPoolAddress: workerPool});

        vm.prank(portal);
        vm.expectRevert();
        feeRouter.setFeeConfig(newConfig);
    }

    function testRouteFeesDifferentSplit() public {
        FeeRouterModule.FeeConfig memory newConfig =
            FeeRouterModule.FeeConfig({sqdProvidersBps: 7000, workerPoolBps: 3000, workerPoolAddress: workerPool});

        feeRouter.setFeeConfig(newConfig);

        uint256 totalAmount = 1000e6;

        vm.prank(portal);
        (uint256 toProviders, uint256 toWorkers,) = feeRouter.routeFees(portal, IERC20(paymentToken), totalAmount);

        assertEq(toProviders, 700e6);
        assertEq(toWorkers, 300e6);
    }

    function testRouteFeesEvent() public {
        uint256 totalAmount = 1000e6;

        vm.expectEmit(true, true, false, true);
        emit FeeRouterModule.FeesRouted(portal, address(paymentToken), 500e6, 500e6);

        vm.prank(portal);
        feeRouter.routeFees(portal, IERC20(paymentToken), totalAmount);
    }

    function testFuzzRouteFees(uint256 amount) public {
        vm.assume(amount > 0 && amount <= 1_000_000e6);

        paymentToken.mint(portal, amount);

        vm.prank(portal);
        (uint256 toProviders, uint256 toWorkers,) = feeRouter.routeFees(portal, IERC20(paymentToken), amount);

        assertEq(toProviders + toWorkers, amount);
        assertEq(toProviders, amount / 2);
    }

    function testFuzzSetFeeConfig(uint16 providerBps, uint16 workerBps) public {
        vm.assume(uint256(providerBps) + uint256(workerBps) == 10000);
        vm.assume(providerBps > 0 && workerBps > 0);

        FeeRouterModule.FeeConfig memory newConfig =
            FeeRouterModule.FeeConfig({sqdProvidersBps: providerBps, workerPoolBps: workerBps, workerPoolAddress: workerPool});

        feeRouter.setFeeConfig(newConfig);

        (uint16 sqdProvidersBps, uint16 workerPoolBps,) = feeRouter.feeConfig();
        assertEq(sqdProvidersBps, providerBps);
        assertEq(workerPoolBps, workerBps);
    }

    function testMultipleRouteFees() public {
        vm.startPrank(portal);

        feeRouter.routeFees(portal, IERC20(paymentToken), 100e6);
        feeRouter.routeFees(portal, IERC20(paymentToken), 200e6);
        feeRouter.routeFees(portal, IERC20(paymentToken), 300e6);

        vm.stopPrank();

        assertEq(paymentToken.balanceOf(workerPool), 300e6);
    }

    function testRouteFeesRounding() public {
        uint256 totalAmount = 1001e6;

        vm.prank(portal);
        (uint256 toProviders, uint256 toWorkers,) = feeRouter.routeFees(portal, IERC20(paymentToken), totalAmount);

        assertEq(toProviders, 500.5e6);
        assertEq(toWorkers, 500.5e6);
        assertEq(toProviders + toWorkers, totalAmount);
    }
}
