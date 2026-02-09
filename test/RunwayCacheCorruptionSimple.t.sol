// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./BaseTest.sol";
import {PortalPoolImplementation} from "../src/PortalPoolImplementation.sol";
import {IPortalFactory} from "../src/interfaces/IPortalFactory.sol";

contract RunwayCacheLockPoC is BaseTest {
    PortalPoolImplementation public pool;

    uint256 public constant CAPACITY = 100_000 ether;
    uint256 public constant DIST_RATE = 1_000;
    uint256 public constant INITIAL_CREDIT = 86_400;

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
    }

    function testPermanentCacheLockAfterTopUp() public {
        vm.prank(user1);
        pool.deposit(CAPACITY);

        vm.prank(user1);
        pool.requestExit(50_000 ether);

        skip(200_000);

        vm.prank(user1);
        pool.claimRewards();

        int256 cachedRunway = pool.runwayPassed();
        assertTrue(cachedRunway > 0);
        assertTrue(cachedRunway < int256(block.timestamp));
        emit log_named_int("cached_runway_before_topup", cachedRunway);

        uint256 topupAmount = 1_000_000;
        vm.prank(operator);
        usdc.approve(address(pool), topupAmount);
        vm.prank(operator);
        pool.topUpRewards(topupAmount);

        int256 runwayAfterTopup = pool.runwayPassed();
        emit log_named_int("cached_runway_after_topup", runwayAfterTopup);
        emit log_named_int("current_timestamp", int256(block.timestamp));

        assertEq(runwayAfterTopup, cachedRunway);

        uint256 currentDebt = pool.debt();
        uint256 currentCredit = pool.credit();
        emit log_named_uint("debt_after_topup", currentDebt);
        emit log_named_uint("credit_after_topup", currentCredit);
        assertEq(currentDebt, 0);
        assertTrue(currentCredit > 0);

        int256 runway = pool.getRunway();
        emit log_named_int("getRunway_returns", runway);
        assertTrue(runway < int256(block.timestamp));

        skip(1000);

        vm.prank(user1);
        try pool.claimRewards() returns (uint256 claimed) {
            emit log_named_uint("claimed_after_topup_and_wait", claimed);
            fail();
        } catch {
            emit log_named_uint("pool_usdc_balance", usdc.balanceOf(address(pool)));
            assertTrue(usdc.balanceOf(address(pool)) > 0);
        }
    }

    function testCircularDependencyNeverClears() public {
        vm.prank(user1);
        pool.deposit(CAPACITY);

        vm.prank(user1);
        pool.requestExit(50_000 ether);

        skip(200_000);
        vm.prank(user1);
        pool.claimRewards();

        int256 stuckValue = pool.runwayPassed();
        assertTrue(stuckValue > 0);

        vm.prank(operator);
        usdc.approve(address(pool), 10_000_000);
        vm.prank(operator);
        pool.topUpRewards(10_000_000);

        vm.prank(user1);
        pool.deposit(1);
        assertEq(pool.runwayPassed(), stuckValue);

        vm.prank(user1);
        pool.requestExit(1);
        assertEq(pool.runwayPassed(), stuckValue);

        skip(10_000);

        assertEq(pool.runwayPassed(), stuckValue);

        int256 runway = pool.getRunway();
        uint256 credit = pool.credit();
        emit log_named_int("getRunway (stuck in past)", runway);
        emit log_named_uint("actual credit available", credit);
        emit log_named_int("current time", int256(block.timestamp));

        assertTrue(credit > 0);
        assertTrue(runway < int256(block.timestamp));
    }

    function testMultipleTopUpsCantFixIt() public {
        vm.prank(user1);
        pool.deposit(CAPACITY);
        vm.prank(user1);
        pool.requestExit(50_000 ether);
        skip(200_000);
        vm.prank(user1);
        pool.claimRewards();

        int256 stuckValue = pool.runwayPassed();

        vm.prank(operator);
        usdc.approve(address(pool), 5_000_000);
        vm.prank(operator);
        pool.topUpRewards(5_000_000);
        assertEq(pool.runwayPassed(), stuckValue);

        vm.prank(operator);
        usdc.approve(address(pool), 5_000_000);
        vm.prank(operator);
        pool.topUpRewards(5_000_000);
        assertEq(pool.runwayPassed(), stuckValue);

        vm.prank(operator);
        usdc.approve(address(pool), 5_000_000);
        vm.prank(operator);
        pool.topUpRewards(5_000_000);
        assertEq(pool.runwayPassed(), stuckValue);

        emit log_named_uint("total_credit", pool.credit());
        emit log_named_int("stuck_runway", pool.getRunway());
        assertTrue(pool.credit() > 0 && pool.getRunway() < int256(block.timestamp));
    }
}
