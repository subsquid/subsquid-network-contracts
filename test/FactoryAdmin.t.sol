// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./BaseTest.sol";
import {PoolErrors} from "../src/libs/PoolErrors.sol";
import {Constants} from "../src/libs/Constants.sol";

/// @title Factory Admin Tests
/// @notice Tests for factory admin setters and createPortalPool validation branches
contract FactoryAdminTest is BaseTest {
    function setUp() public override {
        super.setUp();
    }

    /// @dev Helper: minimum rate for precision requirement
    function _minRateForCapacity(uint256 capacity) internal pure returns (uint256) {
        uint256 minRate = capacity / 1e12;
        return minRate < 1000 ? 1000 : minRate;
    }

    function test_AdminSetters_Success() public {
        // setFeeRouter
        address newFeeRouter = address(0x999);
        vm.expectEmit(true, true, false, false);
        emit IPortalFactory.FeeRouterUpdated(address(feeRouter), newFeeRouter);
        factory.setFeeRouter(newFeeRouter);
        assertEq(factory.feeRouter(), newFeeRouter);

        // setMinDistributionRate
        uint256 newMinRate = 500;
        vm.expectEmit(true, true, false, false);
        emit IPortalFactory.MinDistributionRateUpdated(Constants.MIN_DISTRIBUTION_RATE_PER_SECOND, newMinRate);
        factory.setMinDistributionRate(newMinRate);
        assertEq(factory.minDistributionRatePerSecond(), newMinRate);

        // setMinStakeThreshold
        uint256 newMinStake = 200_000 ether;
        vm.expectEmit(true, true, false, false);
        emit IPortalFactory.MinStakeThresholdUpdated(MIN_STAKE_THRESHOLD, newMinStake);
        factory.setMinStakeThreshold(newMinStake);
        assertEq(factory.minStakeThreshold(), newMinStake);

        // setWorkerEpochLength
        uint256 newEpochLength = 14400;
        vm.expectEmit(true, true, false, false);
        emit IPortalFactory.WorkerEpochLengthUpdated(WORKER_EPOCH_LENGTH, newEpochLength);
        factory.setWorkerEpochLength(newEpochLength);
        assertEq(factory.workerEpochLength(), newEpochLength);

        // setPoolDeploymentOpen - toggle true then false
        vm.expectEmit(true, true, false, false);
        emit IPortalFactory.PoolDeploymentOpenUpdated(false, true);
        factory.setPoolDeploymentOpen(true);
        assertTrue(factory.poolDeploymentOpen());

        vm.expectEmit(true, true, false, false);
        emit IPortalFactory.PoolDeploymentOpenUpdated(true, false);
        factory.setPoolDeploymentOpen(false);
        assertFalse(factory.poolDeploymentOpen());
    }

    function test_AdminSetters_RevertOnNonAdmin() public {
        vm.startPrank(user1);

        vm.expectRevert();
        factory.setFeeRouter(address(0x999));

        vm.expectRevert();
        factory.setMinDistributionRate(500);

        vm.expectRevert();
        factory.setMinStakeThreshold(200_000 ether);

        vm.expectRevert();
        factory.setWorkerEpochLength(14400);

        vm.expectRevert();
        factory.setPoolDeploymentOpen(true);

        vm.stopPrank();
    }

    function test_SetFeeRouter_RevertOnZeroAddress() public {
        vm.expectRevert(PoolErrors.InvalidAddress.selector);
        factory.setFeeRouter(address(0));
    }

    function test_CreatePortal_RevertWhenDeploymentClosed() public {
        // Close deployment
        factory.setPoolDeploymentOpen(false);
        assertFalse(factory.poolDeploymentOpen());

        // Non-deployer tries to create
        uint256 rate = _minRateForCapacity(MIN_STAKE_THRESHOLD);
        uint256 initialDeposit = rate * 1 days / 1000;

        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: user1,
            capacity: MIN_STAKE_THRESHOLD,
            peerId: "test-peer-id",
            tokenSuffix: "TestPortal",
            distributionRatePerSecond: rate,
            initialDeposit: initialDeposit,
            metadata: "",
            rewardToken: address(usdc)
        });

        vm.startPrank(user1);
        usdc.mint(user1, initialDeposit);
        usdc.approve(address(factory), initialDeposit);
        vm.expectRevert(PoolErrors.NotAuthorized.selector);
        factory.createPortalPool(params);
        vm.stopPrank();

        // Admin (deployer) can still create
        usdc.approve(address(factory), initialDeposit);
        address portal = factory.createPortalPool(params);
        assertTrue(portal != address(0));
    }

    function test_CreatePortal_RevertOnRateBelowMinimum() public {
        // Set minimum rate high enough to trigger error
        uint256 minRate = _minRateForCapacity(MIN_STAKE_THRESHOLD);
        factory.setMinDistributionRate(minRate * 2);

        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: MIN_STAKE_THRESHOLD,
            peerId: "test-peer-id",
            tokenSuffix: "TestPortal",
            distributionRatePerSecond: minRate, // Below new minimum
            initialDeposit: minRate * 1 days / 1000,
            metadata: "",
            rewardToken: address(usdc)
        });

        vm.expectRevert(PoolErrors.RateBelowMinimum.selector);
        factory.createPortalPool(params);
    }

    function test_CreatePortal_RevertOnRateExceedsMaximum() public {
        // Set a low maximum rate
        uint256 lowMax = 1000;
        factory.setMaxDistributionRate(lowMax);

        uint256 rate = _minRateForCapacity(MIN_STAKE_THRESHOLD);
        assertTrue(rate > lowMax, "Test setup: rate should exceed max");

        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: MIN_STAKE_THRESHOLD,
            peerId: "test-peer-id",
            tokenSuffix: "TestPortal",
            distributionRatePerSecond: rate,
            initialDeposit: rate * 1 days / 1000,
            metadata: "",
            rewardToken: address(usdc)
        });

        vm.expectRevert(PoolErrors.RateExceedsMaximum.selector);
        factory.createPortalPool(params);
    }

    function test_CreatePortal_RevertOnInsufficientPrecision() public {
        // Very large capacity with small rate causes precision issues
        // perStakeRate = (rate * 1e27) / (capacity * 1000)
        // For rate=1000 and capacity=1e27: perStakeRate = 1e30 / 1e30 = 1
        // MIN_PER_STAKE_RATE is 1e12, so this should fail
        uint256 hugeCapacity = 1e27;
        uint256 tinyRate = 1000; // Just above zero to avoid other errors

        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: operator,
            capacity: hugeCapacity,
            peerId: "test-peer-id",
            tokenSuffix: "TestPortal",
            distributionRatePerSecond: tinyRate,
            initialDeposit: tinyRate * 1 days / 1000,
            metadata: "",
            rewardToken: address(usdc)
        });

        vm.expectRevert(PoolErrors.InsufficientRewardPrecision.selector);
        factory.createPortalPool(params);
    }
}
