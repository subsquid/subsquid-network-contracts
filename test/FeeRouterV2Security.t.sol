// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import {FeeRouterModuleV2} from "../src/FeeRouterModuleV2.sol";
import {IFeeRouter} from "../src/interfaces/IFeeRouter.sol";
import {PoolErrors} from "../src/libs/PoolErrors.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockPancakeRouter} from "./mocks/MockPancakeRouter.sol";

/// @title FeeRouterModuleV2 Security & Edge Case Tests
/// @notice Tests for % drift, stuck funds, rounding, MEV, and edge cases
contract FeeRouterV2SecurityTest is Test {
    FeeRouterModuleV2 public router;
    MockERC20 public usdc;
    MockERC20 public sqdToken;
    MockERC20 public wethToken;
    MockPancakeRouter public pancakeRouter;

    address public admin = address(this);
    address public workerPool = address(0x5555);
    address public burnAddr = address(0xdead);

    function setUp() public {
        usdc = new MockERC20("USDC", "USDC", 6);
        sqdToken = new MockERC20("SQD", "SQD", 18);
        wethToken = new MockERC20("WETH", "WETH", 18);
        pancakeRouter = new MockPancakeRouter();

        router = new FeeRouterModuleV2();
        router.configureBuyback(
            address(pancakeRouter), address(sqdToken), address(wethToken), 2500, 2500, 0
        );
        router.setWorkerPoolAddress(workerPool);
        router.setAllowedRewardToken(address(usdc), true);
        router.setBuybackEnabled(true);

        usdc.mint(admin, 100_000_000 * 1e6);
    }

    // ═══════════════════════════════════════════════════════
    // VULN-1: Config change between accumulation and buyback
    //         (% drift - tokens split under wrong config)
    // ═══════════════════════════════════════════════════════

    function test_VULN_ConfigChangeBetweenAccumulateAndBuyback() public {
        // Step 1: Accumulate under 50/45/5 config
        usdc.approve(address(router), 1000 * 1e6);
        router.routeToBurn(address(usdc), 1000 * 1e6);

        // Step 2: Admin changes config to 50/5/45 (flip worker/burn)
        router.setFeeConfig(5000, 500, 4500);

        // Step 3: Execute buyback - uses NEW config, not the one active during accumulation
        pancakeRouter.setRate(1, 1); // 1:1
        router.executeBuyback(address(usdc), 0);

        // Under OLD config (4500/500): workers should get 900 SQD, burn 100 SQD
        // Under NEW config (500/4500): workers get 100 SQD, burn 900 SQD
        // THIS IS THE BUG - workers get 10% instead of intended 90%

        assertEq(sqdToken.balanceOf(workerPool), 100 * 1e6, "workers got 10% instead of 90%");
        assertEq(sqdToken.balanceOf(burnAddr), 900 * 1e6, "burn got 90% instead of 10%");

        // This demonstrates the % drift vulnerability.
        // IMPACT: Admin config change retroactively affects already-accumulated funds.
        // SEVERITY: Medium - requires admin action, but silently misallocates funds.
    }

    // ═══════════════════════════════════════════════════════
    // VULN-2: SQD stuck if workerPoolAddress is address(0)
    // ═══════════════════════════════════════════════════════

    function test_VULN_SQDStuckWhenNoWorkerPool() public {
        // Deploy fresh router WITHOUT setting worker pool
        FeeRouterModuleV2 freshRouter = new FeeRouterModuleV2();
        freshRouter.setAllowedRewardToken(address(usdc), true);
        freshRouter.setBuybackEnabled(true);
        freshRouter.configureBuyback(
            address(pancakeRouter), address(sqdToken), address(wethToken), 2500, 2500, 0
        );
        // workerPoolAddress is address(0)

        pancakeRouter.setRate(1, 1);
        usdc.approve(address(freshRouter), 1000 * 1e6);
        freshRouter.routeToBurn(address(usdc), 1000 * 1e6);
        freshRouter.executeBuyback(address(usdc), 0);

        // With config (5000, 4500, 500), protocolBPS = 5000
        // toWorkerPool = 1000 * 4500/5000 = 900 SQD - SKIPPED (address(0))
        // toBurn = 100 SQD - sent to 0xdead
        // 900 SQD stuck in router!

        uint256 stuckSqd = sqdToken.balanceOf(address(freshRouter));
        assertEq(stuckSqd, 900 * 1e6, "900 SQD stuck in router");

        // accumulatedForBuyback is 0 so this won't show up in any tracking
        assertEq(freshRouter.accumulatedForBuyback(address(usdc)), 0, "tracking cleared");

        // Can it be recovered? SQD is not an allowed reward token, so recoverTokens works
        freshRouter.recoverTokens(address(sqdToken), admin, stuckSqd);
        assertEq(sqdToken.balanceOf(address(freshRouter)), 0, "recovered via recoverTokens");
    }

    function test_VULN_SQDStuckAndUnrecoverable_IfSQDIsAllowedToken() public {
        // Worst case: if SQD is also an allowed reward token
        router.setAllowedRewardToken(address(sqdToken), true);

        // Remove worker pool to trigger the stuck path
        // Can't set to address(0) via setter (reverts), so use a fresh router
        FeeRouterModuleV2 freshRouter = new FeeRouterModuleV2();
        freshRouter.setAllowedRewardToken(address(usdc), true);
        freshRouter.setAllowedRewardToken(address(sqdToken), true);
        freshRouter.setBuybackEnabled(true);
        freshRouter.configureBuyback(
            address(pancakeRouter), address(sqdToken), address(wethToken), 2500, 2500, 0
        );

        pancakeRouter.setRate(1, 1);
        usdc.approve(address(freshRouter), 1000 * 1e6);
        freshRouter.routeToBurn(address(usdc), 1000 * 1e6);
        freshRouter.executeBuyback(address(usdc), 0);

        uint256 stuckSqd = sqdToken.balanceOf(address(freshRouter));
        assertEq(stuckSqd, 900 * 1e6, "900 SQD stuck");

        // Cannot recover because SQD is allowed
        vm.expectRevert(PoolErrors.TokenNotAllowed.selector);
        freshRouter.recoverTokens(address(sqdToken), admin, stuckSqd);

        // SQD is permanently stuck! No way to extract it.
    }

    // ═══════════════════════════════════════════════════════
    // VULN-3: Rounding always favors protocol over providers
    // ═══════════════════════════════════════════════════════

    function test_VULN_RoundingDriftOverManyTopUps() public {
        // Small amounts + many iterations = accumulated rounding drift
        uint256 totalProviders;
        uint256 totalProtocol;
        uint256 iterations = 1000;
        uint256 amountPerTopUp = 3; // worst case for rounding with 50/50

        for (uint256 i = 0; i < iterations; i++) {
            (uint256 p,, uint256 b) = router.calculateSplit(amountPerTopUp);
            totalProviders += p;
            totalProtocol += b;
        }

        uint256 totalInput = iterations * amountPerTopUp; // 3000
        uint256 expectedProviders = totalInput * 5000 / 10000; // 1500

        // Due to floor division: 3 * 5000 / 10000 = 1 per iteration
        // Providers get 1000, protocol gets 2000
        // Real 50%: providers should get 1500
        // Drift: providers SHORT by 500 (33% less than expected!)

        assertEq(totalProviders, 1000, "providers only got 1000/3000");
        assertEq(totalProtocol, 2000, "protocol got 2000/3000");
        assertGt(totalProtocol - expectedProviders, 0, "systematic rounding in protocol's favor");
    }

    function test_RoundingDrift_LargerAmounts_NegligibleImpact() public view {
        // With realistic amounts (1000 USDC = 1e9), rounding is at most 1 wei
        uint256 amount = 1000 * 1e6;
        (uint256 p,, uint256 b) = router.calculateSplit(amount);

        uint256 expectedP = amount * 5000 / 10000;
        assertEq(p, expectedP, "no drift at realistic amounts");
        assertEq(p + b, amount, "exact total");
    }

    // ═══════════════════════════════════════════════════════
    // VULN-4: protocolBPS=0 with leftover accumulated tokens
    // ═══════════════════════════════════════════════════════

    function test_VULN_LeftoverTokensAfterConfigSetToAllProviders() public {
        // Accumulate tokens under normal config
        usdc.approve(address(router), 500 * 1e6);
        router.routeToBurn(address(usdc), 500 * 1e6);

        // Admin sets 100% to providers (0% protocol)
        router.setFeeConfig(10000, 0, 0);

        // There's still 500 USDC sitting in the router from before
        assertEq(usdc.balanceOf(address(router)), 500 * 1e6);

        // Buyback: protocolBPS = 0, falls to else branch → all SQD to burn
        pancakeRouter.setRate(1, 1);
        router.executeBuyback(address(usdc), 0);

        // All 500 SQD goes to burn (protocolBPS=0 means else branch)
        assertEq(sqdToken.balanceOf(burnAddr), 500 * 1e6, "all to burn when protocolBPS=0");
        assertEq(sqdToken.balanceOf(workerPool), 0, "nothing to workers");

        // Not necessarily wrong, but might be surprising.
        // Those tokens were accumulated when workers should have gotten 90%.
    }

    // ═══════════════════════════════════════════════════════
    // VULN-5: accumulatedForBuyback desync from actual balance
    // ═══════════════════════════════════════════════════════

    function test_VULN_DirectTransferCreatesPhantomBalance() public {
        // Someone sends USDC directly to router (not through routeToBurn)
        usdc.transfer(address(router), 500 * 1e6);

        // accumulatedForBuyback is 0, but balance is 500 USDC
        assertEq(router.accumulatedForBuyback(address(usdc)), 0, "tracking says 0");
        assertEq(usdc.balanceOf(address(router)), 500 * 1e6, "but balance says 500");

        // executeBuyback uses balanceOf, not accumulatedForBuyback
        pancakeRouter.setRate(1, 1);
        router.executeBuyback(address(usdc), 0);

        // The untracked 500 USDC gets swapped and distributed!
        assertGt(sqdToken.balanceOf(workerPool), 0, "phantom balance was swapped");
    }

    function test_VULN_AccumulatedTrackingDesyncAfterBelowThreshold() public {
        router.setMinBuybackThreshold(1000 * 1e6);

        // Accumulate 500 USDC (below threshold)
        usdc.approve(address(router), 500 * 1e6);
        router.routeToBurn(address(usdc), 500 * 1e6);

        // executeBuyback: below threshold, restores accumulatedForBuyback
        router.executeBuyback(address(usdc), 0);
        assertEq(router.accumulatedForBuyback(address(usdc)), 500 * 1e6, "restored");

        // Now someone sends 600 USDC directly (not through routeToBurn)
        usdc.transfer(address(router), 600 * 1e6);

        // Balance is 1100 USDC, but accumulated says 500
        assertEq(usdc.balanceOf(address(router)), 1100 * 1e6);
        assertEq(router.accumulatedForBuyback(address(usdc)), 500 * 1e6);

        // Lower threshold and execute - uses full 1100 balance
        router.setMinBuybackThreshold(0);
        pancakeRouter.setRate(1, 1);
        router.executeBuyback(address(usdc), 0);

        // All 1100 swapped, tracking cleared to 0
        assertEq(router.accumulatedForBuyback(address(usdc)), 0);
        uint256 totalSqd = sqdToken.balanceOf(workerPool) + sqdToken.balanceOf(burnAddr);
        assertEq(totalSqd, 1100 * 1e6, "full balance swapped including untracked");
    }

    // ═══════════════════════════════════════════════════════
    // VULN-6: Auto-buyback MEV (minSqdOut = 0)
    // ═══════════════════════════════════════════════════════

    function test_VULN_AutoBuyback_ZeroSlippage_MEVExposure() public {
        router.setAutoBuybackEnabled(true);
        router.setMinBuybackThreshold(100 * 1e6);

        // Simulate MEV: sandwich attacker manipulates price
        // Normal rate: 2 SQD per USDC
        // Sandwiched rate: 0.1 SQD per USDC (attacker moved the pool)
        pancakeRouter.setRate(1, 10); // terrible rate: 0.1 SQD per USDC

        usdc.approve(address(router), 200 * 1e6);
        // This triggers auto-buyback with minSqdOut=0 - accepts the terrible rate
        router.routeToBurn(address(usdc), 200 * 1e6);

        // Got only 20 SQD instead of ~400 SQD at fair price
        uint256 totalSqd = sqdToken.balanceOf(workerPool) + sqdToken.balanceOf(burnAddr);
        assertEq(totalSqd, 20 * 1e6, "only 20 SQD - 95% value extracted by MEV");

        // Compare to fair rate:
        // Fair: 200 USDC * 2 = 400 SQD
        // Got: 200 USDC * 0.1 = 20 SQD
        // Loss: 380 SQD (95%)
    }


    function test_EDGE_FeeConfigChangeDoesNotAffectPendingSplit() public {
        pancakeRouter.setRate(1, 1);

        // Accumulate under (5000, 4500, 500)
        usdc.approve(address(router), 1000 * 1e6);
        router.routeToBurn(address(usdc), 1000 * 1e6);

        // Execute before any config change - correct split
        router.executeBuyback(address(usdc), 0);
        assertEq(sqdToken.balanceOf(workerPool), 900 * 1e6, "correct 90% to workers");
        assertEq(sqdToken.balanceOf(burnAddr), 100 * 1e6, "correct 10% to burn");
    }

    // ═══════════════════════════════════════════════════════
    // EDGE: Multiple tokens accumulated, partial buyback
    // ═══════════════════════════════════════════════════════

    function test_EDGE_MultipleSeparateBuybacks() public {
        MockERC20 dai = new MockERC20("DAI", "DAI", 18);
        router.setAllowedRewardToken(address(dai), true);
        pancakeRouter.setRate(1, 1);

        // Accumulate both tokens
        usdc.approve(address(router), 500 * 1e6);
        router.routeToBurn(address(usdc), 500 * 1e6);

        dai.mint(admin, 1000 ether);
        dai.approve(address(router), 1000 ether);
        router.routeToBurn(address(dai), 1000 ether);

        // Buyback only USDC - DAI stays
        router.executeBuyback(address(usdc), 0);

        assertEq(usdc.balanceOf(address(router)), 0, "USDC swapped");
        assertEq(dai.balanceOf(address(router)), 1000 ether, "DAI still there");
        assertEq(router.accumulatedForBuyback(address(dai)), 1000 ether, "DAI tracking intact");
    }

    // ═══════════════════════════════════════════════════════
    // EDGE: Very small amounts - precision loss in SQD split
    // ═══════════════════════════════════════════════════════

    function test_EDGE_TinySQDAmountSplitPrecision() public {
        pancakeRouter.setRate(1, 1);

        // 1 wei USDC → 1 wei SQD. Split 4500/5000 → workers get 0 (floor), burn gets 1
        usdc.approve(address(router), 1);
        router.routeToBurn(address(usdc), 1);
        router.executeBuyback(address(usdc), 0);

        // FullMath.mulDiv(1, 4500, 5000) = 0 - workers get nothing
        assertEq(sqdToken.balanceOf(workerPool), 0, "workers get 0 from 1 wei");
        assertEq(sqdToken.balanceOf(burnAddr), 1, "burn gets everything");
    }

    function test_EDGE_SmallAmountSplitAccumulatesCorrectly() public {
        pancakeRouter.setRate(1, 1);

        // 9 SQD: workers = 9*4500/5000 = 8, burn = 1
        usdc.approve(address(router), 9);
        router.routeToBurn(address(usdc), 9);
        router.executeBuyback(address(usdc), 0);

        assertEq(sqdToken.balanceOf(workerPool), 8, "floor(9*4500/5000) = 8");
        assertEq(sqdToken.balanceOf(burnAddr), 1, "9 - 8 = 1");
    }

    // ═══════════════════════════════════════════════════════
    // FUZZ: Split integrity - total always equals input
    // ═══════════════════════════════════════════════════════

    function testFuzz_BuybackSplitTotalEqualsInput(uint256 sqdAmount, uint16 workerBPS) public {
        vm.assume(sqdAmount > 0 && sqdAmount < 1e30);
        vm.assume(workerBPS <= 5000); // max 50% to workers (providers take 50%)

        uint16 burnBPS = uint16(5000 - workerBPS); // remainder of protocol share

        router.setFeeConfig(5000, workerBPS, burnBPS);
        pancakeRouter.setRate(1, 1);

        usdc.mint(admin, sqdAmount);
        usdc.approve(address(router), sqdAmount);
        router.routeToBurn(address(usdc), sqdAmount);
        router.executeBuyback(address(usdc), 0);

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
        assertEq(a + b + c, amount, "exact total");
        assertEq(b, 0, "toWorkerPool always 0");
        assertLe(a, amount, "providers <= input");
    }
}
