// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./BaseTest.sol";
import {LiquidPortalToken} from "../src/LiquidPortalToken.sol";
import {PortalPoolImplementation} from "../src/PortalPoolImplementation.sol";

contract LiquidPortalTokenTest is BaseTest {
    LiquidPortalToken public lpt;
    address public portal;

    function setUp() public override {
        super.setUp();

        portal = _createPortal(operator, MIN_STAKE_THRESHOLD, "TestPortal");
        lpt = PortalPoolImplementation(portal).lptToken();
    }

    function test_Constructor_SetsCorrectValues() public view {
        assertEq(lpt.PORTAL_POOL(), portal);
        assertEq(lpt.name(), "Portal Locked SQD TestPortal");
        assertEq(lpt.symbol(), "plSQD-TestPortal");
    }

    function test_Mint_Success() public {
        vm.startPrank(user1);
        sqd.approve(portal, STAKE_AMOUNT);
        IPortalPool(portal).deposit(STAKE_AMOUNT);
        vm.stopPrank();

        assertEq(lpt.balanceOf(user1), STAKE_AMOUNT);
        assertEq(lpt.totalSupply(), STAKE_AMOUNT);
    }

    function test_Mint_RevertOnNonPool() public {
        vm.prank(user1);
        vm.expectRevert(LiquidPortalToken.OnlyPortalPool.selector);
        lpt.mint(user1, STAKE_AMOUNT);
    }

    function test_Burn_Success() public {
        vm.startPrank(user1);
        sqd.approve(portal, STAKE_AMOUNT);
        IPortalPool(portal).deposit(STAKE_AMOUNT);

        IPortalPool(portal).requestExit(STAKE_AMOUNT);
        vm.stopPrank();

        assertEq(lpt.balanceOf(user1), 0);
    }

    function test_Burn_RevertOnNonPool() public {
        vm.prank(user1);
        vm.expectRevert(LiquidPortalToken.OnlyPortalPool.selector);
        lpt.burn(user1, STAKE_AMOUNT);
    }

    function test_Transfer_UpdatesStakeAccounting() public {
        vm.startPrank(user1);
        sqd.approve(portal, STAKE_AMOUNT);
        IPortalPool(portal).deposit(STAKE_AMOUNT);
        vm.stopPrank();

        uint256 user1StakeBefore = IPortalPool(portal).getProviderStake(user1);
        assertEq(user1StakeBefore, STAKE_AMOUNT);

        uint256 transferAmount = STAKE_AMOUNT / 2;
        vm.prank(user1);
        lpt.transfer(user2, transferAmount);

        assertEq(lpt.balanceOf(user1), STAKE_AMOUNT - transferAmount);
        assertEq(lpt.balanceOf(user2), transferAmount);

        uint256 user1StakeAfter = IPortalPool(portal).getProviderStake(user1);
        uint256 user2StakeAfter = IPortalPool(portal).getProviderStake(user2);

        assertEq(user1StakeAfter, STAKE_AMOUNT - transferAmount);
        assertEq(user2StakeAfter, transferAmount);
    }

    function test_TransferFrom_Success() public {
        vm.startPrank(user1);
        sqd.approve(portal, STAKE_AMOUNT);
        IPortalPool(portal).deposit(STAKE_AMOUNT);

        lpt.approve(user2, STAKE_AMOUNT);
        vm.stopPrank();

        uint256 transferAmount = STAKE_AMOUNT / 2;
        vm.prank(user2);
        lpt.transferFrom(user1, user3, transferAmount);

        assertEq(lpt.balanceOf(user1), STAKE_AMOUNT - transferAmount);
        assertEq(lpt.balanceOf(user3), transferAmount);

        uint256 user1Stake = IPortalPool(portal).getProviderStake(user1);
        uint256 user3Stake = IPortalPool(portal).getProviderStake(user3);

        assertEq(user1Stake, STAKE_AMOUNT - transferAmount);
        assertEq(user3Stake, transferAmount);
    }

    function test_Transfer_DoesNotCallCallbackOnMint() public {
        vm.startPrank(user1);
        sqd.approve(portal, STAKE_AMOUNT);

        IPortalPool(portal).deposit(STAKE_AMOUNT);
        vm.stopPrank();

        assertEq(lpt.balanceOf(user1), STAKE_AMOUNT);
    }

    function test_Transfer_DoesNotCallCallbackOnBurn() public {
        vm.startPrank(user1);
        sqd.approve(portal, STAKE_AMOUNT);
        IPortalPool(portal).deposit(STAKE_AMOUNT);

        IPortalPool(portal).requestExit(STAKE_AMOUNT);
        vm.stopPrank();

        assertEq(lpt.balanceOf(user1), 0);
    }

    function test_Transfer_MultipleUsers() public {
        address largePortal = _createPortal(operator, MIN_STAKE_THRESHOLD * 3, "LargePortal");
        LiquidPortalToken largeLpt = PortalPoolImplementation(largePortal).lptToken();

        vm.startPrank(user1);
        sqd.approve(largePortal, STAKE_AMOUNT);
        IPortalPool(largePortal).deposit(STAKE_AMOUNT);
        vm.stopPrank();

        vm.startPrank(user2);
        sqd.approve(largePortal, STAKE_AMOUNT);
        IPortalPool(largePortal).deposit(STAKE_AMOUNT);
        vm.stopPrank();

        uint256 transferAmount = STAKE_AMOUNT / 4;
        vm.prank(user1);
        largeLpt.transfer(user3, transferAmount);

        assertEq(largeLpt.balanceOf(user1), STAKE_AMOUNT - transferAmount);
        assertEq(largeLpt.balanceOf(user2), STAKE_AMOUNT);
        assertEq(largeLpt.balanceOf(user3), transferAmount);

        assertEq(largeLpt.totalSupply(), STAKE_AMOUNT * 2);
    }

    function test_Transfer_FullBalance() public {
        vm.startPrank(user1);
        sqd.approve(portal, STAKE_AMOUNT);
        IPortalPool(portal).deposit(STAKE_AMOUNT);

        lpt.transfer(user2, STAKE_AMOUNT);
        vm.stopPrank();

        assertEq(lpt.balanceOf(user1), 0);
        assertEq(lpt.balanceOf(user2), STAKE_AMOUNT);

        uint256 user1Stake = IPortalPool(portal).getProviderStake(user1);
        uint256 user2Stake = IPortalPool(portal).getProviderStake(user2);

        assertEq(user1Stake, 0);
        assertEq(user2Stake, STAKE_AMOUNT);
    }

    function test_Approve_Success() public {
        vm.startPrank(user1);
        sqd.approve(portal, STAKE_AMOUNT);
        IPortalPool(portal).deposit(STAKE_AMOUNT);

        lpt.approve(user2, STAKE_AMOUNT);
        vm.stopPrank();

        assertEq(lpt.allowance(user1, user2), STAKE_AMOUNT);
    }

    function test_TotalSupply_UpdatesCorrectly() public {
        address largePortal = _createPortal(operator, MIN_STAKE_THRESHOLD * 3, "LargePortal");
        LiquidPortalToken largeLpt = PortalPoolImplementation(largePortal).lptToken();

        assertEq(largeLpt.totalSupply(), 0);

        vm.startPrank(user1);
        sqd.approve(largePortal, STAKE_AMOUNT);
        IPortalPool(largePortal).deposit(STAKE_AMOUNT);
        vm.stopPrank();

        assertEq(largeLpt.totalSupply(), STAKE_AMOUNT);

        vm.startPrank(user2);
        sqd.approve(largePortal, STAKE_AMOUNT);
        IPortalPool(largePortal).deposit(STAKE_AMOUNT);
        vm.stopPrank();

        assertEq(largeLpt.totalSupply(), STAKE_AMOUNT * 2);

        vm.prank(user1);
        IPortalPool(largePortal).requestExit(STAKE_AMOUNT);

        assertEq(largeLpt.totalSupply(), STAKE_AMOUNT);
    }

    function test_Transfer_ZeroAmount() public {
        vm.startPrank(user1);
        sqd.approve(portal, STAKE_AMOUNT);
        IPortalPool(portal).deposit(STAKE_AMOUNT);

        lpt.transfer(user2, 0);
        vm.stopPrank();

        assertEq(lpt.balanceOf(user1), STAKE_AMOUNT);
        assertEq(lpt.balanceOf(user2), 0);
    }

    function test_Transfer_ToSelf() public {
        vm.startPrank(user1);
        sqd.approve(portal, STAKE_AMOUNT);
        IPortalPool(portal).deposit(STAKE_AMOUNT);

        lpt.transfer(user1, STAKE_AMOUNT / 2);
        vm.stopPrank();

        assertEq(lpt.balanceOf(user1), STAKE_AMOUNT);
    }
}
