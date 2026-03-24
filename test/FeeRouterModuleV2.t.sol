// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import {FeeRouterModuleV2} from "../src/FeeRouterModuleV2.sol";
import {IFeeRouter} from "../src/interfaces/IFeeRouter.sol";
import {PoolErrors} from "../src/libs/PoolErrors.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockPancakeRouter} from "./mocks/MockPancakeRouter.sol";
import {MockPancakeFactory} from "./mocks/MockPancakeFactory.sol";
import {MockPancakePool} from "./mocks/MockPancakePool.sol";

contract FeeRouterModuleV2Test is Test {
    FeeRouterModuleV2 public router;
    MockERC20 public usdc;
    MockERC20 public dai;
    MockERC20 public sqdToken;
    MockERC20 public wethToken;
    MockPancakeRouter public pancakeRouter;

    address public admin = address(this);
    address public workerPool = address(0x5555);
    address public burnAddr = address(0xdead);
    address public user1 = address(0x1);

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        dai = new MockERC20("Dai", "DAI", 18);
        sqdToken = new MockERC20("Subsquid", "SQD", 18);
        wethToken = new MockERC20("WETH", "WETH", 18);
        pancakeRouter = new MockPancakeRouter();

        router = new FeeRouterModuleV2();
        router.configureBuyback(
            address(pancakeRouter), address(sqdToken), address(wethToken), 2500, 2500, 100 * 1e6
        );
        router.setWorkerPoolAddress(workerPool);
        router.setAllowedRewardToken(address(usdc), true);
        router.setAllowedRewardToken(address(dai), true);
        router.setBuybackEnabled(true);

        usdc.mint(admin, 100_000_000 * 1e6);
        usdc.mint(user1, 10_000_000 * 1e6);
        dai.mint(admin, 10_000_000 ether);
    }

    // ═══════════════════════════════════════════════════════
    // Constructor & Defaults
    // ═══════════════════════════════════════════════════════

    function test_Constructor_Defaults() public view {
        IFeeRouter.FeeConfig memory cfg = router.getFeeConfig();
        assertEq(cfg.toProvidersBPS, 5000, "50% providers");
        assertEq(cfg.toWorkerPoolBPS, 4500, "45% workers");
        assertEq(cfg.toBurnBPS, 500, "5% burn");
        assertEq(router.sqdBurnAddress(), burnAddr);
        assertTrue(router.hasRole(router.DEFAULT_ADMIN_ROLE(), admin));
        assertEq(router.getBurnAddress(), address(router));
    }

    // ═══════════════════════════════════════════════════════
    // calculateSplit
    // ═══════════════════════════════════════════════════════

    function test_CalculateSplit_Default() public view {
        (uint256 toProviders, uint256 toWorkerPool, uint256 toBurn) = router.calculateSplit(10000 * 1e6);
        assertEq(toProviders, 5000 * 1e6, "50% providers");
        assertEq(toWorkerPool, 0, "always 0");
        assertEq(toBurn, 5000 * 1e6, "50% to swap path");
    }

    function test_CalculateSplit_Zero() public view {
        (uint256 a, uint256 b, uint256 c) = router.calculateSplit(0);
        assertEq(a + b + c, 0);
    }

    function test_CalculateSplit_OddAmount() public view {
        (uint256 a, uint256 b, uint256 c) = router.calculateSplit(1001);
        assertEq(a, 500);
        assertEq(b, 0);
        assertEq(c, 501);
        assertEq(a + b + c, 1001);
    }

    function test_CalculateSplit_OneWei() public view {
        (uint256 a,, uint256 c) = router.calculateSplit(1);
        assertEq(a, 0);
        assertEq(c, 1);
    }

    function test_CalculateSplit_AllToProviders() public {
        router.setFeeConfig(10000, 0, 0);
        (uint256 a,, uint256 c) = router.calculateSplit(999);
        assertEq(a, 999);
        assertEq(c, 0);
    }

    function test_CalculateSplit_NothingToProviders() public {
        router.setFeeConfig(0, 9000, 1000);
        (uint256 a,, uint256 c) = router.calculateSplit(999);
        assertEq(a, 0);
        assertEq(c, 999);
    }

    function testFuzz_CalculateSplit_TotalEqualsInput(uint256 amount) public view {
        vm.assume(amount < type(uint256).max / 10000);
        (uint256 a, uint256 b, uint256 c) = router.calculateSplit(amount);
        assertEq(a + b + c, amount);
        assertEq(b, 0);
    }

    // ═══════════════════════════════════════════════════════
    // setFeeConfig
    // ═══════════════════════════════════════════════════════

    function test_SetFeeConfig_Success() public {
        vm.expectEmit(true, true, true, true);
        emit IFeeRouter.FeeConfigUpdated(3000, 5000, 2000);
        router.setFeeConfig(3000, 5000, 2000);

        IFeeRouter.FeeConfig memory cfg = router.getFeeConfig();
        assertEq(cfg.toProvidersBPS, 3000);
        assertEq(cfg.toWorkerPoolBPS, 5000);
        assertEq(cfg.toBurnBPS, 2000);
    }

    function test_SetFeeConfig_AllToProviders() public {
        router.setFeeConfig(10000, 0, 0);
        IFeeRouter.FeeConfig memory cfg = router.getFeeConfig();
        assertEq(cfg.toProvidersBPS, 10000);
    }

    function test_SetFeeConfig_RevertInvalidTotal() public {
        vm.expectRevert(PoolErrors.InvalidFeeConfig.selector);
        router.setFeeConfig(5000, 4000, 500);
    }

    function test_SetFeeConfig_RevertNonAdmin() public {
        vm.prank(user1);
        vm.expectRevert();
        router.setFeeConfig(5000, 4500, 500);
    }

    function testFuzz_SetFeeConfig_Valid(uint16 p, uint16 w) public {
        vm.assume(p <= 10000);
        vm.assume(w <= 10000 - p);
        uint16 b = uint16(10000 - p - w);
        router.setFeeConfig(p, w, b);
        IFeeRouter.FeeConfig memory cfg = router.getFeeConfig();
        assertEq(cfg.toProvidersBPS, p);
        assertEq(cfg.toWorkerPoolBPS, w);
        assertEq(cfg.toBurnBPS, b);
    }

    // ═══════════════════════════════════════════════════════
    // routeToWorkerPool (legacy)
    // ═══════════════════════════════════════════════════════

    function test_RouteToWorkerPool_Success() public {
        usdc.approve(address(router), 1000 * 1e6);
        router.routeToWorkerPool(address(usdc), 1000 * 1e6);
        assertEq(usdc.balanceOf(workerPool), 1000 * 1e6);
    }

    function test_RouteToWorkerPool_ZeroNoOp() public {
        router.routeToWorkerPool(address(usdc), 0);
    }

    function test_RouteToWorkerPool_RevertNoAddress() public {
        FeeRouterModuleV2 fresh = new FeeRouterModuleV2();
        usdc.approve(address(fresh), 100);
        vm.expectRevert(PoolErrors.InvalidAddress.selector);
        fresh.routeToWorkerPool(address(usdc), 100);
    }

    function test_RouteToWorkerPool_RevertWhenPaused() public {
        router.pause();
        vm.expectRevert();
        router.routeToWorkerPool(address(usdc), 100);
    }

    // ═══════════════════════════════════════════════════════
    // routeToBurn
    // ═══════════════════════════════════════════════════════

    function test_RouteToBurn_Accumulates() public {
        usdc.approve(address(router), 50 * 1e6);
        router.routeToBurn(address(usdc), 50 * 1e6);
        assertEq(usdc.balanceOf(address(router)), 50 * 1e6);
        assertEq(router.accumulatedForBuyback(address(usdc)), 50 * 1e6);
    }

    function test_RouteToBurn_TracksTokenOnce() public {
        usdc.approve(address(router), 200 * 1e6);
        router.routeToBurn(address(usdc), 100 * 1e6);
        router.routeToBurn(address(usdc), 100 * 1e6);
        (address[] memory tokens,) = router.getAccumulatedTokens();
        assertEq(tokens.length, 1);
        assertEq(router.accumulatedForBuyback(address(usdc)), 200 * 1e6);
    }

    function test_RouteToBurn_MultipleTokens() public {
        usdc.approve(address(router), 50 * 1e6);
        router.routeToBurn(address(usdc), 50 * 1e6);
        dai.mint(admin, 100 ether);
        dai.approve(address(router), 100 ether);
        router.routeToBurn(address(dai), 100 ether);
        (address[] memory tokens,) = router.getAccumulatedTokens();
        assertEq(tokens.length, 2);
    }

    function test_RouteToBurn_RevertDisallowed() public {
        MockERC20 rnd = new MockERC20("R", "R", 18);
        rnd.mint(admin, 100 ether);
        rnd.approve(address(router), 100 ether);
        vm.expectRevert(PoolErrors.TokenNotAllowed.selector);
        router.routeToBurn(address(rnd), 100 ether);
    }

    function test_RouteToBurn_ZeroNoOp() public {
        router.routeToBurn(address(usdc), 0);
        assertEq(router.accumulatedForBuyback(address(usdc)), 0);
    }

    function test_RouteToBurn_RevertWhenPaused() public {
        router.pause();
        vm.expectRevert();
        router.routeToBurn(address(usdc), 100);
    }

    function test_RouteToBurn_AutoBuybackAboveThreshold() public {
        router.setAutoBuybackEnabled(true);
        pancakeRouter.setRate(2, 1); // 2 SQD per USDC

        usdc.approve(address(router), 200 * 1e6);
        router.routeToBurn(address(usdc), 200 * 1e6);

        // 200 USDC -> 400 SQD. Split: 4500/(4500+500) = 90% worker, 10% burn
        assertEq(sqdToken.balanceOf(workerPool), 360 * 1e6, "90% of 400 to workers");
        assertEq(sqdToken.balanceOf(burnAddr), 40 * 1e6, "10% of 400 burned");
        assertEq(router.accumulatedForBuyback(address(usdc)), 0);
    }

    function test_RouteToBurn_AutoBuybackBelowThreshold() public {
        router.setAutoBuybackEnabled(true);
        usdc.approve(address(router), 50 * 1e6);
        router.routeToBurn(address(usdc), 50 * 1e6);
        assertEq(usdc.balanceOf(address(router)), 50 * 1e6, "not swapped");
    }

    function test_RouteToBurn_NoAutoWhenDisabled() public {
        assertFalse(router.autoBuybackEnabled());
        usdc.approve(address(router), 200 * 1e6);
        router.routeToBurn(address(usdc), 200 * 1e6);
        assertEq(usdc.balanceOf(address(router)), 200 * 1e6, "not swapped");
    }

    // ═══════════════════════════════════════════════════════
    // executeBuyback — SQD split per config
    // ═══════════════════════════════════════════════════════

    function test_ExecuteBuyback_Default_50_45_5_Split() public {
        usdc.approve(address(router), 500 * 1e6);
        router.routeToBurn(address(usdc), 500 * 1e6);
        pancakeRouter.setRate(2, 1); // 1000 SQD

        uint256 bought = router.executeBuyback(address(usdc), 0);
        assertEq(bought, 1000 * 1e6);

        // protocolBPS = 4500 + 500 = 5000
        // toWorkerPool = 1000 * 4500 / 5000 = 900
        // toBurn = 1000 - 900 = 100
        assertEq(sqdToken.balanceOf(workerPool), 900 * 1e6, "90% of SQD to workers");
        assertEq(sqdToken.balanceOf(burnAddr), 100 * 1e6, "10% of SQD burned");
    }

    function test_ExecuteBuyback_Config_30_50_20() public {
        router.setFeeConfig(3000, 5000, 2000);
        usdc.approve(address(router), 700 * 1e6); // 70% goes through swap
        router.routeToBurn(address(usdc), 700 * 1e6);
        pancakeRouter.setRate(1, 1); // 700 SQD

        router.executeBuyback(address(usdc), 0);

        // protocolBPS = 5000 + 2000 = 7000
        // toWorkerPool = 700 * 5000 / 7000 = 500
        // toBurn = 700 - 500 = 200
        assertEq(sqdToken.balanceOf(workerPool), 500 * 1e6, "5000/7000 of SQD");
        assertEq(sqdToken.balanceOf(burnAddr), 200 * 1e6, "2000/7000 of SQD");
    }

    function test_ExecuteBuyback_AllBurn_NoWorkers() public {
        router.setFeeConfig(5000, 0, 5000);
        usdc.approve(address(router), 500 * 1e6);
        router.routeToBurn(address(usdc), 500 * 1e6);
        pancakeRouter.setRate(2, 1);
        router.executeBuyback(address(usdc), 0);

        assertEq(sqdToken.balanceOf(workerPool), 0, "nothing to workers");
        assertEq(sqdToken.balanceOf(burnAddr), 1000 * 1e6, "100% burned");
    }

    function test_ExecuteBuyback_AllWorkers_NoBurn() public {
        router.setFeeConfig(5000, 5000, 0);
        usdc.approve(address(router), 500 * 1e6);
        router.routeToBurn(address(usdc), 500 * 1e6);
        pancakeRouter.setRate(2, 1);
        router.executeBuyback(address(usdc), 0);

        assertEq(sqdToken.balanceOf(workerPool), 1000 * 1e6, "100% to workers");
        assertEq(sqdToken.balanceOf(burnAddr), 0, "nothing burned");
    }

    function test_ExecuteBuyback_RevertNothingToBuyback() public {
        vm.expectRevert(PoolErrors.NothingToBuyback.selector);
        router.executeBuyback(address(usdc), 0);
    }

    function test_ExecuteBuyback_RevertDisallowedToken() public {
        vm.expectRevert(PoolErrors.TokenNotAllowed.selector);
        router.executeBuyback(address(sqdToken), 0);
    }

    function test_ExecuteBuyback_RevertWhenPaused() public {
        usdc.approve(address(router), 500 * 1e6);
        router.routeToBurn(address(usdc), 500 * 1e6);
        router.pause();
        vm.expectRevert();
        router.executeBuyback(address(usdc), 0);
    }

    function test_ExecuteBuyback_SlippageProtection() public {
        usdc.approve(address(router), 500 * 1e6);
        router.routeToBurn(address(usdc), 500 * 1e6);
        pancakeRouter.setRate(2, 1);
        assertEq(router.executeBuyback(address(usdc), 999 * 1e6), 1000 * 1e6);
    }

    function test_ExecuteBuyback_SlippageRevert() public {
        usdc.approve(address(router), 500 * 1e6);
        router.routeToBurn(address(usdc), 500 * 1e6);
        pancakeRouter.setRate(2, 1);
        vm.expectRevert("MockRouter: insufficient output");
        router.executeBuyback(address(usdc), 1001 * 1e6);
    }

    function test_ExecuteBuyback_ClearsAccumulated() public {
        usdc.approve(address(router), 500 * 1e6);
        router.routeToBurn(address(usdc), 500 * 1e6);
        pancakeRouter.setRate(2, 1);
        router.executeBuyback(address(usdc), 0);
        assertEq(router.accumulatedForBuyback(address(usdc)), 0);
    }

    function test_ExecuteBuyback_CallableByAnyone() public {
        usdc.approve(address(router), 500 * 1e6);
        router.routeToBurn(address(usdc), 500 * 1e6);
        pancakeRouter.setRate(2, 1);
        vm.prank(user1);
        assertGt(router.executeBuyback(address(usdc), 0), 0);
    }

    // ═══════════════════════════════════════════════════════
    // Buyback fallback paths
    // ═══════════════════════════════════════════════════════

    function test_ExecuteBuyback_DisabledFallback() public {
        router.setBuybackEnabled(false);
        usdc.approve(address(router), 500 * 1e6);
        router.routeToBurn(address(usdc), 500 * 1e6);
        router.executeBuyback(address(usdc), 0);
        assertEq(usdc.balanceOf(burnAddr), 500 * 1e6);
    }

    function test_ExecuteBuyback_BelowThresholdKeepsAccumulating() public {
        router.setMinBuybackThreshold(1000 * 1e6);
        usdc.approve(address(router), 500 * 1e6);
        router.routeToBurn(address(usdc), 500 * 1e6);
        router.executeBuyback(address(usdc), 0);
        assertEq(usdc.balanceOf(address(router)), 500 * 1e6);
        assertEq(router.accumulatedForBuyback(address(usdc)), 500 * 1e6);
    }

    function test_ExecuteBuyback_NoConfigFallback() public {
        FeeRouterModuleV2 fresh = new FeeRouterModuleV2();
        fresh.setAllowedRewardToken(address(usdc), true);
        fresh.setBuybackEnabled(true);
        usdc.approve(address(fresh), 500 * 1e6);
        fresh.routeToBurn(address(usdc), 500 * 1e6);
        fresh.executeBuyback(address(usdc), 0);
        assertEq(usdc.balanceOf(burnAddr), 500 * 1e6);
    }

    // ═══════════════════════════════════════════════════════
    // configureBuyback
    // ═══════════════════════════════════════════════════════

    function test_ConfigureBuyback() public {
        router.configureBuyback(address(0xABC), address(0xDEF), address(0x123), 500, 100, 50 * 1e6);
        (address r, address s, address w, uint24 f1, uint24 f2, uint256 mt, bool en) = router.getBuybackConfig();
        assertEq(r, address(0xABC));
        assertEq(s, address(0xDEF));
        assertEq(w, address(0x123));
        assertEq(f1, 500);
        assertEq(f2, 100);
        assertEq(mt, 50 * 1e6);
        assertTrue(en);
    }

    function test_ConfigureBuyback_RevertZeroAddresses() public {
        vm.expectRevert(PoolErrors.InvalidAddress.selector);
        router.configureBuyback(address(0), address(sqdToken), address(wethToken), 2500, 2500, 0);
        vm.expectRevert(PoolErrors.InvalidAddress.selector);
        router.configureBuyback(address(pancakeRouter), address(0), address(wethToken), 2500, 2500, 0);
        vm.expectRevert(PoolErrors.InvalidAddress.selector);
        router.configureBuyback(address(pancakeRouter), address(sqdToken), address(0), 2500, 2500, 0);
    }

    function test_ConfigureBuyback_RevertInvalidFees() public {
        vm.expectRevert(PoolErrors.InvalidPoolFee.selector);
        router.configureBuyback(address(pancakeRouter), address(sqdToken), address(wethToken), 999, 2500, 0);
    }

    function test_ConfigureBuyback_RevertNonAdmin() public {
        vm.prank(user1);
        vm.expectRevert();
        router.configureBuyback(address(pancakeRouter), address(sqdToken), address(wethToken), 2500, 2500, 0);
    }

    // ═══════════════════════════════════════════════════════
    // Admin setters
    // ═══════════════════════════════════════════════════════

    function test_SetBuybackEnabled() public {
        router.setBuybackEnabled(false);
        assertFalse(router.buybackEnabled());
        router.setBuybackEnabled(true);
        assertTrue(router.buybackEnabled());
    }

    function test_SetAutoBuybackEnabled() public {
        router.setAutoBuybackEnabled(true);
        assertTrue(router.autoBuybackEnabled());
    }

    function test_SetAllowedRewardToken() public {
        MockERC20 t = new MockERC20("T", "T", 18);
        router.setAllowedRewardToken(address(t), true);
        assertTrue(router.allowedRewardTokens(address(t)));
        router.setAllowedRewardToken(address(t), false);
        assertFalse(router.allowedRewardTokens(address(t)));
    }

    function test_SetPoolFee_ValidTiers() public {
        uint24[4] memory valid = [uint24(100), uint24(500), uint24(2500), uint24(10000)];
        for (uint256 i = 0; i < valid.length; i++) {
            router.setPoolFee(valid[i]);
            assertEq(router.poolFee(), valid[i]);
        }
    }

    function test_SetPoolFee_RevertInvalid() public {
        vm.expectRevert(PoolErrors.InvalidPoolFee.selector);
        router.setPoolFee(200);
    }

    function test_SetPoolFee2() public {
        router.setPoolFee2(500);
        assertEq(router.poolFee2(), 500);
    }

    function test_SetPoolFee2_RevertInvalid() public {
        vm.expectRevert(PoolErrors.InvalidPoolFee.selector);
        router.setPoolFee2(3000);
    }

    function test_SetWeth() public {
        router.setWeth(address(0x999));
        assertEq(router.weth(), address(0x999));
    }

    function test_SetWeth_RevertZero() public {
        vm.expectRevert(PoolErrors.InvalidAddress.selector);
        router.setWeth(address(0));
    }

    function test_SetMinBuybackThreshold() public {
        router.setMinBuybackThreshold(42);
        assertEq(router.minBuybackThreshold(), 42);
    }

    function test_SetBurnAddress() public {
        router.setBurnAddress(address(0xBEEF));
        assertEq(router.sqdBurnAddress(), address(0xBEEF));
    }

    function test_SetBurnAddress_RevertZero() public {
        vm.expectRevert(PoolErrors.InvalidAddress.selector);
        router.setBurnAddress(address(0));
    }

    function test_SetWorkerPoolAddress() public {
        router.setWorkerPoolAddress(address(0xCAFE));
        assertEq(router.getWorkerPoolAddress(), address(0xCAFE));
    }

    function test_SetWorkerPoolAddress_RevertZero() public {
        vm.expectRevert(PoolErrors.InvalidAddress.selector);
        router.setWorkerPoolAddress(address(0));
    }

    function test_Pause_Unpause() public {
        router.pause();
        assertTrue(router.paused());
        router.unpause();
        assertFalse(router.paused());
    }

    function test_Pause_RevertNonAdmin() public {
        vm.prank(user1);
        vm.expectRevert();
        router.pause();
    }

    // ═══════════════════════════════════════════════════════
    // recoverTokens
    // ═══════════════════════════════════════════════════════

    function test_RecoverTokens_Success() public {
        MockERC20 rnd = new MockERC20("R", "R", 18);
        rnd.mint(address(router), 500 ether);
        router.recoverTokens(address(rnd), user1, 500 ether);
        assertEq(rnd.balanceOf(user1), 500 ether);
    }

    function test_RecoverTokens_RevertAllowed() public {
        vm.expectRevert(PoolErrors.TokenNotAllowed.selector);
        router.recoverTokens(address(usdc), user1, 100);
    }

    function test_RecoverTokens_RevertZeroTo() public {
        MockERC20 rnd = new MockERC20("R", "R", 18);
        rnd.mint(address(router), 100);
        vm.expectRevert(PoolErrors.InvalidAddress.selector);
        router.recoverTokens(address(rnd), address(0), 100);
    }

    function test_RecoverTokens_RevertNonAdmin() public {
        vm.prank(user1);
        vm.expectRevert();
        router.recoverTokens(address(usdc), user1, 100);
    }

    // ═══════════════════════════════════════════════════════
    // Views
    // ═══════════════════════════════════════════════════════

    function test_GetPendingBuyback() public {
        usdc.approve(address(router), 300 * 1e6);
        router.routeToBurn(address(usdc), 300 * 1e6);
        assertEq(router.getPendingBuyback(address(usdc)), 300 * 1e6);
    }

    function test_GetAccumulatedTokens_Empty() public view {
        (address[] memory t, uint256[] memory a) = router.getAccumulatedTokens();
        assertEq(t.length, 0);
        assertEq(a.length, 0);
    }

    // ═══════════════════════════════════════════════════════
    // E2E
    // ═══════════════════════════════════════════════════════

    function test_E2E_AccumulateAndBuyback() public {
        pancakeRouter.setRate(3, 1);
        for (uint256 i = 0; i < 3; i++) {
            usdc.approve(address(router), 500 * 1e6);
            router.routeToBurn(address(usdc), 500 * 1e6);
        }
        // 1500 USDC -> 4500 SQD. workers = 4500*4500/5000=4050, burn = 450
        uint256 bought = router.executeBuyback(address(usdc), 0);
        assertEq(bought, 4500 * 1e6);
        assertEq(sqdToken.balanceOf(workerPool), 4050 * 1e6);
        assertEq(sqdToken.balanceOf(burnAddr), 450 * 1e6);
    }

    function test_E2E_AutoBuyback_ThirdDeposit() public {
        router.setAutoBuybackEnabled(true);
        router.setMinBuybackThreshold(250 * 1e6);
        pancakeRouter.setRate(2, 1);

        usdc.approve(address(router), 300 * 1e6);
        router.routeToBurn(address(usdc), 100 * 1e6);
        router.routeToBurn(address(usdc), 100 * 1e6);
        router.routeToBurn(address(usdc), 100 * 1e6);

        // 300 USDC -> 600 SQD. workers = 600*4500/5000=540, burn = 60
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(sqdToken.balanceOf(workerPool), 540 * 1e6);
        assertEq(sqdToken.balanceOf(burnAddr), 60 * 1e6);
    }

    /// @notice Verify spec: $10,000 top-up -> 50% providers, 45% workers (SQD), 5% burn (SQD)
    function test_E2E_SpecSplit_50_45_5() public {
        pancakeRouter.setRate(1, 1); // 1:1 for easy math
        uint256 totalFee = 10000 * 1e6;

        (uint256 toProviders,, uint256 toProtocol) = router.calculateSplit(totalFee);
        assertEq(toProviders, 5000 * 1e6, "50% stays as USDC for providers");
        assertEq(toProtocol, 5000 * 1e6, "50% goes to swap");

        usdc.approve(address(router), toProtocol);
        router.routeToBurn(address(usdc), toProtocol);
        router.executeBuyback(address(usdc), 0);

        // 5000 SQD -> 4500 to workers, 500 burned
        assertEq(sqdToken.balanceOf(workerPool), 4500 * 1e6, "45% of total to workers");
        assertEq(sqdToken.balanceOf(burnAddr), 500 * 1e6, "5% of total burned");
    }

    /// @notice Custom: 30/50/20 -> 70% swapped, workers=50/70, burn=20/70
    function test_E2E_CustomSplit_30_50_20() public {
        router.setFeeConfig(3000, 5000, 2000);
        pancakeRouter.setRate(1, 1);
        uint256 totalFee = 10000 * 1e6;

        (uint256 toProviders,, uint256 toProtocol) = router.calculateSplit(totalFee);
        assertEq(toProviders, 3000 * 1e6, "30% providers");
        assertEq(toProtocol, 7000 * 1e6, "70% to swap");

        usdc.approve(address(router), toProtocol);
        router.routeToBurn(address(usdc), toProtocol);
        router.executeBuyback(address(usdc), 0);

        // 7000 SQD -> workers = 7000*5000/7000=5000, burn = 7000-5000=2000
        assertEq(sqdToken.balanceOf(workerPool), 5000 * 1e6, "50% of total to workers");
        assertEq(sqdToken.balanceOf(burnAddr), 2000 * 1e6, "20% of total burned");
    }

    // ═══════════════════════════════════════════════════════
    // TWAP slippage protection
    // ═══════════════════════════════════════════════════════

    function _setupTwap() internal returns (MockPancakeFactory, MockPancakePool, MockPancakePool) {
        MockPancakeFactory factory = new MockPancakeFactory();

        // order tokens correctly for pool token0/token1
        address t0Hop1 = address(usdc) < address(wethToken) ? address(usdc) : address(wethToken);
        address t1Hop1 = address(usdc) < address(wethToken) ? address(wethToken) : address(usdc);
        MockPancakePool pool1 = new MockPancakePool(t0Hop1, t1Hop1);

        address t0Hop2 = address(wethToken) < address(sqdToken) ? address(wethToken) : address(sqdToken);
        address t1Hop2 = address(wethToken) < address(sqdToken) ? address(sqdToken) : address(wethToken);
        MockPancakePool pool2 = new MockPancakePool(t0Hop2, t1Hop2);

        factory.setPool(address(usdc), address(wethToken), 500, address(pool1));
        factory.setPool(address(wethToken), address(sqdToken), 10000, address(pool2));

        // tick=0 means 1:1 price. set cumulative so twapTick = 0 over 1800s window
        pool1.setTickCumulatives(0, 0);
        pool2.setTickCumulatives(0, 0);

        router.configureSlippageProtection(
            address(factory),
            500,    // oraclePoolFee for USDC/WETH
            10000,  // oraclePoolFee2 for WETH/SQD
            1800,   // 30 min twap window
            300     // 3% max slippage
        );

        return (factory, pool1, pool2);
    }

    function test_ConfigureSlippageProtection() public {
        _setupTwap();
        assertEq(router.maxSlippageBPS(), 300);
        assertEq(router.twapWindow(), 1800);
        assertEq(router.oraclePoolFee(), 500);
        assertEq(router.oraclePoolFee2(), 10000);
    }

    function test_ConfigureSlippageProtection_RevertZeroFactory() public {
        vm.expectRevert(PoolErrors.InvalidAddress.selector);
        router.configureSlippageProtection(address(0), 500, 10000, 1800, 300);
    }

    function test_ConfigureSlippageProtection_RevertZeroWindow() public {
        vm.expectRevert(PoolErrors.InvalidAmount.selector);
        router.configureSlippageProtection(address(0x1), 500, 10000, 0, 300);
    }

    function test_ConfigureSlippageProtection_RevertSlippageTooHigh() public {
        vm.expectRevert(PoolErrors.InvalidFeeConfig.selector);
        router.configureSlippageProtection(address(0x1), 500, 10000, 1800, 10001);
    }

    function test_ConfigureSlippageProtection_RevertNonAdmin() public {
        vm.prank(user1);
        vm.expectRevert();
        router.configureSlippageProtection(address(0x1), 500, 10000, 1800, 300);
    }

    function test_SetMaxSlippageBPS() public {
        router.setMaxSlippageBPS(500);
        assertEq(router.maxSlippageBPS(), 500);
    }

    function test_SetMaxSlippageBPS_RevertTooHigh() public {
        vm.expectRevert(PoolErrors.InvalidFeeConfig.selector);
        router.setMaxSlippageBPS(10001);
    }

    function test_SetMaxSlippageBPS_RevertNonAdmin() public {
        vm.prank(user1);
        vm.expectRevert();
        router.setMaxSlippageBPS(500);
    }

    function test_SetTwapWindow() public {
        router.setTwapWindow(600);
        assertEq(router.twapWindow(), 600);
    }

    function test_SetTwapWindow_RevertZero() public {
        vm.expectRevert(PoolErrors.InvalidAmount.selector);
        router.setTwapWindow(0);
    }

    function test_SetTwapWindow_RevertNonAdmin() public {
        vm.prank(user1);
        vm.expectRevert();
        router.setTwapWindow(600);
    }

    function test_AutoBuyback_WithTwapProtection_FairPrice() public {
        _setupTwap();
        router.setAutoBuybackEnabled(true);
        pancakeRouter.setRate(1, 1); // 1:1 = fair price (tick=0 means 1:1)

        usdc.approve(address(router), 200 * 1e6);
        // auto-buyback triggers; twap says 1:1, slippage 3%, minOut = 194
        // actual output 200 >= 194, passes
        router.routeToBurn(address(usdc), 200 * 1e6);

        // should succeed
        assertEq(usdc.balanceOf(address(router)), 0, "swapped successfully");
        assertGt(sqdToken.balanceOf(workerPool) + sqdToken.balanceOf(burnAddr), 0);
    }

    function test_AutoBuyback_WithTwapProtection_BadPrice_Reverts() public {
        _setupTwap();
        router.setAutoBuybackEnabled(true);
        // sandwich: rate is 0.5 SQD per USDC (50% loss vs twap 1:1)
        pancakeRouter.setRate(1, 2);

        usdc.approve(address(router), 200 * 1e6);
        // auto-buyback triggers but minSqdOut from twap = 200*0.97 = 194
        // actual output = 100, which is < 194 -> reverts inside router.exactInput
        // but routeToBurn catches this via the revert and... actually nonReentrant
        // the whole tx should revert
        vm.expectRevert("MockRouter: insufficient output");
        router.routeToBurn(address(usdc), 200 * 1e6);
    }

    function test_ManualBuyback_CallerSlippage_OverridesTwap() public {
        _setupTwap();
        pancakeRouter.setRate(1, 2); // bad rate: 0.5x

        usdc.approve(address(router), 200 * 1e6);
        router.routeToBurn(address(usdc), 200 * 1e6);

        // manual call with explicit minSqdOut=50 (caller accepts bad price)
        uint256 bought = router.executeBuyback(address(usdc), 50 * 1e6);
        assertEq(bought, 100 * 1e6, "caller accepted 0.5x rate");
    }

    function test_AutoBuyback_NoTwapConfig_NoProtection() public {
        // don't call _setupTwap(), maxSlippageBPS=0 and factory=0
        router.setAutoBuybackEnabled(true);
        pancakeRouter.setRate(1, 10); // terrible rate

        usdc.approve(address(router), 200 * 1e6);
        // without twap config, minSqdOut stays 0 (no protection)
        router.routeToBurn(address(usdc), 200 * 1e6);

        // goes through at terrible rate
        uint256 total = sqdToken.balanceOf(workerPool) + sqdToken.balanceOf(burnAddr);
        assertEq(total, 20 * 1e6, "no protection, got terrible rate");
    }
}
