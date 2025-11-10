// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {GatewayRegistry} from "../src/GatewayRegistry.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {Errors} from "../src/libs/Errors.sol";

contract GatewayRegistryTest is Test {
    GatewayRegistry public registry;
    MockERC20 public sqdToken;
    address public portalFactory;
    address public individual;
    address public portal;
    address public owner;

    uint256 constant MIN_STAKE = 1_000_000e18;
    uint256 constant INDIVIDUAL_LOCK_DURATION = 50400;

    function setUp() public {
        owner = address(this);
        individual = makeAddr("individual");
        portal = makeAddr("portal");
        portalFactory = makeAddr("portalFactory");

        sqdToken = new MockERC20("SQD Token", "SQD", 18);
        registry = new GatewayRegistry(address(sqdToken), portalFactory);

        sqdToken.mint(individual, 10_000_000e18);
        sqdToken.mint(portal, 10_000_000e18);

        vm.prank(individual);
        sqdToken.approve(address(registry), type(uint256).max);

        vm.prank(portal);
        sqdToken.approve(address(registry), type(uint256).max);
    }

    function testStakeIndividual() public {
        uint256 amount = MIN_STAKE;

        vm.prank(individual);
        registry.stake(amount);

        GatewayRegistry.Stake memory stakeData = registry.getStake(individual);
        assertEq(stakeData.amount, amount);
        assertEq(uint8(stakeData.stakerType), uint8(GatewayRegistry.StakerType.Individual));
        assertEq(stakeData.lockEndBlock, block.number + INDIVIDUAL_LOCK_DURATION);
    }

    function testStakeIndividualBelowMinimum() public {
        vm.prank(individual);
        vm.expectRevert(Errors.BelowMinimumDeposit.selector);
        registry.stake(MIN_STAKE - 1);
    }

    function testStakeIndividualAlreadyExists() public {
        vm.startPrank(individual);
        registry.stake(MIN_STAKE);

        vm.expectRevert(Errors.StakeAlreadyExists.selector);
        registry.stake(MIN_STAKE);
        vm.stopPrank();
    }

    function testUnstakeIndividual() public {
        vm.startPrank(individual);
        registry.stake(MIN_STAKE);

        vm.roll(block.number + INDIVIDUAL_LOCK_DURATION + 1);

        uint256 balanceBefore = sqdToken.balanceOf(individual);
        registry.unstake();
        uint256 balanceAfter = sqdToken.balanceOf(individual);

        assertEq(balanceAfter - balanceBefore, MIN_STAKE);

        GatewayRegistry.Stake memory stakeData = registry.getStake(individual);
        assertEq(stakeData.amount, 0);
        vm.stopPrank();
    }

    function testUnstakeBeforeLockEnd() public {
        vm.startPrank(individual);
        registry.stake(MIN_STAKE);

        vm.expectRevert(Errors.StakeIsLocked.selector);
        registry.unstake();
        vm.stopPrank();
    }

    function testRegisterPortal() public {
        vm.prank(portalFactory);
        registry.registerPortal(portal);

        GatewayRegistry.Stake memory stakeData = registry.getStake(portal);
        assertEq(uint8(stakeData.stakerType), uint8(GatewayRegistry.StakerType.Portal));
        assertEq(stakeData.amount, 0);
    }

    function testRegisterPortalOnlyFactory() public {
        vm.prank(individual);
        vm.expectRevert(Errors.NotFactory.selector);
        registry.registerPortal(portal);
    }

    function testRegisterPortalZeroAddress() public {
        vm.prank(portalFactory);
        vm.expectRevert(Errors.ZeroAddress.selector);
        registry.registerPortal(address(0));
    }

    function testRegisterPortalAlreadyInitialized() public {
        vm.startPrank(portalFactory);
        registry.registerPortal(portal);

        vm.expectRevert(Errors.AlreadyInitialized.selector);
        registry.registerPortal(portal);
        vm.stopPrank();
    }

    function testAdjustStakePortalIncrease() public {
        vm.prank(portalFactory);
        registry.registerPortal(portal);

        vm.prank(portal);
        registry.adjustStake(int256(MIN_STAKE));

        GatewayRegistry.Stake memory stakeData = registry.getStake(portal);
        assertEq(stakeData.amount, MIN_STAKE);
    }

    function testAdjustStakePortalDecrease() public {
        vm.prank(portalFactory);
        registry.registerPortal(portal);

        vm.startPrank(portal);
        registry.adjustStake(int256(MIN_STAKE * 2));
        registry.adjustStake(-int256(MIN_STAKE));
        vm.stopPrank();

        GatewayRegistry.Stake memory stakeData = registry.getStake(portal);
        assertEq(stakeData.amount, MIN_STAKE);
    }

    function testAdjustStakePortalBelowMinimum() public {
        vm.prank(portalFactory);
        registry.registerPortal(portal);

        vm.startPrank(portal);
        registry.adjustStake(int256(MIN_STAKE));

        vm.expectRevert(Errors.BelowMinimumDeposit.selector);
        registry.adjustStake(-int256(MIN_STAKE / 2));
        vm.stopPrank();
    }

    function testAdjustStakePortalInsufficientBalance() public {
        vm.prank(portalFactory);
        registry.registerPortal(portal);

        vm.prank(portal);
        vm.expectRevert(Errors.InsufficientBalance.selector);
        registry.adjustStake(-int256(MIN_STAKE));
    }

    function testAdjustStakeOnlyPortal() public {
        vm.prank(individual);
        vm.expectRevert(Errors.InvalidCaller.selector);
        registry.adjustStake(int256(MIN_STAKE));
    }

    function testAdjustStakeToZero() public {
        vm.prank(portalFactory);
        registry.registerPortal(portal);

        vm.startPrank(portal);
        registry.adjustStake(int256(MIN_STAKE));
        registry.adjustStake(-int256(MIN_STAKE));
        vm.stopPrank();

        GatewayRegistry.Stake memory stakeData = registry.getStake(portal);
        assertEq(stakeData.amount, 0);
    }

    function testComputationUnitsAmount() public view {
        uint256 amount = 5_000_000e18;
        uint256 duration = 50400;

        uint256 cus = registry.computationUnitsAmount(amount, duration);

        assertGt(cus, 0);
    }

    function testCalculateBoostFactor() public view {
        assertEq(registry.calculateBoostFactor(29 days), 10000);
        assertEq(registry.calculateBoostFactor(30 days), 10500);
        assertEq(registry.calculateBoostFactor(89 days), 10500);
        assertEq(registry.calculateBoostFactor(90 days), 11000);
        assertEq(registry.calculateBoostFactor(179 days), 11000);
        assertEq(registry.calculateBoostFactor(180 days), 12000);
        assertEq(registry.calculateBoostFactor(359 days), 12000);
        assertEq(registry.calculateBoostFactor(365 days), 15000);
    }

    function testComputationUnitsAvailableIndividual() public {
        vm.prank(individual);
        registry.stake(MIN_STAKE);

        uint256 cus = registry.computationUnitsAvailable(individual);
        assertGt(cus, 0);
    }

    function testComputationUnitsAvailableIndividualExpired() public {
        vm.prank(individual);
        registry.stake(MIN_STAKE);

        vm.roll(block.number + INDIVIDUAL_LOCK_DURATION + 1);

        uint256 cus = registry.computationUnitsAvailable(individual);
        assertEq(cus, 0);
    }

    function testComputationUnitsAvailablePortal() public {
        vm.prank(portalFactory);
        registry.registerPortal(portal);

        vm.prank(portal);
        registry.adjustStake(int256(MIN_STAKE));

        uint256 cus = registry.computationUnitsAvailable(portal);
        assertGt(cus, 0);
    }

    function testComputationUnitsAvailableZeroStake() public view {
        uint256 cus = registry.computationUnitsAvailable(address(0x999));
        assertEq(cus, 0);
    }

    function testCanUnstakeIndividual() public {
        vm.prank(individual);
        registry.stake(MIN_STAKE);

        assertFalse(registry.canUnstake(individual));

        vm.roll(block.number + INDIVIDUAL_LOCK_DURATION + 1);
        assertTrue(registry.canUnstake(individual));
    }

    function testCanUnstakePortal() public {
        vm.prank(portalFactory);
        registry.registerPortal(portal);

        assertFalse(registry.canUnstake(portal));
    }

    function testIsPortal() public {
        vm.prank(portalFactory);
        registry.registerPortal(portal);

        assertTrue(registry.isPortal(portal));
        assertFalse(registry.isPortal(individual));
    }

    function testStakedAmount() public {
        vm.prank(individual);
        registry.stake(MIN_STAKE);

        assertEq(registry.stakedAmount(individual), MIN_STAKE);
    }

    function testSetPortalFactory() public {
        address newFactory = makeAddr("newFactory");

        registry.setPortalFactory(newFactory);
        assertEq(registry.portalFactory(), newFactory);
    }

    function testSetPortalFactoryOnlyOwner() public {
        vm.prank(individual);
        vm.expectRevert();
        registry.setPortalFactory(makeAddr("newFactory"));
    }

    function testSetPortalFactoryZeroAddress() public {
        vm.expectRevert(Errors.ZeroAddress.selector);
        registry.setPortalFactory(address(0));
    }

    function testSetAverageBlockTime() public {
        registry.setAverageBlockTime(15);
        assertEq(registry.averageBlockTime(), 15);
    }

    function testSetWorkerEpochLength() public {
        registry.setWorkerEpochLength(10000);
        assertEq(registry.workerEpochLength(), 10000);
    }

    function testWeightedDurationTracking() public {
        vm.prank(portalFactory);
        registry.registerPortal(portal);

        vm.startPrank(portal);
        registry.adjustStake(int256(MIN_STAKE));

        vm.roll(block.number + 1000);

        registry.adjustStake(int256(MIN_STAKE));
        vm.stopPrank();

        GatewayRegistry.Stake memory stakeData = registry.getStake(portal);
        assertGt(stakeData.durationBlocks, 0);
    }

    function testMultipleAdjustments() public {
        vm.prank(portalFactory);
        registry.registerPortal(portal);

        vm.startPrank(portal);
        registry.adjustStake(int256(MIN_STAKE));
        vm.roll(block.number + 100);

        registry.adjustStake(int256(MIN_STAKE));
        vm.roll(block.number + 200);

        registry.adjustStake(-int256(MIN_STAKE / 2));
        vm.stopPrank();

        GatewayRegistry.Stake memory stakeData = registry.getStake(portal);
        assertEq(stakeData.amount, MIN_STAKE * 3 / 2);
    }

    function testConstructorZeroSQDAddress() public {
        vm.expectRevert(Errors.ZeroAddress.selector);
        new GatewayRegistry(address(0), portalFactory);
    }

    function testConstructorZeroFactoryAddress() public {
        vm.expectRevert(Errors.ZeroAddress.selector);
        new GatewayRegistry(address(sqdToken), address(0));
    }

    function testFuzzStakeAmount(uint256 amount) public {
        vm.assume(amount >= MIN_STAKE && amount <= 100_000_000e18);

        sqdToken.mint(individual, amount);

        vm.prank(individual);
        registry.stake(amount);

        assertEq(registry.stakedAmount(individual), amount);
    }

    function testFuzzAdjustStake(int256 delta) public {
        vm.assume(delta > 0 && uint256(delta) >= MIN_STAKE && uint256(delta) <= 10_000_000e18);

        vm.prank(portalFactory);
        registry.registerPortal(portal);

        vm.prank(portal);
        registry.adjustStake(delta);

        assertEq(registry.stakedAmount(portal), uint256(delta));
    }
}
