// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPortalRegistry} from "../src/interfaces/IPortalRegistry.sol";
import {IPortalPool} from "../src/interfaces/IPortalPool.sol";
import {PortalRegistryErrors} from "../src/libs/PortalRegistryErrors.sol";
import {FullMath} from "../src/libs/FullMath.sol";
import {Multicall} from "../src/utils/Multicall.sol";

/**
 * @title PortalRegistry
 * @notice Core registry for all clusters in the Subsquid network
 * @dev UUPS upgradeable. Cluster contains Portal[] (up to 10 peerIds).
 *      Only factory-created pools can register and interact with this registry.
 *      Portals (peer IDs) are bound to clusters only by PORTAL_MANAGER_ROLE, which checks
 *      peer-ID ownership off-chain. Cluster operators can remove their own portals and edit metadata.
 */
contract PortalRegistry is
    IPortalRegistry,
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable,
    Multicall
{
    using SafeERC20 for IERC20;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    /// @notice Binds peer IDs to clusters (addPortal) and removes any portal (forceRemovePortal).
    /// @dev Its admin is DEFAULT_ADMIN_ROLE (the AccessControl default), so no initializer is needed.
    bytes32 public constant PORTAL_MANAGER_ROLE = keccak256("PORTAL_MANAGER_ROLE");
    uint8 public constant MAX_PORTALS_PER_CLUSTER = 10;
    uint256 public constant MAX_CLUSTERS_PER_OWNER = 100;
    /// @notice Maximum length in bytes of cluster and portal metadata, enforced on every write
    uint256 public constant MAX_METADATA_LENGTH = 1024;
    /// @notice Maximum length in bytes of a portal peer ID
    uint256 public constant MAX_PEER_ID_LENGTH = 128;

    // solhint-disable-next-line var-name-mixedcase
    IERC20 public SQD;

    mapping(bytes32 => Cluster) internal _clusters;
    mapping(address => bytes32[]) public ownerClusters;

    mapping(address => bytes32) public addressToClusterId;
    mapping(bytes32 => bytes32) public peerIdToCluster;

    mapping(address => bool) private _isCluster;

    uint256 public minStake;
    uint256 public mana;
    address public factory;

    /// @notice All cluster IDs indexed by sequential number
    mapping(uint256 => bytes32) public allClusterIds;
    /// @notice Total number of clusters registered
    uint256 public clusterCount;

    uint256[50] private __gap;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _sqd, uint256 _minStake, uint256 _mana) external initializer {
        if (_sqd == address(0)) revert PortalRegistryErrors.InvalidAddress();

        __AccessControl_init();
        __Pausable_init();

        SQD = IERC20(_sqd);
        minStake = _minStake;
        mana = _mana;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
    }

    /// @inheritdoc IPortalRegistry
    function registerCluster(address clusterAddress, address operator, string calldata metadata)
        external
        whenNotPaused
        returns (bytes32 clusterId)
    {
        if (msg.sender != factory) revert PortalRegistryErrors.OnlyFactory();
        if (operator == address(0)) revert PortalRegistryErrors.InvalidAddress();
        if (clusterAddress == address(0)) revert PortalRegistryErrors.InvalidAddress();
        if (addressToClusterId[clusterAddress] != bytes32(0)) {
            revert PortalRegistryErrors.ClusterAlreadyRegistered();
        }

        if (ownerClusters[operator].length >= MAX_CLUSTERS_PER_OWNER) {
            revert PortalRegistryErrors.MaxClustersReached();
        }
        _checkMetadataLength(metadata);

        clusterId = _generateClusterId(clusterAddress);

        Cluster storage cluster = _clusters[clusterId];
        cluster.clusterAddress = clusterAddress;
        cluster.operator = operator;
        cluster.totalStaked = 0;
        cluster.registeredAt = block.number;
        cluster.active = false;
        cluster.metadata = metadata;

        addressToClusterId[clusterAddress] = clusterId;
        ownerClusters[operator].push(clusterId);
        _isCluster[clusterAddress] = true;

        allClusterIds[clusterCount] = clusterId;
        ++clusterCount;

        emit ClusterCreated(clusterId, clusterAddress, operator);
    }

    /// @inheritdoc IPortalRegistry
    function addPortal(bytes32 clusterId, bytes calldata peerId, string calldata metadata)
        external
        onlyRole(PORTAL_MANAGER_ROLE)
        whenNotPaused
    {
        Cluster storage cluster = _clusters[clusterId];
        if (cluster.clusterAddress == address(0)) {
            revert PortalRegistryErrors.ClusterNotRegistered();
        }
        if (peerId.length == 0) {
            revert PortalRegistryErrors.InvalidPeerId();
        }
        if (peerId.length > MAX_PEER_ID_LENGTH) {
            revert PortalRegistryErrors.PeerIdTooLong();
        }
        _checkMetadataLength(metadata);
        if (cluster.portals.length >= MAX_PORTALS_PER_CLUSTER) {
            revert PortalRegistryErrors.MaxPortalsReached();
        }

        bytes32 peerIdHash = keccak256(peerId);
        if (peerIdToCluster[peerIdHash] != bytes32(0)) {
            revert PortalRegistryErrors.PeerIdInUse();
        }

        cluster.portals.push(Portal({peerId: peerId, metadata: metadata, addedAt: uint64(block.number)}));

        peerIdToCluster[peerIdHash] = clusterId;

        emit PortalAdded(clusterId, peerId, metadata);
    }

    /// @inheritdoc IPortalRegistry
    function removePortal(bytes32 clusterId, uint256 portalIndex) external whenNotPaused {
        Cluster storage cluster = _clusters[clusterId];
        if (cluster.clusterAddress == address(0)) {
            revert PortalRegistryErrors.ClusterNotRegistered();
        }
        if (msg.sender != _getClusterOperator(cluster.clusterAddress)) {
            revert PortalRegistryErrors.NotClusterOperator();
        }
        if (portalIndex >= cluster.portals.length) {
            revert PortalRegistryErrors.InvalidPortalIndex();
        }

        _removePortalAt(clusterId, cluster, portalIndex);
    }

    /// @inheritdoc IPortalRegistry
    /// @dev Deliberately not `whenNotPaused`: like the other role-gated admin setters, it must stay usable
    ///      during a pause so a wrong binding can be undone without re-enabling stake/unstake.
    ///      It reads no pool state, so it works for clusters of CLOSED and FAILED pools.
    function forceRemovePortal(bytes calldata peerId) external onlyRole(PORTAL_MANAGER_ROLE) {
        bytes32 peerIdHash = keccak256(peerId);
        bytes32 clusterId = peerIdToCluster[peerIdHash];
        if (clusterId == bytes32(0)) {
            revert PortalRegistryErrors.PeerIdNotRegistered();
        }

        Cluster storage cluster = _clusters[clusterId];
        uint256 portalCount = cluster.portals.length;
        for (uint256 i = 0; i < portalCount;) {
            if (keccak256(cluster.portals[i].peerId) == peerIdHash) {
                _removePortalAt(clusterId, cluster, i);
                return;
            }
            unchecked {
                ++i;
            }
        }
        // Unreachable while peerIdToCluster and the portals arrays stay in sync (they are only written together).
        revert PortalRegistryErrors.PeerIdNotRegistered();
    }

    /// @inheritdoc IPortalRegistry
    function setPortalMetadata(bytes32 clusterId, uint256 portalIndex, string calldata metadata) external {
        Cluster storage cluster = _clusters[clusterId];
        if (cluster.clusterAddress == address(0)) {
            revert PortalRegistryErrors.ClusterNotRegistered();
        }
        if (msg.sender != _getClusterOperator(cluster.clusterAddress)) {
            revert PortalRegistryErrors.NotClusterOperator();
        }
        if (portalIndex >= cluster.portals.length) {
            revert PortalRegistryErrors.InvalidPortalIndex();
        }
        _checkMetadataLength(metadata);

        cluster.portals[portalIndex].metadata = metadata;

        emit PortalMetadataUpdated(clusterId, portalIndex, metadata);
    }

    /// @inheritdoc IPortalRegistry
    function setClusterMetadata(bytes32 clusterId, string calldata metadata) external {
        Cluster storage cluster = _clusters[clusterId];
        if (cluster.clusterAddress == address(0)) {
            revert PortalRegistryErrors.ClusterNotRegistered();
        }
        if (msg.sender != _getClusterOperator(cluster.clusterAddress)) {
            revert PortalRegistryErrors.NotClusterOperator();
        }
        _checkMetadataLength(metadata);

        cluster.metadata = metadata;

        emit ClusterMetadataUpdated(clusterId, metadata);
    }

    /// @inheritdoc IPortalRegistry
    function setClusterMetadataByPool(string calldata metadata) external {
        bytes32 clusterId = addressToClusterId[msg.sender];
        Cluster storage cluster = _clusters[clusterId];
        if (cluster.clusterAddress == address(0)) {
            revert PortalRegistryErrors.ClusterNotRegistered();
        }
        _checkMetadataLength(metadata);

        cluster.metadata = metadata;

        emit ClusterMetadataUpdated(clusterId, metadata);
    }

    /// @inheritdoc IPortalRegistry
    function updateClusterOperator(address newOperator) external {
        if (newOperator == address(0)) revert PortalRegistryErrors.InvalidAddress();

        bytes32 clusterId = addressToClusterId[msg.sender];
        Cluster storage cluster = _clusters[clusterId];
        if (cluster.clusterAddress == address(0)) {
            revert PortalRegistryErrors.ClusterNotRegistered();
        }

        address oldOperator = cluster.operator;
        if (newOperator == oldOperator) return; // No change

        // Update cluster operator
        cluster.operator = newOperator;

        // Remove clusterId from old operator's list
        bytes32[] storage oldOperatorClusters = ownerClusters[oldOperator];
        for (uint256 i = 0; i < oldOperatorClusters.length;) {
            if (oldOperatorClusters[i] == clusterId) {
                // Swap with last and pop
                oldOperatorClusters[i] = oldOperatorClusters[oldOperatorClusters.length - 1];
                oldOperatorClusters.pop();
                break;
            }
            unchecked {
                ++i;
            }
        }

        // Add clusterId to new operator's list
        ownerClusters[newOperator].push(clusterId);

        emit ClusterOperatorUpdated(clusterId, oldOperator, newOperator);
    }

    /// @inheritdoc IPortalRegistry
    function getCluster(bytes32 clusterId) external view returns (Cluster memory) {
        return _clusters[clusterId];
    }

    /// @inheritdoc IPortalRegistry
    function getClusterByAddress(address clusterAddress) external view returns (Cluster memory) {
        bytes32 clusterId = addressToClusterId[clusterAddress];
        return _clusters[clusterId];
    }

    /// @inheritdoc IPortalRegistry
    function getClusterIdByAddress(address clusterAddress) external view returns (bytes32) {
        return addressToClusterId[clusterAddress];
    }

    /// @inheritdoc IPortalRegistry
    function getClusterPortals(bytes32 clusterId) external view returns (Portal[] memory) {
        return _clusters[clusterId].portals;
    }

    /// @inheritdoc IPortalRegistry
    function getPortalCount(bytes32 clusterId) external view returns (uint256) {
        return _clusters[clusterId].portals.length;
    }

    /// @inheritdoc IPortalRegistry
    function getClusterIdByPeerId(bytes calldata peerId) external view returns (bytes32) {
        return peerIdToCluster[keccak256(peerId)];
    }

    /// @inheritdoc IPortalRegistry
    function getOperatorClusters(address operator) external view returns (bytes32[] memory) {
        return ownerClusters[operator];
    }

    /// @inheritdoc IPortalRegistry
    function getClustersPaginated(uint256 offset, uint256 limit)
        external
        view
        returns (bytes32[] memory clusterIds, Cluster[] memory clusters)
    {
        if (offset >= clusterCount) {
            return (new bytes32[](0), new Cluster[](0));
        }

        uint256 end = offset + limit;
        if (end > clusterCount) {
            end = clusterCount;
        }

        uint256 size = end - offset;
        clusterIds = new bytes32[](size);
        clusters = new Cluster[](size);

        for (uint256 i = 0; i < size;) {
            bytes32 clusterId = allClusterIds[offset + i];
            clusterIds[i] = clusterId;
            clusters[i] = _clusters[clusterId];
            unchecked {
                ++i;
            }
        }
    }

    /// @inheritdoc IPortalRegistry
    function getActiveClusters(uint256 offset, uint256 limit)
        external
        view
        returns (bytes32[] memory clusterIds, Cluster[] memory clusters, uint256 totalActive)
    {
        // First pass: count active clusters
        for (uint256 i = 0; i < clusterCount;) {
            if (_clusters[allClusterIds[i]].active) {
                ++totalActive;
            }
            unchecked {
                ++i;
            }
        }

        if (offset >= totalActive) {
            return (new bytes32[](0), new Cluster[](0), totalActive);
        }

        uint256 end = offset + limit;
        if (end > totalActive) {
            end = totalActive;
        }

        uint256 size = end - offset;
        clusterIds = new bytes32[](size);
        clusters = new Cluster[](size);

        uint256 activeIndex = 0;
        uint256 collected = 0;
        for (uint256 i = 0; i < clusterCount && collected < size;) {
            bytes32 clusterId = allClusterIds[i];
            if (_clusters[clusterId].active) {
                if (activeIndex >= offset) {
                    clusterIds[collected] = clusterId;
                    clusters[collected] = _clusters[clusterId];
                    ++collected;
                }
                ++activeIndex;
            }
            unchecked {
                ++i;
            }
        }
    }

    /// @inheritdoc IPortalRegistry
    function getComputationUnits(bytes32 clusterId) external view returns (uint256) {
        Cluster storage cluster = _clusters[clusterId];

        if (!cluster.active) return 0;

        // Cap totalStaked at pool capacity to prevent inflation via deposit/exit cycling
        uint256 poolCapacity = IPortalPool(cluster.clusterAddress).getPoolInfo().capacity;
        uint256 effectiveStake = cluster.totalStaked > poolCapacity ? poolCapacity : cluster.totalStaked;

        return FullMath.mulDiv(effectiveStake, mana, 10000 * 1e18);
    }

    /// @inheritdoc IPortalRegistry
    function isCluster(address clusterAddress) external view returns (bool) {
        return _isCluster[clusterAddress];
    }

    /// @inheritdoc IPortalRegistry
    function stake(uint256 amount) external whenNotPaused {
        bytes32 clusterId = addressToClusterId[msg.sender];
        Cluster storage cluster = _clusters[clusterId];

        if (cluster.clusterAddress == address(0)) {
            revert PortalRegistryErrors.ClusterNotRegistered();
        }

        uint256 balanceBefore = SQD.balanceOf(address(this));
        SQD.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = SQD.balanceOf(address(this)) - balanceBefore;
        if (received != amount) revert PortalRegistryErrors.InvalidStakeTransfer();

        cluster.totalStaked += received;

        // auto-activate when stake threshold is met
        if (!cluster.active && cluster.totalStaked >= minStake) {
            cluster.active = true;
            emit ClusterActivated(clusterId);
        }

        emit Staked(clusterId, amount);
    }

    /// @inheritdoc IPortalRegistry
    function unstake(address provider, uint256 amount) external whenNotPaused {
        bytes32 clusterId = addressToClusterId[msg.sender];
        Cluster storage cluster = _clusters[clusterId];

        if (cluster.clusterAddress == address(0)) {
            revert PortalRegistryErrors.ClusterNotRegistered();
        }
        if (cluster.totalStaked < amount) {
            revert PortalRegistryErrors.InsufficientAllocation();
        }

        cluster.totalStaked -= amount;

        if (cluster.active && cluster.totalStaked < minStake) {
            cluster.active = false;
            emit ClusterDeactivated(clusterId);
        }

        SQD.safeTransfer(provider, amount);

        emit Unstaked(clusterId, amount);
    }

    /// @inheritdoc IPortalRegistry
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @inheritdoc IPortalRegistry
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @inheritdoc IPortalRegistry
    function setMinStake(uint256 _minStake) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 oldValue = minStake;
        minStake = _minStake;
        emit MinStakeUpdated(oldValue, _minStake);
    }

    /// @inheritdoc IPortalRegistry
    function setMana(uint256 _mana) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 oldValue = mana;
        mana = _mana;
        emit ManaUpdated(oldValue, _mana);
    }

    /// @inheritdoc IPortalRegistry
    function setFactory(address _factory) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_factory == address(0)) revert PortalRegistryErrors.InvalidAddress();
        address oldFactory = factory;
        factory = _factory;
        emit FactoryUpdated(oldFactory, _factory);
    }

    /// @dev Removes the portal at `portalIndex` (swap-and-pop) and releases its peer ID
    function _removePortalAt(bytes32 clusterId, Cluster storage cluster, uint256 portalIndex) internal {
        bytes memory peerId = cluster.portals[portalIndex].peerId;
        bytes32 peerIdHash = keccak256(peerId);

        delete peerIdToCluster[peerIdHash];

        uint256 lastIndex = cluster.portals.length - 1;
        if (portalIndex != lastIndex) {
            cluster.portals[portalIndex] = cluster.portals[lastIndex];
        }
        cluster.portals.pop();

        emit PortalRemoved(clusterId, peerId);
    }

    function _checkMetadataLength(string calldata metadata) internal pure {
        if (bytes(metadata).length > MAX_METADATA_LENGTH) {
            revert PortalRegistryErrors.MetadataTooLong();
        }
    }

    function _generateClusterId(address clusterAddress) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(clusterAddress, block.chainid, block.number));
    }

    /// @dev Gets the current operator of a cluster by reading from the pool contract
    function _getClusterOperator(address clusterAddress) internal view returns (address) {
        return IPortalPool(clusterAddress).getOperator();
    }

    // solhint-disable-next-line no-empty-blocks
    function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
