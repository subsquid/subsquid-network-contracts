// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./BaseTest.sol";
import {PoolErrors} from "../src/libs/PoolErrors.sol";
import {PortalPoolImplementation} from "../src/PortalPoolImplementation.sol";
import {LiquidPortalToken} from "../src/LiquidPortalToken.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/// @title Pool Lifecycle Tests
/// @notice Tests for closePool, emergencyWithdraw, claimRewardsFromClosed, recoverRewardsFromFailed
contract PoolLifecycleTest is BaseTest {
    function setUp() public override {
        super.setUp();
    }

    /// @dev Helper: minimum rate for precision requirement
    function _minRateForCapacity(uint256 capacity) internal pure returns (uint256) {
        uint256 minRate = capacity / 1e12;
        return minRate < 1000 ? 1000 : minRate;
    }

    /// @dev Helper: create pool without activation (stays in COLLECTING)
    function _createCollectingPool() internal returns (address) {
        uint256 rate = _minRateForCapacity(MIN_STAKE_THRESHOLD);
        uint256 initialDeposit = rate * 1 days / 1000;

        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: MIN_STAKE_THRESHOLD,
            tokenSuffix: "Collecting",
            distributionRatePerSecond: rate,
            initialDeposit: initialDeposit,
            metadata: "",
            rewardToken: address(usdc)
        });

        usdc.approve(address(factory), initialDeposit);
        return factory.createPortalPool(params);
    }

    function test_ClosePool_Success_EmitsEventAndZerosRates() public {
        // Create and activate pool
        address portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "CloseTest");
        PortalPoolImplementation pool = PortalPoolImplementation(portal);

        // Verify pool is ACTIVE
        assertEq(uint256(pool.getState()), uint256(IPortalPool.PoolState.ACTIVE));

        // Admin (this contract) closes pool
        vm.expectEmit(true, true, false, false);
        emit IPortalPool.StateChanged(IPortalPool.PoolState.ACTIVE, IPortalPool.PoolState.CLOSED);

        pool.closePool();

        // Verify state changed to CLOSED
        assertEq(uint256(pool.getState()), uint256(IPortalPool.PoolState.CLOSED));

        // Verify rates zeroed
        assertEq(pool.totalDistributionRatePerSec(), 0);
        assertEq(pool.providerRatePerSec(), 0);
        assertEq(pool.treasuryRatePerSec(), 0);
        assertEq(pool.perStakeRateWad(), 0);
    }

    function test_ClosePool_RevertCases() public {
        address portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "RevertTest");
        PortalPoolImplementation pool = PortalPoolImplementation(portal);

        // Revert: non-admin tries to close
        vm.prank(user1);
        vm.expectRevert(PoolErrors.NotAdmin.selector);
        pool.closePool();

        // Close the pool first
        pool.closePool();
        assertEq(uint256(pool.getState()), uint256(IPortalPool.PoolState.CLOSED));

        // Revert: already CLOSED
        vm.expectRevert(PoolErrors.PoolClosed.selector);
        pool.closePool();

        // Create failed pool for FAILED state test
        address failedPortal = _createCollectingPool();
        PortalPoolImplementation failedPool = PortalPoolImplementation(failedPortal);
        _warpToAfterDeadline(failedPortal);
        failedPool.checkAndFailPortal();
        assertEq(uint256(failedPool.getState()), uint256(IPortalPool.PoolState.FAILED));

        // Revert: FAILED state
        vm.expectRevert(PoolErrors.InvalidState.selector);
        failedPool.closePool();
    }

    function test_EmergencyWithdraw_NeverActivated() public {
        // Create pool but don't fill to capacity
        address portal = _createCollectingPool();
        PortalPoolImplementation pool = PortalPoolImplementation(portal);

        // User1 deposits partial amount
        uint256 depositAmount = MIN_STAKE_THRESHOLD / 2;
        vm.startPrank(user1);
        sqd.approve(portal, depositAmount);
        pool.deposit(depositAmount);
        vm.stopPrank();

        // Verify pool is COLLECTING, not yet activated
        assertEq(uint256(pool.getState()), uint256(IPortalPool.PoolState.COLLECTING));
        IPortalPool.PoolInfo memory info = pool.getPoolInfo();
        assertFalse(info.firstActivated);

        uint256 user1SqdBefore = sqd.balanceOf(user1);

        // Admin closes pool while still COLLECTING
        pool.closePool();
        assertEq(uint256(pool.getState()), uint256(IPortalPool.PoolState.CLOSED));

        // User1 emergency withdraws
        vm.prank(user1);
        pool.emergencyWithdraw();

        // Verify: SQD returned from pool contract (never went to registry)
        assertEq(sqd.balanceOf(user1), user1SqdBefore + depositAmount);
        assertEq(pool.getProviderStake(user1), 0);
    }

    function test_EmergencyWithdraw_WasActivated() public {
        // Create and activate pool (SQD goes to registry)
        address portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "EmergencyActive");
        PortalPoolImplementation pool = PortalPoolImplementation(portal);

        // Verify activated
        IPortalPool.PoolInfo memory info = pool.getPoolInfo();
        assertTrue(info.firstActivated);

        uint256 user1SqdBefore = sqd.balanceOf(user1);
        uint256 user1Stake = pool.getProviderStake(user1);

        // Close pool
        pool.closePool();

        // User1 emergency withdraws
        vm.prank(user1);
        pool.emergencyWithdraw();

        // Verify: SQD returned from registry
        assertEq(sqd.balanceOf(user1), user1SqdBefore + user1Stake);
        assertEq(pool.getProviderStake(user1), 0);
    }

    function test_ClaimRewardsFromClosed_Success() public {
        address portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ClaimClosed");
        PortalPoolImplementation pool = PortalPoolImplementation(portal);

        // Top up rewards
        uint256 topUpAmount = 1000 * 1e6;
        vm.startPrank(operator);
        usdc.approve(portal, topUpAmount);
        pool.topUpRewards(topUpAmount);
        vm.stopPrank();

        // Warp to accrue rewards
        vm.warp(block.timestamp + 1 days);

        uint256 claimableBefore = pool.getClaimableRewards(user1);
        assertTrue(claimableBefore > 0, "Should have claimable rewards");

        // Close pool
        pool.closePool();

        // Revert: trying to claim from non-closed pool (create another)
        address activePortal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "StillActive");
        vm.prank(user1);
        vm.expectRevert(PoolErrors.PoolNotClosed.selector);
        PortalPoolImplementation(activePortal).claimRewardsFromClosed();

        // Success: claim from closed pool
        uint256 user1UsdcBefore = usdc.balanceOf(user1);

        vm.prank(user1);
        uint256 claimed = pool.claimRewardsFromClosed();

        assertTrue(claimed > 0, "Should claim rewards");
        assertEq(usdc.balanceOf(user1), user1UsdcBefore + claimed);

        // Revert: nothing left to claim
        vm.prank(user1);
        vm.expectRevert(PoolErrors.NothingToClaim.selector);
        pool.claimRewardsFromClosed();
    }

    function test_RecoverRewardsFromFailed_Success() public {
        // Create pool and deposit initial rewards
        address portal = _createCollectingPool();
        PortalPoolImplementation pool = PortalPoolImplementation(portal);

        // Verify initial state
        assertEq(uint256(pool.getState()), uint256(IPortalPool.PoolState.COLLECTING));

        // Pool has reward tokens from initial deposit
        uint256 poolRewardBalance = usdc.balanceOf(portal);
        assertTrue(poolRewardBalance > 0, "Pool should have reward tokens");

        // Warp past deadline without filling capacity
        _warpToAfterDeadline(portal);

        // Trigger FAILED state
        pool.checkAndFailPortal();
        assertEq(uint256(pool.getState()), uint256(IPortalPool.PoolState.FAILED));

        // Operator recovers rewards
        uint256 operatorBalBefore = usdc.balanceOf(operator);

        vm.prank(operator);
        uint256 recovered = pool.recoverRewardsFromFailed();

        assertTrue(recovered > 0, "Should recover rewards");
        assertEq(usdc.balanceOf(operator), operatorBalBefore + recovered);

        // Revert: nothing left
        vm.prank(operator);
        vm.expectRevert(PoolErrors.NothingToClaim.selector);
        pool.recoverRewardsFromFailed();
    }

    function test_RecoverRewardsFromFailed_RevertOnNotFailed() public {
        address portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "NotFailed");
        PortalPoolImplementation pool = PortalPoolImplementation(portal);

        // Pool is ACTIVE, not FAILED
        vm.prank(operator);
        vm.expectRevert(PoolErrors.PoolNotFailed.selector);
        pool.recoverRewardsFromFailed();
    }

    function test_PoolFailsOnDeadline_DepositsBlocked() public {
        address portal = _createCollectingPool();
        PortalPoolImplementation pool = PortalPoolImplementation(portal);

        // Partial deposit before deadline
        uint256 partialDeposit = MIN_STAKE_THRESHOLD / 2;
        vm.startPrank(user1);
        sqd.approve(portal, MIN_STAKE_THRESHOLD);
        pool.deposit(partialDeposit);
        vm.stopPrank();

        assertEq(uint256(pool.getState()), uint256(IPortalPool.PoolState.COLLECTING));

        // Warp past deadline
        _warpToAfterDeadline(portal);

        // getState() dynamically returns FAILED after deadline without activation
        assertEq(uint256(pool.getState()), uint256(IPortalPool.PoolState.FAILED));

        // Deposit after deadline reverts with InvalidState
        vm.startPrank(user2);
        sqd.approve(portal, SMALL_STAKE);
        vm.expectRevert(PoolErrors.InvalidState.selector);
        pool.deposit(SMALL_STAKE);
        vm.stopPrank();

        // User1 can withdraw from failed pool
        vm.prank(user1);
        pool.withdrawFromFailed();
        assertEq(pool.getProviderStake(user1), 0);
    }

    function test_IdleToActiveRecovery() public {
        // Create pool with capacity that allows partial fill
        uint256 capacity = MIN_STAKE_THRESHOLD * 2;
        address portal = _createAndActivatePortal(operator, capacity, "IdleRecovery");
        PortalPoolImplementation pool = PortalPoolImplementation(portal);

        // User1 has MIN_STAKE_THRESHOLD staked (from _createAndActivatePortal which uses capacity)
        // Actually _createAndActivatePortal deposits full capacity, so let's adjust
        // For this test, we need users to exit so we drop below threshold

        // First verify we're ACTIVE
        assertEq(uint256(pool.getState()), uint256(IPortalPool.PoolState.ACTIVE));

        // Request exit for most of the stake to drop below minStakeThreshold
        uint256 exitAmount = capacity - MIN_STAKE_THRESHOLD / 2; // Leave only half of minimum

        vm.startPrank(user1);
        pool.requestExit(exitAmount);
        vm.stopPrank();

        // Warp to process exit queue
        vm.warp(block.timestamp + 365 days);

        // Withdraw exit
        vm.prank(user1);
        pool.withdrawExit(0);

        // Now pool should be IDLE (below min threshold)
        assertEq(uint256(pool.getState()), uint256(IPortalPool.PoolState.IDLE));

        // User2 deposits enough to recover above threshold
        uint256 recoveryAmount = MIN_STAKE_THRESHOLD;

        vm.startPrank(user2);
        sqd.approve(portal, recoveryAmount);
        pool.deposit(recoveryAmount);
        vm.stopPrank();

        // Pool should transition back to ACTIVE
        assertEq(uint256(pool.getState()), uint256(IPortalPool.PoolState.ACTIVE));
    }

    function test_GetQueueStatusWithTimestamp_AllBranches() public {
        address portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "QueueTest");
        PortalPoolImplementation pool = PortalPoolImplementation(portal);

        // Request exit to create ticket
        vm.prank(user1);
        pool.requestExit(SMALL_STAKE);

        // Branch 1: Not ready yet (else branch - normal case)
        (,, uint256 secRemaining, bool ready, uint256 unlockTs) = pool.getQueueStatusWithTimestamp(user1, 0);
        assertFalse(ready);
        assertTrue(secRemaining > 0 && secRemaining < type(uint256).max);
        assertEq(unlockTs, block.timestamp + secRemaining);

        // Branch 2: Ready (warp past unlock time)
        vm.warp(block.timestamp + 365 days);
        (,, secRemaining, ready, unlockTs) = pool.getQueueStatusWithTimestamp(user1, 0);
        assertTrue(ready);
        assertEq(unlockTs, block.timestamp);
    }

    function test_GetWithdrawalWaitingTimestamp_RevertOnZero() public {
        address portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "WaitTest");
        PortalPoolImplementation pool = PortalPoolImplementation(portal);

        vm.expectRevert(PoolErrors.InvalidAmount.selector);
        pool.getWithdrawalWaitingTimestamp(0);
    }

    function test_GetWithdrawalWaitingTimestamp_Success() public {
        address portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "WaitTest2");
        PortalPoolImplementation pool = PortalPoolImplementation(portal);

        uint256 timestamp = pool.getWithdrawalWaitingTimestamp(SMALL_STAKE);
        assertTrue(timestamp > block.timestamp);
    }

    function test_SetDistributionRate_RevertOnRateExceedsMax() public {
        address portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "RateMax");
        PortalPoolImplementation pool = PortalPoolImplementation(portal);

        uint256 maxRate = factory.maxDistributionRatePerSecond();

        // Set a lower max rate on factory to trigger the error
        factory.setMaxDistributionRate(maxRate / 2);
        uint256 newMax = factory.maxDistributionRatePerSecond();

        vm.prank(operator);
        vm.expectRevert(PoolErrors.RateExceedsMaximum.selector);
        pool.setDistributionRate(newMax + 1);
    }

    function test_SetDistributionRate_RevertOnRateBelowMin() public {
        address portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "RateMin");
        PortalPoolImplementation pool = PortalPoolImplementation(portal);

        uint256 minRate = factory.minDistributionRatePerSecond();

        vm.prank(operator);
        vm.expectRevert(PoolErrors.RateBelowMinimum.selector);
        pool.setDistributionRate(minRate - 1);
    }

    function test_SetDistributionRate_RevertOnInsufficientPrecision() public {
        // Create pool with larger capacity
        uint256 largeCapacity = 1e24; // Very large
        address portal = _createAndActivatePortal(operator, largeCapacity, "PrecTest");
        PortalPoolImplementation pool = PortalPoolImplementation(portal);

        // Try to set a rate that would fail precision check
        // perStakeRate = (rate * 1e27) / (capacity * 1000) < 1e12
        uint256 tinyRate = 1000; // This will fail precision for large capacity

        vm.prank(operator);
        vm.expectRevert(PoolErrors.InsufficientRewardPrecision.selector);
        pool.setDistributionRate(tinyRate);
    }

    function test_RequestExit_RevertWhenClosed() public {
        address portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ExitClosed");
        PortalPoolImplementation pool = PortalPoolImplementation(portal);

        // Close the pool
        pool.closePool();
        assertEq(uint256(pool.getState()), uint256(IPortalPool.PoolState.CLOSED));

        // Try to request exit - should revert with PoolClosed
        vm.prank(user1);
        vm.expectRevert(PoolErrors.PoolClosed.selector);
        pool.requestExit(SMALL_STAKE);
    }

    function test_OnLPTTransfer_RevertWhenNotWhitelisted() public {
        address portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "WhitelistTest");
        PortalPoolImplementation pool = PortalPoolImplementation(portal);

        // Enable whitelist (as operator) and only whitelist user1
        vm.startPrank(operator);
        pool.setWhitelistEnabled(true);
        address[] memory whitelistUsers = new address[](1);
        whitelistUsers[0] = user1;
        pool.addToWhitelist(whitelistUsers);
        vm.stopPrank();

        // User1 has LPT from deposit, try to transfer to user2 (not whitelisted)
        LiquidPortalToken lpt = pool.lptToken();

        vm.prank(user1);
        vm.expectRevert(PoolErrors.NotWhitelisted.selector);
        lpt.transfer(user2, SMALL_STAKE);
    }
}
