// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {PortalPool} from "../src/PortalPool.sol";
import {PortalFactory} from "../src/PortalFactory.sol";
import {GatewayRegistry} from "../src/GatewayRegistry.sol";
import {FeeRouterModule} from "../src/FeeRouterModule.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {Errors} from "../src/libs/Errors.sol";

contract PortalPoolTest is Test {
    PortalFactory public factory;
    PortalPool public pool;
    GatewayRegistry public gatewayRegistry;
    FeeRouterModule public feeRouter;
    MockERC20 public sqdToken;
    MockERC20 public usdcToken;

    address public owner;
    address public consumer;
    address public provider1;
    address public provider2;
    address public workerPool;

    uint256 constant MIN_STAKE = 1_000_000e18;
    uint256 constant TARGET_SQD = 10_000_000e18;
    uint256 constant BUDGET = 10_000e6;

    function setUp() public {
        owner = address(this);
        consumer = makeAddr("consumer");
        provider1 = makeAddr("provider1");
        provider2 = makeAddr("provider2");
        workerPool = makeAddr("workerPool");

        sqdToken = new MockERC20("SQD Token", "SQD", 18);
        usdcToken = new MockERC20("USDC", "USDC", 6);

        gatewayRegistry = new GatewayRegistry(address(sqdToken), address(this));
        feeRouter = new FeeRouterModule(5000, 5000, workerPool);

        address[] memory supportedTokens = new address[](1);
        supportedTokens[0] = address(usdcToken);

        factory = new PortalFactory(supportedTokens, address(sqdToken), address(feeRouter), address(gatewayRegistry));

        gatewayRegistry.setPortalFactory(address(factory));

        sqdToken.mint(provider1, 100_000_000e18);
        sqdToken.mint(provider2, 100_000_000e18);
        usdcToken.mint(consumer, 1_000_000e6);

        vm.startPrank(provider1);
        sqdToken.approve(address(factory), type(uint256).max);
        vm.stopPrank();

        vm.startPrank(provider2);
        sqdToken.approve(address(factory), type(uint256).max);
        vm.stopPrank();

        vm.startPrank(consumer);
        usdcToken.approve(address(factory), type(uint256).max);
        address portalAddr = factory.createPortal(
            consumer, TARGET_SQD, MIN_STAKE, uint64(block.timestamp + 7 days), address(usdcToken), BUDGET
        );
        usdcToken.approve(portalAddr, type(uint256).max);
        vm.stopPrank();

        pool = PortalPool(portalAddr);

        vm.prank(provider1);
        sqdToken.approve(address(pool), type(uint256).max);

        vm.prank(provider2);
        sqdToken.approve(address(pool), type(uint256).max);
    }

    function testInitialState() public view {
        assertEq(uint8(pool.state()), uint8(PortalPool.State.Collecting));
        assertEq(pool.budget(), BUDGET);
        assertEq(pool.targetSQD(), TARGET_SQD);
        assertEq(pool.minimumSQD(), MIN_STAKE);
    }

    function testDepositSQD() public {
        uint256 amount = 2_000_000e18;

        vm.prank(provider1);
        pool.depositSQD(amount);

        assertEq(pool.activeBalances(provider1), amount);
        assertEq(pool.totalActiveSQD(), amount);
    }

    function testDepositSQDZeroAmount() public {
        vm.prank(provider1);
        vm.expectRevert(Errors.ZeroAmount.selector);
        pool.depositSQD(0);
    }

    function testDepositSQDBelowMinimum() public {
        vm.prank(provider1);
        vm.expectRevert(Errors.BelowMinimumDeposit.selector);
        pool.depositSQD(1e18 - 1);
    }

    function testDepositSQDExceedsWhaleLimit() public {
        uint256 whaleAmount = (TARGET_SQD * 2000 / 10000) + 1;

        vm.prank(provider1);
        vm.expectRevert(Errors.ExceedsMaximumDeposit.selector);
        pool.depositSQD(whaleAmount);
    }

    function testActivateManually() public {
        vm.prank(provider1);
        pool.depositSQD(MIN_STAKE);

        assertEq(uint8(pool.state()), uint8(PortalPool.State.Active));
        assertGt(pool.activatedAt(), 0);
    }

    function testActivateAutomatically() public {
        vm.prank(provider1);
        pool.depositSQD(MIN_STAKE);

        assertEq(uint8(pool.state()), uint8(PortalPool.State.Active));
    }

    function testActivateBeforeMinimum() public {
        vm.prank(provider1);
        pool.depositSQD(MIN_STAKE / 2);

        vm.expectRevert(Errors.TargetNotMet.selector);
        pool.activate();
    }

    function testActivateAfterDeadline() public {
        vm.warp(block.timestamp + 8 days);

        vm.expectRevert(Errors.PastDeadline.selector);
        pool.activate();
    }

    function testMarkFailed() public {
        vm.warp(block.timestamp + 8 days);

        pool.markFailed();

        assertEq(uint8(pool.state()), uint8(PortalPool.State.Failed));
    }

    function testMarkFailedBeforeDeadline() public {
        vm.expectRevert(Errors.DeadlineNotReached.selector);
        pool.markFailed();
    }

    function testMarkFailedWhenTargetMet() public {
        vm.prank(provider1);
        pool.depositSQD(MIN_STAKE);

        vm.warp(block.timestamp + 8 days);

        vm.expectRevert(Errors.InvalidState.selector);
        pool.markFailed();
    }

    function testDistribute() public {
        vm.prank(provider1);
        pool.depositSQD(MIN_STAKE);

        uint256 distributionAmount = 1000e6;

        vm.prank(consumer);
        pool.distribute(distributionAmount);

        assertEq(pool.totalRewardsDistributed(), 500e6);
    }

    function testDistributeZeroAmount() public {
        vm.prank(provider1);
        pool.depositSQD(MIN_STAKE);

        vm.prank(consumer);
        vm.expectRevert(Errors.ZeroAmount.selector);
        pool.distribute(0);
    }

    function testDistributeOnlyConsumer() public {
        vm.prank(provider1);
        pool.depositSQD(MIN_STAKE);

        vm.prank(provider1);
        vm.expectRevert(Errors.NotConsumer.selector);
        pool.distribute(1000e6);
    }

    function testClaimRewards() public {
        vm.prank(provider1);
        pool.depositSQD(MIN_STAKE);

        vm.prank(consumer);
        pool.distribute(1000e6);

        uint256 balanceBefore = usdcToken.balanceOf(provider1);

        vm.prank(provider1);
        uint256 claimed = pool.claimRewards();

        uint256 balanceAfter = usdcToken.balanceOf(provider1);

        assertEq(balanceAfter - balanceBefore, claimed);
        assertGt(claimed, 0);
    }

    function testClaimRewardsNothingToClaim() public {
        vm.prank(provider1);
        pool.depositSQD(MIN_STAKE);

        vm.prank(provider1);
        vm.expectRevert(Errors.NothingToClaim.selector);
        pool.claimRewards();
    }

    function testPendingRewards() public {
        vm.prank(provider1);
        pool.depositSQD(MIN_STAKE);

        vm.prank(consumer);
        pool.distribute(1000e6);

        uint256 pending = pool.pendingRewards(provider1);
        assertEq(pending, 500e6);
    }

    function testPendingRewardsMultipleProviders() public {
        vm.startPrank(provider1);
        pool.depositSQD(MIN_STAKE / 4);
        vm.stopPrank();

        vm.startPrank(provider2);
        pool.depositSQD(MIN_STAKE / 4);
        vm.stopPrank();

        pool.activate();

        vm.prank(consumer);
        pool.distribute(1000e6);

        uint256 pending1 = pool.pendingRewards(provider1);
        uint256 pending2 = pool.pendingRewards(provider2);

        assertEq(pending1, 250e6);
        assertEq(pending2, 250e6);
    }

    function testRequestExit() public {
        vm.prank(provider1);
        pool.depositSQD(1_500_000e18);

        uint256 exitAmount = 100_000e18;

        vm.prank(provider1);
        pool.requestExit(exitAmount);

        assertEq(pool.activeBalances(provider1), 1_400_000e18);
        assertEq(pool.exitingBalances(provider1), exitAmount);
        assertEq(pool.totalExitingSQD(), exitAmount);
    }

    function testRequestExitZeroAmount() public {
        vm.prank(provider1);
        pool.depositSQD(MIN_STAKE);

        vm.prank(provider1);
        vm.expectRevert(Errors.ZeroAmount.selector);
        pool.requestExit(0);
    }

    function testRequestExitInsufficientBalance() public {
        vm.prank(provider1);
        pool.depositSQD(MIN_STAKE);

        vm.prank(provider1);
        vm.expectRevert(Errors.InsufficientBalance.selector);
        pool.requestExit(MIN_STAKE + 1);
    }

    function testRequestExitCreatesTicket() public {
        vm.prank(provider1);
        pool.depositSQD(MIN_STAKE * 2);

        vm.prank(provider1);
        pool.requestExit(MIN_STAKE / 2);

        uint256 ticketId = 1;
        (address owner,, uint64 unlockTime, bool fulfilled) = pool.getTicket(ticketId);
        assertEq(owner, provider1);
        assertFalse(fulfilled);
        assertGt(unlockTime, 0);
    }

    function testProcessExits() public {
        vm.prank(provider1);
        pool.depositSQD(MIN_STAKE * 2);

        uint256 exitAmount = MIN_STAKE / 2;

        vm.prank(provider1);
        pool.requestExit(exitAmount);

        (,, uint64 unlockTimestamp,) = pool.getTicket(1);

        vm.warp(unlockTimestamp + 1);

        uint256 balanceBefore = sqdToken.balanceOf(provider1);

        pool.processExits(1);

        uint256 balanceAfter = sqdToken.balanceOf(provider1);

        assertEq(balanceAfter - balanceBefore, exitAmount);
    }

    function testProcessExitsBeforeUnlock() public {
        vm.prank(provider1);
        pool.depositSQD(MIN_STAKE * 2);

        vm.prank(provider1);
        pool.requestExit(MIN_STAKE / 2);

        pool.processExits(1);

        assertEq(pool.getExitQueueLength(), 1);
    }

    function testProcessExitsZeroAmount() public {
        vm.expectRevert(Errors.ZeroAmount.selector);
        pool.processExits(0);
    }

    function testRefundOnFailure() public {
        vm.prank(provider1);
        pool.depositSQD(MIN_STAKE / 2);

        vm.warp(block.timestamp + 8 days);

        pool.markFailed();

        uint256 balanceBefore = sqdToken.balanceOf(provider1);

        vm.prank(provider1);
        pool.refundOnFailure();

        uint256 balanceAfter = sqdToken.balanceOf(provider1);

        assertEq(balanceAfter - balanceBefore, MIN_STAKE / 2);
    }

    function testRefundConsumerOnFailure() public {
        vm.warp(block.timestamp + 8 days);

        pool.markFailed();

        uint256 balanceBefore = usdcToken.balanceOf(consumer);

        vm.prank(consumer);
        pool.refundConsumerOnFailure();

        uint256 balanceAfter = usdcToken.balanceOf(consumer);

        assertEq(balanceAfter - balanceBefore, BUDGET);
    }

    function testGetCurrentEpoch() public view {
        uint256 epoch = pool.getCurrentEpoch();
        assertEq(epoch, block.number / 7200);
    }

    function testGetExitQueueLength() public {
        vm.prank(provider1);
        pool.depositSQD(MIN_STAKE * 2);

        vm.prank(provider1);
        pool.requestExit(MIN_STAKE / 4);

        vm.prank(provider1);
        pool.requestExit(MIN_STAKE / 4);

        assertEq(pool.getExitQueueLength(), 2);
    }

    function testPauseUnpause() public {
        factory.pausePortal(address(pool));
        assertTrue(pool.paused());

        factory.unpausePortal(address(pool));
        assertFalse(pool.paused());
    }

    function testDepositSQDWhenPaused() public {
        factory.pausePortal(address(pool));

        vm.prank(provider1);
        vm.expectRevert();
        pool.depositSQD(MIN_STAKE);
    }

    function testMinimumThresholdAutoClose() public {
        vm.prank(provider1);
        pool.depositSQD(MIN_STAKE + 100e18);

        vm.prank(provider1);
        pool.requestExit(200e18);

        assertEq(uint8(pool.state()), uint8(PortalPool.State.Closed));
    }

    function testMultipleDistributions() public {
        vm.prank(provider1);
        pool.depositSQD(MIN_STAKE);

        vm.startPrank(consumer);
        pool.distribute(1000e6);
        pool.distribute(500e6);
        pool.distribute(250e6);
        vm.stopPrank();

        uint256 expectedTotal = (1000e6 + 500e6 + 250e6) / 2;
        assertEq(pool.totalRewardsDistributed(), expectedTotal);
    }


    function testFuzzDepositSQD(uint256 amount) public {
        vm.assume(amount >= 1e18 && amount <= (TARGET_SQD * 2000 / 10000));

        vm.prank(provider1);
        pool.depositSQD(amount);

        assertEq(pool.activeBalances(provider1), amount);
    }

    function testFuzzDistribute(uint256 amount) public {
        vm.assume(amount > 0 && amount <= 100_000e6);

        usdcToken.mint(consumer, amount);

        vm.prank(provider1);
        pool.depositSQD(MIN_STAKE);

        vm.prank(consumer);
        pool.distribute(amount);

        assertEq(pool.totalRewardsDistributed(), amount / 2);
    }

    function testProportionalRewards() public {
        vm.prank(provider1);
        pool.depositSQD(600_000e18);

        vm.prank(provider2);
        pool.depositSQD(400_000e18);

        vm.prank(consumer);
        pool.distribute(1000e6);

        uint256 pending1 = pool.pendingRewards(provider1);
        uint256 pending2 = pool.pendingRewards(provider2);

        assertEq(pending1, 300e6);
        assertEq(pending2, 200e6);
    }
}
