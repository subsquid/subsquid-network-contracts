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
        IPortalFactory.CreatePortalParams memory params = IPortalFactory.CreatePortalParams({
            operator: operator,
            maxCapacity: 1_000_000 ether,
            peerId: "small-wallet-limit",
            portalName: "SmallLimit",
            distributionRatePerSecond: 1 ether,
            maxStakePerWallet: SMALL_STAKE
        });
        address smallLimitPortal = factory.createPortal(params);

        vm.startPrank(user1);
        sqd.approve(smallLimitPortal, SMALL_STAKE + 1);

        vm.expectRevert(PortalErrors.ExceedsWalletLimit.selector);
        IPortalPool(smallLimitPortal).deposit(SMALL_STAKE + 1);
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

        (uint256 processed, uint256 userEndPos, uint256 secondsRemaining, bool ready) = pool.getQueueStatus(user1, ticketId);
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
        IPortalFactory.CreatePortalParams memory params = IPortalFactory.CreatePortalParams({
            operator: operator,
            maxCapacity: MIN_STAKE_THRESHOLD,
            peerId: "reward-portal",
            portalName: "RewardPortal",
            distributionRatePerSecond: 1e6,
            maxStakePerWallet: DEFAULT_MAX_STAKE_PER_WALLET
        });
        portal = factory.createPortal(params);
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
        IPortalFactory.CreatePortalParams memory params = IPortalFactory.CreatePortalParams({
            operator: operator,
            maxCapacity: MIN_STAKE_THRESHOLD,
            peerId: "transfer-limit",
            portalName: "TransferLimit",
            distributionRatePerSecond: 1 ether,
            maxStakePerWallet: SMALL_STAKE
        });
        address limitPortal = factory.createPortal(params);

        vm.startPrank(user1);
        sqd.approve(limitPortal, MIN_STAKE_THRESHOLD);
        IPortalPool(limitPortal).deposit(SMALL_STAKE);
        vm.stopPrank();

        vm.startPrank(user2);
        sqd.approve(limitPortal, MIN_STAKE_THRESHOLD);
        IPortalPool(limitPortal).deposit(SMALL_STAKE);
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
}
