// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import {FeeRouterModuleV2} from "../../src/FeeRouterModuleV2.sol";
import {IFeeRouterV2} from "../../src/interfaces/IFeeRouterV2.sol";
import {PoolErrors} from "../../src/libs/PoolErrors.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockPancakeRouter} from "../mocks/MockPancakeRouter.sol";
import {MockPancakeFactory} from "../mocks/MockPancakeFactory.sol";
import {MockPancakePool} from "../mocks/MockPancakePool.sol";

contract FeeRouterModuleV2Test is Test {
    FeeRouterModuleV2 public router;
    MockERC20 public usdc;
    MockERC20 public sqdToken;
    MockERC20 public wethToken;
    MockPancakeRouter public pancakeRouter;
    MockPancakeFactory public pancakeFactory;

    address public admin = address(this);
    address public workerPool = address(0x5555);
    address public burnAddr = address(0xdead);
    address public user1 = address(0x1);

    uint32 internal constant TWAP_WINDOW = 1800;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        sqdToken = new MockERC20("Subsquid", "SQD", 18);
        wethToken = new MockERC20("WETH", "WETH", 18);
        pancakeRouter = new MockPancakeRouter();
        pancakeFactory = new MockPancakeFactory();

        router = _newRouter();
        router.configureBuyback(address(pancakeRouter), address(sqdToken), address(wethToken), 2500, 2500);
        router.setWorkerPoolAddress(workerPool);
        router.setFeeConfig(5000, 4500, 500);
        router.setAllowedRewardToken(address(usdc), true);
        router.setAllowedRewardToken(address(sqdToken), true);
        router.setBuybackEnabled(true);
        _setupTwap();

        usdc.mint(admin, 100_000_000 * 1e6);
        usdc.mint(user1, 10_000_000 * 1e6);
        sqdToken.mint(admin, 1_000_000 ether);
    }

    function test_Constructor_Defaults() public {
        FeeRouterModuleV2 fresh = _newRouter();
        IFeeRouterV2.FeeConfig memory cfg = fresh.getFeeConfig();
        assertEq(cfg.toProvidersBPS, 10_000);
        assertEq(cfg.toWorkerPoolBPS, 0);
        assertEq(cfg.toBurnBPS, 0);
        assertEq(fresh.sqdBurnAddress(), burnAddr);
        assertTrue(fresh.hasRole(fresh.DEFAULT_ADMIN_ROLE(), admin));
        assertEq(fresh.getBurnAddress(), address(fresh));
    }

    function test_CalculateSplit_Default() public view {
        (uint256 toProviders, uint256 toWorkerPool, uint256 toBurn) = router.calculateSplit(10000 * 1e6);
        assertEq(toProviders, 5000 * 1e6);
        assertEq(toWorkerPool, 0);
        assertEq(toBurn, 5000 * 1e6);
    }

    function test_CalculateSplit_OddAmount() public view {
        (uint256 a, uint256 b, uint256 c) = router.calculateSplit(1001);
        assertEq(a, 500);
        assertEq(b, 0);
        assertEq(c, 501);
        assertEq(a + b + c, 1001);
    }

    function testFuzz_CalculateSplit_TotalEqualsInput(uint256 amount) public view {
        vm.assume(amount < type(uint256).max / 10000);
        (uint256 a, uint256 b, uint256 c) = router.calculateSplit(amount);
        assertEq(a + b + c, amount);
        assertEq(b, 0);
    }

    function test_SetFeeConfig_Success() public {
        vm.expectEmit(true, true, true, true);
        emit IFeeRouterV2.FeeConfigUpdated(3000, 5000, 2000);
        router.setFeeConfig(3000, 5000, 2000);

        IFeeRouterV2.FeeConfig memory cfg = router.getFeeConfig();
        assertEq(cfg.toProvidersBPS, 3000);
        assertEq(cfg.toWorkerPoolBPS, 5000);
        assertEq(cfg.toBurnBPS, 2000);
    }

    function test_SetFeeConfig_RevertInvalidTotal() public {
        vm.expectRevert(PoolErrors.InvalidFeeConfig.selector);
        router.setFeeConfig(5000, 4000, 500);
    }

    function test_RouteToWorkerPool_Success() public {
        usdc.approve(address(router), 1000 * 1e6);
        router.routeToWorkerPool(address(usdc), 1000 * 1e6);
        assertEq(usdc.balanceOf(workerPool), 1000 * 1e6);
    }

    function test_RouteToWorkerPool_RevertNoAddress() public {
        FeeRouterModuleV2 fresh = _newRouter();
        fresh.setAllowedRewardToken(address(usdc), true);
        usdc.approve(address(fresh), 100);
        vm.expectRevert(PoolErrors.InvalidAddress.selector);
        fresh.routeToWorkerPool(address(usdc), 100);
    }

    function test_RouteToWorkerPool_RevertTokenNotAllowed() public {
        FeeRouterModuleV2 fresh = _newRouter();
        fresh.setWorkerPoolAddress(workerPool);
        usdc.approve(address(fresh), 100);
        vm.expectRevert(PoolErrors.TokenNotAllowed.selector);
        fresh.routeToWorkerPool(address(usdc), 100);
    }

    function test_RouteToBurn_ExecutesImmediately() public {
        pancakeRouter.setRate(2, 1);
        usdc.approve(address(router), 50 * 1e6);

        router.routeToBurn(address(usdc), 50 * 1e6);

        assertEq(usdc.balanceOf(address(router)), 0, "no reward tokens left on router");
        assertEq(router.getPendingBuyback(address(usdc)), 0, "no pending buyback");
        assertEq(sqdToken.balanceOf(workerPool), 90 * 1e6, "90% of SQD to workers");
        assertEq(sqdToken.balanceOf(burnAddr), 10 * 1e6, "10% of SQD burned");
    }

    function test_RouteToBurn_UsesSingleHop_WhenRewardTokenIsWeth() public {
        router.setAllowedRewardToken(address(wethToken), true);
        pancakeRouter.setRate(2, 1);
        wethToken.mint(admin, 50 ether);
        wethToken.approve(address(router), 50 ether);

        router.routeToBurn(address(wethToken), 50 ether);

        assertEq(wethToken.balanceOf(address(router)), 0, "weth input should not remain on router");
        assertEq(sqdToken.balanceOf(workerPool), 90 ether, "single-hop weth->sqd should split to workers");
        assertEq(sqdToken.balanceOf(burnAddr), 10 ether, "single-hop weth->sqd should split to burn");
    }

    function test_ConfigureBuyback_RevertWhenSqdEqualsWeth() public {
        vm.expectRevert(PoolErrors.InvalidTokenConfig.selector);
        router.configureBuyback(address(pancakeRouter), address(wethToken), address(wethToken), 2500, 2500);
    }

    function test_SetWeth_RevertWhenEqualsSqd() public {
        vm.expectRevert(PoolErrors.InvalidTokenConfig.selector);
        router.setWeth(address(sqdToken));
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
        assertEq(router.getPendingBuyback(address(usdc)), 0);
    }

    function test_RouteToBurn_RevertWhenPaused() public {
        router.pause();
        vm.expectRevert();
        router.routeToBurn(address(usdc), 100);
    }

    function test_RouteToBurn_SqdInputSplitsDirectly() public {
        sqdToken.approve(address(router), 100 ether);

        router.routeToBurn(address(sqdToken), 100 ether);

        assertEq(sqdToken.balanceOf(workerPool), 90 ether);
        assertEq(sqdToken.balanceOf(burnAddr), 10 ether);
        assertEq(sqdToken.balanceOf(address(router)), 0);
    }

    function test_ExecuteBuyback_SweepsDirectTransfer() public {
        pancakeRouter.setRate(2, 1);
        usdc.transfer(address(router), 500 * 1e6);

        uint256 bought = router.executeBuyback(address(usdc));

        assertEq(bought, 1000 * 1e6);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(sqdToken.balanceOf(workerPool), 900 * 1e6);
        assertEq(sqdToken.balanceOf(burnAddr), 100 * 1e6);
    }

    function test_ExecuteBuyback_UsesSingleHop_WhenRewardTokenIsWeth() public {
        router.setAllowedRewardToken(address(wethToken), true);
        pancakeRouter.setRate(2, 1);
        wethToken.mint(address(router), 50 ether);

        uint256 bought = router.executeBuyback(address(wethToken));

        assertEq(bought, 100 ether);
        assertEq(wethToken.balanceOf(address(router)), 0, "single-hop sweep should clear weth balance");
        assertEq(sqdToken.balanceOf(workerPool), 90 ether, "workers receive swapped sqd");
        assertEq(sqdToken.balanceOf(burnAddr), 10 ether, "burn receives swapped sqd");
    }

    function test_ExecuteBuyback_RevertNothingToBuyback() public {
        vm.expectRevert(PoolErrors.NothingToBuyback.selector);
        router.executeBuyback(address(usdc));
    }

    function test_ExecuteBuyback_RevertDisallowedToken() public {
        MockERC20 rnd = new MockERC20("R", "R", 18);
        rnd.mint(address(router), 100);

        vm.expectRevert(PoolErrors.TokenNotAllowed.selector);
        router.executeBuyback(address(rnd));
    }

    function test_RouteToBurn_RevertsWhenBuybackDisabled() public {
        router.setBuybackEnabled(false);
        usdc.approve(address(router), 500 * 1e6);
        uint256 balanceBefore = usdc.balanceOf(admin);

        vm.expectRevert(PoolErrors.BuybackDisabled.selector);
        router.routeToBurn(address(usdc), 500 * 1e6);

        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(usdc.balanceOf(burnAddr), 0);
        assertEq(usdc.balanceOf(admin), balanceBefore, "route revert must refund reward tokens");
    }

    function test_ExecuteBuyback_RevertsWhenBuybackDisabled() public {
        FeeRouterModuleV2 fresh = _newRouter();
        fresh.setAllowedRewardToken(address(usdc), true);
        // buybackEnabled stays false
        usdc.transfer(address(fresh), 500 * 1e6);

        vm.expectRevert(PoolErrors.BuybackDisabled.selector);
        fresh.executeBuyback(address(usdc));

        assertEq(usdc.balanceOf(burnAddr), 0);
        assertEq(usdc.balanceOf(address(fresh)), 500 * 1e6);
    }

    function test_GetBuybackConfig() public view {
        (address r, address s, address w, uint24 f1, uint24 f2, bool enabled) = router.getBuybackConfig();

        assertEq(r, address(pancakeRouter));
        assertEq(s, address(sqdToken));
        assertEq(w, address(wethToken));
        assertEq(f1, 2500);
        assertEq(f2, 2500);
        assertTrue(enabled);
    }

    function test_ConfigureBuyback() public {
        router.configureBuyback(address(0xABC), address(0xDEF), address(0x123), 500, 100);
        (address r, address s, address w, uint24 f1, uint24 f2, bool en) = router.getBuybackConfig();

        assertEq(r, address(0xABC));
        assertEq(s, address(0xDEF));
        assertEq(w, address(0x123));
        assertEq(f1, 500);
        assertEq(f2, 100);
        assertTrue(en);
    }

    function test_ConfigureBuyback_RevertZeroAddresses() public {
        vm.expectRevert(PoolErrors.InvalidAddress.selector);
        router.configureBuyback(address(0), address(sqdToken), address(wethToken), 2500, 2500);

        vm.expectRevert(PoolErrors.InvalidAddress.selector);
        router.configureBuyback(address(pancakeRouter), address(0), address(wethToken), 2500, 2500);

        vm.expectRevert(PoolErrors.InvalidAddress.selector);
        router.configureBuyback(address(pancakeRouter), address(sqdToken), address(0), 2500, 2500);
    }

    function test_RouteToBurn_RevertsWhenTwapNotConfigured() public {
        FeeRouterModuleV2 fresh = _newRouter();
        fresh.configureBuyback(address(pancakeRouter), address(sqdToken), address(wethToken), 2500, 2500);
        fresh.setWorkerPoolAddress(workerPool);
        fresh.setAllowedRewardToken(address(usdc), true);
        fresh.setBuybackEnabled(true);

        usdc.approve(address(fresh), 200 * 1e6);

        vm.expectRevert(PoolErrors.SlippageProtectionNotConfigured.selector);
        fresh.routeToBurn(address(usdc), 200 * 1e6);
    }

    function test_ExecuteBuyback_RevertsWhenTwapNotConfigured() public {
        FeeRouterModuleV2 fresh = _newRouter();
        fresh.configureBuyback(address(pancakeRouter), address(sqdToken), address(wethToken), 2500, 2500);
        fresh.setWorkerPoolAddress(workerPool);
        fresh.setAllowedRewardToken(address(usdc), true);
        fresh.setBuybackEnabled(true);

        usdc.transfer(address(fresh), 200 * 1e6);

        vm.expectRevert(PoolErrors.SlippageProtectionNotConfigured.selector);
        fresh.executeBuyback(address(usdc));
    }

    function test_AdminSetters() public {
        router.setBuybackEnabled(false);
        assertFalse(router.buybackEnabled());

        MockERC20 t = new MockERC20("T", "T", 18);
        router.setAllowedRewardToken(address(t), true);
        assertTrue(router.allowedRewardTokens(address(t)));

        router.setPoolFee(500);
        router.setPoolFee2(100);
        router.setWeth(address(0x999));
        router.setBurnAddress(address(0xBEEF));
        router.setWorkerPoolAddress(address(0xCAFE));

        assertEq(router.poolFee(), 500);
        assertEq(router.poolFee2(), 100);
        assertEq(router.weth(), address(0x999));
        assertEq(router.sqdBurnAddress(), address(0xBEEF));
        assertEq(router.getWorkerPoolAddress(), address(0xCAFE));
    }

    function test_SetBurnAddress_RevertWhenSelf() public {
        vm.expectRevert(PoolErrors.InvalidAddress.selector);
        router.setBurnAddress(address(router));
    }

    function test_Pause_Unpause() public {
        router.pause();
        assertTrue(router.paused());
        router.unpause();
        assertFalse(router.paused());
    }

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

    function test_E2E_SpecSplit_50_45_5() public {
        pancakeRouter.setRate(1, 1);
        uint256 totalFee = 10000 * 1e6;

        (uint256 toProviders,, uint256 toProtocol) = router.calculateSplit(totalFee);
        assertEq(toProviders, 5000 * 1e6);
        assertEq(toProtocol, 5000 * 1e6);

        usdc.approve(address(router), toProtocol);
        router.routeToBurn(address(usdc), toProtocol);

        assertEq(sqdToken.balanceOf(workerPool), 4500 * 1e6);
        assertEq(sqdToken.balanceOf(burnAddr), 500 * 1e6);
        assertEq(usdc.balanceOf(address(router)), 0, "no protocol leftovers");
    }

    function test_ConfigureSlippageProtection() public {
        _setupTwap();
        assertEq(router.maxSlippageBPS(), 300);
        assertEq(router.twapWindow(), TWAP_WINDOW);
        assertEq(router.poolFee(), 2500);
        assertEq(router.poolFee2(), 2500);
    }

    function test_AutoRoute_WithTwapProtection_FairPrice() public {
        _setupTwap();
        pancakeRouter.setRate(1, 1);
        usdc.approve(address(router), 200 * 1e6);

        router.routeToBurn(address(usdc), 200 * 1e6);

        assertEq(usdc.balanceOf(address(router)), 0);
        assertGt(sqdToken.balanceOf(workerPool) + sqdToken.balanceOf(burnAddr), 0);
    }

    function test_AutoRoute_WithTwapProtection_BadPrice_Reverts() public {
        _setupTwap();
        pancakeRouter.setRate(1, 2);
        usdc.approve(address(router), 200 * 1e6);

        vm.expectRevert("MockRouter: insufficient output");
        router.routeToBurn(address(usdc), 200 * 1e6);

        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function test_ExecuteBuyback_UsesTwapProtection() public {
        _setupTwap();
        pancakeRouter.setRate(1, 2);
        usdc.transfer(address(router), 200 * 1e6);

        vm.expectRevert("MockRouter: insufficient output");
        router.executeBuyback(address(usdc));
    }

    function test_SetFeeConfig_RevertWorkerBPSWithoutWorkerPool() public {
        FeeRouterModuleV2 fresh = _newRouter();
        vm.expectRevert(PoolErrors.InvalidAddress.selector);
        fresh.setFeeConfig(5000, 4500, 500);
    }

    function test_SetTwapWindow_Success() public {
        _setupTwap();
        vm.expectEmit(true, true, true, true);
        emit IFeeRouterV2.TwapWindowChanged(TWAP_WINDOW, 3600);
        router.setTwapWindow(3600);
        assertEq(router.twapWindow(), 3600);
    }

    function test_SetTwapWindow_RevertZero() public {
        vm.expectRevert(PoolErrors.InvalidAmount.selector);
        router.setTwapWindow(0);
    }

    function test_SetMaxSlippageBPS_Success() public {
        _setupTwap();
        vm.expectEmit(true, true, true, true);
        emit IFeeRouterV2.MaxSlippageChanged(300, 500);
        router.setMaxSlippageBPS(500);
        assertEq(router.maxSlippageBPS(), 500);
    }

    function test_SetMaxSlippageBPS_RevertTooHigh() public {
        vm.expectRevert(PoolErrors.InvalidFeeConfig.selector);
        router.setMaxSlippageBPS(10_000);
    }

    function test_EmergencyRecover_Success() public {
        usdc.transfer(address(router), 500 * 1e6);
        router.pause();
        uint256 user1Before = usdc.balanceOf(user1);

        vm.expectEmit(true, true, false, true);
        emit IFeeRouterV2.TokensRecovered(address(usdc), user1, 500 * 1e6, true);
        router.emergencyRecoverRewardToken(address(usdc), user1, 500 * 1e6);

        assertEq(usdc.balanceOf(user1), user1Before + 500 * 1e6);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function test_EmergencyRecover_RevertWhenNotPaused() public {
        usdc.transfer(address(router), 500 * 1e6);
        vm.expectRevert();
        router.emergencyRecoverRewardToken(address(usdc), user1, 500 * 1e6);
    }

    function test_EmergencyRecover_RevertTokenNotAllowed() public {
        MockERC20 rnd = new MockERC20("R", "R", 18);
        router.pause();
        vm.expectRevert(PoolErrors.TokenNotAllowed.selector);
        router.emergencyRecoverRewardToken(address(rnd), user1, 100);
    }

    function test_EmergencyRecover_RevertZeroAddress() public {
        router.pause();
        vm.expectRevert(PoolErrors.InvalidAddress.selector);
        router.emergencyRecoverRewardToken(address(usdc), address(0), 100);
    }

    function test_RecoverTokens_EmitsEvent() public {
        MockERC20 rnd = new MockERC20("R", "R", 18);
        rnd.mint(address(router), 500 ether);

        vm.expectEmit(true, true, false, true);
        emit IFeeRouterV2.TokensRecovered(address(rnd), user1, 500 ether, false);
        router.recoverTokens(address(rnd), user1, 500 ether);
    }

    function test_SetAllowedRewardToken_RevertZeroAddressWhenAllowed() public {
        vm.expectRevert(PoolErrors.InvalidAddress.selector);
        router.setAllowedRewardToken(address(0), true);
    }

    function test_SetWeth_RevertZero() public {
        vm.expectRevert(PoolErrors.InvalidAddress.selector);
        router.setWeth(address(0));
    }

    function test_SetBurnAddress_RevertZero() public {
        vm.expectRevert(PoolErrors.InvalidAddress.selector);
        router.setBurnAddress(address(0));
    }

    function test_SetWorkerPoolAddress_RevertZero() public {
        vm.expectRevert(PoolErrors.InvalidAddress.selector);
        router.setWorkerPoolAddress(address(0));
    }

    function test_ConfigureSlippageProtection_RevertZeroWindow() public {
        vm.expectRevert(PoolErrors.InvalidAmount.selector);
        router.configureSlippageProtection(0, 300);
    }

    function test_RecoverTokens_RevertZeroAddress() public {
        MockERC20 rnd = new MockERC20("R", "R", 18);
        vm.expectRevert(PoolErrors.InvalidAddress.selector);
        router.recoverTokens(address(rnd), address(0), 100);
    }

    function _newRouter() internal returns (FeeRouterModuleV2) {
        return new FeeRouterModuleV2(
            address(pancakeRouter), address(pancakeFactory), address(sqdToken), address(wethToken)
        );
    }

    function _setupTwap() internal returns (MockPancakePool pool1, MockPancakePool pool2) {
        address t0Hop1 = address(usdc) < address(wethToken) ? address(usdc) : address(wethToken);
        address t1Hop1 = address(usdc) < address(wethToken) ? address(wethToken) : address(usdc);
        pool1 = new MockPancakePool(t0Hop1, t1Hop1);

        address t0Hop2 = address(wethToken) < address(sqdToken) ? address(wethToken) : address(sqdToken);
        address t1Hop2 = address(wethToken) < address(sqdToken) ? address(sqdToken) : address(wethToken);
        pool2 = new MockPancakePool(t0Hop2, t1Hop2);

        pancakeFactory.setPool(address(usdc), address(wethToken), router.poolFee(), address(pool1));
        pancakeFactory.setPool(address(wethToken), address(sqdToken), router.poolFee2(), address(pool2));
        pool1.setTickCumulatives(0, 0);
        pool2.setTickCumulatives(0, 0);

        router.configureSlippageProtection(TWAP_WINDOW, 300);
    }
}
