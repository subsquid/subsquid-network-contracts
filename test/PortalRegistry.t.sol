// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./BaseTest.sol";
import {PortalRegistryErrors} from "../src/libs/PortalRegistryErrors.sol";
import {IPortalRegistry} from "../src/interfaces/IPortalRegistry.sol";

contract PortalRegistryTest is BaseTest {
    bytes public constant TEST_PEER_ID = "test-peer-id-12345";
    bytes public constant TEST_PEER_ID_2 = "test-peer-id-67890";

    function setUp() public override {
        super.setUp();
    }

    function test_Constructor_SetsCorrectValues() public view {
        assertEq(address(registry.SQD()), address(sqd));
        assertEq(address(registry.networkController()), address(networkController));
        assertEq(registry.minStake(), MIN_STAKE_THRESHOLD);
        assertEq(registry.mana(), MANA);
    }

    function test_Constructor_RevertOnZeroSQD() public {
        vm.expectRevert(PortalRegistryErrors.InvalidAddress.selector);
        new PortalRegistry(address(0), address(networkController), MIN_STAKE_THRESHOLD, MANA);
    }

    function test_Constructor_RevertOnZeroNetworkController() public {
        vm.expectRevert(PortalRegistryErrors.InvalidAddress.selector);
        new PortalRegistry(address(sqd), address(0), MIN_STAKE_THRESHOLD, MANA);
    }

    function test_RegisterDirectPortal_Success() public {
        vm.prank(operator);
        address portalId = registry.registerDirectPortal(TEST_PEER_ID, "");

        assertTrue(portalId != address(0));
        assertTrue(registry.isPortal(portalId));
        assertEq(registry.operatorToDirectPortal(operator), portalId);

        IPortalRegistry.Portal memory portal = registry.getPortal(portalId);
        assertEq(portal.operator, operator);
        assertEq(portal.portalAddress, portalId);
        assertFalse(portal.active);
        assertTrue(portal.portalType == IPortalRegistry.PortalType.DIRECT);
    }

    function test_RegisterDirectPortal_EmitsEvent() public {
        vm.prank(operator);
        vm.expectEmit(false, true, true, true);
        emit IPortalRegistry.PortalRegistered(address(0), TEST_PEER_ID, operator, IPortalRegistry.PortalType.DIRECT);
        registry.registerDirectPortal(TEST_PEER_ID, "");
    }

    function test_RegisterDirectPortal_RevertOnDuplicate() public {
        vm.startPrank(operator);
        registry.registerDirectPortal(TEST_PEER_ID, "");

        vm.expectRevert(PortalRegistryErrors.AlreadyHasDirectPortal.selector);
        registry.registerDirectPortal(TEST_PEER_ID_2, "");
        vm.stopPrank();
    }

    function test_RegisterDirectPortal_RevertOnDuplicatePeerId() public {
        vm.prank(operator);
        registry.registerDirectPortal(TEST_PEER_ID, "");

        vm.prank(user1);
        vm.expectRevert(PortalRegistryErrors.PeerIdInUse.selector);
        registry.registerDirectPortal(TEST_PEER_ID, "");
    }

    function test_StakeToDirectPortal_Success() public {
        vm.prank(operator);
        address portalId = registry.registerDirectPortal(TEST_PEER_ID, "");

        vm.startPrank(operator);
        sqd.approve(address(registry), STAKE_AMOUNT);
        registry.stakeToDirectPortal(STAKE_AMOUNT);
        vm.stopPrank();

        IPortalRegistry.Portal memory portal = registry.getPortal(portalId);
        assertEq(portal.totalStaked, STAKE_AMOUNT);
        assertEq(registry.providerAllocations(portalId, operator), STAKE_AMOUNT);
    }

    function test_StakeToDirectPortal_ActivatesPortal() public {
        vm.prank(operator);
        address portalId = registry.registerDirectPortal(TEST_PEER_ID, "");

        vm.startPrank(operator);
        sqd.approve(address(registry), MIN_STAKE_THRESHOLD);

        vm.expectEmit(true, false, false, false);
        emit IPortalRegistry.PortalActivated(portalId);

        registry.stakeToDirectPortal(MIN_STAKE_THRESHOLD);
        vm.stopPrank();

        IPortalRegistry.Portal memory portal = registry.getPortal(portalId);
        assertTrue(portal.active);
    }

    function test_StakeToDirectPortal_RevertOnZeroAmount() public {
        vm.prank(operator);
        registry.registerDirectPortal(TEST_PEER_ID, "");

        vm.prank(operator);
        vm.expectRevert(PortalRegistryErrors.InvalidAmount.selector);
        registry.stakeToDirectPortal(0);
    }

    function test_StakeToDirectPortal_RevertOnNoDirectPortal() public {
        vm.prank(user1);
        vm.expectRevert(PortalRegistryErrors.NoDirectPortal.selector);
        registry.stakeToDirectPortal(STAKE_AMOUNT);
    }

    function test_UnstakeFromDirectPortal_Success() public {
        vm.startPrank(operator);
        address portalId = registry.registerDirectPortal(TEST_PEER_ID, "");
        sqd.approve(address(registry), MIN_STAKE_THRESHOLD);
        registry.stakeToDirectPortal(MIN_STAKE_THRESHOLD);

        uint256 balanceBefore = sqd.balanceOf(operator);

        uint256 unstakeAmount = MIN_STAKE_THRESHOLD / 2;
        registry.unstakeFromDirectPortal(unstakeAmount);
        vm.stopPrank();

        IPortalRegistry.Portal memory portal = registry.getPortal(portalId);
        assertEq(portal.totalStaked, MIN_STAKE_THRESHOLD - unstakeAmount);
        assertEq(sqd.balanceOf(operator), balanceBefore + unstakeAmount);
    }

    function test_UnstakeFromDirectPortal_DeactivatesPortal() public {
        vm.startPrank(operator);
        address portalId = registry.registerDirectPortal(TEST_PEER_ID, "");
        sqd.approve(address(registry), MIN_STAKE_THRESHOLD);
        registry.stakeToDirectPortal(MIN_STAKE_THRESHOLD);

        vm.expectEmit(true, false, false, false);
        emit IPortalRegistry.PortalDeactivated(portalId);

        registry.unstakeFromDirectPortal(MIN_STAKE_THRESHOLD);
        vm.stopPrank();

        IPortalRegistry.Portal memory portal = registry.getPortal(portalId);
        assertFalse(portal.active);
    }

    function test_UnstakeFromDirectPortal_RevertOnZeroAmount() public {
        vm.startPrank(operator);
        registry.registerDirectPortal(TEST_PEER_ID, "");
        sqd.approve(address(registry), STAKE_AMOUNT);
        registry.stakeToDirectPortal(STAKE_AMOUNT);

        vm.expectRevert(PortalRegistryErrors.InvalidAmount.selector);
        registry.unstakeFromDirectPortal(0);
        vm.stopPrank();
    }

    function test_UnstakeFromDirectPortal_RevertOnInsufficientAllocation() public {
        vm.startPrank(operator);
        registry.registerDirectPortal(TEST_PEER_ID, "");
        sqd.approve(address(registry), STAKE_AMOUNT);
        registry.stakeToDirectPortal(STAKE_AMOUNT);

        vm.expectRevert(PortalRegistryErrors.InsufficientAllocation.selector);
        registry.unstakeFromDirectPortal(STAKE_AMOUNT + 1);
        vm.stopPrank();
    }

    function test_RegisterPortal_Success() public {
        address portalAddress = _createPortal(operator, MIN_STAKE_THRESHOLD, "TestPortal");

        assertTrue(registry.isPortal(portalAddress));

        IPortalRegistry.Portal memory portal = registry.getPortal(portalAddress);
        assertEq(portal.operator, operator);
        assertEq(portal.portalAddress, portalAddress);
        assertTrue(portal.portalType == IPortalRegistry.PortalType.POOL);
    }

    function test_RegisterPortal_OnlyCallableByPortal() public {
        address portalAddress = _createPortal(operator, MIN_STAKE_THRESHOLD, "TestPortal");
        assertTrue(registry.isPortal(portalAddress));
    }

    function test_Stake_Success() public {
        address portalAddress = _createPortal(operator, MIN_STAKE_THRESHOLD, "TestPortal");

        vm.startPrank(user1);
        sqd.approve(portalAddress, STAKE_AMOUNT);
        IPortalPool(portalAddress).deposit(STAKE_AMOUNT);
        vm.stopPrank();

        IPortalRegistry.Portal memory portal = registry.getPortal(portalAddress);
        assertEq(portal.totalStaked, STAKE_AMOUNT);
    }

    function test_ActivatePortal_Success() public {
        address portalAddress = _createPortal(operator, MIN_STAKE_THRESHOLD, "TestPortal");

        vm.startPrank(user1);
        sqd.approve(portalAddress, MIN_STAKE_THRESHOLD);
        IPortalPool(portalAddress).deposit(MIN_STAKE_THRESHOLD);
        vm.stopPrank();

        IPortalRegistry.Portal memory portal = registry.getPortal(portalAddress);
        assertTrue(portal.active);
    }

    function test_GetComputationUnits_ReturnsZeroWhenInactive() public {
        address portalAddress = _createPortal(operator, MIN_STAKE_THRESHOLD, "TestPortal");

        uint256 cus = registry.getComputationUnits(portalAddress);
        assertEq(cus, 0);
    }

    function test_GetComputationUnits_ReturnsValueWhenActive() public {
        address portalAddress = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "TestPortal");

        uint256 cus = registry.getComputationUnits(portalAddress);
        assertTrue(cus > 0);
    }

    function test_GetDirectPortalId() public {
        vm.prank(operator);
        address portalId = registry.registerDirectPortal(TEST_PEER_ID, "");

        assertEq(registry.getDirectPortalId(operator), portalId);
        assertEq(registry.getDirectPortalId(user1), address(0));
    }

    function test_IsDirectPortal() public {
        vm.prank(operator);
        address directPortalId = registry.registerDirectPortal(TEST_PEER_ID, "");

        address poolPortalAddress = _createPortal(user1, MIN_STAKE_THRESHOLD, "PoolPortal");

        assertTrue(registry.isDirectPortal(directPortalId));
        assertFalse(registry.isDirectPortal(poolPortalAddress));
    }

    function test_SetMinStake_Success() public {
        uint256 newMinStake = 200_000 ether;

        vm.expectEmit(true, true, false, false);
        emit IPortalRegistry.MinStakeUpdated(MIN_STAKE_THRESHOLD, newMinStake);

        registry.setMinStake(newMinStake);

        assertEq(registry.minStake(), newMinStake);
    }

    function test_SetMinStake_RevertOnNonAdmin() public {
        vm.prank(user1);
        vm.expectRevert();
        registry.setMinStake(200_000 ether);
    }

    function test_SetMana_Success() public {
        uint256 newMana = 2000;

        vm.expectEmit(true, true, false, false);
        emit IPortalRegistry.ManaUpdated(MANA, newMana);

        registry.setMana(newMana);

        assertEq(registry.mana(), newMana);
    }

    function test_SetMana_RevertOnNonAdmin() public {
        vm.prank(user1);
        vm.expectRevert();
        registry.setMana(2000);
    }

    function test_SetPortalStatus_Success() public {
        address portalAddress = _createPortal(operator, MIN_STAKE_THRESHOLD, "TestPortal");
        assertTrue(registry.isPortal(portalAddress));

        vm.expectEmit(true, true, false, false);
        emit IPortalRegistry.PortalStatusChanged(portalAddress, false);

        registry.setPortalStatus(portalAddress, false);

        assertFalse(registry.isPortal(portalAddress));
    }

    function test_Pause_Success() public {
        registry.pause();
        assertTrue(registry.paused());
    }

    function test_Unpause_Success() public {
        registry.pause();
        registry.unpause();
        assertFalse(registry.paused());
    }

    function test_RegisterDirectPortal_RevertWhenPaused() public {
        registry.pause();

        vm.prank(operator);
        vm.expectRevert();
        registry.registerDirectPortal(TEST_PEER_ID, "");
    }

    function test_StakeToDirectPortal_RevertWhenPaused() public {
        vm.prank(operator);
        registry.registerDirectPortal(TEST_PEER_ID, "");

        registry.pause();

        vm.prank(operator);
        vm.expectRevert();
        registry.stakeToDirectPortal(STAKE_AMOUNT);
    }

    function test_WithdrawFailedPortal_Success() public {
        address portalAddress = _createPortal(operator, MIN_STAKE_THRESHOLD, "TestPortal");

        uint256 partialStake = MIN_STAKE_THRESHOLD / 2;
        vm.startPrank(user1);
        sqd.approve(portalAddress, partialStake);
        IPortalPool(portalAddress).deposit(partialStake);
        vm.stopPrank();

        _warpToAfterDeadline(portalAddress);

        assertEq(uint8(IPortalPool(portalAddress).getState()), uint8(IPortalPool.PortalState.FAILED));

        uint256 balanceBefore = sqd.balanceOf(user1);

        vm.prank(user1);
        IPortalPool(portalAddress).withdrawFromFailed();

        assertEq(sqd.balanceOf(user1), balanceBefore + partialStake);
    }

    function test_ImmediateUnlock_ReducesActiveStake() public {
        address portalAddress = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "TestPortal");

        uint256 activeStakeBefore = IPortalPool(portalAddress).getActiveStake();
        assertEq(activeStakeBefore, MIN_STAKE_THRESHOLD);

        vm.startPrank(user1);
        IPortalPool(portalAddress).requestExit(MIN_STAKE_THRESHOLD);
        vm.stopPrank();

        uint256 activeStakeAfter = IPortalPool(portalAddress).getActiveStake();
        assertEq(activeStakeAfter, 0);
    }

    function test_RegisterPortal_RevertOnZeroOperator() public {
        vm.prank(address(0x999));
        vm.expectRevert(PortalRegistryErrors.OnlyPortal.selector);
        registry.registerPortalPool(TEST_PEER_ID, address(0x888), address(0), "");
    }

    function test_RegisterPortal_RevertOnEmptyPeerId() public {
        vm.prank(address(0x999));
        vm.expectRevert(PortalRegistryErrors.InvalidPeerId.selector);
        registry.registerPortalPool("", address(0x999), operator, "");
    }

    function test_Stake_RevertOnNonPortal() public {
        vm.prank(user1);
        vm.expectRevert(PortalRegistryErrors.PortalNotRegistered.selector);
        registry.stake(user1, user1, STAKE_AMOUNT);
    }

    function test_Stake_RevertOnZeroAmount() public {
        address portalAddress = _createPortal(operator, MIN_STAKE_THRESHOLD, "TestPortal");
        vm.prank(portalAddress);
        vm.expectRevert(PortalRegistryErrors.InvalidAmount.selector);
        registry.stake(portalAddress, user1, 0);
    }

    function test_ActivatePortalPool_RevertOnNonPortal() public {
        vm.prank(user1);
        vm.expectRevert(PortalRegistryErrors.PortalNotRegistered.selector);
        registry.activatePortalPool();
    }

    function test_ActivatePortalPool_RevertOnDirectPortal() public {
        vm.prank(operator);
        address directPortalId = registry.registerDirectPortal(TEST_PEER_ID, "");

        vm.prank(directPortalId);
        vm.expectRevert(PortalRegistryErrors.OnlyPoolPortal.selector);
        registry.activatePortalPool();
    }

    function test_ActivatePortalPool_NoOpWhenAlreadyActive() public {
        address portalAddress = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "TestPortal");

        IPortalRegistry.Portal memory portalBefore = registry.getPortal(portalAddress);
        assertTrue(portalBefore.active);

        vm.prank(portalAddress);
        registry.activatePortalPool();

        IPortalRegistry.Portal memory portalAfter = registry.getPortal(portalAddress);
        assertTrue(portalAfter.active);
    }

    function test_StakePoolFunds_RevertOnNonPortal() public {
        vm.prank(user1);
        vm.expectRevert(PortalRegistryErrors.PortalNotRegistered.selector);
        registry.stakePoolFunds(STAKE_AMOUNT);
    }

    function test_StakePoolFunds_RevertOnDirectPortal() public {
        vm.prank(operator);
        address directPortalId = registry.registerDirectPortal(TEST_PEER_ID, "");

        vm.prank(directPortalId);
        vm.expectRevert(PortalRegistryErrors.OnlyPoolPortal.selector);
        registry.stakePoolFunds(STAKE_AMOUNT);
    }

    function test_WithdrawFailedPortal_RevertOnNonPortal() public {
        vm.prank(user1);
        vm.expectRevert(PortalRegistryErrors.PortalNotRegistered.selector);
        registry.withdrawFailedPortal(user1, STAKE_AMOUNT);
    }

    function test_ImmediateUnlock_RevertOnNonPortal() public {
        vm.prank(user1);
        vm.expectRevert(PortalRegistryErrors.PortalNotRegistered.selector);
        registry.immediateUnlock(user1, STAKE_AMOUNT);
    }

    function test_ImmediateUnlock_RevertOnInsufficientAllocation() public {
        address portalAddress = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "TestPortal");

        vm.prank(portalAddress);
        vm.expectRevert(PortalRegistryErrors.InsufficientAllocation.selector);
        registry.immediateUnlock(user2, STAKE_AMOUNT);
    }

    function test_UnstakeFromDirectPortal_RevertWhenPaused() public {
        vm.startPrank(operator);
        registry.registerDirectPortal(TEST_PEER_ID, "");
        sqd.approve(address(registry), STAKE_AMOUNT);
        registry.stakeToDirectPortal(STAKE_AMOUNT);
        vm.stopPrank();

        registry.pause();

        vm.prank(operator);
        vm.expectRevert();
        registry.unstakeFromDirectPortal(STAKE_AMOUNT);
    }

    function test_UnstakeFromDirectPortal_RevertOnNoDirectPortal() public {
        vm.prank(user1);
        vm.expectRevert(PortalRegistryErrors.NoDirectPortal.selector);
        registry.unstakeFromDirectPortal(STAKE_AMOUNT);
    }

    function test_Pause_RevertOnNonPauser() public {
        vm.prank(user1);
        vm.expectRevert();
        registry.pause();
    }

    function test_Unpause_RevertOnNonPauser() public {
        registry.pause();
        vm.prank(user1);
        vm.expectRevert();
        registry.unpause();
    }

    function test_SetPortalStatus_RevertOnNonAdmin() public {
        address portalAddress = _createPortal(operator, MIN_STAKE_THRESHOLD, "TestPortal");
        vm.prank(user1);
        vm.expectRevert();
        registry.setPortalStatus(portalAddress, false);
    }

    function test_StakeToDirectPortal_MultipleStakes() public {
        vm.prank(operator);
        address portalId = registry.registerDirectPortal(TEST_PEER_ID, "");

        vm.startPrank(operator);
        sqd.approve(address(registry), STAKE_AMOUNT * 2);
        registry.stakeToDirectPortal(STAKE_AMOUNT);
        registry.stakeToDirectPortal(STAKE_AMOUNT);
        vm.stopPrank();

        IPortalRegistry.Portal memory portal = registry.getPortal(portalId);
        assertEq(portal.totalStaked, STAKE_AMOUNT * 2);
    }

    function test_UnstakeFromDirectPortal_PartialUnstake() public {
        uint256 stakeAmount = MIN_STAKE_THRESHOLD * 2;
        vm.startPrank(operator);
        address portalId = registry.registerDirectPortal(TEST_PEER_ID, "");
        sqd.approve(address(registry), stakeAmount);
        registry.stakeToDirectPortal(stakeAmount);

        uint256 partialAmount = MIN_STAKE_THRESHOLD / 4;
        registry.unstakeFromDirectPortal(partialAmount);
        vm.stopPrank();

        IPortalRegistry.Portal memory portal = registry.getPortal(portalId);
        assertTrue(portal.active);
        assertEq(portal.totalStaked, stakeAmount - partialAmount);
    }

    function test_WithdrawFailedPortal_RevertOnInsufficientAllocation() public {
        address portalAddress = _createPortal(operator, MIN_STAKE_THRESHOLD, "TestPortal");

        uint256 partialStake = MIN_STAKE_THRESHOLD / 2;
        vm.startPrank(user1);
        sqd.approve(portalAddress, partialStake);
        IPortalPool(portalAddress).deposit(partialStake);
        vm.stopPrank();

        _warpToAfterDeadline(portalAddress);

        vm.prank(portalAddress);
        vm.expectRevert(PortalRegistryErrors.InsufficientAllocation.selector);
        registry.withdrawFailedPortal(user2, partialStake);
    }

    function test_RegisterPortal_RevertOnPortalAlreadyRegistered() public {
        address portalAddress = _createPortal(operator, MIN_STAKE_THRESHOLD, "TestPortal");

        vm.prank(portalAddress);
        vm.expectRevert(PortalRegistryErrors.PortalAlreadyRegistered.selector);
        registry.registerPortalPool(TEST_PEER_ID_2, portalAddress, operator, "");
    }
}
