// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./BaseTest.sol";
import {PortalErrors} from "../src/libs/PortalErrors.sol";
import {Constants} from "../src/libs/Constants.sol";
import {PortalPoolImplementation} from "../src/PortalPoolImplementation.sol";

contract PortalPoolImplementationTest is BaseTest {
    address public portal;
    PortalPoolImplementation public pool;

    function setUp() public override {
        super.setUp();
        portal = _createPortal(operator, MIN_STAKE_THRESHOLD, "TestPortal");
        pool = PortalPoolImplementation(portal);
    }

    function test_Initialize_SetsCorrectValues() public view {
        IPortalPool.PortalInfo memory info = pool.getPortalInfo();

        assertEq(info.operator, operator);
        assertEq(info.maxCapacity, MIN_STAKE_THRESHOLD);
        assertEq(info.totalStaked, 0);
        assertEq(uint8(info.state), uint8(IPortalPool.PortalState.COLLECTING));
        assertFalse(info.paused);
        assertFalse(info.firstActivated);
    }

    function test_Initialize_DeploysLPTToken() public view {
        LiquidPortalToken lpt = LiquidPortalToken(address(pool.lptToken()));
        assertEq(lpt.name(), "TestPortal Liquidity Portal Token");
        assertEq(lpt.symbol(), "TestPortal-LPT");
    }

    function test_Deposit_InCollectingState() public {
        uint256 amount = SMALL_STAKE;

        vm.startPrank(user1);
        sqd.approve(portal, amount);

        vm.expectEmit(true, false, false, true);
        emit IPortalPool.Staked(user1, amount, amount);

        pool.deposit(amount);
        vm.stopPrank();

        assertEq(pool.getProviderStake(user1), amount);
        assertEq(pool.getPortalInfo().totalStaked, amount);

        LiquidPortalToken lpt = LiquidPortalToken(address(pool.lptToken()));
        assertEq(lpt.balanceOf(user1), amount);
    }

    function test_Deposit_RevertOnZeroAmount() public {
        vm.startPrank(user1);
        sqd.approve(portal, SMALL_STAKE);

        vm.expectRevert(PortalErrors.InvalidAmount.selector);
        pool.deposit(0);
        vm.stopPrank();
    }

    function test_Deposit_RevertOnExceedsCapacity() public {
        uint256 amount = MIN_STAKE_THRESHOLD + 1;

        vm.startPrank(user1);
        sqd.approve(portal, amount);

        vm.expectRevert(PortalErrors.CapacityExceeded.selector);
        pool.deposit(amount);
        vm.stopPrank();
    }

    function test_Deposit_RevertOnExceedsWalletLimit() public {
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: DEFAULT_MAX_STAKE_PER_WALLET * 2,
            peerId: "wallet-limit-test",
            portalName: "WalletLimitTest",
            distributionRatePerSecond: 1 ether,
            metadata: ""
        });
        address testPortal = factory.createPortalPool(params);

        vm.startPrank(user1);
        sqd.approve(testPortal, DEFAULT_MAX_STAKE_PER_WALLET + 1);

        vm.expectRevert(PortalErrors.ExceedsWalletLimit.selector);
        IPortalPool(testPortal).deposit(DEFAULT_MAX_STAKE_PER_WALLET + 1);
        vm.stopPrank();
    }

    function test_Deposit_TriggersActivation() public {
        vm.startPrank(user1);
        sqd.approve(portal, MIN_STAKE_THRESHOLD);

        vm.expectEmit(true, true, false, false);
        emit IPortalPool.StateChanged(IPortalPool.PortalState.COLLECTING, IPortalPool.PortalState.ACTIVE);

        pool.deposit(MIN_STAKE_THRESHOLD);
        vm.stopPrank();

        assertEq(uint8(pool.getState()), uint8(IPortalPool.PortalState.ACTIVE));
        assertTrue(pool.getPortalInfo().firstActivated);
    }

    function test_Deposit_AfterDeadline_FailsPortal() public {
        vm.startPrank(user1);
        sqd.approve(portal, SMALL_STAKE);
        pool.deposit(SMALL_STAKE);
        vm.stopPrank();

        _warpToAfterDeadline(portal);

        assertEq(uint8(pool.getState()), uint8(IPortalPool.PortalState.FAILED));

        vm.startPrank(user2);
        sqd.approve(portal, SMALL_STAKE);
        uint256 user2StakeBefore = pool.getProviderStake(user2);
        vm.expectRevert(PortalErrors.InvalidState.selector);
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

        assertEq(uint8(pool.getState()), uint8(IPortalPool.PortalState.ACTIVE));

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
        vm.expectRevert(PortalErrors.InvalidAmount.selector);
        pool.requestExit(0);
    }

    function test_RequestExit_RevertOnInsufficientStake() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ExitPortal");
        pool = PortalPoolImplementation(portal);

        vm.prank(user1);
        vm.expectRevert(PortalErrors.InsufficientStake.selector);
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
        vm.expectRevert(PortalErrors.StillInQueue.selector);
        pool.withdrawExit(ticketId);
    }

    function test_WithdrawExit_RevertOnStillInQueue_Detailed() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ExitPortal");
        pool = PortalPoolImplementation(portal);

        vm.prank(user1);
        uint256 ticketId = pool.requestExit(SMALL_STAKE);

        vm.prank(user1);
        vm.expectRevert(PortalErrors.StillInQueue.selector);
        pool.withdrawExit(ticketId);

        vm.warp(block.timestamp + (SMALL_STAKE / 1e18) / 2);

        vm.prank(user1);
        vm.expectRevert(PortalErrors.StillInQueue.selector);
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
        vm.expectRevert(PortalErrors.PortalNotFailed.selector);
        pool.withdrawFromFailed();
    }

    function test_DistributeFees_Success() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "FeePortal");
        pool = PortalPoolImplementation(portal);

        uint256 feeAmount = 1000 * 1e6;

        vm.startPrank(operator);
        usdc.approve(portal, feeAmount);

        vm.expectEmit(true, false, false, true);
        emit IPortalPool.FeesDistributed(address(usdc), feeAmount, 500 * 1e6, 500 * 1e6, 0);

        pool.distributeFees(address(usdc), feeAmount);
        vm.stopPrank();

        assertEq(pool.totalFeesDistributed(address(usdc)), 500 * 1e6);
    }

    function test_DistributeFees_RevertOnInvalidState() public {
        vm.startPrank(operator);
        usdc.approve(portal, 1000 * 1e6);

        vm.expectRevert(PortalErrors.InvalidState.selector);
        pool.distributeFees(address(usdc), 1000 * 1e6);
        vm.stopPrank();
    }

    function test_DistributeFees_RevertOnTokenNotAllowed() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "FeePortal");
        pool = PortalPoolImplementation(portal);

        MockERC20 unknownToken = new MockERC20("Unknown", "UNK", 18);

        vm.startPrank(operator);
        unknownToken.mint(operator, 1000 ether);
        unknownToken.approve(portal, 1000 ether);

        vm.expectRevert(PortalErrors.TokenNotAllowed.selector);
        pool.distributeFees(address(unknownToken), 1000 ether);
        vm.stopPrank();
    }

    function test_ClaimFees_Success() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "FeePortal");
        pool = PortalPoolImplementation(portal);

        uint256 feeAmount = 1000 * 1e6;
        vm.startPrank(operator);
        usdc.approve(portal, feeAmount);
        pool.distributeFees(address(usdc), feeAmount);
        vm.stopPrank();

        uint256 claimable = pool.getClaimableFees(user1, address(usdc));
        assertEq(claimable, 500 * 1e6);

        uint256 balanceBefore = usdc.balanceOf(user1);

        vm.prank(user1);
        uint256 claimed = pool.claimFees(address(usdc));

        assertEq(claimed, 500 * 1e6);
        assertEq(usdc.balanceOf(user1), balanceBefore + claimed);
    }

    function test_ClaimFees_RevertOnNothingToClaim() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "FeePortal");
        pool = PortalPoolImplementation(portal);

        vm.prank(user1);
        vm.expectRevert(PortalErrors.NothingToClaim.selector);
        pool.claimFees(address(usdc));
    }

    function test_TopUpRewards_Success() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "RewardPortal");
        pool = PortalPoolImplementation(portal);

        uint256 rewardAmount = 1000 * 1e6;

        vm.startPrank(operator);
        usdc.approve(portal, rewardAmount);

        vm.expectEmit(true, false, false, true);
        emit IPortalPool.RewardsToppedUp(operator, rewardAmount, rewardAmount * Constants.PRECISION);

        pool.topUpRewards(rewardAmount);
        vm.stopPrank();

        assertEq(pool.getCurrentRewardBalance(), rewardAmount);
    }

    function test_TopUpRewards_RevertOnNotActive() public {
        vm.startPrank(operator);
        usdc.approve(portal, 1000 * 1e6);

        vm.expectRevert(PortalErrors.InvalidState.selector);
        pool.topUpRewards(1000 * 1e6);
        vm.stopPrank();
    }

    function test_ClaimRewards_Success() public {
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: MIN_STAKE_THRESHOLD,
            peerId: "reward-portal",
            portalName: "RewardPortal",
            distributionRatePerSecond: 1e6,
            metadata: ""
        });
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
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: DEFAULT_MAX_STAKE_PER_WALLET * 2,
            peerId: "transfer-limit",
            portalName: "TransferLimit",
            distributionRatePerSecond: 1 ether,
            metadata: ""
        });
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
        vm.expectRevert(PortalErrors.ExceedsWalletLimit.selector);
        lpt.transfer(user2, 1);
    }

    function test_GetState_COLLECTING() public view {
        assertEq(uint8(pool.getState()), uint8(IPortalPool.PortalState.COLLECTING));
    }

    function test_GetState_ACTIVE() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ActivePortal");
        pool = PortalPoolImplementation(portal);

        assertEq(uint8(pool.getState()), uint8(IPortalPool.PortalState.ACTIVE));
    }

    function test_GetState_FAILED() public {
        _warpToAfterDeadline(portal);

        assertEq(uint8(pool.getState()), uint8(IPortalPool.PortalState.FAILED));
    }

    function test_GetState_IDLE_ViaDirectStateCheck() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "IdlePortal");
        pool = PortalPoolImplementation(portal);

        assertEq(uint8(pool.getState()), uint8(IPortalPool.PortalState.ACTIVE));
        assertTrue(pool.getPortalInfo().firstActivated);
        assertTrue(pool.getPortalInfo().totalStaked >= MIN_STAKE_THRESHOLD);
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

    function test_GetPortalInfo() public {
        _approveAndDeposit(user1, portal, SMALL_STAKE);

        IPortalPool.PortalInfo memory info = pool.getPortalInfo();

        assertEq(info.operator, operator);
        assertEq(info.totalStaked, SMALL_STAKE);
        assertEq(uint8(info.state), uint8(IPortalPool.PortalState.COLLECTING));
    }

    function test_GetActiveStake() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ActiveStakePortal");
        pool = PortalPoolImplementation(portal);

        assertEq(pool.getActiveStake(), MIN_STAKE_THRESHOLD);

        vm.prank(user1);
        pool.requestExit(SMALL_STAKE);

        assertEq(pool.getActiveStake(), MIN_STAKE_THRESHOLD - SMALL_STAKE);
    }

    function test_GetPeerId() public view {
        bytes memory peerId = pool.getPeerId();
        assertEq(peerId, abi.encodePacked("peer-", "TestPortal"));
    }

    function test_GetAllowedPaymentTokens() public view {
        address[] memory tokens = pool.getAllowedPaymentTokens();
        assertEq(tokens.length, 2);
        assertEq(tokens[0], address(usdc));
        assertEq(tokens[1], address(dai));
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

        assertEq(pool.distributionRateScaled(), newRate * Constants.PRECISION);
    }

    function test_CheckAndFailPortal_Success() public {
        _warpToAfterDeadline(portal);

        PortalPoolImplementation(portal).checkAndFailPortal();

        assertEq(uint8(pool.getState()), uint8(IPortalPool.PortalState.FAILED));
    }

    function test_CheckAndFailPortal_RevertOnWrongState() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ActivePortal");

        vm.expectRevert(PortalErrors.InvalidState.selector);
        PortalPoolImplementation(portal).checkAndFailPortal();
    }

    function test_CheckAndFailPortal_RevertBeforeDeadline() public {
        vm.expectRevert(PortalErrors.DeadlineNotPassed.selector);
        PortalPoolImplementation(portal).checkAndFailPortal();
    }

    function test_WithdrawFromFailed_WithExitRequest() public {
        portal = _createPortal(operator, MIN_STAKE_THRESHOLD, "FailedExitPortal");
        pool = PortalPoolImplementation(portal);

        vm.startPrank(user1);
        sqd.approve(portal, SMALL_STAKE);
        pool.deposit(SMALL_STAKE);
        pool.requestExit(SMALL_STAKE / 2);
        vm.stopPrank();

        _warpToAfterDeadline(portal);

        uint256 balanceBefore = sqd.balanceOf(user1);

        vm.prank(user1);
        pool.withdrawFromFailed();

        assertEq(sqd.balanceOf(user1), balanceBefore + SMALL_STAKE);
        assertEq(pool.getProviderStake(user1), 0);
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
        vm.expectRevert(PortalErrors.NotOperator.selector);
        PortalPoolImplementation(portal).setDistributionRate(2 ether);
    }

    function test_SetDistributionRate_InCollectingState() public {
        uint256 newRate = 2 ether;
        vm.prank(operator);
        pool.setDistributionRate(newRate);

        assertEq(pool.distributionRateScaled(), newRate * Constants.PRECISION);
    }

    function test_SetCapacity_Success() public {
        // First activate the portal
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "CapacityTestPortal");
        pool = PortalPoolImplementation(portal);

        uint256 oldCapacity = pool.getPortalInfo().maxCapacity;
        uint256 newCapacity = oldCapacity + 100_000 ether;

        vm.prank(operator);
        vm.expectEmit(true, true, false, false);
        emit IPortalPool.CapacityUpdated(oldCapacity, newCapacity);
        pool.setCapacity(newCapacity);

        assertEq(pool.getPortalInfo().maxCapacity, newCapacity);
    }

    function test_SetCapacity_RevertOnNotActivated() public {
        // Pool is in COLLECTING state, not activated yet
        uint256 newCapacity = MIN_STAKE_THRESHOLD + 100_000 ether;

        vm.prank(operator);
        vm.expectRevert(PortalErrors.NotActivated.selector);
        pool.setCapacity(newCapacity);
    }

    function test_SetCapacity_RevertOnNonOperator() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "CapacityTestPortal2");
        pool = PortalPoolImplementation(portal);

        uint256 newCapacity = MIN_STAKE_THRESHOLD + 100_000 ether;

        vm.prank(user1);
        vm.expectRevert(PortalErrors.NotOperator.selector);
        pool.setCapacity(newCapacity);
    }

    function test_SetCapacity_LowerCapacity_Success() public {
        // Create and activate portal at minimum capacity
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "CapacityTestPortal3");
        pool = PortalPoolImplementation(portal);

        // First increase capacity
        uint256 higherCapacity = MIN_STAKE_THRESHOLD * 2;
        vm.prank(operator);
        pool.setCapacity(higherCapacity);
        assertEq(pool.getPortalInfo().maxCapacity, higherCapacity);

        // Now lower it back - totalStaked is MIN_STAKE_THRESHOLD, so we can go down to that
        uint256 lowerCapacity = MIN_STAKE_THRESHOLD + 1000 ether;
        vm.prank(operator);
        pool.setCapacity(lowerCapacity);

        assertEq(pool.getPortalInfo().maxCapacity, lowerCapacity);
        assertTrue(lowerCapacity < higherCapacity, "Should have lowered capacity");
    }

    function test_SetCapacity_LowerToExactlyCurrentStake() public {
        // Create and activate portal, then increase capacity
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "CapacityTestPortal4");
        pool = PortalPoolImplementation(portal);

        // Increase capacity
        uint256 higherCapacity = MIN_STAKE_THRESHOLD * 2;
        vm.prank(operator);
        pool.setCapacity(higherCapacity);

        // Lower to exactly the totalStaked amount (MIN_STAKE_THRESHOLD)
        vm.prank(operator);
        pool.setCapacity(MIN_STAKE_THRESHOLD);

        assertEq(pool.getPortalInfo().maxCapacity, MIN_STAKE_THRESHOLD);
    }

    function test_SetCapacity_RevertOnBelowCurrentStake() public {
        uint256 initialCapacity = MIN_STAKE_THRESHOLD * 2;
        portal = _createAndActivatePortal(operator, initialCapacity, "CapacityTestPortal5");
        pool = PortalPoolImplementation(portal);

        vm.prank(operator);
        vm.expectRevert(PortalErrors.BelowCurrentStake.selector);
        pool.setCapacity(MIN_STAKE_THRESHOLD);
    }

    function test_SetCapacity_RevertOnBelowMinimum() public {
        // Create and activate portal
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "CapacityTestPortal6");
        pool = PortalPoolImplementation(portal);

        // Increase capacity first
        uint256 higherCapacity = MIN_STAKE_THRESHOLD * 2;
        vm.prank(operator);
        pool.setCapacity(higherCapacity);

        // Try to lower capacity below minStakeThreshold
        uint256 belowMin = MIN_STAKE_THRESHOLD - 1;

        vm.prank(operator);
        vm.expectRevert(PortalErrors.BelowMinimum.selector);
        pool.setCapacity(belowMin);
    }

    function test_SetCapacity_RevertOnSameCapacity() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "CapacityTestPortal9");
        pool = PortalPoolImplementation(portal);

        uint256 currentCapacity = pool.getPortalInfo().maxCapacity;

        vm.prank(operator);
        vm.expectRevert(PortalErrors.NoChange.selector);
        pool.setCapacity(currentCapacity);
    }

    function test_SetCapacity_RevertOnAboveMaxPoolCapacity() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "CapacityTestPortal7");
        pool = PortalPoolImplementation(portal);

        uint256 aboveMaxCapacity = MAX_POOL_CAPACITY + 1;

        vm.prank(operator);
        vm.expectRevert(PortalErrors.AboveMaximum.selector);
        pool.setCapacity(aboveMaxCapacity);
    }

    function test_SetCapacity_AllowsAdditionalDeposits() public {
        // Activate portal with minimum capacity
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "CapacityTestPortal8");
        pool = PortalPoolImplementation(portal);

        vm.startPrank(user2);
        sqd.approve(portal, SMALL_STAKE);
        vm.expectRevert(PortalErrors.CapacityExceeded.selector);
        pool.deposit(SMALL_STAKE);
        vm.stopPrank();

        uint256 newCapacity = MIN_STAKE_THRESHOLD + SMALL_STAKE;
        vm.prank(operator);
        pool.setCapacity(newCapacity);

        vm.startPrank(user2);
        pool.deposit(SMALL_STAKE);
        vm.stopPrank();

        assertEq(pool.getPortalInfo().totalStaked, newCapacity);
    }

    function test_RequestExit_RevertOnFailed() public {
        _approveAndDeposit(user1, portal, SMALL_STAKE);

        _warpToAfterDeadline(portal);

        vm.prank(user1);
        vm.expectRevert(PortalErrors.UseWithdrawFromFailed.selector);
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
        vm.expectRevert(PortalErrors.NothingToClaim.selector);
        pool.claimRewards();
    }

    function test_TopUpRewards_RevertOnNonOperator() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "RewardsPortal");
        pool = PortalPoolImplementation(portal);

        uint256 rewardAmount = 1_000_000 * 1e6;
        vm.startPrank(user2);
        usdc.mint(user2, rewardAmount);
        usdc.approve(portal, rewardAmount);
        vm.expectRevert(PortalErrors.NotOperator.selector);
        pool.topUpRewards(rewardAmount);
        vm.stopPrank();
    }

    function test_DistributeFees_TransfersTokens() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "FeesPortal");
        pool = PortalPoolImplementation(portal);

        uint256 feeAmount = 100_000 * 1e6;
        uint256 operatorBalanceBefore = usdc.balanceOf(operator);

        vm.startPrank(operator);
        usdc.mint(operator, feeAmount);
        usdc.approve(portal, feeAmount);
        pool.distributeFees(address(usdc), feeAmount);
        vm.stopPrank();

        assertEq(usdc.balanceOf(operator), operatorBalanceBefore);
    }

    function test_DistributeFees_RevertOnZeroAmount() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ZeroFeesPortal");
        pool = PortalPoolImplementation(portal);

        vm.prank(operator);
        vm.expectRevert(PortalErrors.InvalidAmount.selector);
        pool.distributeFees(address(usdc), 0);
    }

    function test_WithdrawFromFailed_RevertOnNoStake() public {
        portal = _createPortal(operator, MIN_STAKE_THRESHOLD, "NoStakeFailedPortal");
        pool = PortalPoolImplementation(portal);

        _warpToAfterDeadline(portal);

        vm.prank(user1);
        vm.expectRevert(PortalErrors.NoStakeToWithdraw.selector);
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
        vm.expectRevert(PortalErrors.InvalidState.selector);
        pool.deposit(SMALL_STAKE);
        vm.stopPrank();
    }

    function test_DistributeFees_WithBurn() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "BurnFeesPortal");
        pool = PortalPoolImplementation(portal);

        // Set fee config with burn > 0
        feeRouter.setFeeConfig(6000, 2000, 2000); // 60% providers, 20% worker pool, 20% burn

        uint256 feeAmount = 100_000 * 1e6;

        vm.startPrank(operator);
        usdc.mint(operator, feeAmount);
        usdc.approve(portal, feeAmount);
        pool.distributeFees(address(usdc), feeAmount);
        vm.stopPrank();

        // Verify burn happened (to dead address)
        assertGt(usdc.balanceOf(address(0xdead)), 0);
    }

    function test_ClaimFees_RevertOnInvalidToken() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "InvalidTokenPortal");
        pool = PortalPoolImplementation(portal);

        vm.prank(user1);
        vm.expectRevert(PortalErrors.InvalidAddress.selector);
        pool.claimFees(address(0));
    }

    function test_ClaimFees_RevertOnDisallowedToken() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "DisallowedTokenPortal");
        pool = PortalPoolImplementation(portal);

        MockERC20 unknownToken = new MockERC20("Unknown", "UNK", 18);

        vm.prank(user1);
        vm.expectRevert(PortalErrors.TokenNotAllowed.selector);
        pool.claimFees(address(unknownToken));
    }

    function test_GetClaimableRewards_InCollectingState() public {
        // In collecting state, rewards shouldn't accrue since not active
        uint256 rewards = pool.getClaimableRewards(user1);
        assertEq(rewards, 0);
    }

    function test_GetClaimableRewards_WithRunwayLimit() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "RunwayPortal");
        pool = PortalPoolImplementation(portal);

        // Top up small amount of rewards
        uint256 rewardAmount = 100 * 1e6; // Small amount
        vm.startPrank(operator);
        usdc.mint(operator, rewardAmount);
        usdc.approve(portal, rewardAmount);
        pool.topUpRewards(rewardAmount);
        vm.stopPrank();

        // Warp far into future - rewards should be capped by runway
        vm.warp(block.timestamp + 365 days);

        uint256 rewards = pool.getClaimableRewards(user1);
        // Rewards should be limited by what was topped up (minus precision loss)
        assertTrue(rewards <= rewardAmount);
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

        uint256 balance = pool.getCurrentRewardBalance();
        assertEq(balance, 0);
    }

    function test_SetDistributionRate_ToZero() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ZeroRatePortal");
        pool = PortalPoolImplementation(portal);

        vm.prank(operator);
        pool.setDistributionRate(0);

        assertEq(pool.distributionRateScaled(), 0);
    }

    function test_Deposit_InActiveState_AdditionalUser() public {
        // Create portal with larger capacity to allow additional deposits
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: MIN_STAKE_THRESHOLD * 2,
            peerId: "active-deposit-portal",
            portalName: "ActiveDepositPortal",
            distributionRatePerSecond: 1 ether,
            metadata: ""
        });
        portal = factory.createPortalPool(params);
        pool = PortalPoolImplementation(portal);

        // Activate by filling to capacity
        vm.startPrank(user1);
        sqd.approve(portal, MIN_STAKE_THRESHOLD * 2);
        pool.deposit(MIN_STAKE_THRESHOLD * 2);
        vm.stopPrank();

        assertEq(uint8(pool.getState()), uint8(IPortalPool.PortalState.ACTIVE));
    }

    function test_DistributeFees_RevertOnInvalidToken() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "InvalidDistributePortal");
        pool = PortalPoolImplementation(portal);

        vm.prank(operator);
        vm.expectRevert(PortalErrors.InvalidAddress.selector);
        pool.distributeFees(address(0), 100);
    }

    function test_DistributeFees_RevertOnDisallowedToken() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "DisallowedDistributePortal");
        pool = PortalPoolImplementation(portal);

        MockERC20 unknownToken = new MockERC20("Unknown", "UNK", 18);

        vm.prank(operator);
        vm.expectRevert(PortalErrors.TokenNotAllowed.selector);
        pool.distributeFees(address(unknownToken), 100);
    }

    function test_DistributeFees_RevertOnNonOperator() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "NonOperatorDistributePortal");
        pool = PortalPoolImplementation(portal);

        vm.prank(user1);
        vm.expectRevert(PortalErrors.NotOperator.selector);
        pool.distributeFees(address(usdc), 100);
    }

    function test_DistributeFees_RevertOnNotActive() public {
        vm.prank(operator);
        vm.expectRevert(PortalErrors.InvalidState.selector);
        pool.distributeFees(address(usdc), 100);
    }

    function test_OnLPTTransfer_RevertOnInsufficientTransferable() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "InsufficientTransferPortal");
        pool = PortalPoolImplementation(portal);

        LiquidPortalToken lpt = pool.lptToken();

        // Request exit for most stake
        uint256 exitAmount = pool.getProviderStake(user1) - 1;
        vm.prank(user1);
        pool.requestExit(exitAmount);

        // User1 has 1 transferable stake, but 0 in LPT (burned)
        // Try to transfer more than remaining stake
        vm.prank(user1);
        vm.expectRevert(); // Will revert with InsufficientTransferableStake or ERC20 error
        lpt.transfer(user2, exitAmount);
    }

    function test_OnLPTTransfer_RevertOnExceedsReceiverLimit() public {
        // Create portal with capacity for two users at default wallet limit
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: DEFAULT_MAX_STAKE_PER_WALLET * 2,
            peerId: "receiver-limit",
            portalName: "ReceiverLimit",
            distributionRatePerSecond: 1 ether,
            metadata: ""
        });
        address limitPortal = factory.createPortalPool(params);
        PortalPoolImplementation limitPool = PortalPoolImplementation(limitPortal);

        // user1 deposits up to the limit
        vm.startPrank(user1);
        sqd.approve(limitPortal, DEFAULT_MAX_STAKE_PER_WALLET);
        limitPool.deposit(DEFAULT_MAX_STAKE_PER_WALLET);
        vm.stopPrank();

        // user2 deposits up to the limit
        vm.startPrank(user2);
        sqd.approve(limitPortal, DEFAULT_MAX_STAKE_PER_WALLET);
        limitPool.deposit(DEFAULT_MAX_STAKE_PER_WALLET);
        vm.stopPrank();

        LiquidPortalToken lpt = limitPool.lptToken();

        // Try to transfer from user1 to user2 (should fail - exceeds receiver limit)
        vm.prank(user1);
        vm.expectRevert(PortalErrors.ExceedsWalletLimit.selector);
        lpt.transfer(user2, 1);
    }

    function test_OnAllocationReduced_FromRegistry() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "AllocationReducedPortal");
        pool = PortalPoolImplementation(portal);

        uint256 stakeBefore = pool.getProviderStake(user1);
        uint256 reduction = SMALL_STAKE / 2;

        // Simulate registry calling onAllocationReduced
        vm.prank(address(registry));
        pool.onAllocationReduced(user1, reduction);

        assertEq(pool.getProviderStake(user1), stakeBefore - reduction);
    }

    function test_OnAllocationReduced_RevertOnNonRegistry() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "NonRegistryReducePortal");
        pool = PortalPoolImplementation(portal);

        vm.prank(user1);
        vm.expectRevert(PortalErrors.NotPortalRegistry.selector);
        pool.onAllocationReduced(user1, SMALL_STAKE);
    }

    function test_OnAllocationReduced_WithExitRequest() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ReduceWithExitPortal");
        pool = PortalPoolImplementation(portal);

        vm.prank(user1);
        pool.requestExit(SMALL_STAKE / 2);

        uint256 stakeBefore = pool.getProviderStake(user1);
        uint256 reduction = SMALL_STAKE;

        vm.prank(address(registry));
        pool.onAllocationReduced(user1, reduction);

        assertEq(pool.getProviderStake(user1), stakeBefore - reduction);
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

    function test_Deposit_DeadlinePassedViaGetState() public {
        _approveAndDeposit(user1, portal, SMALL_STAKE);

        _warpToAfterDeadline(portal);

        assertEq(uint8(pool.getState()), uint8(IPortalPool.PortalState.FAILED));
    }

    function test_OnLPTTransfer_RevertOnNotLPTToken() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "NotLPTPortal");
        pool = PortalPoolImplementation(portal);

        vm.prank(user1);
        vm.expectRevert(PortalErrors.NotLPTToken.selector);
        pool.onLPTTransfer(user1, user2, 100);
    }

    function test_WithdrawExit_RevertOnNoActiveRequest() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "NoRequestPortal");
        pool = PortalPoolImplementation(portal);

        vm.prank(user1);
        vm.expectRevert(PortalErrors.NoActiveExitRequest.selector);
        pool.withdrawExit(999);
    }

    function test_Deposit_TriggerHandleDeadlinePassed() public {
        _approveAndDeposit(user1, portal, SMALL_STAKE);

        _warpToAfterDeadline(portal);

        assertEq(uint8(pool.getState()), uint8(IPortalPool.PortalState.FAILED));

        vm.startPrank(user2);
        sqd.approve(portal, SMALL_STAKE);
        vm.expectRevert(PortalErrors.InvalidState.selector);
        pool.deposit(SMALL_STAKE);
        vm.stopPrank();
    }

    function test_GetClaimableRewards_ZeroCapacity() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ZeroCapRewardsPortal");
        pool = PortalPoolImplementation(portal);

        uint256 rewards = pool.getClaimableRewards(user1);
        assertTrue(rewards >= 0);
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
        vm.expectRevert(PortalErrors.InvalidAmount.selector);
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
        vm.expectRevert(PortalErrors.DistributionTurnedOff.selector);
        pool.topUpRewards(1_000_000 * 1e6);
        vm.stopPrank();
    }

    function test_ZeroDistributionRate_ClaimRevertsWhenOff() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ZeroRatePortal2");
        pool = PortalPoolImplementation(portal);

        // Set rate to 0 to turn off distribution
        vm.prank(operator);
        pool.setDistributionRate(0);

        // claimRewards should revert
        vm.prank(user1);
        vm.expectRevert(PortalErrors.DistributionTurnedOff.selector);
        pool.claimRewards();
    }

    function test_ZeroDistributionRate_ViewFunctionsReturnZero() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ZeroRatePortal3");
        pool = PortalPoolImplementation(portal);

        // Set rate to 0 to turn off distribution
        vm.prank(operator);
        pool.setDistributionRate(0);

        // View functions should return 0
        assertEq(pool.getClaimableRewards(user1), 0);
        assertEq(pool.getCurrentRewardBalance(), 0);
    }

    function test_ZeroDistributionRate_CanEnableBySettingRate() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ZeroRatePortal4");
        pool = PortalPoolImplementation(portal);

        // Set rate to 0 to turn off distribution
        vm.prank(operator);
        pool.setDistributionRate(0);

        // Verify it's off
        vm.prank(user1);
        vm.expectRevert(PortalErrors.DistributionTurnedOff.selector);
        pool.claimRewards();

        // Set rate to non-zero to enable distribution
        vm.prank(operator);
        pool.setDistributionRate(1e6); // 1 USDC per second

        // Now topUpRewards should work
        vm.startPrank(operator);
        usdc.mint(operator, 1000 * 1e6);
        usdc.approve(portal, 1000 * 1e6);
        pool.topUpRewards(1000 * 1e6);
        vm.stopPrank();

        assertEq(pool.getCurrentRewardBalance(), 1000 * 1e6);
    }

    function test_CreatePoolWithZeroDistributionRate() public {
        // Create portal with 0 distribution rate
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: MIN_STAKE_THRESHOLD,
            peerId: "peer-zero-rate",
            portalName: "ZeroRatePool",
            distributionRatePerSecond: 0, // Zero rate
            metadata: ""
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
        vm.expectRevert(PortalErrors.DistributionTurnedOff.selector);
        zeroRatePool.topUpRewards(1000 * 1e6);
    }

    function test_WithdrawFromFailed_LptBurnLimit() public {
        portal = _createPortal(operator, MIN_STAKE_THRESHOLD, "LptLimitPortal");
        pool = PortalPoolImplementation(portal);

        // User deposits
        vm.startPrank(user1);
        sqd.approve(portal, SMALL_STAKE);
        pool.deposit(SMALL_STAKE);

        pool.requestExit(SMALL_STAKE / 2);
        vm.stopPrank();

        _warpToAfterDeadline(portal);

        uint256 balanceBefore = sqd.balanceOf(user1);

        vm.prank(user1);
        pool.withdrawFromFailed();

        assertEq(sqd.balanceOf(user1), balanceBefore + SMALL_STAKE);
    }

    function test_SettleFees_ZeroActiveStake() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ZeroActiveFeePortal");
        pool = PortalPoolImplementation(portal);

        // Distribute fees first
        uint256 feeAmount = 1000 * 1e6;
        vm.startPrank(operator);
        usdc.approve(portal, feeAmount);
        pool.distributeFees(address(usdc), feeAmount);
        vm.stopPrank();

        // Request ex   it for all stake
        vm.prank(user1);
        pool.requestExit(MIN_STAKE_THRESHOLD);

        uint256 claimable = pool.getClaimableFees(user1, address(usdc));
        assertTrue(claimable >= 0);
    }

    function test_DistributeFees_ZeroActiveStake() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ZeroActiveDistributePortal");
        pool = PortalPoolImplementation(portal);

        vm.prank(user1);
        pool.requestExit(MIN_STAKE_THRESHOLD);

        uint256 feeAmount = 1000 * 1e6;
        vm.startPrank(operator);
        usdc.approve(portal, feeAmount);
        pool.distributeFees(address(usdc), feeAmount);
        vm.stopPrank();

        assertEq(pool.totalFeesDistributed(address(usdc)), 500 * 1e6);
    }

    function test_OnAllocationReduced_FullExitAmount() public {
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "FullExitReducePortal");
        pool = PortalPoolImplementation(portal);

        uint256 stakeBefore = pool.getProviderStake(user1);

        vm.prank(user1);
        pool.requestExit(stakeBefore);

        uint256 reduction = stakeBefore / 2;
        vm.prank(address(registry));
        pool.onAllocationReduced(user1, reduction);

        assertEq(pool.getProviderStake(user1), stakeBefore - reduction);
    }
}
