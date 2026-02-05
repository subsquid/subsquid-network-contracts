// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./BaseTest.sol";
import {PoolErrors} from "../src/libs/PoolErrors.sol";
import {PortalRegistryErrors} from "../src/libs/PortalRegistryErrors.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

contract OperatorTransferEdgeCasesTest is BaseTest {
    address public portal;
    address public newOperator = address(0x999);

    function setUp() public override {
        super.setUp();
        portal = _createPortal(operator, MIN_STAKE_THRESHOLD, "TEST");
        vm.label(newOperator, "NewOperator");
    }

    function test_transferOperator_bypassesMaxClustersLimit() public {
        for (uint256 i = 0; i < 100; i++) {
            _createPortal(newOperator, MIN_STAKE_THRESHOLD, string(abi.encodePacked("POOL", i)));
        }

        bytes32[] memory clusters = registry.getOperatorClusters(newOperator);
        assertEq(clusters.length, 100);

        vm.prank(operator);
        PortalPoolImplementation(portal).transferOperator(newOperator);

        clusters = registry.getOperatorClusters(newOperator);
        assertEq(clusters.length, 101);
    }

    function test_transferOperator_oldOperatorNotAutoRemovedFromWhitelist() public {
        address largeCapacityPortal = _createPortal(operator, MIN_STAKE_THRESHOLD * 2, "LARGE");

        vm.startPrank(operator);
        PortalPoolImplementation(largeCapacityPortal).setWhitelistEnabled(true);
        address[] memory toWhitelist = new address[](2);
        toWhitelist[0] = operator;
        toWhitelist[1] = user1;
        PortalPoolImplementation(largeCapacityPortal).addToWhitelist(toWhitelist);
        vm.stopPrank();

        assertTrue(PortalPoolImplementation(largeCapacityPortal).isWhitelisted(operator));

        vm.prank(operator);
        PortalPoolImplementation(largeCapacityPortal).transferOperator(newOperator);

        assertTrue(PortalPoolImplementation(largeCapacityPortal).isWhitelisted(newOperator));
        assertTrue(PortalPoolImplementation(largeCapacityPortal).isWhitelisted(operator));

        vm.startPrank(user1);
        sqd.approve(largeCapacityPortal, MIN_STAKE_THRESHOLD);
        IPortalPool(largeCapacityPortal).deposit(MIN_STAKE_THRESHOLD);
        vm.stopPrank();

        vm.startPrank(operator);
        sqd.approve(largeCapacityPortal, MIN_STAKE_THRESHOLD);
        IPortalPool(largeCapacityPortal).deposit(MIN_STAKE_THRESHOLD);
        vm.stopPrank();
    }

    function test_transferOperator_worksInCollectingState() public {
        assertEq(uint256(IPortalPool(portal).getState()), uint256(IPortalPool.PoolState.COLLECTING));

        vm.prank(operator);
        PortalPoolImplementation(portal).transferOperator(newOperator);

        assertEq(PortalPoolImplementation(portal).getOperator(), newOperator);
    }

    function test_transferOperator_worksInActiveState() public {
        vm.startPrank(user1);
        sqd.approve(portal, MIN_STAKE_THRESHOLD);
        IPortalPool(portal).deposit(MIN_STAKE_THRESHOLD);
        vm.stopPrank();

        assertEq(uint256(IPortalPool(portal).getState()), uint256(IPortalPool.PoolState.ACTIVE));

        vm.prank(operator);
        PortalPoolImplementation(portal).transferOperator(newOperator);

        assertEq(PortalPoolImplementation(portal).getOperator(), newOperator);
    }

    function test_transferOperator_worksInIdleState() public {
        vm.startPrank(user1);
        sqd.approve(portal, MIN_STAKE_THRESHOLD);
        IPortalPool(portal).deposit(MIN_STAKE_THRESHOLD);
        vm.stopPrank();

        vm.startPrank(user1);
        IPortalPool(portal).requestExit(MIN_STAKE_THRESHOLD);
        vm.stopPrank();

        vm.warp(block.timestamp + 30 days);

        vm.prank(user1);
        IPortalPool(portal).withdrawExit(0);

        assertEq(uint256(IPortalPool(portal).getState()), uint256(IPortalPool.PoolState.IDLE));

        vm.prank(operator);
        PortalPoolImplementation(portal).transferOperator(newOperator);

        assertEq(PortalPoolImplementation(portal).getOperator(), newOperator);
    }

    function test_transferOperator_revertsInFailedState() public {
        vm.warp(block.timestamp + 31 days);

        assertEq(uint256(IPortalPool(portal).getState()), uint256(IPortalPool.PoolState.FAILED));

        vm.prank(operator);
        vm.expectRevert(PoolErrors.InvalidState.selector);
        PortalPoolImplementation(portal).transferOperator(newOperator);

        // Operator unchanged
        assertEq(PortalPoolImplementation(portal).getOperator(), operator);
    }

    function test_transferOperator_revertsInClosedState() public {
        vm.startPrank(user1);
        sqd.approve(portal, MIN_STAKE_THRESHOLD);
        IPortalPool(portal).deposit(MIN_STAKE_THRESHOLD);
        vm.stopPrank();

        PortalPoolImplementation(portal).closePool();

        assertEq(uint256(IPortalPool(portal).getState()), uint256(IPortalPool.PoolState.CLOSED));

        vm.prank(operator);
        vm.expectRevert(PoolErrors.PoolClosed.selector);
        PortalPoolImplementation(portal).transferOperator(newOperator);

        // Operator unchanged
        assertEq(PortalPoolImplementation(portal).getOperator(), operator);
    }

    function test_transferOperator_registryFunctionsWorkForNewOperator() public {
        bytes32 clusterId = registry.getClusterIdByAddress(portal);

        vm.prank(operator);
        PortalPoolImplementation(portal).transferOperator(newOperator);

        vm.prank(newOperator);
        registry.addPortal(clusterId, "peer123", "metadata");

        vm.prank(newOperator);
        registry.setClusterMetadata(clusterId, "new metadata");

        vm.prank(newOperator);
        registry.removePortal(clusterId, 0);
    }

    function test_transferOperator_registryFunctionsRevertForOldOperator() public {
        bytes32 clusterId = registry.getClusterIdByAddress(portal);

        vm.prank(operator);
        PortalPoolImplementation(portal).transferOperator(newOperator);

        vm.prank(operator);
        vm.expectRevert(PortalRegistryErrors.NotClusterOperator.selector);
        registry.addPortal(clusterId, "peer123", "metadata");

        vm.prank(operator);
        vm.expectRevert(PortalRegistryErrors.NotClusterOperator.selector);
        registry.setClusterMetadata(clusterId, "should fail");
    }

    function test_transferOperator_poolAndRegistryStayConsistent() public {
        bytes32 clusterId = registry.getClusterIdByAddress(portal);

        assertEq(PortalPoolImplementation(portal).getOperator(), operator);
        IPortalRegistry.Cluster memory cluster = registry.getCluster(clusterId);
        assertEq(cluster.operator, operator);

        vm.prank(operator);
        PortalPoolImplementation(portal).transferOperator(newOperator);

        assertEq(PortalPoolImplementation(portal).getOperator(), newOperator);
        cluster = registry.getCluster(clusterId);
        assertEq(cluster.operator, newOperator);

        bytes32[] memory oldOpClusters = registry.getOperatorClusters(operator);
        bytes32[] memory newOpClusters = registry.getOperatorClusters(newOperator);

        bool foundInOld = false;
        for (uint256 i = 0; i < oldOpClusters.length; i++) {
            if (oldOpClusters[i] == clusterId) foundInOld = true;
        }
        assertFalse(foundInOld);

        bool foundInNew = false;
        for (uint256 i = 0; i < newOpClusters.length; i++) {
            if (newOpClusters[i] == clusterId) foundInNew = true;
        }
        assertTrue(foundInNew);
    }

    function test_updateClusterOperator_revertIfCalledByNonPool() public {
        vm.prank(operator);
        vm.expectRevert(PortalRegistryErrors.ClusterNotRegistered.selector);
        registry.updateClusterOperator(newOperator);

        vm.expectRevert(PortalRegistryErrors.ClusterNotRegistered.selector);
        registry.updateClusterOperator(newOperator);
    }

    function test_transferOperator_revertsWhenPoolIsPaused() public {
        PortalPoolImplementation(portal).pause();
        assertTrue(PortalPoolImplementation(portal).paused());

        vm.prank(operator);
        vm.expectRevert();
        PortalPoolImplementation(portal).transferOperator(newOperator);

        // Operator unchanged
        assertEq(PortalPoolImplementation(portal).getOperator(), operator);
    }

    function test_transferOperator_canTransferToContractAddress() public {
        address contractOperator = address(new MockOperatorContract());
        vm.label(contractOperator, "ContractOperator");

        vm.prank(operator);
        PortalPoolImplementation(portal).transferOperator(contractOperator);

        assertEq(PortalPoolImplementation(portal).getOperator(), contractOperator);
    }

    function test_transferOperator_rapidSuccessiveTransfers() public {
        address op2 = address(0x222);
        address op3 = address(0x333);
        address op4 = address(0x444);

        vm.prank(operator);
        PortalPoolImplementation(portal).transferOperator(newOperator);

        vm.prank(newOperator);
        PortalPoolImplementation(portal).transferOperator(op2);

        vm.prank(op2);
        PortalPoolImplementation(portal).transferOperator(op3);

        vm.prank(op3);
        PortalPoolImplementation(portal).transferOperator(op4);

        assertEq(PortalPoolImplementation(portal).getOperator(), op4);

        bytes32 clusterId = registry.getClusterIdByAddress(portal);
        bytes32[] memory opClusters = registry.getOperatorClusters(operator);
        bytes32[] memory newOpClusters = registry.getOperatorClusters(newOperator);
        bytes32[] memory op2Clusters = registry.getOperatorClusters(op2);
        bytes32[] memory op3Clusters = registry.getOperatorClusters(op3);
        bytes32[] memory op4Clusters = registry.getOperatorClusters(op4);

        assertEq(opClusters.length, 0);
        assertEq(newOpClusters.length, 0);
        assertEq(op2Clusters.length, 0);
        assertEq(op3Clusters.length, 0);
        assertEq(op4Clusters.length, 1);
        assertEq(op4Clusters[0], clusterId);
    }

    function test_transferOperator_canTransferBackToOriginal() public {
        vm.prank(operator);
        PortalPoolImplementation(portal).transferOperator(newOperator);

        assertEq(PortalPoolImplementation(portal).getOperator(), newOperator);

        vm.prank(newOperator);
        PortalPoolImplementation(portal).transferOperator(operator);

        assertEq(PortalPoolImplementation(portal).getOperator(), operator);

        vm.startPrank(user1);
        sqd.approve(portal, MIN_STAKE_THRESHOLD);
        IPortalPool(portal).deposit(MIN_STAKE_THRESHOLD);
        vm.stopPrank();

        vm.startPrank(operator);
        usdc.mint(operator, 1000e6);
        usdc.approve(portal, 1000e6);
        PortalPoolImplementation(portal).topUpRewards(1000e6);
        vm.stopPrank();
    }

    function test_registryAlwaysReadsLiveOperatorFromPool() public {
        bytes32 clusterId = registry.getClusterIdByAddress(portal);

        vm.prank(operator);
        registry.addPortal(clusterId, "peer1", "meta1");

        vm.prank(operator);
        PortalPoolImplementation(portal).transferOperator(newOperator);

        vm.prank(operator);
        vm.expectRevert(PortalRegistryErrors.NotClusterOperator.selector);
        registry.addPortal(clusterId, "peer2", "meta2");

        vm.prank(newOperator);
        registry.addPortal(clusterId, "peer2", "meta2");
    }
}

contract MockOperatorContract {}
