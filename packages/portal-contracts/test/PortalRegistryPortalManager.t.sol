// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./BaseTest.sol";
import {PortalRegistryErrors} from "../src/libs/PortalRegistryErrors.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

/// @notice Third-party pool hardening of PortalRegistry:
///         1. only PORTAL_MANAGER_ROLE binds peer IDs (addPortal),
///         2. PORTAL_MANAGER_ROLE can remove any portal (forceRemovePortal),
///         3. metadata and peer IDs have length caps on every write path.
contract PortalRegistryPortalManagerTest is BaseTest {
    bytes32 internal constant ROLE = keccak256("PORTAL_MANAGER_ROLE");

    // 38-byte Ed25519 identity multihash, the shape of live peer IDs
    bytes internal constant PEER_A = hex"002408011220aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    bytes internal constant PEER_B = hex"002408011220bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    bytes internal constant PEER_C = hex"002408011220cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    address internal otherOperator = address(0x0123);
    address internal pool;
    bytes32 internal clusterId;

    function setUp() public override {
        super.setUp();
        pool = _createAndActivatePortal(operator, MIN_STAKE_THRESHOLD, "PM");
        clusterId = registry.getClusterIdByAddress(pool);
    }

    function _bytesOfLength(uint256 len) internal pure returns (bytes memory b) {
        b = new bytes(len);
        for (uint256 i = 0; i < len; ++i) {
            b[i] = 0x61; // 'a'
        }
    }

    function _str(uint256 len) internal pure returns (string memory) {
        return string(_bytesOfLength(len));
    }

    function _addPortal(bytes32 cid, bytes memory peerId) internal {
        vm.prank(portalManager);
        registry.addPortal(cid, peerId, "");
    }

    /* ROLE SETUP */

    function test_Role_ConstantAndAdmin() public view {
        assertEq(registry.PORTAL_MANAGER_ROLE(), ROLE);
        assertEq(registry.getRoleAdmin(ROLE), registry.DEFAULT_ADMIN_ROLE());
        assertTrue(registry.hasRole(ROLE, portalManager));
        assertFalse(registry.hasRole(ROLE, operator));
    }

    function test_Role_OnlyDefaultAdminCanGrant() public {
        bytes32 adminRole = registry.DEFAULT_ADMIN_ROLE();

        vm.prank(operator);
        vm.expectRevert(_unauthorized(operator, adminRole));
        registry.grantRole(ROLE, operator);

        // a manager cannot extend the role to others
        vm.prank(portalManager);
        vm.expectRevert(_unauthorized(portalManager, adminRole));
        registry.grantRole(ROLE, operator);

        registry.grantRole(ROLE, operator);
        assertTrue(registry.hasRole(ROLE, operator));
    }

    /* addPortal ACCESS CONTROL */

    function test_AddPortal_RevertsForClusterOperator() public {
        vm.prank(operator);
        vm.expectRevert(_unauthorized(operator, ROLE));
        registry.addPortal(clusterId, PEER_A, "");
        assertEq(registry.getClusterIdByPeerId(PEER_A), bytes32(0));
    }

    function test_AddPortal_RevertsForDefaultAdminWithoutRole() public {
        // DEFAULT_ADMIN_ROLE must grant itself the role explicitly; it is not implied
        vm.expectRevert(_unauthorized(admin, ROLE));
        registry.addPortal(clusterId, PEER_A, "");
    }

    function test_AddPortal_RevertsForPausers() public {
        // PAUSER_ROLE holder (admin in tests) has no portal power either
        assertTrue(registry.hasRole(registry.PAUSER_ROLE(), admin));
        vm.expectRevert(_unauthorized(admin, ROLE));
        registry.addPortal(clusterId, PEER_A, "");
    }

    function test_AddPortal_SucceedsForManager() public {
        vm.expectEmit(true, false, false, true, address(registry));
        emit IPortalRegistry.PortalAdded(clusterId, PEER_A, "meta");
        vm.prank(portalManager);
        registry.addPortal(clusterId, PEER_A, "meta");

        assertEq(registry.getClusterIdByPeerId(PEER_A), clusterId);
        assertEq(registry.peerIdToCluster(keccak256(PEER_A)), clusterId);
        IPortalRegistry.Portal[] memory portals = registry.getClusterPortals(clusterId);
        assertEq(portals.length, 1);
        assertEq(portals[0].peerId, PEER_A);
        assertEq(portals[0].metadata, "meta");
    }

    function test_AddPortal_RevokedManagerReverts() public {
        registry.revokeRole(ROLE, portalManager);
        vm.prank(portalManager);
        vm.expectRevert(_unauthorized(portalManager, ROLE));
        registry.addPortal(clusterId, PEER_A, "");
    }

    function test_AddPortal_StillRevertsWhenPaused() public {
        registry.pause();
        vm.prank(portalManager);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        registry.addPortal(clusterId, PEER_A, "");
    }

    function test_AddPortal_ManagerStillHitsClusterChecks() public {
        vm.prank(portalManager);
        vm.expectRevert(PortalRegistryErrors.ClusterNotRegistered.selector);
        registry.addPortal(bytes32(uint256(1)), PEER_A, "");

        _addPortal(clusterId, PEER_A);
        address other = _createAndActivatePortal(otherOperator, MIN_STAKE_THRESHOLD, "O");
        bytes32 otherCluster = registry.getClusterIdByAddress(other);
        vm.prank(portalManager);
        vm.expectRevert(PortalRegistryErrors.PeerIdInUse.selector);
        registry.addPortal(otherCluster, PEER_A, "");
    }

    function test_AddPortal_OperatorRefusedInEveryPoolState() public {
        bytes memory registeredPeerId = PEER_A;

        // a pool that has collected nothing yet
        address collecting = _createPortal(otherOperator, MIN_STAKE_THRESHOLD, "C");
        bytes32 collectingCluster = registry.getClusterIdByAddress(collecting);
        assertEq(uint256(IPortalPool(collecting).getState()), uint256(IPortalPool.PoolState.COLLECTING));
        vm.prank(otherOperator);
        vm.expectRevert(_unauthorized(otherOperator, ROLE));
        registry.addPortal(collectingCluster, registeredPeerId, "");

        // an active pool
        vm.prank(operator);
        vm.expectRevert(_unauthorized(operator, ROLE));
        registry.addPortal(clusterId, registeredPeerId, "");

        // a closed pool
        IPortalPool(collecting).closePool();
        assertEq(uint256(IPortalPool(collecting).getState()), uint256(IPortalPool.PoolState.CLOSED));
        vm.prank(otherOperator);
        vm.expectRevert(_unauthorized(otherOperator, ROLE));
        registry.addPortal(collectingCluster, PEER_B, "");

        assertEq(registry.getClusterIdByPeerId(registeredPeerId), bytes32(0));
        assertEq(registry.getClusterIdByPeerId(PEER_B), bytes32(0));

        // the manager binds the peer ID to the cluster it belongs to
        _addPortal(clusterId, registeredPeerId);
        assertEq(registry.getClusterIdByPeerId(registeredPeerId), clusterId);
        assertGt(registry.getComputationUnits(clusterId), 0);
    }

    /* OPERATOR REMOVAL STILL WORKS */

    function test_OperatorCanStillRemoveOwnPortal() public {
        _addPortal(clusterId, PEER_A);
        vm.prank(operator);
        registry.removePortal(clusterId, 0);
        assertEq(registry.getClusterIdByPeerId(PEER_A), bytes32(0));
        assertEq(registry.getPortalCount(clusterId), 0);
    }

    function test_OperatorCannotRemoveOtherClustersPortal() public {
        address other = _createAndActivatePortal(otherOperator, MIN_STAKE_THRESHOLD, "O");
        bytes32 otherCluster = registry.getClusterIdByAddress(other);
        _addPortal(otherCluster, PEER_A);

        vm.prank(operator);
        vm.expectRevert(PortalRegistryErrors.NotClusterOperator.selector);
        registry.removePortal(otherCluster, 0);
    }

    /* forceRemovePortal */

    function test_ForceRemove_ReleasesPeerIdAndEmitsPortalRemoved() public {
        _addPortal(clusterId, PEER_A);

        vm.expectEmit(true, false, false, true, address(registry));
        emit IPortalRegistry.PortalRemoved(clusterId, PEER_A);
        vm.prank(portalManager);
        registry.forceRemovePortal(PEER_A);

        assertEq(registry.getClusterIdByPeerId(PEER_A), bytes32(0));
        assertEq(registry.peerIdToCluster(keccak256(PEER_A)), bytes32(0));
        assertEq(registry.getPortalCount(clusterId), 0);
    }

    function test_ForceRemove_PicksTheRightEntryAndKeepsOthers() public {
        vm.startPrank(portalManager);
        registry.addPortal(clusterId, PEER_A, "a");
        registry.addPortal(clusterId, PEER_B, "b");
        registry.addPortal(clusterId, PEER_C, "c");
        registry.forceRemovePortal(PEER_B); // middle entry: swap-and-pop branch
        vm.stopPrank();

        IPortalRegistry.Portal[] memory portals = registry.getClusterPortals(clusterId);
        assertEq(portals.length, 2);
        assertEq(portals[0].peerId, PEER_A);
        assertEq(portals[0].metadata, "a");
        assertEq(portals[1].peerId, PEER_C);
        assertEq(portals[1].metadata, "c");
        assertEq(registry.getClusterIdByPeerId(PEER_A), clusterId);
        assertEq(registry.getClusterIdByPeerId(PEER_B), bytes32(0));
        assertEq(registry.getClusterIdByPeerId(PEER_C), clusterId);

        // operator's index-based removal still lines up after the swap
        vm.prank(operator);
        registry.removePortal(clusterId, 1);
        assertEq(registry.getClusterIdByPeerId(PEER_C), bytes32(0));
        assertEq(registry.getClusterIdByPeerId(PEER_A), clusterId);
    }

    function test_ForceRemove_OnClosedPoolCluster_PeerIdReusable() public {
        _addPortal(clusterId, PEER_A);
        IPortalPool(pool).closePool(); // admin = factory DEFAULT_ADMIN
        assertEq(uint256(IPortalPool(pool).getState()), uint256(IPortalPool.PoolState.CLOSED));

        vm.prank(portalManager);
        registry.forceRemovePortal(PEER_A);
        assertEq(registry.getClusterIdByPeerId(PEER_A), bytes32(0));

        address other = _createAndActivatePortal(otherOperator, MIN_STAKE_THRESHOLD, "O");
        bytes32 otherCluster = registry.getClusterIdByAddress(other);
        _addPortal(otherCluster, PEER_A);
        assertEq(registry.getClusterIdByPeerId(PEER_A), otherCluster);
    }

    function test_ForceRemove_OnFailedPoolCluster() public {
        address failing = _createPortal(otherOperator, MIN_STAKE_THRESHOLD, "F");
        bytes32 failingCluster = registry.getClusterIdByAddress(failing);
        _addPortal(failingCluster, PEER_A);
        _warpToAfterDeadline(failing);
        assertEq(uint256(IPortalPool(failing).getState()), uint256(IPortalPool.PoolState.FAILED));

        vm.prank(portalManager);
        registry.forceRemovePortal(PEER_A);
        assertEq(registry.getClusterIdByPeerId(PEER_A), bytes32(0));
        assertEq(registry.getPortalCount(failingCluster), 0);
    }

    function test_ForceRemove_UndoesWrongBindingAndPeerIdIsReused() public {
        bytes memory registeredPeerId = PEER_A;

        // bound to the wrong cluster: a pool that never collected anything, later closed
        address wrongPool = _createPortal(otherOperator, MIN_STAKE_THRESHOLD, "W");
        bytes32 wrongCluster = registry.getClusterIdByAddress(wrongPool);
        _addPortal(wrongCluster, registeredPeerId);
        IPortalPool(wrongPool).closePool();

        // closing the pool does not release the peer ID by itself
        assertEq(registry.getClusterIdByPeerId(registeredPeerId), wrongCluster);

        vm.prank(portalManager);
        registry.forceRemovePortal(registeredPeerId);
        assertEq(registry.getClusterIdByPeerId(registeredPeerId), bytes32(0));
        assertEq(registry.getPortalCount(wrongCluster), 0);

        _addPortal(clusterId, registeredPeerId);
        assertEq(registry.getClusterIdByPeerId(registeredPeerId), clusterId);
    }

    function test_ForceRemove_WorksWhilePaused_OperatorRemovalDoesNot() public {
        vm.startPrank(portalManager);
        registry.addPortal(clusterId, PEER_A, "");
        registry.addPortal(clusterId, PEER_B, "");
        vm.stopPrank();
        registry.pause();

        vm.prank(operator);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        registry.removePortal(clusterId, 0);

        vm.prank(portalManager);
        registry.forceRemovePortal(PEER_A);
        assertEq(registry.getClusterIdByPeerId(PEER_A), bytes32(0));
        assertEq(registry.getClusterIdByPeerId(PEER_B), clusterId);
    }

    function test_ForceRemove_RevertsForNonManagers() public {
        _addPortal(clusterId, PEER_A);

        vm.prank(operator);
        vm.expectRevert(_unauthorized(operator, ROLE));
        registry.forceRemovePortal(PEER_A);

        vm.prank(user1);
        vm.expectRevert(_unauthorized(user1, ROLE));
        registry.forceRemovePortal(PEER_A);

        vm.expectRevert(_unauthorized(admin, ROLE));
        registry.forceRemovePortal(PEER_A);

        assertEq(registry.getClusterIdByPeerId(PEER_A), clusterId);
    }

    function test_ForceRemove_RevertsForUnknownPeerId() public {
        vm.prank(portalManager);
        vm.expectRevert(PortalRegistryErrors.PeerIdNotRegistered.selector);
        registry.forceRemovePortal(PEER_A);

        _addPortal(clusterId, PEER_A);
        vm.prank(portalManager);
        registry.forceRemovePortal(PEER_A);

        vm.prank(portalManager);
        vm.expectRevert(PortalRegistryErrors.PeerIdNotRegistered.selector);
        registry.forceRemovePortal(PEER_A);
    }

    /* LENGTH CAPS */

    function test_Caps_Constants() public view {
        assertEq(registry.MAX_METADATA_LENGTH(), 1024);
        assertEq(registry.MAX_PEER_ID_LENGTH(), 128);
    }

    function test_Cap_AddPortal_PeerIdBoundary() public {
        vm.prank(portalManager);
        registry.addPortal(clusterId, _bytesOfLength(128), "");
        assertEq(registry.getClusterIdByPeerId(_bytesOfLength(128)), clusterId);

        vm.prank(portalManager);
        vm.expectRevert(PortalRegistryErrors.PeerIdTooLong.selector);
        registry.addPortal(clusterId, _bytesOfLength(129), "");
    }

    function test_Cap_AddPortal_MetadataBoundary() public {
        vm.prank(portalManager);
        registry.addPortal(clusterId, PEER_A, _str(1024));
        assertEq(registry.getClusterPortals(clusterId)[0].metadata, _str(1024));

        vm.prank(portalManager);
        vm.expectRevert(PortalRegistryErrors.MetadataTooLong.selector);
        registry.addPortal(clusterId, PEER_B, _str(1025));
        assertEq(registry.getClusterIdByPeerId(PEER_B), bytes32(0));
    }

    function test_Cap_SetPortalMetadata_Boundary() public {
        _addPortal(clusterId, PEER_A);

        vm.prank(operator);
        registry.setPortalMetadata(clusterId, 0, _str(1024));
        assertEq(registry.getClusterPortals(clusterId)[0].metadata, _str(1024));

        vm.prank(operator);
        vm.expectRevert(PortalRegistryErrors.MetadataTooLong.selector);
        registry.setPortalMetadata(clusterId, 0, _str(1025));
    }

    function test_Cap_SetClusterMetadata_Boundary() public {
        vm.prank(operator);
        registry.setClusterMetadata(clusterId, _str(1024));
        assertEq(registry.getCluster(clusterId).metadata, _str(1024));

        vm.prank(operator);
        vm.expectRevert(PortalRegistryErrors.MetadataTooLong.selector);
        registry.setClusterMetadata(clusterId, _str(1025));
    }

    function test_Cap_SetClusterMetadataByPool_Boundary() public {
        // through the pool's operator entry point
        vm.prank(operator);
        IPortalPool(pool).setMetadata(_str(1024));
        assertEq(registry.getCluster(clusterId).metadata, _str(1024));

        vm.prank(operator);
        vm.expectRevert(PortalRegistryErrors.MetadataTooLong.selector);
        IPortalPool(pool).setMetadata(_str(1025));

        // and called by the pool directly
        vm.prank(pool);
        vm.expectRevert(PortalRegistryErrors.MetadataTooLong.selector);
        registry.setClusterMetadataByPool(_str(1025));
    }

    function test_Cap_RegisterCluster_DirectBoundary() public {
        address fakePool = address(0xC0FFEE);
        vm.prank(address(factory));
        vm.expectRevert(PortalRegistryErrors.MetadataTooLong.selector);
        registry.registerCluster(fakePool, otherOperator, _str(1025));

        vm.prank(address(factory));
        bytes32 cid = registry.registerCluster(fakePool, otherOperator, _str(1024));
        assertEq(registry.getCluster(cid).metadata, _str(1024));
    }

    function test_Cap_RegisterCluster_ThroughFactory() public {
        IPortalFactory.CreatePortalPoolParams memory params = IPortalFactory.CreatePortalPoolParams({
            operator: otherOperator,
            capacity: MIN_STAKE_THRESHOLD,
            tokenSuffix: "M",
            distributionRatePerSecond: MIN_STAKE_THRESHOLD / 1e12,
            initialDeposit: (MIN_STAKE_THRESHOLD / 1e12) * 1 days / 1000,
            metadata: _str(1025),
            rewardToken: address(usdc)
        });
        usdc.approve(address(factory), type(uint256).max);
        vm.expectRevert(PortalRegistryErrors.MetadataTooLong.selector);
        factory.createPortalPool(params);

        params.metadata = _str(1024);
        address created = factory.createPortalPool(params);
        assertEq(registry.getClusterByAddress(created).metadata, _str(1024));
    }

    function test_Cap_EmptyValuesStillAllowed() public {
        vm.prank(operator);
        registry.setClusterMetadata(clusterId, "");
        _addPortal(clusterId, PEER_A);
        vm.prank(operator);
        registry.setPortalMetadata(clusterId, 0, "");
        assertEq(registry.getClusterPortals(clusterId)[0].metadata, "");
    }

    function testFuzz_Cap_ClusterMetadata(uint16 len) public {
        uint256 l = bound(uint256(len), 0, 2048);
        vm.prank(operator);
        if (l > 1024) vm.expectRevert(PortalRegistryErrors.MetadataTooLong.selector);
        registry.setClusterMetadata(clusterId, _str(l));
    }

    function testFuzz_Cap_PeerId(uint16 len) public {
        uint256 l = bound(uint256(len), 1, 512);
        vm.prank(portalManager);
        if (l > 128) vm.expectRevert(PortalRegistryErrors.PeerIdTooLong.selector);
        registry.addPortal(clusterId, _bytesOfLength(l), "");
    }

    /* READ PATHS UNCHANGED */

    function test_ActiveClustersStillExposePortals() public {
        _addPortal(clusterId, PEER_A);
        (bytes32[] memory ids, IPortalRegistry.Cluster[] memory clusters, uint256 total) =
            registry.getActiveClusters(0, 5);
        assertEq(total, 1);
        assertEq(ids[0], clusterId);
        assertEq(clusters[0].portals.length, 1);
        assertEq(clusters[0].portals[0].peerId, PEER_A);
        assertGt(registry.getComputationUnits(clusterId), 0);
    }
}
