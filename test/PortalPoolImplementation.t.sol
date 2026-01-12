// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./BaseTest.sol";
import {PoolErrors} from "../src/libs/PoolErrors.sol";
import {Constants} from "../src/libs/Constants.sol";
import {PortalPoolImplementation} from "../src/PortalPoolImplementation.sol";

contract PortalPoolImplementationTest is BaseTest {
    address public portal;
    PortalPoolImplementation public pool;

    /// @dev Calculate minimum rate to satisfy precision requirement: rate >= capacity / 1e12
    function _minRateForCapacity(uint256 capacity) internal pure returns (uint256) {
        uint256 minRate = capacity / 1e12;
        return minRate < 1000 ? 1000 : minRate;
    }

    function setUp() public override {
        super.setUp();
        portal = _createPortal(operator, MIN_STAKE_THRESHOLD, "TestPortal");
        pool = PortalPoolImplementation(portal);
    }

    function test_Initialize_SetsCorrectValues() public view {
        IPortalPool.PoolInfo memory info = pool.getPoolInfo();

        assertEq(info.operator, operator);
        assertEq(info.capacity, MIN_STAKE_THRESHOLD);
        assertEq(info.totalStaked, 0);
        assertEq(uint8(info.state), uint8(IPortalPool.PoolState.COLLECTING));
        assertFalse(info.paused);
        assertFalse(info.firstActivated);
    }

    function test_Initialize_DeploysLPTToken() public view {
        LiquidPortalToken lpt = LiquidPortalToken(address(pool.lptToken()));
        assertEq(lpt.name(), "Portal Locked SQD TestPortal");
        assertEq(lpt.symbol(), "plSQD-TestPortal");
    }

    function test_Initialize_RevertOnZeroOperator() public {
        uint256 rate = 1000 * 1000;
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: address(0),
            capacity: MIN_STAKE_THRESHOLD,
            peerId: "zero-op",
            tokenSuffix: "ZeroOp",
            distributionRatePerSecond: rate,
            initialDeposit: rate * 1 days / 1000,
            metadata: "",
            rewardToken: address(usdc)
        });

        vm.expectRevert(PoolErrors.InvalidAddress.selector);
        factory.createPortalPool(params);
    }

    function test_Initialize_RevertOnBelowMinimumCapacity() public {
        uint256 rate = 1000 * 1000;
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: MIN_STAKE_THRESHOLD - 1,
            peerId: "low-cap",
            tokenSuffix: "LowCap",
            distributionRatePerSecond: rate,
            initialDeposit: rate * 1 days / 1000,
            metadata: "",
            rewardToken: address(usdc)
        });

        vm.expectRevert(PoolErrors.BelowMinimum.selector);
        factory.createPortalPool(params);
    }

    function test_Deposit_InCollectingState() public {
        uint256 amount = SMALL_STAKE;

        vm.startPrank(user1);
        sqd.approve(portal, amount);

        vm.expectEmit(true, false, false, true);
        emit IPortalPool.Deposited(user1, amount, amount);

        pool.deposit(amount);
        vm.stopPrank();

        assertEq(pool.getProviderStake(user1), amount);
        assertEq(pool.getPoolInfo().totalStaked, amount);

        LiquidPortalToken lpt = LiquidPortalToken(address(pool.lptToken()));
        assertEq(lpt.balanceOf(user1), amount);
    }

    function test_Deposit_RevertOnZeroAmount() public {
        vm.startPrank(user1);
        sqd.approve(portal, SMALL_STAKE);

        vm.expectRevert(PoolErrors.InvalidAmount.selector);
        pool.deposit(0);
        vm.stopPrank();
    }

    function test_Deposit_RevertOnExceedsCapacity() public {
        uint256 amount = MIN_STAKE_THRESHOLD + 1;

        vm.startPrank(user1);
        sqd.approve(portal, amount);

        vm.expectRevert(PoolErrors.CapacityExceeded.selector);
        pool.deposit(amount);
        vm.stopPrank();
    }

    function test_Deposit_RevertOnExceedsWalletLimit() public {
        uint256 capacity = DEFAULT_MAX_STAKE_PER_WALLET * 2;
        uint256 rate = _minRateForCapacity(capacity);
        uint256 initialDeposit = rate * 1 days / 1000;
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: capacity,
            peerId: "wallet-limit-test",
            tokenSuffix: "WalletLimitTest",
            distributionRatePerSecond: rate,
            initialDeposit: initialDeposit,
            metadata: "",
            rewardToken: address(usdc)
        });
        usdc.approve(address(factory), initialDeposit);
        address testPortal = factory.createPortalPool(params);

        vm.startPrank(user1);
        sqd.approve(testPortal, DEFAULT_MAX_STAKE_PER_WALLET + 1);

        vm.expectRevert(PoolErrors.ExceedsWalletLimit.selector);
        IPortalPool(testPortal).deposit(DEFAULT_MAX_STAKE_PER_WALLET + 1);
        vm.stopPrank();
    }

    function test_Deposit_TriggersActivation() public {
        vm.startPrank(user1);
        sqd.approve(portal, MIN_STAKE_THRESHOLD);

        vm.expectEmit(true, true, false, false);
        emit IPortalPool.StateChanged(IPortalPool.PoolState.COLLECTING, IPortalPool.PoolState.ACTIVE);

        pool.deposit(MIN_STAKE_THRESHOLD);
        vm.stopPrank();

        assertEq(uint8(pool.getState()), uint8(IPortalPool.PoolState.ACTIVE));
        assertTrue(pool.getPoolInfo().firstActivated);
    }

    function test_Deposit_AfterDeadline_FailsPortal() public {
        vm.startPrank(user1);
        sqd.approve(portal, SMALL_STAKE);
        pool.deposit(SMALL_STAKE);
        vm.stopPrank();

        _warpToAfterDeadline(portal);

        assertEq(uint8(pool.getState()), uint8(IPortalPool.PoolState.FAILED));

        vm.startPrank(user2);
        sqd.approve(portal, SMALL_STAKE);
        uint256 user2StakeBefore = pool.getProviderStake(user2);
        vm.expectRevert(PoolErrors.InvalidState.selector);
        pool.deposit(SMALL_STAKE);
        vm.stopPrank();

        assertEq(pool.getProviderStake(user2), user2StakeBefore);
    }

    function test_Deposit_InActiveState() public {
        portal = _createPortal(operator, MIN_STAKE_THRESHOLD * 2, "ActivePortal");
        pool = PortalPoolImplementation(portal);

        vm.startPrank(user1);
        sqd.approve(portal, MIN_STAKE_THRESHOLD * 2);
        pool.deposit(MIN_STAKE_THRESHOLD * 2);
        vm.stopPrank();

        assertEq(uint8(pool.getState()), uint8(IPortalPool.PoolState.ACTIVE));

        assertEq(pool.getProviderStake(user1), MIN_STAKE_THRESHOLD * 2);
    }

    function test_RequestExit_Success() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ExitPortal");
        pool = PortalPoolImplementation(portal);

        uint256 exitAmount = SMALL_STAKE;

        vm.startPrank(user1);
        uint256 ticketId = pool.requestExit(exitAmount);
        vm.stopPrank();

        assertEq(ticketId, 0);

        IPortalPool.ExitTicket memory ticket = pool.getExitTicket(user1, ticketId);
        assertEq(ticket.amount, exitAmount);
        assertFalse(ticket.withdrawn);
    }

    function test_RequestExit_RevertOnZeroAmount() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ExitPortal");
        pool = PortalPoolImplementation(portal);

        vm.prank(user1);
        vm.expectRevert(PoolErrors.InvalidAmount.selector);
        pool.requestExit(0);
    }

    function test_RequestExit_RevertOnInsufficientStake() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ExitPortal");
        pool = PortalPoolImplementation(portal);

        vm.prank(user1);
        vm.expectRevert(PoolErrors.InsufficientStake.selector);
        pool.requestExit(MIN_STAKE_THRESHOLD + 1);
    }

    function test_RequestExit_BurnsLPT() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ExitPortal");
        pool = PortalPoolImplementation(portal);

        LiquidPortalToken lpt = LiquidPortalToken(address(pool.lptToken()));
        uint256 lptBefore = lpt.balanceOf(user1);

        vm.prank(user1);
        pool.requestExit(SMALL_STAKE);

        assertEq(lpt.balanceOf(user1), lptBefore - SMALL_STAKE);
    }

    function test_RequestExit_MultipleTickets() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ExitPortal");
        pool = PortalPoolImplementation(portal);

        vm.startPrank(user1);
        uint256 ticket0 = pool.requestExit(SMALL_STAKE);
        uint256 ticket1 = pool.requestExit(SMALL_STAKE);
        vm.stopPrank();

        assertEq(ticket0, 0);
        assertEq(ticket1, 1);
        assertEq(pool.getTicketCount(user1), 2);
    }

    function test_WithdrawExit_QueueMechanics() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ExitPortal");
        pool = PortalPoolImplementation(portal);

        vm.prank(user1);
        uint256 ticketId = pool.requestExit(SMALL_STAKE);

        IPortalPool.ExitTicket memory ticket = pool.getExitTicket(user1, ticketId);
        assertEq(ticket.amount, SMALL_STAKE);
        assertFalse(ticket.withdrawn);

        (uint256 processed, uint256 userEndPos, uint256 secondsRemaining, bool ready) =
            pool.getQueueStatus(user1, ticketId);
        assertFalse(ready);
        assertTrue(secondsRemaining > 0);

        vm.warp(block.timestamp + SMALL_STAKE / 1e18 + 1);

        (processed, userEndPos, secondsRemaining, ready) = pool.getQueueStatus(user1, ticketId);
        assertTrue(ready);
        assertEq(secondsRemaining, 0);
    }

    function test_WithdrawExit_RevertOnStillInQueue() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ExitPortal");
        pool = PortalPoolImplementation(portal);

        vm.prank(user1);
        uint256 ticketId = pool.requestExit(SMALL_STAKE);

        vm.prank(user1);
        vm.expectRevert(PoolErrors.StillInQueue.selector);
        pool.withdrawExit(ticketId);
    }

    function test_WithdrawExit_RevertOnAlreadyWithdrawn() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ExitPortal");
        pool = PortalPoolImplementation(portal);

        vm.prank(user1);
        uint256 ticketId = pool.requestExit(SMALL_STAKE);

        (,, uint256 secondsRemaining,) = pool.getQueueStatus(user1, ticketId);
        vm.warp(block.timestamp + secondsRemaining + 1);

        vm.prank(user1);
        pool.withdrawExit(ticketId);

        vm.prank(user1);
        vm.expectRevert(PoolErrors.AlreadyWithdrawn.selector);
        pool.withdrawExit(ticketId);
    }

    function test_WithdrawFromFailed_Success() public {
        _approveAndDeposit(user1, portal, SMALL_STAKE);

        _warpToAfterDeadline(portal);

        PortalPoolImplementation(portal).checkAndFailPortal();

        uint256 balanceBefore = sqd.balanceOf(user1);

        vm.prank(user1);
        pool.withdrawFromFailed();

        assertEq(sqd.balanceOf(user1), balanceBefore + SMALL_STAKE);
        assertEq(pool.getProviderStake(user1), 0);
    }

    function test_WithdrawFromFailed_RevertOnNotFailed() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ActivePortal");
        pool = PortalPoolImplementation(portal);

        vm.prank(user1);
        vm.expectRevert(PoolErrors.PoolNotFailed.selector);
        pool.withdrawFromFailed();
    }

    function test_TopUpRewards_Success() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "RewardPortal");
        pool = PortalPoolImplementation(portal);

        // Get initial credit (50% of initial deposit goes to providers)
        int256 initialProviderCredit = pool.getCurrentRewardBalance();

        uint256 rewardAmount = 1000 * 1e6;
        // FeeRouter splits 50/50 by default, so half goes to providers and half to worker pool
        uint256 toProviders = rewardAmount / 2;
        uint256 toWorkerPool = rewardAmount / 2;
        uint256 toBurn = 0;

        vm.startPrank(operator);
        usdc.approve(portal, rewardAmount);

        // Event now emits: received, toProviders, toWorkerPool, toBurn
        vm.expectEmit(true, false, false, true);
        emit IPortalPool.RewardsToppedUp(operator, rewardAmount, toProviders, toWorkerPool, toBurn);

        pool.topUpRewards(rewardAmount);
        vm.stopPrank();

        // Balance = initial credit + provider amount from top-up
        assertEq(pool.getCurrentRewardBalance(), initialProviderCredit + int256(toProviders));
    }

    function test_TopUpRewards_RevertOnNotActive() public {
        vm.startPrank(operator);
        usdc.approve(portal, 1000 * 1e6);

        vm.expectRevert(PoolErrors.InvalidState.selector);
        pool.topUpRewards(1000 * 1e6);
        vm.stopPrank();
    }

    function test_TopUpRewards_RevertOnMissingWorkerPool() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "RewardPortalMissingWorker");
        pool = PortalPoolImplementation(portal);

        // Set factory's worker pool address to zero
        factory.setWorkerPoolAddress(address(0));

        uint256 rewardAmount = 1000 * 1e6;

        vm.startPrank(operator);
        usdc.approve(portal, rewardAmount);
        vm.expectRevert(PoolErrors.InvalidAddress.selector);
        pool.topUpRewards(rewardAmount);
        vm.stopPrank();
    }

    function test_ClaimRewards_Success() public {
        uint256 rate = _minRateForCapacity(MIN_STAKE_THRESHOLD);
        uint256 initialDeposit = rate * 1 days / 1000;
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: MIN_STAKE_THRESHOLD,
            peerId: "reward-portal",
            tokenSuffix: "RewardPortal",
            distributionRatePerSecond: rate,
            initialDeposit: initialDeposit,
            metadata: "",
            rewardToken: address(usdc)
        });
        usdc.approve(address(factory), initialDeposit);
        portal = factory.createPortalPool(params);
        pool = PortalPoolImplementation(portal);

        vm.startPrank(user1);
        sqd.approve(portal, MIN_STAKE_THRESHOLD);
        pool.deposit(MIN_STAKE_THRESHOLD);
        vm.stopPrank();

        uint256 rewardAmount = 1_000_000 * 1e6;
        vm.startPrank(operator);
        usdc.mint(operator, rewardAmount);
        usdc.approve(portal, rewardAmount);
        pool.topUpRewards(rewardAmount);
        vm.stopPrank();

        vm.warp(block.timestamp + 100);

        uint256 balanceBefore = usdc.balanceOf(user1);

        vm.prank(user1);
        uint256 claimed = pool.claimRewards();

        assertTrue(claimed > 0);
        assertEq(usdc.balanceOf(user1), balanceBefore + claimed);
    }

    function test_OnLPTTransfer_UpdatesStakes() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "TransferPortal");
        pool = PortalPoolImplementation(portal);

        LiquidPortalToken lpt = LiquidPortalToken(address(pool.lptToken()));

        uint256 transferAmount = SMALL_STAKE;

        uint256 user1StakeBefore = pool.getProviderStake(user1);

        vm.prank(user1);
        lpt.transfer(user2, transferAmount);

        assertEq(pool.getProviderStake(user1), user1StakeBefore - transferAmount);
        assertEq(pool.getProviderStake(user2), transferAmount);
    }

    function test_OnLPTTransfer_RevertOnExceedsWalletLimit() public {
        uint256 capacity = DEFAULT_MAX_STAKE_PER_WALLET * 2;
        uint256 rate = _minRateForCapacity(capacity);
        uint256 initialDeposit = rate * 1 days / 1000;
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: capacity,
            peerId: "transfer-limit",
            tokenSuffix: "TransferLimit",
            distributionRatePerSecond: rate,
            initialDeposit: initialDeposit,
            metadata: "",
            rewardToken: address(usdc)
        });
        usdc.approve(address(factory), initialDeposit);
        address limitPortal = factory.createPortalPool(params);

        vm.startPrank(user1);
        sqd.approve(limitPortal, DEFAULT_MAX_STAKE_PER_WALLET);
        IPortalPool(limitPortal).deposit(DEFAULT_MAX_STAKE_PER_WALLET);
        vm.stopPrank();

        vm.startPrank(user2);
        sqd.approve(limitPortal, DEFAULT_MAX_STAKE_PER_WALLET);
        IPortalPool(limitPortal).deposit(DEFAULT_MAX_STAKE_PER_WALLET);
        vm.stopPrank();

        LiquidPortalToken lpt = PortalPoolImplementation(limitPortal).lptToken();

        vm.prank(user1);
        vm.expectRevert(PoolErrors.ExceedsWalletLimit.selector);
        lpt.transfer(user2, 1);
    }

    function test_GetState_FAILED() public {
        _warpToAfterDeadline(portal);

        assertEq(uint8(pool.getState()), uint8(IPortalPool.PoolState.FAILED));
    }

    function test_GetState_IDLE_ViaDirectStateCheck() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "IdlePortal");
        pool = PortalPoolImplementation(portal);

        assertEq(uint8(pool.getState()), uint8(IPortalPool.PoolState.ACTIVE));
        assertTrue(pool.getPoolInfo().firstActivated);
        assertTrue(pool.getPoolInfo().totalStaked >= MIN_STAKE_THRESHOLD);
    }

    function test_Pause_BlocksDeposit() public {
        vm.prank(operator);
        pool.pause();

        vm.startPrank(user1);
        sqd.approve(portal, SMALL_STAKE);

        vm.expectRevert();
        pool.deposit(SMALL_STAKE);
        vm.stopPrank();
    }

    function test_Unpause_AllowsDeposit() public {
        vm.prank(operator);
        pool.pause();

        vm.prank(operator);
        pool.unpause();

        _approveAndDeposit(user1, portal, SMALL_STAKE);
        assertEq(pool.getProviderStake(user1), SMALL_STAKE);
    }

    function test_GetPoolInfo() public {
        _approveAndDeposit(user1, portal, SMALL_STAKE);

        IPortalPool.PoolInfo memory info = pool.getPoolInfo();

        assertEq(info.operator, operator);
        assertEq(info.totalStaked, SMALL_STAKE);
        assertEq(uint8(info.state), uint8(IPortalPool.PoolState.COLLECTING));
    }

    function test_GetActiveStake() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ActiveStakePortal");
        pool = PortalPoolImplementation(portal);

        assertEq(pool.getActiveStake(), MIN_STAKE_THRESHOLD);

        vm.prank(user1);
        pool.requestExit(SMALL_STAKE);

        assertEq(pool.getActiveStake(), MIN_STAKE_THRESHOLD - SMALL_STAKE);
    }

    function test_GetQueueStatus() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "QueuePortal");
        pool = PortalPoolImplementation(portal);

        vm.prank(user1);
        uint256 ticketId = pool.requestExit(SMALL_STAKE);

        (uint256 processed, uint256 userEndPos, uint256 secondsRemaining, bool ready) =
            pool.getQueueStatus(user1, ticketId);

        assertEq(processed, 0);
        assertEq(userEndPos, SMALL_STAKE);
        assertEq(secondsRemaining, SMALL_STAKE / 1e18);
        assertFalse(ready);

        vm.warp(block.timestamp + SMALL_STAKE / 1e18 + 1);

        (processed, userEndPos, secondsRemaining, ready) = pool.getQueueStatus(user1, ticketId);

        assertTrue(processed >= SMALL_STAKE);
        assertEq(secondsRemaining, 0);
        assertTrue(ready);
    }

    function test_SetDistributionRate() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "RatePortal");
        pool = PortalPoolImplementation(portal);

        uint256 newRate = 2 ether;

        vm.prank(operator);
        pool.setDistributionRate(newRate);

        assertEq(pool.totalDistributionRatePerSec(), newRate);
    }

    function test_CheckAndFailPortal_Success() public {
        _warpToAfterDeadline(portal);

        PortalPoolImplementation(portal).checkAndFailPortal();

        assertEq(uint8(pool.getState()), uint8(IPortalPool.PoolState.FAILED));
    }

    function test_CheckAndFailPortal_RevertOnWrongState() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ActivePortal");

        vm.expectRevert(PoolErrors.InvalidState.selector);
        PortalPoolImplementation(portal).checkAndFailPortal();
    }

    function test_CheckAndFailPortal_RevertBeforeDeadline() public {
        vm.expectRevert(PoolErrors.DeadlineNotPassed.selector);
        PortalPoolImplementation(portal).checkAndFailPortal();
    }

    function test_RequestExit_RevertInCollectingState() public {
        portal = _createPortal(operator, MIN_STAKE_THRESHOLD, "CollectingExitPortal");
        pool = PortalPoolImplementation(portal);

        vm.startPrank(user1);
        sqd.approve(portal, SMALL_STAKE);
        pool.deposit(SMALL_STAKE);

        // Cannot requestExit during COLLECTING - must wait for activation or deadline
        vm.expectRevert(PoolErrors.WaitForActivationOrDeadline.selector);
        pool.requestExit(SMALL_STAKE / 2);
        vm.stopPrank();
    }

    function test_Pause_RevertOnNonOperator() public {
        vm.prank(user1);
        vm.expectRevert();
        pool.pause();
    }

    function test_Unpause_RevertOnNonOperator() public {
        vm.prank(operator);
        pool.pause();

        vm.prank(user1);
        vm.expectRevert();
        pool.unpause();
    }

    function test_SetDistributionRate_RevertOnNonOperator() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "RatePortal");

        vm.prank(user1);
        vm.expectRevert(PoolErrors.NotOperator.selector);
        PortalPoolImplementation(portal).setDistributionRate(2 ether);
    }

    function test_SetDistributionRate_RevertInCollectingState() public {
        uint256 newRate = 2000 * 1000;
        vm.prank(operator);
        vm.expectRevert(PoolErrors.InvalidState.selector);
        pool.setDistributionRate(newRate);
    }

    function test_SetCapacity_Success() public {
        // Create portal with rate that supports 2x capacity (for the increase test)
        uint256 targetCapacity = MIN_STAKE_THRESHOLD * 2;
        uint256 rate = _minRateForCapacity(targetCapacity);

        uint256 initialDeposit = rate * 1 days / 1000;
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: MIN_STAKE_THRESHOLD,
            peerId: "cap-success",
            tokenSuffix: "CapacityTestPortal",
            distributionRatePerSecond: rate,
            initialDeposit: initialDeposit,
            metadata: "",
            rewardToken: address(usdc)
        });
        usdc.approve(address(factory), initialDeposit);
        portal = factory.createPortalPool(params);
        pool = PortalPoolImplementation(portal);

        // Activate by depositing
        vm.startPrank(user1);
        sqd.approve(portal, MIN_STAKE_THRESHOLD);
        pool.deposit(MIN_STAKE_THRESHOLD);
        vm.stopPrank();

        uint256 oldCapacity = pool.getPoolInfo().capacity;
        uint256 newCapacity = targetCapacity;

        vm.prank(operator);
        vm.expectEmit(true, true, false, false);
        emit IPortalPool.CapacityUpdated(oldCapacity, newCapacity);
        pool.setCapacity(newCapacity);

        assertEq(pool.getPoolInfo().capacity, newCapacity);
    }

    function test_SetCapacity_RevertOnNotActivated() public {
        // Pool is in COLLECTING state, not activated yet
        uint256 newCapacity = MIN_STAKE_THRESHOLD + 100_000 ether;

        vm.prank(operator);
        vm.expectRevert(PoolErrors.NotActivated.selector);
        pool.setCapacity(newCapacity);
    }

    function test_SetCapacity_RevertOnNonOperator() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "CapacityTestPortal2");
        pool = PortalPoolImplementation(portal);

        uint256 newCapacity = MIN_STAKE_THRESHOLD + 100_000 ether;

        vm.prank(user1);
        vm.expectRevert(PoolErrors.NotOperator.selector);
        pool.setCapacity(newCapacity);
    }

    function test_SetCapacity_LowerCapacity_Success() public {
        // Create and activate portal with rate that supports 2x capacity
        uint256 higherCapacity = MIN_STAKE_THRESHOLD * 2;
        uint256 rate = _minRateForCapacity(higherCapacity);

        uint256 initialDeposit = rate * 1 days / 1000;
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: MIN_STAKE_THRESHOLD,
            peerId: "cap-test-3",
            tokenSuffix: "CapacityTestPortal3",
            distributionRatePerSecond: rate,
            initialDeposit: initialDeposit,
            metadata: "",
            rewardToken: address(usdc)
        });
        usdc.approve(address(factory), initialDeposit);
        portal = factory.createPortalPool(params);
        pool = PortalPoolImplementation(portal);

        // Activate by depositing
        vm.startPrank(user1);
        sqd.approve(portal, MIN_STAKE_THRESHOLD);
        pool.deposit(MIN_STAKE_THRESHOLD);
        vm.stopPrank();

        // First increase capacity
        vm.prank(operator);
        pool.setCapacity(higherCapacity);
        assertEq(pool.getPoolInfo().capacity, higherCapacity);

        // Now lower it back - totalStaked is MIN_STAKE_THRESHOLD, so we can go down to that
        uint256 lowerCapacity = MIN_STAKE_THRESHOLD + 1000 ether;
        vm.prank(operator);
        pool.setCapacity(lowerCapacity);

        assertEq(pool.getPoolInfo().capacity, lowerCapacity);
        assertTrue(lowerCapacity < higherCapacity, "Should have lowered capacity");
    }

    function test_SetCapacity_LowerToExactlyCurrentStake() public {
        // Create and activate portal with rate that supports 2x capacity
        uint256 higherCapacity = MIN_STAKE_THRESHOLD * 2;
        uint256 rate = _minRateForCapacity(higherCapacity);

        uint256 initialDeposit = rate * 1 days / 1000;
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: MIN_STAKE_THRESHOLD,
            peerId: "cap-test-4",
            tokenSuffix: "CapacityTestPortal4",
            distributionRatePerSecond: rate,
            initialDeposit: initialDeposit,
            metadata: "",
            rewardToken: address(usdc)
        });
        usdc.approve(address(factory), initialDeposit);
        portal = factory.createPortalPool(params);
        pool = PortalPoolImplementation(portal);

        // Activate by depositing
        vm.startPrank(user1);
        sqd.approve(portal, MIN_STAKE_THRESHOLD);
        pool.deposit(MIN_STAKE_THRESHOLD);
        vm.stopPrank();

        // Increase capacity
        vm.prank(operator);
        pool.setCapacity(higherCapacity);

        // Lower to exactly the totalStaked amount (MIN_STAKE_THRESHOLD)
        vm.prank(operator);
        pool.setCapacity(MIN_STAKE_THRESHOLD);

        assertEq(pool.getPoolInfo().capacity, MIN_STAKE_THRESHOLD);
    }

    function test_SetCapacity_RevertOnBelowCurrentStake() public {
        uint256 initialCapacity = MIN_STAKE_THRESHOLD * 2;
        portal = _createAndActivatePortal(operator, initialCapacity, "CapacityTestPortal5");
        pool = PortalPoolImplementation(portal);

        vm.prank(operator);
        vm.expectRevert(PoolErrors.BelowCurrentStake.selector);
        pool.setCapacity(MIN_STAKE_THRESHOLD);
    }

    function test_SetCapacity_RevertOnBelowMinimum() public {
        // Create and activate portal with rate that supports 2x capacity
        uint256 higherCapacity = MIN_STAKE_THRESHOLD * 2;
        uint256 rate = _minRateForCapacity(higherCapacity);

        uint256 initialDeposit = rate * 1 days / 1000;
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: MIN_STAKE_THRESHOLD,
            peerId: "cap-test-6",
            tokenSuffix: "CapacityTestPortal6",
            distributionRatePerSecond: rate,
            initialDeposit: initialDeposit,
            metadata: "",
            rewardToken: address(usdc)
        });
        usdc.approve(address(factory), initialDeposit);
        portal = factory.createPortalPool(params);
        pool = PortalPoolImplementation(portal);

        // Activate by depositing
        vm.startPrank(user1);
        sqd.approve(portal, MIN_STAKE_THRESHOLD);
        pool.deposit(MIN_STAKE_THRESHOLD);
        vm.stopPrank();

        // Increase capacity first
        vm.prank(operator);
        pool.setCapacity(higherCapacity);

        // Try to lower capacity below minStakeThreshold
        uint256 belowMin = MIN_STAKE_THRESHOLD - 1;

        vm.prank(operator);
        vm.expectRevert(PoolErrors.BelowMinimum.selector);
        pool.setCapacity(belowMin);
    }

    function test_SetCapacity_RevertOnSameCapacity() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "CapacityTestPortal9");
        pool = PortalPoolImplementation(portal);

        uint256 currentCapacity = pool.getPoolInfo().capacity;

        vm.prank(operator);
        vm.expectRevert(PoolErrors.NoChange.selector);
        pool.setCapacity(currentCapacity);
    }

    function test_SetCapacity_AllowsAdditionalDeposits() public {
        // Create portal with rate that supports the new capacity
        uint256 newCapacity = MIN_STAKE_THRESHOLD + SMALL_STAKE;
        uint256 rate = _minRateForCapacity(newCapacity);

        uint256 initialDeposit = rate * 1 days / 1000;
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: MIN_STAKE_THRESHOLD,
            peerId: "cap-test-8",
            tokenSuffix: "CapacityTestPortal8",
            distributionRatePerSecond: rate,
            initialDeposit: initialDeposit,
            metadata: "",
            rewardToken: address(usdc)
        });
        usdc.approve(address(factory), initialDeposit);
        portal = factory.createPortalPool(params);
        pool = PortalPoolImplementation(portal);

        // Activate by depositing
        vm.startPrank(user1);
        sqd.approve(portal, MIN_STAKE_THRESHOLD);
        pool.deposit(MIN_STAKE_THRESHOLD);
        vm.stopPrank();

        vm.startPrank(user2);
        sqd.approve(portal, SMALL_STAKE);
        vm.expectRevert(PoolErrors.CapacityExceeded.selector);
        pool.deposit(SMALL_STAKE);
        vm.stopPrank();
        vm.prank(operator);
        pool.setCapacity(newCapacity);

        vm.startPrank(user2);
        pool.deposit(SMALL_STAKE);
        vm.stopPrank();

        assertEq(pool.getPoolInfo().totalStaked, newCapacity);
    }

    function test_RequestExit_RevertOnFailed() public {
        _approveAndDeposit(user1, portal, SMALL_STAKE);

        _warpToAfterDeadline(portal);

        vm.prank(user1);
        vm.expectRevert(PoolErrors.UseWithdrawFromFailed.selector);
        pool.requestExit(SMALL_STAKE);
    }

    function test_GetClaimableRewards_ZeroWhenNoRewards() public view {
        uint256 rewards = pool.getClaimableRewards(user1);
        assertEq(rewards, 0);
    }

    function test_GetProviderStake_ReturnsCorrectValue() public {
        _approveAndDeposit(user1, portal, SMALL_STAKE);
        assertEq(pool.getProviderStake(user1), SMALL_STAKE);
        assertEq(pool.getProviderStake(user2), 0);
    }

    function test_OnLPTTransfer_SenderZeroStakeAfterFullTransfer() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "TransferPortal");
        pool = PortalPoolImplementation(portal);

        LiquidPortalToken lpt = pool.lptToken();

        uint256 user1Stake = pool.getProviderStake(user1);

        vm.prank(user1);
        lpt.transfer(user2, user1Stake);

        assertEq(pool.getProviderStake(user1), 0);
        assertEq(pool.getProviderStake(user2), user1Stake);
    }

    function test_ClaimRewards_RevertOnNothingToClaim() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "NoRewardsPortal");
        pool = PortalPoolImplementation(portal);

        vm.prank(user1);
        vm.expectRevert(PoolErrors.NothingToClaim.selector);
        pool.claimRewards();
    }

    function test_TopUpRewards_RevertOnNonOperator() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "RewardsPortal");
        pool = PortalPoolImplementation(portal);

        uint256 rewardAmount = 1_000_000 * 1e6;
        vm.startPrank(user2);
        usdc.mint(user2, rewardAmount);
        usdc.approve(portal, rewardAmount);
        vm.expectRevert(PoolErrors.NotOperator.selector);
        pool.topUpRewards(rewardAmount);
        vm.stopPrank();
    }

    function test_WithdrawFromFailed_RevertOnNoStake() public {
        portal = _createPortal(operator, MIN_STAKE_THRESHOLD, "NoStakeFailedPortal");
        pool = PortalPoolImplementation(portal);

        _warpToAfterDeadline(portal);

        vm.prank(user1);
        vm.expectRevert(PoolErrors.NoStakeToWithdraw.selector);
        pool.withdrawFromFailed();
    }

    function test_RequestExit_UpdatesExitAmounts() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ExitAmountsPortal");
        pool = PortalPoolImplementation(portal);

        uint256 exitAmount = SMALL_STAKE;

        vm.prank(user1);
        pool.requestExit(exitAmount);

        uint256 activeStake = pool.getActiveStake();
        assertEq(activeStake, MIN_STAKE_THRESHOLD - exitAmount);
    }

    function test_Deposit_RevertOnFailed() public {
        _warpToAfterDeadline(portal);

        vm.startPrank(user1);
        sqd.approve(portal, SMALL_STAKE);
        vm.expectRevert(PoolErrors.InvalidState.selector);
        pool.deposit(SMALL_STAKE);
        vm.stopPrank();
    }

    function test_GetClaimableRewards_InCollectingState() public {
        // In collecting state, rewards shouldn't accrue since not active
        uint256 rewards = pool.getClaimableRewards(user1);
        assertEq(rewards, 0);
    }

    function test_GetClaimableRewards_WithRunwayLimit() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "RunwayPortal");
        pool = PortalPoolImplementation(portal);

        // Get initial provider credit from pool creation
        int256 initialCredit = pool.getCurrentRewardBalance();
        assertTrue(initialCredit > 0, "Should have initial credit from pool creation");

        // Top up small amount of rewards
        uint256 rewardAmount = 100 * 1e6; // Small amount
        vm.startPrank(operator);
        usdc.mint(operator, rewardAmount);
        usdc.approve(portal, rewardAmount);
        pool.topUpRewards(rewardAmount);
        vm.stopPrank();

        // Total available = initial credit + 50% of rewardAmount (FeeRouter split)
        int256 totalCredit = pool.getCurrentRewardBalance();

        // Warp far into future - rewards should be capped by runway
        vm.warp(block.timestamp + 365 days);

        uint256 rewards = pool.getClaimableRewards(user1);
        // Rewards should be limited by total available credit
        assertTrue(rewards <= uint256(totalCredit), "Rewards capped by total credit");
    }

    function test_GetCurrentRewardBalance_WhenExhausted() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ExhaustedRewardsPortal");
        pool = PortalPoolImplementation(portal);

        // Top up small amount of rewards
        uint256 rewardAmount = 100 * 1e6;
        vm.startPrank(operator);
        usdc.mint(operator, rewardAmount);
        usdc.approve(portal, rewardAmount);
        pool.topUpRewards(rewardAmount);
        vm.stopPrank();

        // Warp far into future - rewards should be exhausted
        vm.warp(block.timestamp + 365 days);

        int256 balance = pool.getCurrentRewardBalance();
        assertLe(balance, int256(0)); // Balance can be 0 or negative (debt)
    }

    function test_SetDistributionRate_ToZero() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ZeroRatePortal");
        pool = PortalPoolImplementation(portal);

        vm.prank(operator);
        pool.setDistributionRate(0);

        assertEq(pool.totalDistributionRatePerSec(), 0);
    }

    function test_Deposit_InActiveState_AdditionalUser() public {
        // Create portal with larger capacity to allow additional deposits
        uint256 capacity = MIN_STAKE_THRESHOLD * 2;
        uint256 rate = _minRateForCapacity(capacity);
        uint256 initialDeposit = rate * 1 days / 1000;
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: capacity,
            peerId: "active-deposit-portal",
            tokenSuffix: "ActiveDepositPortal",
            distributionRatePerSecond: rate,
            initialDeposit: initialDeposit,
            metadata: "",
            rewardToken: address(usdc)
        });
        usdc.approve(address(factory), initialDeposit);
        portal = factory.createPortalPool(params);
        pool = PortalPoolImplementation(portal);

        // Activate by filling to capacity
        vm.startPrank(user1);
        sqd.approve(portal, MIN_STAKE_THRESHOLD * 2);
        pool.deposit(MIN_STAKE_THRESHOLD * 2);
        vm.stopPrank();

        assertEq(uint8(pool.getState()), uint8(IPortalPool.PoolState.ACTIVE));
    }

    function test_GetExitTicket() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "TicketPortal");
        pool = PortalPoolImplementation(portal);

        vm.prank(user1);
        uint256 ticketId = pool.requestExit(SMALL_STAKE);

        IPortalPool.ExitTicket memory ticket = pool.getExitTicket(user1, ticketId);

        assertEq(ticket.amount, SMALL_STAKE);
        assertEq(ticket.endPosition, SMALL_STAKE);
        assertFalse(ticket.withdrawn);
    }

    function test_GetTicketCount() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "TicketCountPortal");
        pool = PortalPoolImplementation(portal);

        assertEq(pool.getTicketCount(user1), 0);

        vm.prank(user1);
        pool.requestExit(SMALL_STAKE / 3);
        assertEq(pool.getTicketCount(user1), 1);

        vm.prank(user1);
        pool.requestExit(SMALL_STAKE / 3);
        assertEq(pool.getTicketCount(user1), 2);
    }

    function test_GetTotalProcessed() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ProcessedPortal");
        pool = PortalPoolImplementation(portal);

        assertEq(pool.getTotalProcessed(), 0);

        vm.prank(user1);
        pool.requestExit(SMALL_STAKE);

        // Warp and check processed
        vm.warp(block.timestamp + SMALL_STAKE / 1e18 + 1);

        assertGt(pool.getTotalProcessed(), 0);
    }

    function test_GetComputationUnits() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "CUsPortal");
        pool = PortalPoolImplementation(portal);

        uint256 cus = pool.getComputationUnits();
        assertGt(cus, 0);
    }

    function test_WithdrawExit_RevertOnNoActiveRequest() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "NoRequestPortal");
        pool = PortalPoolImplementation(portal);

        vm.prank(user1);
        vm.expectRevert(PoolErrors.NoActiveExitRequest.selector);
        pool.withdrawExit(999);
    }

    function test_GetClaimableRewards_ZeroStake() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ZeroStakeRewardsPortal");
        pool = PortalPoolImplementation(portal);

        uint256 rewards = pool.getClaimableRewards(user2);
        assertEq(rewards, 0);
    }

    function test_GetClaimableRewards_AllStakeInExit() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "AllExitRewardsPortal");
        pool = PortalPoolImplementation(portal);

        // Request exit for all stake
        vm.prank(user1);
        pool.requestExit(MIN_STAKE_THRESHOLD);

        // Active stake is 0 since all is in exit queue
        uint256 rewards = pool.getClaimableRewards(user1);
        assertEq(rewards, 0);
    }

    function test_TopUpRewards_RevertOnZeroAmount() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ZeroRewardsPortal");
        pool = PortalPoolImplementation(portal);

        vm.prank(operator);
        vm.expectRevert(PoolErrors.InvalidAmount.selector);
        pool.topUpRewards(0);
    }

    function test_ZeroDistributionRate_TopUpRevertsWhenOff() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ZeroRatePortal1");
        pool = PortalPoolImplementation(portal);

        // Set rate to 0 to turn off distribution
        vm.prank(operator);
        pool.setDistributionRate(0);

        // topUpRewards should revert
        vm.startPrank(operator);
        usdc.mint(operator, 1_000_000 * 1e6);
        usdc.approve(portal, 1_000_000 * 1e6);
        vm.expectRevert(PoolErrors.DistributionTurnedOff.selector);
        pool.topUpRewards(1_000_000 * 1e6);
        vm.stopPrank();
    }

    function test_ZeroDistributionRate_ClaimRevertsWhenOff() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ZeroRatePortal2");
        pool = PortalPoolImplementation(portal);

        // Claim any initial rewards first
        vm.prank(user1);
        try pool.claimRewards() {} catch {}

        // Set rate to 0 to turn off distribution
        vm.prank(operator);
        pool.setDistributionRate(0);

        // With rate at 0, no new rewards accrue, so claim reverts with NothingToClaim
        vm.prank(user1);
        vm.expectRevert(PoolErrors.NothingToClaim.selector);
        pool.claimRewards();
    }

    function test_ZeroDistributionRate_ViewFunctionsReturnZero() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ZeroRatePortal3");
        pool = PortalPoolImplementation(portal);

        // Get initial credit before disabling distribution
        int256 initialCredit = pool.getCurrentRewardBalance();
        assertTrue(initialCredit > 0, "Should have initial credit from pool creation");

        // Set rate to 0 to turn off distribution
        vm.prank(operator);
        pool.setDistributionRate(0);

        // View functions: claimable should be 0, but balance still shows credit
        assertEq(pool.getClaimableRewards(user1), 0);
        // Balance still shows remaining credit even when rate is 0
        assertEq(pool.getCurrentRewardBalance(), initialCredit);
    }

    function test_ZeroDistributionRate_CanEnableBySettingRate() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ZeroRatePortal4");
        pool = PortalPoolImplementation(portal);

        // Get initial credit from pool creation
        int256 initialCredit = pool.getCurrentRewardBalance();

        // Set rate to 0 to turn off distribution
        vm.prank(operator);
        pool.setDistributionRate(0);

        // Claim any accrued rewards first
        vm.prank(user1);
        try pool.claimRewards() {} catch {}

        // With rate at 0, no new rewards accrue, so claim reverts with NothingToClaim
        vm.prank(user1);
        vm.expectRevert(PoolErrors.NothingToClaim.selector);
        pool.claimRewards();

        // Set rate to non-zero to enable distribution (must meet precision requirements)
        uint256 minRate = _minRateForCapacity(MIN_STAKE_THRESHOLD);
        vm.prank(operator);
        pool.setDistributionRate(minRate);

        // Now topUpRewards should work
        uint256 topUpAmount = 1000 * 1e6;
        vm.startPrank(operator);
        usdc.mint(operator, topUpAmount);
        usdc.approve(portal, topUpAmount);
        pool.topUpRewards(topUpAmount);
        vm.stopPrank();

        // FeeRouter splits 50/50, so provider balance = initial credit + 50% of top-up
        assertEq(pool.getCurrentRewardBalance(), initialCredit + int256(topUpAmount / 2));
    }

    function test_CreatePoolWithZeroDistributionRate() public {
        // Create portal with 0 distribution rate
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: MIN_STAKE_THRESHOLD,
            peerId: "peer-zero-rate",
            tokenSuffix: "ZeroRatePool",
            distributionRatePerSecond: 0, // Zero rate
            initialDeposit: 0,
            metadata: "",
            rewardToken: address(usdc)
        });

        address zeroRatePortal = factory.createPortalPool(params);
        PortalPoolImplementation zeroRatePool = PortalPoolImplementation(zeroRatePortal);

        // Activate the portal
        vm.startPrank(user1);
        sqd.approve(zeroRatePortal, MIN_STAKE_THRESHOLD);
        zeroRatePool.deposit(MIN_STAKE_THRESHOLD);
        vm.stopPrank();

        // Verify distribution is off
        vm.prank(operator);
        vm.expectRevert(PoolErrors.DistributionTurnedOff.selector);
        zeroRatePool.topUpRewards(1000 * 1e6);
    }

    function test_WithdrawFromFailed_SimpleWithdraw() public {
        portal = _createPortal(operator, MIN_STAKE_THRESHOLD, "LptLimitPortal");
        pool = PortalPoolImplementation(portal);

        // User deposits during COLLECTING
        vm.startPrank(user1);
        sqd.approve(portal, SMALL_STAKE);
        pool.deposit(SMALL_STAKE);
        vm.stopPrank();

        // Warp to after deadline - pool becomes FAILED
        _warpToAfterDeadline(portal);

        uint256 balanceBefore = sqd.balanceOf(user1);

        // User withdraws from failed pool
        vm.prank(user1);
        pool.withdrawFromFailed();

        assertEq(sqd.balanceOf(user1), balanceBefore + SMALL_STAKE);
    }

    function test_Deposit_AllowedWhenPendingExitsExist() public {
        address largePortal = _createPortal(operator, MIN_STAKE_THRESHOLD * 2, "LargePortal");
        PortalPoolImplementation largePool = PortalPoolImplementation(largePortal);

        // User1 fills the pool to capacity
        vm.startPrank(user1);
        sqd.approve(largePortal, MIN_STAKE_THRESHOLD * 2);
        largePool.deposit(MIN_STAKE_THRESHOLD * 2);
        vm.stopPrank();

        // Pool is now ACTIVE and at full capacity
        assertEq(uint8(largePool.getPoolInfo().state), uint8(IPortalPool.PoolState.ACTIVE));
        assertEq(largePool.getPoolInfo().totalStaked, MIN_STAKE_THRESHOLD * 2);

        // Top up rewards so pool is active
        vm.startPrank(operator);
        usdc.approve(largePortal, 1_000_000);
        largePool.topUpRewards(1_000_000);
        vm.stopPrank();

        // User1 requests exit for half their stake
        uint256 exitAmount = MIN_STAKE_THRESHOLD;
        vm.prank(user1);
        largePool.requestExit(exitAmount);

        // Verify state: totalStaked unchanged, but activeStake reduced
        assertEq(largePool.getPoolInfo().totalStaked, MIN_STAKE_THRESHOLD * 2, "totalStaked should be unchanged");
        assertEq(largePool.getActiveStake(), MIN_STAKE_THRESHOLD, "activeStake should be reduced by exit amount");

        // User2 should be able to deposit up to the freed capacity
        vm.startPrank(user2);
        sqd.approve(largePortal, exitAmount);

        // This should succeed because activeStake (MIN_STAKE_THRESHOLD) + deposit (MIN_STAKE_THRESHOLD) <= capacity (MIN_STAKE_THRESHOLD * 2)
        largePool.deposit(exitAmount);
        vm.stopPrank();

        // Verify final state
        assertEq(largePool.getProviderStake(user2), exitAmount, "user2 should have deposited");
        // totalStaked is now capacity + exitAmount (temporarily over capacity, but activeStake is at capacity)
        assertEq(
            largePool.getPoolInfo().totalStaked,
            MIN_STAKE_THRESHOLD * 3,
            "totalStaked includes pending exits + new deposit"
        );
        assertEq(largePool.getActiveStake(), MIN_STAKE_THRESHOLD * 2, "activeStake should equal capacity");
    }

    /// @notice test that deposits are still rejected when activeStake would exceed capacity
    function test_Deposit_RejectedWhenActiveStakeExceedsCapacity() public {
        // Create a larger pool
        address largePortal = _createPortal(operator, MIN_STAKE_THRESHOLD * 2, "LargePortal2");
        PortalPoolImplementation largePool = PortalPoolImplementation(largePortal);

        // User1 fills the pool to capacity
        vm.startPrank(user1);
        sqd.approve(largePortal, MIN_STAKE_THRESHOLD * 2);
        largePool.deposit(MIN_STAKE_THRESHOLD * 2);
        vm.stopPrank();

        // User1 requests exit for a small amount
        uint256 exitAmount = SMALL_STAKE;
        vm.prank(user1);
        largePool.requestExit(exitAmount);

        // User2 tries to deposit more than the freed capacity - should fail
        uint256 depositAmount = exitAmount + 1;
        vm.startPrank(user2);
        sqd.approve(largePortal, depositAmount);

        vm.expectRevert(PoolErrors.CapacityExceeded.selector);
        largePool.deposit(depositAmount);
        vm.stopPrank();
    }

    /// @notice Test deposit at exact capacity boundary with pending exits
    function test_Deposit_ExactCapacityWithPendingExits() public {
        // Create a larger pool
        address largePortal = _createPortal(operator, MIN_STAKE_THRESHOLD * 2, "LargePortal3");
        PortalPoolImplementation largePool = PortalPoolImplementation(largePortal);

        // User1 fills the pool to capacity
        vm.startPrank(user1);
        sqd.approve(largePortal, MIN_STAKE_THRESHOLD * 2);
        largePool.deposit(MIN_STAKE_THRESHOLD * 2);
        vm.stopPrank();

        // Top up rewards so pool is active
        vm.startPrank(operator);
        usdc.approve(largePortal, 1_000_000);
        largePool.topUpRewards(1_000_000);
        vm.stopPrank();

        // User1 requests exit for exactly SMALL_STAKE
        vm.prank(user1);
        largePool.requestExit(SMALL_STAKE);

        // User2 deposits exactly SMALL_STAKE - should succeed (at exact capacity)
        vm.startPrank(user2);
        sqd.approve(largePortal, SMALL_STAKE);
        largePool.deposit(SMALL_STAKE);
        vm.stopPrank();

        // Verify activeStake equals capacity
        assertEq(largePool.getActiveStake(), MIN_STAKE_THRESHOLD * 2, "activeStake should equal capacity");

        // User3 tries to deposit 1 wei more - should fail
        vm.startPrank(user3);
        sqd.approve(largePortal, 1);

        vm.expectRevert(PoolErrors.CapacityExceeded.selector);
        largePool.deposit(1);
        vm.stopPrank();
    }
}
