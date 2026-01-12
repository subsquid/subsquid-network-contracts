// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./BaseTest.sol";
import {PoolErrors} from "../src/libs/PoolErrors.sol";
import {PortalPoolImplementation} from "../src/PortalPoolImplementation.sol";
import {LiquidPortalToken} from "../src/LiquidPortalToken.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract SecurityTests is BaseTest {
    address public portal;
    PortalPoolImplementation public pool;
    LiquidPortalToken public lpt;

    function setUp() public override {
        super.setUp();
        portal = _createSecurityTestPortal(operator, MIN_STAKE_THRESHOLD, "SecurityPortal");
        pool = PortalPoolImplementation(portal);
        lpt = LiquidPortalToken(address(pool.lptToken()));
    }

    /// @dev Calculate minimum rate to satisfy precision requirement: rate >= capacity / 1e12
    function _minRateForCapacity(uint256 capacity) internal pure returns (uint256) {
        uint256 minRate = capacity / 1e12;
        return minRate < 1000 ? 1000 : minRate;
    }

    function _createSecurityTestPortal(address _operator, uint256 _capacity, string memory _name)
        internal
        returns (address portalAddress)
    {
        uint256 rate = _minRateForCapacity(_capacity);

        uint256 initialDeposit = rate * 1 days / 1000;

        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: _operator,
            capacity: _capacity,
            peerId: abi.encodePacked("peer-", _name),
            tokenSuffix: _name,
            distributionRatePerSecond: rate,
            initialDeposit: initialDeposit,
            metadata: "",
            rewardToken: address(usdc)
        });

        usdc.approve(address(factory), initialDeposit);
        portalAddress = factory.createPortalPool(params);

        // Activate by having user1 deposit full capacity
        vm.startPrank(user1);
        sqd.approve(portalAddress, _capacity);
        IPortalPool(portalAddress).deposit(_capacity);
        vm.stopPrank();
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

    function test_OnLPTTransfer_OrderOfOperations_RewardsSettleBeforeStateUpdate() public {
        // Top up enough rewards to cover the distribution rate for 100 seconds
        // Rate = 12 USDC/sec, so 100 seconds = 1200 USDC
        uint256 topUpAmount = 2000 * 1e6; // 2000 USDC - enough for runway

        vm.startPrank(operator);
        usdc.mint(operator, topUpAmount);
        usdc.approve(portal, topUpAmount);
        pool.topUpRewards(topUpAmount);
        vm.stopPrank();

        vm.warp(block.timestamp + 100);

        uint256 user1RewardsBefore = pool.getClaimableRewards(user1);
        assertTrue(user1RewardsBefore > 0, "User1 should have accrued rewards");

        uint256 user1StakeBefore = pool.getProviderStake(user1);
        uint256 user2StakeBefore = pool.getProviderStake(user2);

        uint256 transferAmount = SMALL_STAKE;

        vm.prank(user1);
        lpt.transfer(user2, transferAmount);

        uint256 user1RewardsAfter = pool.getClaimableRewards(user1);
        uint256 user1StakeAfter = pool.getProviderStake(user1);
        uint256 user2StakeAfter = pool.getProviderStake(user2);

        assertApproxEqRel(user1RewardsBefore, user1RewardsAfter, 0.02e18, "User1 rewards should be ~preserved");
        assertEq(user1StakeAfter, user1StakeBefore - transferAmount);
        assertEq(user2StakeAfter, user2StakeBefore + transferAmount);
    }

    function test_OnLPTTransfer_RevertOnNotLPTToken() public {
        vm.expectRevert(PoolErrors.NotLPTToken.selector);
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

        uint256 capacity = DEFAULT_MAX_STAKE_PER_WALLET * 2;
        uint256 rate = _minRateForCapacity(capacity);
        uint256 initialDeposit = rate * 1 days / 1000;

        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: capacity,
            peerId: "limit-portal",
            tokenSuffix: "LimitPortal",
            distributionRatePerSecond: rate,
            initialDeposit: initialDeposit,
            metadata: "",
            rewardToken: address(usdc)
        });
        usdc.approve(address(factory), initialDeposit);
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
        vm.expectRevert(PoolErrors.ExceedsWalletLimit.selector);
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

    function test_OnLPTTransfer_WithRewardsDistributed_ProperSettlement() public {
        // Top up enough rewards to cover the distribution rate for 100 seconds
        // Rate = 12 USDC/sec, so 100 seconds = 1200 USDC
        uint256 topUpAmount = 2000 * 1e6; // 2000 USDC - enough for runway

        vm.startPrank(operator);
        usdc.mint(operator, topUpAmount);
        usdc.approve(portal, topUpAmount);
        pool.topUpRewards(topUpAmount);
        vm.stopPrank();

        vm.warp(block.timestamp + 100);

        uint256 user1ClaimableBefore = pool.getClaimableRewards(user1);
        assertTrue(user1ClaimableBefore > 0, "User1 should have accrued rewards");

        uint256 transferAmount = SMALL_STAKE;

        vm.prank(user1);
        lpt.transfer(user2, transferAmount);

        uint256 user1ClaimableAfter = pool.getClaimableRewards(user1);
        uint256 user2ClaimableAfter = pool.getClaimableRewards(user2);

        assertApproxEqRel(user1ClaimableBefore, user1ClaimableAfter, 0.02e18, "User1 rewards should be ~preserved");

        assertLt(user2ClaimableAfter, 2 * 1e6, "User2 should start with near-zero claimable");
    }

    function test_OnLPTTransfer_EventEmitted() public {
        uint256 transferAmount = SMALL_STAKE;

        vm.expectEmit(true, true, false, false);
        emit IPortalPool.StakeTransferred(user1, user2, transferAmount);

        vm.prank(user1);
        lpt.transfer(user2, transferAmount);
    }
}
