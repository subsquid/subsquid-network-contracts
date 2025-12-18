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
        sqd.mint(user1, DEFAULT_MAX_STAKE_PER_WALLET);
        sqd.mint(user2, DEFAULT_MAX_STAKE_PER_WALLET);

        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: DEFAULT_MAX_STAKE_PER_WALLET * 2,
            peerId: "limit-portal",
            portalName: "LimitPortal",
            distributionRatePerSecond: 1 ether,
            metadata: ""
        });
        address limitPortal = factory.createPortalPool(params);
        LiquidPortalToken limitLpt = PortalPoolImplementation(limitPortal).lptToken();

        vm.startPrank(user1);
        sqd.approve(limitPortal, DEFAULT_MAX_STAKE_PER_WALLET);
        IPortalPool(limitPortal).deposit(DEFAULT_MAX_STAKE_PER_WALLET);
        vm.stopPrank();

        vm.startPrank(user2);
        sqd.approve(limitPortal, DEFAULT_MAX_STAKE_PER_WALLET);
        IPortalPool(limitPortal).deposit(DEFAULT_MAX_STAKE_PER_WALLET);
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

    function test_OnLPTTransfer_EventEmitted() public {
        uint256 transferAmount = SMALL_STAKE;

        vm.expectEmit(true, true, false, false);
        emit IPortalPool.StakeTransferred(user1, user2, transferAmount);

        vm.prank(user1);
        lpt.transfer(user2, transferAmount);
    }
}
