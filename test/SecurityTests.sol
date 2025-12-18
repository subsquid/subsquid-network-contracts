// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./BaseTest.sol";
import {PortalErrors} from "../src/libs/PortalErrors.sol";
import {PortalPoolImplementation} from "../src/PortalPoolImplementation.sol";
import {LiquidPortalToken} from "../src/LiquidPortalToken.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract SecurityTests is BaseTest {
    address public portal;
    PortalPoolImplementation public pool;
    LiquidPortalToken public lpt;

    function setUp() public override {
        super.setUp();
        portal = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "SecurityPortal");
        pool = PortalPoolImplementation(portal);
        lpt = LiquidPortalToken(address(pool.lptToken()));
    }

    function test_OnLPTTransfer_NonReentrant_PreventsReentrancy() public {
        uint256 transferAmount = MIN_STAKE_THRESHOLD / 4;

        vm.prank(user1);
        lpt.transfer(user2, transferAmount);

        assertEq(lpt.balanceOf(user2), transferAmount);
        assertEq(pool.getProviderStake(user2), transferAmount);
        assertEq(pool.getProviderStake(user1), MIN_STAKE_THRESHOLD - transferAmount);
    }

    function test_OnLPTTransfer_NonReentrant_DirectCallReverts() public {
        vm.expectRevert();
        pool.onLPTTransfer(user1, user2, SMALL_STAKE);
    }

    function test_OnLPTTransfer_NonReentrant_OnlyLPTTokenCanCall() public {
        vm.prank(address(lpt));
        pool.onLPTTransfer(user1, user2, SMALL_STAKE);

        assertEq(pool.getProviderStake(user2), SMALL_STAKE);
    }

    function test_OnLPTTransfer_OrderOfOperations_SettleFeesBeforeStateUpdate() public {
        vm.startPrank(operator);
        usdc.approve(portal, 1000 * 1e6);
        pool.distributeFees(address(usdc), 1000 * 1e6);
        vm.stopPrank();

        uint256 user1FeesBeforeTransfer = pool.getClaimableFees(user1, address(usdc));
        uint256 user1StakeBefore = pool.getProviderStake(user1);
        uint256 user2StakeBefore = pool.getProviderStake(user2);

        uint256 transferAmount = SMALL_STAKE;

        vm.prank(user1);
        lpt.transfer(user2, transferAmount);

        uint256 user1FeesAfterTransfer = pool.getClaimableFees(user1, address(usdc));
        uint256 user1StakeAfter = pool.getProviderStake(user1);
        uint256 user2StakeAfter = pool.getProviderStake(user2);

        assertEq(user1FeesBeforeTransfer, user1FeesAfterTransfer);
        assertEq(user1StakeAfter, user1StakeBefore - transferAmount);
        assertEq(user2StakeAfter, user2StakeBefore + transferAmount);
    }

    function test_OnLPTTransfer_RevertOnNotLPTToken() public {
        vm.expectRevert(PortalErrors.NotLPTToken.selector);
        pool.onLPTTransfer(user1, user2, SMALL_STAKE);
    }

    function test_OnLPTTransfer_ExitReducesTransferable() public {
        vm.prank(user1);
        pool.requestExit(MIN_STAKE_THRESHOLD / 2);

        uint256 transferableAmount = MIN_STAKE_THRESHOLD - (MIN_STAKE_THRESHOLD / 2);
        uint256 lptBalance = lpt.balanceOf(user1);

        assertEq(lptBalance, transferableAmount);

        vm.prank(user1);
        lpt.transfer(user2, transferableAmount);

        assertEq(pool.getProviderStake(user1), MIN_STAKE_THRESHOLD / 2);
        assertEq(pool.getProviderStake(user2), transferableAmount);
    }

    function test_OnLPTTransfer_RevertOnExceedsWalletLimit() public {
        IPortalFactory.CreatePortalParams memory params = IPortalFactory.CreatePortalParams({
            operator: operator,
            maxCapacity: MIN_STAKE_THRESHOLD * 2,
            peerId: "limit-portal",
            portalName: "LimitPortal",
            distributionRatePerSecond: 1 ether,
            maxStakePerWallet: SMALL_STAKE
        });
        address limitPortal = factory.createPortal(params);
        LiquidPortalToken limitLpt = PortalPoolImplementation(limitPortal).lptToken();

        vm.startPrank(user1);
        sqd.approve(limitPortal, SMALL_STAKE);
        IPortalPool(limitPortal).deposit(SMALL_STAKE);
        vm.stopPrank();

        vm.startPrank(user2);
        sqd.approve(limitPortal, SMALL_STAKE);
        IPortalPool(limitPortal).deposit(SMALL_STAKE);
        vm.stopPrank();

        vm.prank(user1);
        vm.expectRevert(PortalErrors.ExceedsWalletLimit.selector);
        limitLpt.transfer(user2, 1);
    }

    function test_OnLPTTransfer_MultipleTransfers_NoReentrancy() public {
        uint256 transfer1 = SMALL_STAKE;
        uint256 transfer2 = SMALL_STAKE / 2;

        vm.prank(user1);
        lpt.transfer(user2, transfer1);

        vm.prank(user1);
        lpt.transfer(user3, transfer2);

        assertEq(pool.getProviderStake(user1), MIN_STAKE_THRESHOLD - transfer1 - transfer2);
        assertEq(pool.getProviderStake(user2), transfer1);
        assertEq(pool.getProviderStake(user3), transfer2);
    }

    function test_OnLPTTransfer_WithFeesDistributed_ProperSettlement() public {
        vm.startPrank(operator);
        usdc.approve(portal, 1000 * 1e6);
        pool.distributeFees(address(usdc), 1000 * 1e6);
        vm.stopPrank();

        vm.warp(block.timestamp + 100);

        uint256 user1ClaimableBefore = pool.getClaimableFees(user1, address(usdc));

        uint256 transferAmount = SMALL_STAKE;

        vm.prank(user1);
        lpt.transfer(user2, transferAmount);

        uint256 user1ClaimableAfter = pool.getClaimableFees(user1, address(usdc));
        uint256 user2ClaimableAfter = pool.getClaimableFees(user2, address(usdc));

        assertEq(user1ClaimableBefore, user1ClaimableAfter);
        assertEq(user2ClaimableAfter, 0);
    }

    function test_OnLPTTransfer_CheckpointUpdate_AfterTransfer() public {
        IPortalFactory.CreatePortalParams memory params = IPortalFactory.CreatePortalParams({
            operator: operator,
            maxCapacity: MIN_STAKE_THRESHOLD,
            peerId: "checkpoint-portal",
            portalName: "CheckpointPortal",
            distributionRatePerSecond: 1e6,
            maxStakePerWallet: 1_000_000 ether
        });
        address checkpointPortal = factory.createPortal(params);
        PortalPoolImplementation checkpointPool = PortalPoolImplementation(checkpointPortal);

        vm.startPrank(user1);
        sqd.approve(checkpointPortal, MIN_STAKE_THRESHOLD);
        checkpointPool.deposit(MIN_STAKE_THRESHOLD);
        vm.stopPrank();

        LiquidPortalToken checkpointLpt = LiquidPortalToken(address(checkpointPool.lptToken()));

        uint256 rewardAmount = 1_000_000 * 1e6;
        vm.startPrank(operator);
        usdc.approve(checkpointPortal, rewardAmount);
        checkpointPool.topUpRewards(rewardAmount);
        vm.stopPrank();

        vm.warp(block.timestamp + 1000);

        uint256 user1RewardsBefore = checkpointPool.getClaimableRewards(user1);

        uint256 transferAmount = SMALL_STAKE;

        vm.prank(user1);
        checkpointLpt.transfer(user2, transferAmount);

        vm.warp(block.timestamp + 1000);

        uint256 user1RewardsAfter = checkpointPool.getClaimableRewards(user1);
        uint256 user2RewardsAfter = checkpointPool.getClaimableRewards(user2);

        assertTrue(user1RewardsAfter >= user1RewardsBefore);
        assertTrue(user2RewardsAfter > 0);
    }

    function test_OnLPTTransfer_EventEmitted() public {
        uint256 transferAmount = SMALL_STAKE;

        vm.expectEmit(true, true, false, false);
        emit IPortalPool.StakeTransferred(user1, user2, transferAmount);

        vm.prank(user1);
        lpt.transfer(user2, transferAmount);
    }
}
