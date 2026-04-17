// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import {FeeRouterModuleV2} from "../../src/FeeRouterModuleV2.sol";
import {IFeeRouterV2} from "../../src/interfaces/IFeeRouterV2.sol";
import {IPancakeV3Pool} from "../../src/interfaces/IPancakeV3Pool.sol";
import {PoolErrors} from "../../src/libs/PoolErrors.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockPancakeRouter} from "../mocks/MockPancakeRouter.sol";
import {MockPancakeFactory} from "../mocks/MockPancakeFactory.sol";
import {MockPancakePool} from "../mocks/MockPancakePool.sol";

/// @dev Pool that reverts when asked for TWAP data. Used to drive _probeOraclePool's catch path.
contract RevertingObservePool is IPancakeV3Pool {
    function observe(uint32[] calldata) external pure override returns (int56[] memory, uint160[] memory) {
        revert("OLD");
    }

    function slot0() external pure override returns (uint160, int24, uint16, uint16, uint16, uint32, bool) {
        return (0, 0, 0, 0, 0, 0, false);
    }

    function token0() external pure override returns (address) {
        return address(0);
    }

    function token1() external pure override returns (address) {
        return address(0);
    }
}

/// @dev Focused coverage for the review-driven hardening:
/// - MAX_SLIPPAGE_BPS and MIN_TWAP_WINDOW boundaries
/// - Every ReadyReason exit of isSlippageProtectionReady
/// - _probeOraclePool outcomes (missing pool, observe-revert, ok)
contract FeeRouterV2GovernanceTest is Test {
    MockERC20 internal usdc;
    MockERC20 internal sqdToken;
    MockERC20 internal wethToken;
    MockPancakeRouter internal pancakeRouter;
    MockPancakeFactory internal pancakeFactory;

    address internal constant WORKER_POOL = address(0x5555);
    uint24 internal constant FEE1 = 2500;
    uint24 internal constant FEE2 = 2500;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        sqdToken = new MockERC20("Subsquid", "SQD", 18);
        wethToken = new MockERC20("WETH", "WETH", 18);
        pancakeRouter = new MockPancakeRouter();
        pancakeFactory = new MockPancakeFactory();
    }

    /* ------------------------------------------------------------ */
    /* Constants                                                    */
    /* ------------------------------------------------------------ */

    function test_Constants_Values() public {
        FeeRouterModuleV2 r = new FeeRouterModuleV2();
        assertEq(r.MAX_SLIPPAGE_BPS(), 5000, "cap expected at 50%");
        assertEq(r.MIN_TWAP_WINDOW(), 600, "min window expected at 10min");
    }

    /* ------------------------------------------------------------ */
    /* setMaxSlippageBPS boundary                                   */
    /* ------------------------------------------------------------ */

    function test_SetMaxSlippageBPS_AcceptsExactMax() public {
        FeeRouterModuleV2 r = _routerReadyForSlippage();
        r.configureSlippageProtection(address(pancakeFactory), 1800, 300);
        r.setMaxSlippageBPS(5000);
        assertEq(r.maxSlippageBPS(), 5000);
    }

    function test_SetMaxSlippageBPS_RevertsOneAboveMax() public {
        FeeRouterModuleV2 r = _routerReadyForSlippage();
        vm.expectRevert(PoolErrors.InvalidFeeConfig.selector);
        r.setMaxSlippageBPS(5001);
    }

    function test_SetMaxSlippageBPS_AcceptsZero() public {
        FeeRouterModuleV2 r = _routerReadyForSlippage();
        r.configureSlippageProtection(address(pancakeFactory), 1800, 300);
        r.setMaxSlippageBPS(0);
        assertEq(r.maxSlippageBPS(), 0, "zero is valid (strict TWAP)");
    }

    function test_SetMaxSlippageBPS_RevertsForNonAdmin() public {
        FeeRouterModuleV2 r = _routerReadyForSlippage();
        vm.prank(address(0xBEEF));
        vm.expectRevert();
        r.setMaxSlippageBPS(500);
    }

    /* ------------------------------------------------------------ */
    /* setTwapWindow boundary                                       */
    /* ------------------------------------------------------------ */

    function test_SetTwapWindow_AcceptsExactMin() public {
        FeeRouterModuleV2 r = _routerReadyForSlippage();
        r.configureSlippageProtection(address(pancakeFactory), 1800, 300);
        r.setTwapWindow(600);
        assertEq(r.twapWindow(), 600);
    }

    function test_SetTwapWindow_RevertsOneBelowMin() public {
        FeeRouterModuleV2 r = _routerReadyForSlippage();
        vm.expectRevert(PoolErrors.InvalidAmount.selector);
        r.setTwapWindow(599);
    }

    function test_SetTwapWindow_RevertsForNonAdmin() public {
        FeeRouterModuleV2 r = _routerReadyForSlippage();
        vm.prank(address(0xBEEF));
        vm.expectRevert();
        r.setTwapWindow(1800);
    }

    /* ------------------------------------------------------------ */
    /* configureSlippageProtection boundaries                       */
    /* ------------------------------------------------------------ */

    function test_ConfigureSlippageProtection_AcceptsExactBoundaries() public {
        FeeRouterModuleV2 r = _routerReadyForSlippage();
        r.configureSlippageProtection(address(pancakeFactory), 600, 5000);
        assertEq(r.twapWindow(), 600);
        assertEq(r.maxSlippageBPS(), 5000);
    }

    function test_ConfigureSlippageProtection_RevertsWindowOneBelowMin() public {
        FeeRouterModuleV2 r = _routerReadyForSlippage();
        vm.expectRevert(PoolErrors.InvalidAmount.selector);
        r.configureSlippageProtection(address(pancakeFactory), 599, 300);
    }

    function test_ConfigureSlippageProtection_RevertsSlippageOneAboveMax() public {
        FeeRouterModuleV2 r = _routerReadyForSlippage();
        vm.expectRevert(PoolErrors.InvalidFeeConfig.selector);
        r.configureSlippageProtection(address(pancakeFactory), 1800, 5001);
    }

    /* ------------------------------------------------------------ */
    /* isSlippageProtectionReady — every ReadyReason branch         */
    /* ------------------------------------------------------------ */

    function test_IsReady_TokenNotAllowed() public {
        FeeRouterModuleV2 r = _fullyConfigured();
        MockERC20 unlisted = new MockERC20("X", "X", 18);

        (bool ok, IFeeRouterV2.ReadyReason reason) = r.isSlippageProtectionReady(address(unlisted));
        assertFalse(ok);
        assertEq(uint8(reason), uint8(IFeeRouterV2.ReadyReason.TokenNotAllowed));
    }

    function test_IsReady_SqdShortcutsWithoutOracle() public {
        // Router configured for buyback but no slippage/oracle setup at all.
        // SQD reward must still report Ready because the buyback code takes the SQD shortcut.
        FeeRouterModuleV2 r = new FeeRouterModuleV2();
        r.configureBuyback(address(pancakeRouter), address(sqdToken), address(wethToken), FEE1, FEE2);
        r.setAllowedRewardToken(address(sqdToken), true);
        r.setBuybackEnabled(true);

        (bool ok, IFeeRouterV2.ReadyReason reason) = r.isSlippageProtectionReady(address(sqdToken));
        assertTrue(ok, "SQD path does not require oracle");
        assertEq(uint8(reason), uint8(IFeeRouterV2.ReadyReason.Ready));
    }

    function test_IsReady_BuybackNotConfigured_WhenDisabled() public {
        FeeRouterModuleV2 r = new FeeRouterModuleV2();
        r.configureBuyback(address(pancakeRouter), address(sqdToken), address(wethToken), FEE1, FEE2);
        r.setAllowedRewardToken(address(usdc), true);
        // buybackEnabled stays false

        (bool ok, IFeeRouterV2.ReadyReason reason) = r.isSlippageProtectionReady(address(usdc));
        assertFalse(ok);
        assertEq(uint8(reason), uint8(IFeeRouterV2.ReadyReason.BuybackNotConfigured));
    }

    function test_IsReady_BuybackNotConfigured_WhenRouterUnset() public {
        // Fresh contract: configureBuyback never called (router/sqd/weth all zero).
        FeeRouterModuleV2 r = new FeeRouterModuleV2();
        r.setAllowedRewardToken(address(usdc), true);

        (bool ok, IFeeRouterV2.ReadyReason reason) = r.isSlippageProtectionReady(address(usdc));
        assertFalse(ok);
        assertEq(uint8(reason), uint8(IFeeRouterV2.ReadyReason.BuybackNotConfigured));
    }

    function test_IsReady_SlippageNotConfigured_WhenFactoryMissing() public {
        FeeRouterModuleV2 r = _routerReadyForSlippage();
        // configureSlippageProtection intentionally skipped: factory=0, window=0

        (bool ok, IFeeRouterV2.ReadyReason reason) = r.isSlippageProtectionReady(address(usdc));
        assertFalse(ok);
        assertEq(uint8(reason), uint8(IFeeRouterV2.ReadyReason.SlippageNotConfigured));
    }

    function test_IsReady_WethSqdPoolMissing() public {
        FeeRouterModuleV2 r = _routerReadyForSlippage();
        r.configureSlippageProtection(address(pancakeFactory), 1800, 300);
        // Factory has no pools registered at all.

        (bool ok, IFeeRouterV2.ReadyReason reason) = r.isSlippageProtectionReady(address(usdc));
        assertFalse(ok);
        assertEq(uint8(reason), uint8(IFeeRouterV2.ReadyReason.WethSqdPoolMissing));
    }

    function test_IsReady_WethSqdPoolExistsButObserveReverts() public {
        FeeRouterModuleV2 r = _routerReadyForSlippage();
        r.configureSlippageProtection(address(pancakeFactory), 1800, 300);
        // weth/sqd pool address returns a pool whose observe() reverts → try/catch catches.
        RevertingObservePool badPool = new RevertingObservePool();
        pancakeFactory.setPool(address(wethToken), address(sqdToken), FEE2, address(badPool));

        (bool ok, IFeeRouterV2.ReadyReason reason) = r.isSlippageProtectionReady(address(usdc));
        assertFalse(ok);
        assertEq(uint8(reason), uint8(IFeeRouterV2.ReadyReason.WethSqdPoolNotReady));
    }

    function test_IsReady_RewardWethPoolMissing() public {
        FeeRouterModuleV2 r = _routerReadyForSlippage();
        r.configureSlippageProtection(address(pancakeFactory), 1800, 300);
        // weth/sqd present, reward/weth absent
        _registerValidPool(address(wethToken), address(sqdToken), FEE2);

        (bool ok, IFeeRouterV2.ReadyReason reason) = r.isSlippageProtectionReady(address(usdc));
        assertFalse(ok);
        assertEq(uint8(reason), uint8(IFeeRouterV2.ReadyReason.RewardWethPoolMissing));
    }

    function test_IsReady_RewardWethPoolExistsButObserveReverts() public {
        FeeRouterModuleV2 r = _routerReadyForSlippage();
        r.configureSlippageProtection(address(pancakeFactory), 1800, 300);
        _registerValidPool(address(wethToken), address(sqdToken), FEE2);
        // reward/weth pool returns a contract whose observe() reverts.
        RevertingObservePool badPool = new RevertingObservePool();
        pancakeFactory.setPool(address(usdc), address(wethToken), FEE1, address(badPool));

        (bool ok, IFeeRouterV2.ReadyReason reason) = r.isSlippageProtectionReady(address(usdc));
        assertFalse(ok);
        assertEq(uint8(reason), uint8(IFeeRouterV2.ReadyReason.RewardWethPoolNotReady));
    }

    function test_IsReady_ReadyWhenEverythingConfigured() public {
        FeeRouterModuleV2 r = _fullyConfigured();

        (bool ok, IFeeRouterV2.ReadyReason reason) = r.isSlippageProtectionReady(address(usdc));
        assertTrue(ok);
        assertEq(uint8(reason), uint8(IFeeRouterV2.ReadyReason.Ready));
    }

    function test_IsReady_WethAsRewardSkipsRewardWethProbe() public {
        // When rewardToken == WETH the reward/weth hop is unreachable; only weth/sqd is required.
        FeeRouterModuleV2 r = _routerReadyForSlippage();
        r.setAllowedRewardToken(address(wethToken), true);
        r.configureSlippageProtection(address(pancakeFactory), 1800, 300);
        _registerValidPool(address(wethToken), address(sqdToken), FEE2);
        // Deliberately skip any usdc/weth pool setup.

        (bool ok, IFeeRouterV2.ReadyReason reason) = r.isSlippageProtectionReady(address(wethToken));
        assertTrue(ok, "weth-in path should not require a weth/weth hop");
        assertEq(uint8(reason), uint8(IFeeRouterV2.ReadyReason.Ready));
    }

    /* ------------------------------------------------------------ */
    /* Helpers                                                      */
    /* ------------------------------------------------------------ */

    function _routerReadyForSlippage() internal returns (FeeRouterModuleV2 r) {
        r = new FeeRouterModuleV2();
        r.configureBuyback(address(pancakeRouter), address(sqdToken), address(wethToken), FEE1, FEE2);
        r.setWorkerPoolAddress(WORKER_POOL);
        r.setAllowedRewardToken(address(usdc), true);
        r.setBuybackEnabled(true);
    }

    function _fullyConfigured() internal returns (FeeRouterModuleV2 r) {
        r = _routerReadyForSlippage();
        r.configureSlippageProtection(address(pancakeFactory), 1800, 300);
        _registerValidPool(address(wethToken), address(sqdToken), FEE2);
        _registerValidPool(address(usdc), address(wethToken), FEE1);
    }

    function _registerValidPool(address tokenA, address tokenB, uint24 fee) internal {
        address t0 = tokenA < tokenB ? tokenA : tokenB;
        address t1 = tokenA < tokenB ? tokenB : tokenA;
        MockPancakePool pool = new MockPancakePool(t0, t1);
        pool.setTickCumulatives(0, 0);
        pancakeFactory.setPool(tokenA, tokenB, fee, address(pool));
    }
}
