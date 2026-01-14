// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./BaseTest.sol";
import {PortalRegistryErrors} from "../src/libs/PortalRegistryErrors.sol";
import {IPortalRegistry} from "../src/interfaces/IPortalRegistry.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract PortalRegistryTest is BaseTest {
    bytes public constant TEST_PEER_ID = "test-peer-id-12345";
    bytes public constant TEST_PEER_ID_2 = "test-peer-id-67890";

    function setUp() public override {
        super.setUp();
    }

    function test_Constructor_SetsCorrectValues() public view {
        assertEq(address(registry.SQD()), address(sqd));
        assertEq(registry.minStake(), MIN_STAKE_THRESHOLD);
        assertEq(registry.mana(), MANA);
    }

    function test_Initialize_RevertOnZeroSQD() public {
        PortalRegistry newRegistryImpl = new PortalRegistry();
        vm.expectRevert(PortalRegistryErrors.InvalidAddress.selector);
        new ERC1967Proxy(
            address(newRegistryImpl),
            abi.encodeWithSelector(PortalRegistry.initialize.selector, address(0), MIN_STAKE_THRESHOLD, MANA)
        );
    }

    function test_RegisterCluster_Success() public {
        address clusterAddress = _createPortal(operator, MIN_STAKE_THRESHOLD, "TestCluster");

        assertTrue(registry.isCluster(clusterAddress));

        IPortalRegistry.Cluster memory cluster = registry.getClusterByAddress(clusterAddress);
        assertEq(cluster.operator, operator);
        assertEq(cluster.clusterAddress, clusterAddress);
    }

    function test_RegisterCluster_OnlyCallableByFactory() public {
        address clusterAddress = _createPortal(operator, MIN_STAKE_THRESHOLD, "TestCluster");
        assertTrue(registry.isCluster(clusterAddress));
    }

    function test_RegisterCluster_RevertOnZeroOperator() public {
        vm.prank(address(factory));
        vm.expectRevert(PortalRegistryErrors.InvalidAddress.selector);
        registry.registerCluster(address(0x888), address(0), "");
    }

    function test_RegisterCluster_RevertOnZeroClusterAddress() public {
        vm.prank(address(factory));
        vm.expectRevert(PortalRegistryErrors.InvalidAddress.selector);
        registry.registerCluster(address(0), operator, "");
    }

    function test_RegisterCluster_RevertOnNotFactory() public {
        vm.prank(address(0x999));
        vm.expectRevert(PortalRegistryErrors.OnlyFactory.selector);
        registry.registerCluster(address(0x888), operator, "");
    }

    function test_RegisterCluster_RevertOnClusterAlreadyRegistered() public {
        address clusterAddress = _createPortal(operator, MIN_STAKE_THRESHOLD, "TestCluster");

        vm.prank(address(factory));
        vm.expectRevert(PortalRegistryErrors.ClusterAlreadyRegistered.selector);
        registry.registerCluster(clusterAddress, operator, "");
    }

    function test_Stake_Success() public {
        address clusterAddress = _createPortal(operator, MIN_STAKE_THRESHOLD, "TestCluster");

        vm.startPrank(user1);
        sqd.approve(clusterAddress, STAKE_AMOUNT);
        IPortalPool(clusterAddress).deposit(STAKE_AMOUNT);
        vm.stopPrank();

        IPortalRegistry.Cluster memory cluster = registry.getClusterByAddress(clusterAddress);
        assertEq(cluster.totalStaked, STAKE_AMOUNT);
    }

    function test_Stake_RevertOnNonCluster() public {
        vm.prank(user1);
        vm.expectRevert(PortalRegistryErrors.ClusterNotRegistered.selector);
        registry.stake(STAKE_AMOUNT);
    }

    function test_ActivateCluster_Success() public {
        address clusterAddress = _createPortal(operator, MIN_STAKE_THRESHOLD, "TestCluster");

        vm.startPrank(user1);
        sqd.approve(clusterAddress, MIN_STAKE_THRESHOLD);
        IPortalPool(clusterAddress).deposit(MIN_STAKE_THRESHOLD);
        vm.stopPrank();

        IPortalRegistry.Cluster memory cluster = registry.getClusterByAddress(clusterAddress);
        assertTrue(cluster.active);
    }

    function test_Unstake_Success() public {
        address clusterAddress = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "TestCluster");

        // user1 balance after deposit (made in _createAndActivatePortal)
        uint256 balanceAfterDeposit = sqd.balanceOf(user1);

        vm.startPrank(user1);
        IPortalPool(clusterAddress).requestExit(MIN_STAKE_THRESHOLD);
        vm.stopPrank();

        // warp past exit queue
        vm.warp(block.timestamp + 365 days);

        vm.startPrank(user1);
        IPortalPool(clusterAddress).withdrawExit(0);
        vm.stopPrank();

        // user should get their deposit back
        assertEq(sqd.balanceOf(user1), balanceAfterDeposit + MIN_STAKE_THRESHOLD);
    }

    function test_Unstake_RevertOnNonCluster() public {
        vm.prank(user1);
        vm.expectRevert(PortalRegistryErrors.ClusterNotRegistered.selector);
        registry.unstake(user1, STAKE_AMOUNT);
    }

    function test_Unstake_RevertOnInsufficientAllocation() public {
        address clusterAddress = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "TestCluster");

        vm.prank(clusterAddress);
        vm.expectRevert(PortalRegistryErrors.InsufficientAllocation.selector);
        registry.unstake(user1, MIN_STAKE_THRESHOLD + 1);
    }

    function test_GetComputationUnits_ReturnsZeroWhenInactive() public {
        address clusterAddress = _createPortal(operator, MIN_STAKE_THRESHOLD, "TestCluster");
        bytes32 clusterId = registry.getClusterIdByAddress(clusterAddress);

        uint256 cus = registry.getComputationUnits(clusterId);
        assertEq(cus, 0);
    }

    function test_GetComputationUnits_ReturnsValueWhenActive() public {
        address clusterAddress = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "TestCluster");
        bytes32 clusterId = registry.getClusterIdByAddress(clusterAddress);

        uint256 cus = registry.getComputationUnits(clusterId);
        assertTrue(cus > 0);
    }

    function test_AddPortal_Success() public {
        address clusterAddress = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "TestCluster");
        bytes32 clusterId = registry.getClusterIdByAddress(clusterAddress);

        vm.prank(operator);
        registry.addPortal(clusterId, TEST_PEER_ID, "metadata");

        IPortalRegistry.Portal[] memory portals = registry.getClusterPortals(clusterId);
        assertEq(portals.length, 1);
        assertEq(keccak256(portals[0].peerId), keccak256(TEST_PEER_ID));
    }

    function test_AddPortal_RevertOnInvalidPeerId() public {
        address clusterAddress = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "TestCluster");
        bytes32 clusterId = registry.getClusterIdByAddress(clusterAddress);

        vm.prank(operator);
        vm.expectRevert(PortalRegistryErrors.InvalidPeerId.selector);
        registry.addPortal(clusterId, "", "metadata");
    }

    function test_AddPortal_RevertOnPeerIdInUse() public {
        address clusterAddress = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "TestCluster");
        bytes32 clusterId = registry.getClusterIdByAddress(clusterAddress);

        vm.prank(operator);
        registry.addPortal(clusterId, TEST_PEER_ID, "metadata");

        vm.prank(operator);
        vm.expectRevert(PortalRegistryErrors.PeerIdInUse.selector);
        registry.addPortal(clusterId, TEST_PEER_ID, "metadata2");
    }

    function test_AddPortal_RevertOnNotOperator() public {
        address clusterAddress = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "TestCluster");
        bytes32 clusterId = registry.getClusterIdByAddress(clusterAddress);

        vm.prank(user1);
        vm.expectRevert(PortalRegistryErrors.NotClusterOperator.selector);
        registry.addPortal(clusterId, TEST_PEER_ID, "metadata");
    }

    function test_RemovePortal_Success() public {
        address clusterAddress = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "TestCluster");
        bytes32 clusterId = registry.getClusterIdByAddress(clusterAddress);

        vm.prank(operator);
        registry.addPortal(clusterId, TEST_PEER_ID, "metadata");

        vm.prank(operator);
        registry.removePortal(clusterId, 0);

        IPortalRegistry.Portal[] memory portals = registry.getClusterPortals(clusterId);
        assertEq(portals.length, 0);
    }

    function test_RemovePortal_RevertOnInvalidIndex() public {
        address clusterAddress = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "TestCluster");
        bytes32 clusterId = registry.getClusterIdByAddress(clusterAddress);

        vm.prank(operator);
        vm.expectRevert(PortalRegistryErrors.InvalidPortalIndex.selector);
        registry.removePortal(clusterId, 0);
    }

    function test_SetClusterMetadata_Success() public {
        address clusterAddress = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "TestCluster");
        bytes32 clusterId = registry.getClusterIdByAddress(clusterAddress);

        vm.prank(operator);
        registry.setClusterMetadata(clusterId, "new metadata");

        IPortalRegistry.Cluster memory cluster = registry.getCluster(clusterId);
        assertEq(cluster.metadata, "new metadata");
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

    function test_SetFactory_Success() public {
        address newFactory = address(0x123);

        vm.expectEmit(true, true, false, false);
        emit IPortalRegistry.FactoryUpdated(address(factory), newFactory);

        registry.setFactory(newFactory);

        assertEq(registry.factory(), newFactory);
    }

    function test_SetFactory_RevertOnZeroAddress() public {
        vm.expectRevert(PortalRegistryErrors.InvalidAddress.selector);
        registry.setFactory(address(0));
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

    function test_RegisterCluster_RevertWhenPaused() public {
        registry.pause();

        vm.prank(address(factory));
        vm.expectRevert();
        registry.registerCluster(address(0x888), operator, "");
    }

    function test_WithdrawFromFailed_Success() public {
        address clusterAddress = _createPortal(operator, MIN_STAKE_THRESHOLD, "TestCluster");

        uint256 partialStake = MIN_STAKE_THRESHOLD / 2;
        vm.startPrank(user1);
        sqd.approve(clusterAddress, partialStake);
        IPortalPool(clusterAddress).deposit(partialStake);
        vm.stopPrank();

        _warpToAfterDeadline(clusterAddress);

        assertEq(uint8(IPortalPool(clusterAddress).getState()), uint8(IPortalPool.PoolState.FAILED));

        uint256 balanceBefore = sqd.balanceOf(user1);

        vm.prank(user1);
        IPortalPool(clusterAddress).withdrawFromFailed();

        assertEq(sqd.balanceOf(user1), balanceBefore + partialStake);
    }

    function test_GetClusterIdByPeerId() public {
        address clusterAddress = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "TestCluster");
        bytes32 clusterId = registry.getClusterIdByAddress(clusterAddress);

        vm.prank(operator);
        registry.addPortal(clusterId, TEST_PEER_ID, "metadata");

        bytes32 foundClusterId = registry.getClusterIdByPeerId(TEST_PEER_ID);
        assertEq(foundClusterId, clusterId);
    }

    function test_GetOperatorClusters() public {
        _createPortal(operator, MIN_STAKE_THRESHOLD, "Cluster1");
        _createPortal(operator, MIN_STAKE_THRESHOLD, "Cluster2");

        bytes32[] memory clusters = registry.getOperatorClusters(operator);
        assertEq(clusters.length, 2);
    }

    function test_SetPortalMetadata_Success() public {
        address clusterAddress = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "MetadataCluster");
        bytes32 clusterId = registry.getClusterIdByAddress(clusterAddress);

        vm.prank(operator);
        registry.addPortal(clusterId, TEST_PEER_ID, "initial metadata");

        string memory newMetadata = "updated metadata";

        vm.expectEmit(true, false, false, true);
        emit IPortalRegistry.PortalMetadataUpdated(clusterId, 0, newMetadata);

        vm.prank(operator);
        registry.setPortalMetadata(clusterId, 0, newMetadata);

        IPortalRegistry.Portal[] memory portals = registry.getClusterPortals(clusterId);
        assertEq(portals[0].metadata, newMetadata);
    }

    function test_SetPortalMetadata_RevertOnClusterNotRegistered() public {
        bytes32 invalidClusterId = bytes32(0);

        vm.prank(operator);
        vm.expectRevert(PortalRegistryErrors.ClusterNotRegistered.selector);
        registry.setPortalMetadata(invalidClusterId, 0, "metadata");
    }

    function test_SetPortalMetadata_RevertOnNotClusterOperator() public {
        address clusterAddress = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "OpTest");
        bytes32 clusterId = registry.getClusterIdByAddress(clusterAddress);

        vm.prank(operator);
        registry.addPortal(clusterId, TEST_PEER_ID, "metadata");

        vm.prank(user1);
        vm.expectRevert(PortalRegistryErrors.NotClusterOperator.selector);
        registry.setPortalMetadata(clusterId, 0, "new metadata");
    }

    function test_SetPortalMetadata_RevertOnInvalidPortalIndex() public {
        address clusterAddress = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "IndexTest");
        bytes32 clusterId = registry.getClusterIdByAddress(clusterAddress);

        vm.prank(operator);
        registry.addPortal(clusterId, TEST_PEER_ID, "metadata");

        vm.prank(operator);
        vm.expectRevert(PortalRegistryErrors.InvalidPortalIndex.selector);
        registry.setPortalMetadata(clusterId, 1, "new metadata"); // Index 1 doesn't exist
    }

    function test_GetPortalCount_ReturnsZeroWhenEmpty() public {
        address clusterAddress = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "CountTest");
        bytes32 clusterId = registry.getClusterIdByAddress(clusterAddress);

        assertEq(registry.getPortalCount(clusterId), 0);
    }

    function test_GetPortalCount_ReturnsCorrectCount() public {
        address clusterAddress = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "CountTest2");
        bytes32 clusterId = registry.getClusterIdByAddress(clusterAddress);

        vm.startPrank(operator);
        registry.addPortal(clusterId, "peer-1", "metadata1");
        assertEq(registry.getPortalCount(clusterId), 1);

        registry.addPortal(clusterId, "peer-2", "metadata2");
        assertEq(registry.getPortalCount(clusterId), 2);

        registry.addPortal(clusterId, "peer-3", "metadata3");
        assertEq(registry.getPortalCount(clusterId), 3);
        vm.stopPrank();
    }

    function test_GetPortalCount_ReturnsZeroForNonExistentCluster() public view {
        bytes32 invalidClusterId = bytes32(uint256(12345));
        assertEq(registry.getPortalCount(invalidClusterId), 0);
    }

    function test_AddPortal_RevertOnMaxPortalsReached() public {
        address clusterAddress = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "MaxPortals");
        bytes32 clusterId = registry.getClusterIdByAddress(clusterAddress);

        // Add MAX_PORTALS_PER_CLUSTER (10) portals
        vm.startPrank(operator);
        for (uint256 i = 0; i < 10; i++) {
            bytes memory peerId = abi.encodePacked("peer-", i);
            registry.addPortal(clusterId, peerId, "metadata");
        }
        vm.stopPrank();

        assertEq(registry.getPortalCount(clusterId), 10);

        // 11th portal should fail
        vm.prank(operator);
        vm.expectRevert(PortalRegistryErrors.MaxPortalsReached.selector);
        registry.addPortal(clusterId, "peer-overflow", "metadata");
    }

    function test_RemovePortal_RevertOnClusterNotRegistered() public {
        bytes32 invalidClusterId = bytes32(uint256(99999));

        vm.expectRevert(PortalRegistryErrors.ClusterNotRegistered.selector);
        registry.removePortal(invalidClusterId, 0);
    }

    function test_RemovePortal_RevertOnNotClusterOperator() public {
        address clusterAddress = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "RemoveOp");
        bytes32 clusterId = registry.getClusterIdByAddress(clusterAddress);

        // Add a portal
        vm.prank(operator);
        registry.addPortal(clusterId, "peer-remove", "metadata");

        // Non-operator tries to remove
        vm.prank(user1);
        vm.expectRevert(PortalRegistryErrors.NotClusterOperator.selector);
        registry.removePortal(clusterId, 0);
    }

    function test_RemovePortal_SwapBranch() public {
        address clusterAddress = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "RemoveSwap");
        bytes32 clusterId = registry.getClusterIdByAddress(clusterAddress);

        // Add 3 portals
        vm.startPrank(operator);
        registry.addPortal(clusterId, "peer-0", "meta0");
        registry.addPortal(clusterId, "peer-1", "meta1");
        registry.addPortal(clusterId, "peer-2", "meta2");
        vm.stopPrank();

        assertEq(registry.getPortalCount(clusterId), 3);

        // Remove portal at index 0 (not last) - triggers swap branch
        vm.prank(operator);
        registry.removePortal(clusterId, 0);

        // Should have 2 portals left
        assertEq(registry.getPortalCount(clusterId), 2);
    }

    function test_SetClusterMetadata_RevertOnClusterNotRegistered() public {
        bytes32 invalidClusterId = bytes32(uint256(88888));

        vm.expectRevert(PortalRegistryErrors.ClusterNotRegistered.selector);
        registry.setClusterMetadata(invalidClusterId, "new metadata");
    }

    function test_SetClusterMetadata_RevertOnNotClusterOperator() public {
        address clusterAddress = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "ClusterMeta");
        bytes32 clusterId = registry.getClusterIdByAddress(clusterAddress);

        // Non-operator tries to set metadata
        vm.prank(user1);
        vm.expectRevert(PortalRegistryErrors.NotClusterOperator.selector);
        registry.setClusterMetadata(clusterId, "unauthorized");
    }
}
