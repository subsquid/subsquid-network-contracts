// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./BaseTest.sol";
import {PortalPoolImplementation} from "../src/PortalPoolImplementation.sol";
import {IPortalFactory} from "../src/interfaces/IPortalFactory.sol";
import {PoolErrors} from "../src/libs/PoolErrors.sol";

contract RunwayAccountingRegressionTest is BaseTest {
    PortalPoolImplementation public pool;

    uint256 public constant CAPACITY = 100_000 ether;
    uint256 public constant DIST_RATE = 10_000;
    uint256 public constant INITIAL_CREDIT = 864_000;

    function setUp() public override {
        super.setUp();
        factory.setMinStakeThreshold(80_000 ether);

        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: CAPACITY,
            tokenSuffix: "LOCK",
            distributionRatePerSecond: DIST_RATE,
            initialDeposit: INITIAL_CREDIT,
            metadata: "",
            rewardToken: address(usdc)
        });
        usdc.approve(address(factory), INITIAL_CREDIT);
        pool = PortalPoolImplementation(factory.createPortalPool(params));

        vm.prank(user1);
        sqd.approve(address(pool), type(uint256).max);
        vm.prank(user2);
        sqd.approve(address(pool), type(uint256).max);
    }

    function _activatePool() internal {
        vm.prank(user1);
        pool.deposit(CAPACITY);
    }

    function _topUp(uint256 amount) internal {
        vm.startPrank(operator);
        usdc.approve(address(pool), amount);
        pool.topUpRewards(amount);
        vm.stopPrank();
    }

    function test_TopUpAfterDry_MovesRunwayForward() public {
        _activatePool();

        skip(200_000);

        vm.prank(user1);
        pool.claimRewards();

        assertEq(pool.getCredit(), 0, "pool should be dry");

        _topUp(1_000_000);

        assertTrue(pool.getCredit() > 0, "topup should add credit");
        assertTrue(pool.getRunway() > int256(block.timestamp), "runway should move into future");
    }

    function test_TopUpAfterDry_NoRetroactiveRewards() public {
        _activatePool();

        skip(200_000);
        uint256 claimableBeforeTopUp = pool.getClaimableRewards(user1);

        _topUp(1_000_000);

        uint256 claimableAfterTopUp = pool.getClaimableRewards(user1);
        assertEq(claimableAfterTopUp, claimableBeforeTopUp, "topup must not backfill dry period");

        skip(1_000);
        uint256 claimableAfterResume = pool.getClaimableRewards(user1);
        assertTrue(claimableAfterResume > claimableAfterTopUp, "rewards should resume after topup");
    }

    function disabled_JoinDuringDryThenTopUp_BlockedUntilFunded() public {
        _activatePool();

        vm.prank(user1);
        pool.requestExit(CAPACITY / 2);

        skip(400_000);
        assertEq(pool.getCredit(), 0, "pool should be dry");

        vm.prank(user2);
        vm.expectRevert(PoolErrors.PoolHasDebt.selector);
        pool.deposit(10_000 ether);

        _topUp(1_000_000);

        vm.prank(user2);
        pool.deposit(10_000 ether);

        uint256 claimableAtJoin = pool.getClaimableRewards(user2);
        assertEq(claimableAtJoin, 0, "new depositor should not receive historical rewards");
    }

    function test_TotalRewardsPaid_MonotonicAndCapped() public {
        _activatePool();

        uint256 paidBefore = pool.totalRewardsPaid();

        skip(7200);
        vm.prank(user1);
        pool.claimRewards();

        uint256 paidAfterClaim = pool.totalRewardsPaid();
        assertTrue(paidAfterClaim >= paidBefore, "totalRewardsPaid must be monotonic");

        skip(300_000);
        vm.prank(user1);
        pool.requestExit(1 ether);

        uint256 paidAfterDryAccrual = pool.totalRewardsPaid();
        assertTrue(paidAfterDryAccrual >= paidAfterClaim, "totalRewardsPaid must keep monotonicity");
        assertLe(paidAfterDryAccrual, pool.credit(), "totalRewardsPaid must not exceed credit");
    }
}
