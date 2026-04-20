// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import {FeeRouterModuleV2} from "../../src/FeeRouterModuleV2.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockPancakeRouter} from "../mocks/MockPancakeRouter.sol";
import {MockPancakeFactory} from "../mocks/MockPancakeFactory.sol";
import {MockPancakePool} from "../mocks/MockPancakePool.sol";

contract FeeRouterV2EdgeCasesTest is Test {
    uint32 internal constant TWAP_WINDOW = 1800;

    FeeRouterModuleV2 public router;
    MockERC20 public usdc;
    MockERC20 public sqdToken;
    MockERC20 public wethToken;
    MockPancakeRouter public pancakeRouter;
    MockPancakeFactory public pancakeFactory;

    address public admin = address(this);
    address public workerPool = address(0x5555);
    address public burnAddr = address(0xdead);

    function setUp() public {
        usdc = new MockERC20("USDC", "USDC", 6);
        sqdToken = new MockERC20("SQD", "SQD", 18);
        wethToken = new MockERC20("WETH", "WETH", 18);
        pancakeRouter = new MockPancakeRouter();
        pancakeFactory = new MockPancakeFactory();

        router = new FeeRouterModuleV2(
            address(pancakeRouter), address(pancakeFactory), address(sqdToken), address(wethToken)
        );
        router.configureBuyback(address(pancakeRouter), address(sqdToken), address(wethToken), 2500, 2500);
        router.setWorkerPoolAddress(workerPool);
        router.setFeeConfig(5000, 4500, 500);
        router.setAllowedRewardToken(address(usdc), true);
        router.setBuybackEnabled(true);
        _setupTwap();

        usdc.mint(admin, 100_000_000 * 1e6);
    }

    function test_RoundingDriftOverManyTopUps() public view {
        uint256 totalProviders;
        uint256 totalProtocol;
        uint256 iterations = 1000;
        uint256 amountPerTopUp = 3;

        for (uint256 i = 0; i < iterations; i++) {
            (uint256 p,, uint256 b) = router.calculateSplit(amountPerTopUp);
            totalProviders += p;
            totalProtocol += b;
        }

        uint256 totalInput = iterations * amountPerTopUp;
        uint256 expectedProviders = totalInput * 5000 / 10000;

        assertEq(totalProviders, 1000);
        assertEq(totalProtocol, 2000);
        assertGt(totalProtocol - expectedProviders, 0);
    }

    function test_RoundingDrift_LargerAmounts_NegligibleImpact() public view {
        uint256 amount = 1000 * 1e6;
        (uint256 p,, uint256 b) = router.calculateSplit(amount);

        uint256 expectedP = amount * 5000 / 10000;
        assertEq(p, expectedP);
        assertEq(p + b, amount);
    }

    function test_DirectTransferCanBeSwept() public {
        pancakeRouter.setRate(1, 1);
        usdc.transfer(address(router), 500 * 1e6);

        router.executeBuyback(address(usdc));

        assertEq(usdc.balanceOf(address(router)), 0, "manual sweep clears balance");
        assertEq(sqdToken.balanceOf(workerPool), 450 * 1e6);
        assertEq(sqdToken.balanceOf(burnAddr), 50 * 1e6);
    }

    function test_TinySQDAmountSplitPrecision() public {
        pancakeRouter.setRate(1, 1);
        usdc.approve(address(router), 1);

        router.routeToBurn(address(usdc), 1);

        assertEq(sqdToken.balanceOf(workerPool), 0);
        assertEq(sqdToken.balanceOf(burnAddr), 1);
    }

    function test_SmallAmountSplitStillMatchesRatioFlooring() public {
        pancakeRouter.setRate(1, 1);
        usdc.approve(address(router), 9);

        router.routeToBurn(address(usdc), 9);

        assertEq(sqdToken.balanceOf(workerPool), 8);
        assertEq(sqdToken.balanceOf(burnAddr), 1);
    }

    function test_ConfigChangeAfterImmediateRouteDoesNotChangePastOutcome() public {
        pancakeRouter.setRate(1, 1);
        usdc.approve(address(router), 1000 * 1e6);

        router.routeToBurn(address(usdc), 1000 * 1e6);
        router.setFeeConfig(5000, 500, 4500);

        assertEq(sqdToken.balanceOf(workerPool), 900 * 1e6);
        assertEq(sqdToken.balanceOf(burnAddr), 100 * 1e6);
    }

    function testFuzz_BuybackSplitTotalEqualsInput(uint256 sqdAmount, uint16 workerBPS) public {
        vm.assume(sqdAmount > 0 && sqdAmount < 1e30);
        vm.assume(workerBPS <= 5000);

        uint16 burnBPS = uint16(5000 - workerBPS);
        router.setFeeConfig(5000, workerBPS, burnBPS);
        pancakeRouter.setRate(1, 1);

        usdc.mint(admin, sqdAmount);
        usdc.approve(address(router), sqdAmount);
        router.routeToBurn(address(usdc), sqdAmount);

        uint256 workerBal = sqdToken.balanceOf(workerPool);
        uint256 burnBal = sqdToken.balanceOf(burnAddr);
        assertEq(workerBal + burnBal, sqdAmount, "total SQD distributed must equal input");
    }

    function testFuzz_CalculateSplitNeverExceedsInput(uint256 amount, uint16 providerBPS) public {
        vm.assume(amount < type(uint256).max / 10000);
        vm.assume(providerBPS <= 10000);

        uint16 remaining = uint16(10000 - providerBPS);
        uint16 workerBPS = remaining / 2;
        uint16 burnBPS = remaining - workerBPS;

        router.setFeeConfig(providerBPS, workerBPS, burnBPS);

        (uint256 a, uint256 b, uint256 c) = router.calculateSplit(amount);
        assertEq(a + b + c, amount);
        assertEq(b, 0);
        assertLe(a, amount);
    }

    function _setupTwap() internal returns (MockPancakePool pool1, MockPancakePool pool2) {
        address t0Hop1 = address(usdc) < address(wethToken) ? address(usdc) : address(wethToken);
        address t1Hop1 = address(usdc) < address(wethToken) ? address(wethToken) : address(usdc);
        pool1 = new MockPancakePool(t0Hop1, t1Hop1);

        address t0Hop2 = address(wethToken) < address(sqdToken) ? address(wethToken) : address(sqdToken);
        address t1Hop2 = address(wethToken) < address(sqdToken) ? address(sqdToken) : address(wethToken);
        pool2 = new MockPancakePool(t0Hop2, t1Hop2);

        pancakeFactory.setPool(address(usdc), address(wethToken), 2500, address(pool1));
        pancakeFactory.setPool(address(wethToken), address(sqdToken), 2500, address(pool2));
        pool1.setTickCumulatives(0, 0);
        pool2.setTickCumulatives(0, 0);

        router.configureSlippageProtection(TWAP_WINDOW, 300);
    }
}
