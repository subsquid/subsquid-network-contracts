// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import {FeeRouterModuleV2} from "../../src/FeeRouterModuleV2.sol";
import {PoolErrors} from "../../src/libs/PoolErrors.sol";
import {FullMath} from "../../src/libs/FullMath.sol";
import {TickMath} from "../../src/libs/TickMath.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockPancakeRouter} from "../mocks/MockPancakeRouter.sol";
import {MockPancakeFactory} from "../mocks/MockPancakeFactory.sol";
import {MockPancakePool} from "../mocks/MockPancakePool.sol";

contract FeeRouterV2RegressionTest is Test {
    uint32 internal constant TWAP_WINDOW = 1800;
    int24 internal constant TICK_FOR_2X_PRICE = 6931;

    FeeRouterModuleV2 internal router;
    MockERC20 internal usdc;
    MockERC20 internal sqdToken;
    MockERC20 internal wethToken;
    MockPancakeRouter internal pancakeRouter;

    address internal workerPool = address(0x5555);

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        sqdToken = new MockERC20("Subsquid", "SQD", 18);
        wethToken = new MockERC20("Wrapped Ether", "WETH", 18);
        pancakeRouter = new MockPancakeRouter();

        router = new FeeRouterModuleV2();
        router.configureBuyback(address(pancakeRouter), address(sqdToken), address(wethToken), 2500, 2500);
        router.setAllowedRewardToken(address(usdc), true);
        router.setWorkerPoolAddress(workerPool);
        router.setFeeConfig(5000, 4500, 500);
        router.setBuybackEnabled(true);

        usdc.mint(address(this), 1_000_000 * 1e6);
    }

    function test_NonOneToOneTwapFloorRejectsWorsePrice() public {
        MockPancakeFactory factory = new MockPancakeFactory();
        MockPancakePool rewardToWethPool = _deployPool(address(usdc), address(wethToken));
        MockPancakePool wethToSqdPool = _deployPool(address(wethToken), address(sqdToken));

        factory.setPool(address(usdc), address(wethToken), router.poolFee(), address(rewardToWethPool));
        factory.setPool(address(wethToken), address(sqdToken), router.poolFee2(), address(wethToSqdPool));

        _setReturnedTwapTick(rewardToWethPool, address(usdc), address(wethToken), 0);
        _setReturnedTwapTick(wethToSqdPool, address(wethToken), address(sqdToken), TICK_FOR_2X_PRICE);

        router.configureSlippageProtection(address(factory), TWAP_WINDOW, 300);
        pancakeRouter.setRate(1, 1);
        usdc.approve(address(router), 100 * 1e6);

        vm.expectRevert("MockRouter: insufficient output");
        router.routeToBurn(address(usdc), 100 * 1e6);

        assertEq(router.getPendingBuyback(address(usdc)), 0, "bad swap must not persist");
    }

    function test_FreshDeploy_DefaultsToProviderOnlyUntilWorkerPoolConfigured() public {
        FeeRouterModuleV2 freshRouter = new FeeRouterModuleV2();
        freshRouter.configureBuyback(address(pancakeRouter), address(sqdToken), address(wethToken), 2500, 2500);
        freshRouter.setAllowedRewardToken(address(usdc), true);
        freshRouter.setBuybackEnabled(true);
        MockPancakeFactory factory = new MockPancakeFactory();
        MockPancakePool rewardToWethPool = _deployPool(address(usdc), address(wethToken));
        MockPancakePool wethToSqdPool = _deployPool(address(wethToken), address(sqdToken));

        factory.setPool(address(usdc), address(wethToken), freshRouter.poolFee(), address(rewardToWethPool));
        factory.setPool(address(wethToken), address(sqdToken), freshRouter.poolFee2(), address(wethToSqdPool));
        _setReturnedTwapTick(rewardToWethPool, address(usdc), address(wethToken), 0);
        _setReturnedTwapTick(wethToSqdPool, address(wethToken), address(sqdToken), 0);
        freshRouter.configureSlippageProtection(address(factory), TWAP_WINDOW, 300);

        usdc.approve(address(freshRouter), 100 * 1e6);
        pancakeRouter.setRate(1, 1);

        freshRouter.routeToBurn(address(usdc), 100 * 1e6);

        assertEq(freshRouter.getPendingBuyback(address(usdc)), 0, "route should not leave pending balance");
        assertEq(sqdToken.balanceOf(workerPool), 0, "no worker pool share is required by default");
        assertEq(sqdToken.balanceOf(address(0xdead)), 100 * 1e6, "default config burns the routed protocol leg");
    }

    function test_ConfigureSlippageProtectionRejectsUnsetPoolFee2() public {
        FeeRouterModuleV2 fresh = new FeeRouterModuleV2();
        vm.expectRevert(PoolErrors.InvalidPoolFee.selector);
        fresh.configureSlippageProtection(address(0x1234), TWAP_WINDOW, 300);
    }

    function test_ConfigureSlippageProtectionRejectsHundredPercentSlippage() public {
        vm.expectRevert(PoolErrors.InvalidFeeConfig.selector);
        router.configureSlippageProtection(address(0x1234), TWAP_WINDOW, 10_000);
    }

    function test_SetMaxSlippageBPSRejectsHundredPercentSlippage() public {
        vm.expectRevert(PoolErrors.InvalidFeeConfig.selector);
        router.setMaxSlippageBPS(10_000);
    }

    function test_ZeroSlippageStillUsesTwapFloor() public {
        MockPancakeFactory factory = new MockPancakeFactory();
        MockPancakePool rewardToWethPool = _deployPool(address(usdc), address(wethToken));
        MockPancakePool wethToSqdPool = _deployPool(address(wethToken), address(sqdToken));

        factory.setPool(address(usdc), address(wethToken), router.poolFee(), address(rewardToWethPool));
        factory.setPool(address(wethToken), address(sqdToken), router.poolFee2(), address(wethToSqdPool));

        _setReturnedTwapTick(rewardToWethPool, address(usdc), address(wethToken), 0);
        _setReturnedTwapTick(wethToSqdPool, address(wethToken), address(sqdToken), TICK_FOR_2X_PRICE);

        router.configureSlippageProtection(address(factory), TWAP_WINDOW, 0);
        pancakeRouter.setRate(1, 1);
        usdc.approve(address(router), 100 * 1e6);

        vm.expectRevert("MockRouter: insufficient output");
        router.routeToBurn(address(usdc), 100 * 1e6);
    }

    function test_NegativeTwapRoundingFloorsInsteadOfTruncatingTowardZero() public {
        MockPancakeFactory factory = new MockPancakeFactory();
        MockPancakePool rewardToWethPool = _deployPool(address(usdc), address(wethToken));
        MockPancakePool wethToSqdPool = _deployPool(address(wethToken), address(sqdToken));

        factory.setPool(address(usdc), address(wethToken), router.poolFee(), address(rewardToWethPool));
        factory.setPool(address(wethToken), address(sqdToken), router.poolFee2(), address(wethToSqdPool));

        int56 rawRewardToWethTickDelta = -int56(int32(TWAP_WINDOW)) * 1000 - 1;
        rewardToWethPool.setTickCumulatives(0, rawRewardToWethTickDelta);
        _setReturnedTwapTick(wethToSqdPool, address(wethToken), address(sqdToken), -5000);

        router.configureSlippageProtection(address(factory), TWAP_WINDOW, 0);

        int24 buggyTick1 = _buggyTwapTickFromRawDelta(rawRewardToWethTickDelta, address(usdc), address(wethToken));
        int24 fixedTick1 = _fixedTwapTickFromRawDelta(rawRewardToWethTickDelta, address(usdc), address(wethToken));
        int24 hop2Tick = -5000;
        int24 buggyCombinedTick = buggyTick1 + hop2Tick;
        int24 fixedCombinedTick = fixedTick1 + hop2Tick;

        assertEq(buggyCombinedTick, fixedCombinedTick + 1, "old implementation overstated the output tick");

        uint256 amountIn = 100_000 * 1e6;
        uint256 buggyMinOut = _getAmountFromTick(amountIn, buggyCombinedTick);
        uint256 fixedMinOut = _getAmountFromTick(amountIn, fixedCombinedTick);
        assertGt(buggyMinOut, fixedMinOut, "buggy rounding produced a stricter minOut");

        pancakeRouter.setRate(fixedMinOut, amountIn);
        usdc.approve(address(router), amountIn);

        router.routeToBurn(address(usdc), amountIn);

        assertEq(router.getPendingBuyback(address(usdc)), 0, "successful swap should leave no residue");
    }

    function test_TwapProtectionRevertsWhenOraclePoolMissing() public {
        MockPancakeFactory factory = new MockPancakeFactory();
        router.configureSlippageProtection(address(factory), TWAP_WINDOW, 300);
        pancakeRouter.setRate(1, 1);
        usdc.approve(address(router), 100 * 1e6);

        vm.expectRevert(PoolErrors.InvalidPool.selector);
        router.routeToBurn(address(usdc), 100 * 1e6);

        assertEq(router.getPendingBuyback(address(usdc)), 0);
    }

    function test_ConfigChangeAfterImmediateRouteCannotRetroactivelyAffectBalances() public {
        MockPancakeFactory factory = new MockPancakeFactory();
        MockPancakePool rewardToWethPool = _deployPool(address(usdc), address(wethToken));
        MockPancakePool wethToSqdPool = _deployPool(address(wethToken), address(sqdToken));

        factory.setPool(address(usdc), address(wethToken), router.poolFee(), address(rewardToWethPool));
        factory.setPool(address(wethToken), address(sqdToken), router.poolFee2(), address(wethToSqdPool));
        _setReturnedTwapTick(rewardToWethPool, address(usdc), address(wethToken), 0);
        _setReturnedTwapTick(wethToSqdPool, address(wethToken), address(sqdToken), 0);

        router.configureSlippageProtection(address(factory), TWAP_WINDOW, 300);
        pancakeRouter.setRate(1, 1);
        usdc.approve(address(router), 1000 * 1e6);

        router.routeToBurn(address(usdc), 1000 * 1e6);
        router.setFeeConfig(5000, 500, 4500);

        assertEq(sqdToken.balanceOf(workerPool), 900 * 1e6, "execution used config at route time");
        assertEq(sqdToken.balanceOf(address(0xdead)), 100 * 1e6, "later config change is not retroactive");
    }

    function _deployPool(address tokenA, address tokenB) internal returns (MockPancakePool pool) {
        address token0 = tokenA < tokenB ? tokenA : tokenB;
        address token1 = tokenA < tokenB ? tokenB : tokenA;
        pool = new MockPancakePool(token0, token1);
    }

    function _setReturnedTwapTick(MockPancakePool pool, address tokenA, address tokenB, int24 returnedTick) internal {
        int24 rawPoolTick = tokenA > tokenB ? -returnedTick : returnedTick;
        int56 cumulativeNow = int56(int256(rawPoolTick)) * int56(uint56(TWAP_WINDOW));
        pool.setTickCumulatives(0, cumulativeNow);
    }

    function _buggyTwapTickFromRawDelta(int56 rawTickDelta, address tokenA, address tokenB)
        internal
        pure
        returns (int24)
    {
        int24 twapTick = int24(rawTickDelta / int56(uint56(TWAP_WINDOW)));
        if (tokenA > tokenB) {
            twapTick = -twapTick;
        }
        return twapTick;
    }

    function _fixedTwapTickFromRawDelta(int56 rawTickDelta, address tokenA, address tokenB)
        internal
        pure
        returns (int24)
    {
        int56 timeDelta = int56(uint56(TWAP_WINDOW));
        int24 twapTick = int24(rawTickDelta / timeDelta);
        if (rawTickDelta < 0 && (rawTickDelta % timeDelta != 0)) {
            twapTick--;
        }
        if (tokenA > tokenB) {
            twapTick = -twapTick;
        }
        return twapTick;
    }

    function _getAmountFromTick(uint256 amountIn, int24 tick) internal pure returns (uint256) {
        uint160 sqrtPriceX96 = TickMath.getSqrtRatioAtTick(tick);
        if (sqrtPriceX96 <= type(uint128).max) {
            uint256 priceX192 = uint256(sqrtPriceX96) * sqrtPriceX96;
            return FullMath.mulDiv(amountIn, priceX192, 1 << 192);
        }

        uint256 priceX128 = FullMath.mulDiv(uint256(sqrtPriceX96), sqrtPriceX96, 1 << 64);
        return FullMath.mulDiv(amountIn, priceX128, 1 << 128);
    }
}
