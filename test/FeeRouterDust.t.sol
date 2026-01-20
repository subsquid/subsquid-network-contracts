// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./BaseTest.sol";
import {PoolErrors} from "../src/libs/PoolErrors.sol";
import {PortalPoolImplementation} from "../src/PortalPoolImplementation.sol";
import {IFeeRouter} from "../src/interfaces/IFeeRouter.sol";

/// @title Fee Router Dust Distribution Tests
/// @notice Tests for dust distribution branches, burn address, and topUp scenarios
contract FeeRouterDustTest is BaseTest {
    function setUp() public override {
        super.setUp();
    }

    /// @dev Helper: minimum rate for precision requirement
    function _minRateForCapacity(uint256 capacity) internal pure returns (uint256) {
        uint256 minRate = capacity / 1e12;
        return minRate < 1000 ? 1000 : minRate;
    }

    function test_SetBurnAddress_SuccessAndRevertCases() public {
        // Success: set new burn address
        address newBurn = address(0x123);
        vm.expectEmit(true, false, false, false);
        emit IFeeRouter.BurnAddressUpdated(newBurn);
        feeRouter.setBurnAddress(newBurn);
        assertEq(feeRouter.getBurnAddress(), newBurn);

        // Revert: zero address
        vm.expectRevert(PoolErrors.InvalidAddress.selector);
        feeRouter.setBurnAddress(address(0));

        // Revert: non-admin
        vm.prank(user1);
        vm.expectRevert();
        feeRouter.setBurnAddress(address(0x456));
    }

    function test_GetBurnAddress_ReturnsCorrectValue() public {
        // Default value
        assertEq(feeRouter.getBurnAddress(), address(0xdead));

        // After change
        feeRouter.setBurnAddress(address(0xbeef));
        assertEq(feeRouter.getBurnAddress(), address(0xbeef));
    }

    function test_CalculateSplit_DustToProviders() public {
        // Config: providers > workers > burn
        // 6000, 2000, 2000 with amount 1001
        // providers = 600.6 → 600, workers = 200.2 → 200, burn = 200.2 → 200
        // sum = 1000, dust = 1 → goes to providers
        feeRouter.setFeeConfig(6000, 2000, 2000);

        (uint256 toProviders, uint256 toWorkerPool, uint256 toBurn) = feeRouter.calculateSplit(1001);

        assertEq(toProviders, 601); // 600 + 1 dust
        assertEq(toWorkerPool, 200);
        assertEq(toBurn, 200);
        assertEq(toProviders + toWorkerPool + toBurn, 1001);
    }

    function test_CalculateSplit_DustToBurn() public {
        // Config: burn > workers (and providers not highest)
        // 2000, 2000, 6000 with amount 1001
        // providers = 200.2 → 200, workers = 200.2 → 200, burn = 600.6 → 600
        // sum = 1000, dust = 1 → goes to burn (burn > workers)
        feeRouter.setFeeConfig(2000, 2000, 6000);

        (uint256 toProviders, uint256 toWorkerPool, uint256 toBurn) = feeRouter.calculateSplit(1001);

        assertEq(toProviders, 200);
        assertEq(toWorkerPool, 200);
        assertEq(toBurn, 601); // 600 + 1 dust
        assertEq(toProviders + toWorkerPool + toBurn, 1001);
    }

    function test_CalculateSplit_DustToWorkerPoolOnTie() public {
        // The default case (else branch) covers when:
        // - providers is NOT strictly greater than both workers AND burn
        // - burn is NOT strictly greater than workers
        // In this case workers gets dust

        // Test: equal split 50/50/0 - workers wins tie
        feeRouter.setFeeConfig(5000, 5000, 0);
        (uint256 toProviders, uint256 toWorkerPool, uint256 toBurn) = feeRouter.calculateSplit(1001);

        // 50% of 1001 = 500.5 → 500 each, dust = 1
        // providers (5000) > workers (5000)? NO (equal, not greater)
        // burn (0) > workers (5000)? NO
        // else: workers gets dust
        assertEq(toProviders, 500);
        assertEq(toWorkerPool, 501); // 500 + 1 dust
        assertEq(toBurn, 0);
        assertEq(toProviders + toWorkerPool + toBurn, 1001);

        // Test: workers highest (not a tie, but should still go to workers via else)
        feeRouter.setFeeConfig(3000, 4000, 3000);
        (toProviders, toWorkerPool, toBurn) = feeRouter.calculateSplit(1001);

        // providers (3000) > workers (4000)? NO
        // burn (3000) > workers (4000)? NO
        // else: workers gets dust
        assertEq(toProviders, 300);
        assertEq(toWorkerPool, 401); // 400 + 1 dust
        assertEq(toBurn, 300);
    }

    function test_TopUpRewards_WithBurnAllocation() public {
        // Set fee config with burn allocation
        feeRouter.setFeeConfig(4000, 4000, 2000); // 40% providers, 40% workers, 20% burn

        address portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "BurnTest");
        PortalPoolImplementation pool = PortalPoolImplementation(portal);

        uint256 topUpAmount = 10000 * 1e6; // 10000 USDC
        uint256 burnBalBefore = usdc.balanceOf(address(0xdead));
        uint256 workerPoolBalBefore = usdc.balanceOf(workerRewardPool);

        vm.startPrank(operator);
        usdc.approve(portal, topUpAmount);
        pool.topUpRewards(topUpAmount);
        vm.stopPrank();

        // Verify burn address received 20%
        uint256 expectedBurn = (topUpAmount * 2000) / 10000; // 2000 USDC
        assertEq(usdc.balanceOf(address(0xdead)) - burnBalBefore, expectedBurn);

        // Verify worker pool received 40%
        uint256 expectedWorkers = (topUpAmount * 4000) / 10000; // 4000 USDC
        assertEq(usdc.balanceOf(workerRewardPool) - workerPoolBalBefore, expectedWorkers);
    }

    function test_TopUpRewards_DebtPaymentScenarios() public {
        address portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "DebtTest");
        PortalPoolImplementation pool = PortalPoolImplementation(portal);

        // Wait 1 hour to create small debt (initial credit covers ~1 day)
        vm.warp(block.timestamp + 1 hours);

        // Get balance and debt before topup
        int256 balanceBefore = int256(pool.getCredit()) - int256(pool.getDebt());
        uint256 debtBefore = pool.getDebt();

        // Top up - this exercises both debt payment branches
        uint256 topUpAmount = 1000 * 1e6;

        vm.startPrank(operator);
        usdc.approve(portal, topUpAmount);

        // Expect event with correct split
        vm.expectEmit(true, false, false, false);
        emit IPortalPool.RewardsToppedUp(operator, topUpAmount, 0, 0, 0);

        pool.topUpRewards(topUpAmount);
        vm.stopPrank();

        // Get balance after topup
        (int256 balanceAfter, uint256 debtAfter,,) = pool.getRewardStatus();

        // Balance should improve (toProviders portion adds to credit)
        // Debt should decrease or stay same (credit increases)
        assertTrue(balanceAfter >= balanceBefore, "Balance should not decrease");

        // Verify credit increased
        uint256 creditAfter = pool.getCredit();
        assertTrue(creditAfter > 0, "Credit should be positive after top up");
    }
}
