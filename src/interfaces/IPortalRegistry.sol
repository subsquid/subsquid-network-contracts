// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IPortalRegistry
 * @notice Core registry for all clusters - only factory-created pools can interact
 */
interface IPortalRegistry {
    struct Portal {
        bytes peerId;
        string metadata;
        uint64 addedAt;
    }

    struct Cluster {
        address clusterAddress;
        address operator;
        uint256 totalStaked;
        uint256 registeredAt;
        bool active;
        string metadata;
        Portal[] portals;
    }

    event ClusterCreated(bytes32 indexed clusterId, address indexed clusterAddress, address indexed operator);
    event ClusterActivated(bytes32 indexed clusterId);
    event ClusterDeactivated(bytes32 indexed clusterId);
    event ClusterMetadataUpdated(bytes32 indexed clusterId, string metadata);

    event PortalAdded(bytes32 indexed clusterId, bytes peerId, string metadata);
    event PortalRemoved(bytes32 indexed clusterId, bytes peerId);
    event PortalMetadataUpdated(bytes32 indexed clusterId, uint256 portalIndex, string metadata);

    event Staked(bytes32 indexed clusterId, uint256 amount);
    event Unstaked(bytes32 indexed clusterId, uint256 amount);

    event MinStakeUpdated(uint256 oldValue, uint256 newValue);
    event ManaUpdated(uint256 oldValue, uint256 newValue);
    event FactoryUpdated(address indexed oldFactory, address indexed newFactory);

    function registerCluster(address clusterAddress, address operator, string calldata metadata)
        external
        returns (bytes32 clusterId);

    function addPortal(bytes32 clusterId, bytes calldata peerId, string calldata metadata) external;

    function removePortal(bytes32 clusterId, uint256 portalIndex) external;

    function setPortalMetadata(bytes32 clusterId, uint256 portalIndex, string calldata metadata) external;

    function setClusterMetadata(bytes32 clusterId, string calldata metadata) external;

    function getCluster(bytes32 clusterId) external view returns (Cluster memory);

    function getClusterByAddress(address clusterAddress) external view returns (Cluster memory);

    function getClusterIdByAddress(address clusterAddress) external view returns (bytes32);

    function getClusterPortals(bytes32 clusterId) external view returns (Portal[] memory);

    function getPortalCount(bytes32 clusterId) external view returns (uint256);

    function getClusterIdByPeerId(bytes calldata peerId) external view returns (bytes32);

    function getOperatorClusters(address operator) external view returns (bytes32[] memory);

    function getComputationUnits(bytes32 clusterId) external view returns (uint256);

    function isCluster(address clusterAddress) external view returns (bool);

    function stake(uint256 amount) external;

    function unstake(address provider, uint256 amount) external;

    function activateCluster() external;

    function pause() external;

    function unpause() external;

    function setMinStake(uint256 minStake) external;

    function setMana(uint256 mana) external;

    function setFactory(address factory) external;

    function factory() external view returns (address);

    function minStake() external view returns (uint256);

    function mana() external view returns (uint256);

    function ownerClusters(address operator, uint256 index) external view returns (bytes32);

    function addressToClusterId(address clusterAddress) external view returns (bytes32);

    function peerIdToCluster(bytes32 peerIdHash) external view returns (bytes32);
}
