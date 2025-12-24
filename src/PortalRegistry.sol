// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {INetworkController} from "../src/interfaces/INetworkController.sol";
import {IPortalRegistry} from "../src/interfaces/IPortalRegistry.sol";
import {PortalRegistryErrors} from "../src/libs/PortalRegistryErrors.sol";
import {FullMath} from "../src/libs/FullMath.sol";

/**
 * @title PortalRegistry
 * @notice Core registry for all clusters in the Subsquid network
 * @dev UUPS upgradeable. Cluster contains Portal[] (up to 10 peerIds).
 *      Phase 1: 1 Pool → 1 Cluster, 1 Wallet → 1 Cluster (enforced in logic)
 *      Phase 2: 1 Pool → 1 Cluster, 1 Wallet → N Clusters (remove check, storage ready)
 */
contract PortalRegistry is
    IPortalRegistry,
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    uint8 public constant MAX_PORTALS_PER_CLUSTER = 10;
    uint256 public constant MAX_CLUSTERS_PER_OWNER = 100;  // For Phase 2, prevents DoS

    IERC20 public SQD;
    INetworkController public networkController;

    mapping(bytes32 => Cluster) internal _clusters;
    mapping(address => bytes32[]) public ownerClusters;

    mapping(address => bytes32) public addressToClusterId;
    mapping(bytes32 => bytes32) public peerIdToCluster;

    mapping(address => bool) private _isCluster;
    mapping(bytes32 => mapping(address => uint256)) public providerAllocations;

    mapping(address => bytes32) public operatorToDirectCluster;
    uint256 private _clusterNonce;

    uint256 public minStake;
    uint256 public mana;
    address public factory;

    uint256[50] private __gap;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _sqd,
        address _networkController,
        uint256 _minStake,
        uint256 _mana
    ) external initializer {
        if (_sqd == address(0)) revert PortalRegistryErrors.InvalidAddress();
        if (_networkController == address(0)) revert PortalRegistryErrors.InvalidAddress();

        __AccessControl_init();
        __Pausable_init();

        SQD = IERC20(_sqd);
        networkController = INetworkController(_networkController);
        minStake = _minStake;
        mana = _mana;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
    }

    /// @inheritdoc IPortalRegistry
    function registerPoolCluster(
        address clusterAddress,
        address operator,
        string calldata metadata
    ) external whenNotPaused returns (bytes32 clusterId) {
        if (msg.sender != factory) revert PortalRegistryErrors.OnlyFactory();
        if (operator == address(0)) revert PortalRegistryErrors.InvalidAddress();
        if (clusterAddress == address(0)) revert PortalRegistryErrors.InvalidAddress();
        if (addressToClusterId[clusterAddress] != bytes32(0)) {
            revert PortalRegistryErrors.ClusterAlreadyRegistered();
        }

        if (ownerClusters[operator].length >= MAX_CLUSTERS_PER_OWNER) {
            revert PortalRegistryErrors.MaxClustersReached();
        }

        clusterId = _generateClusterId(clusterAddress);

        Cluster storage cluster = _clusters[clusterId];
        cluster.clusterAddress = clusterAddress;
        cluster.operator = operator;
        cluster.totalStaked = 0;
        cluster.registeredAt = block.number;
        cluster.active = false;
        cluster.clusterType = ClusterType.POOL;
        cluster.metadata = metadata;

        // Update mappings
        addressToClusterId[clusterAddress] = clusterId;
        ownerClusters[operator].push(clusterId);
        _isCluster[clusterAddress] = true;

        emit ClusterCreated(clusterId, clusterAddress, operator, ClusterType.POOL);
    }

    /// @inheritdoc IPortalRegistry
    function registerDirectCluster(
        string calldata metadata,
        uint256 initialStake
    ) external whenNotPaused returns (bytes32 clusterId) {
        // Phase 1: enforce 1 wallet → 1 cluster
        // Phase 2: remove this check to allow N clusters per wallet
        if (operatorToDirectCluster[msg.sender] != bytes32(0)) {
            revert PortalRegistryErrors.AlreadyHasCluster();
        }

        if (ownerClusters[msg.sender].length >= MAX_CLUSTERS_PER_OWNER) {
            revert PortalRegistryErrors.MaxClustersReached();
        }

        // Require initial stake >= minimum threshold
        uint256 minStakeThreshold = networkController.minStakeThreshold();
        if (initialStake < minStakeThreshold) {
            revert PortalRegistryErrors.BelowMinimumStake();
        }

        // Pull SQD from operator
        SQD.safeTransferFrom(msg.sender, address(this), initialStake);

        ++_clusterNonce;
        address generatedAddress = address(uint160(uint256(keccak256(
            abi.encodePacked(msg.sender, _clusterNonce, block.timestamp)
        ))));

        clusterId = _generateClusterId(generatedAddress);

        // Initialize cluster - active immediately since stake >= threshold
        Cluster storage cluster = _clusters[clusterId];
        cluster.clusterAddress = generatedAddress;
        cluster.operator = msg.sender;
        cluster.totalStaked = initialStake;
        cluster.registeredAt = block.number;
        cluster.active = true;
        cluster.clusterType = ClusterType.DIRECT;
        cluster.metadata = metadata;

        // Track provider allocation
        providerAllocations[clusterId][msg.sender] = initialStake;

        // Update mappings
        addressToClusterId[generatedAddress] = clusterId;
        ownerClusters[msg.sender].push(clusterId);
        operatorToDirectCluster[msg.sender] = clusterId;
        _isCluster[generatedAddress] = true;

        emit ClusterCreated(clusterId, generatedAddress, msg.sender, ClusterType.DIRECT);
        emit Staked(clusterId, msg.sender, initialStake);
        emit ClusterActivated(clusterId);
    }

    /// @inheritdoc IPortalRegistry
    function addPortal(
        bytes32 clusterId,
        bytes calldata peerId,
        string calldata metadata
    ) external whenNotPaused {
        Cluster storage cluster = _clusters[clusterId];
        if (cluster.clusterAddress == address(0)) {
            revert PortalRegistryErrors.ClusterNotRegistered();
        }
        if (msg.sender != cluster.operator) {
            revert PortalRegistryErrors.NotClusterOperator();
        }
        if (peerId.length == 0) {
            revert PortalRegistryErrors.InvalidPeerId();
        }
        if (cluster.portals.length >= MAX_PORTALS_PER_CLUSTER) {
            revert PortalRegistryErrors.MaxPortalsReached();
        }

        // Check global peerId uniqueness
        bytes32 peerIdHash = keccak256(peerId);
        if (peerIdToCluster[peerIdHash] != bytes32(0)) {
            revert PortalRegistryErrors.PeerIdInUse();
        }

        // Add portal to cluster
        cluster.portals.push(Portal({
            peerId: peerId,
            metadata: metadata,
            addedAt: uint64(block.number)
        }));

        // Register global peerId mapping
        peerIdToCluster[peerIdHash] = clusterId;

        emit PortalAdded(clusterId, peerId, metadata);
    }

    /// @inheritdoc IPortalRegistry
    function removePortal(bytes32 clusterId, uint256 portalIndex) external whenNotPaused {
        Cluster storage cluster = _clusters[clusterId];
        if (cluster.clusterAddress == address(0)) {
            revert PortalRegistryErrors.ClusterNotRegistered();
        }
        if (msg.sender != cluster.operator) {
            revert PortalRegistryErrors.NotClusterOperator();
        }
        if (portalIndex >= cluster.portals.length) {
            revert PortalRegistryErrors.InvalidPortalIndex();
        }

        // Get peerId before removal
        bytes memory peerId = cluster.portals[portalIndex].peerId;
        bytes32 peerIdHash = keccak256(peerId);

        // Remove global peerId mapping
        delete peerIdToCluster[peerIdHash];

        // Swap and pop to remove from array
        uint256 lastIndex = cluster.portals.length - 1;
        if (portalIndex != lastIndex) {
            cluster.portals[portalIndex] = cluster.portals[lastIndex];
        }
        cluster.portals.pop();

        emit PortalRemoved(clusterId, peerId);
    }

    /// @inheritdoc IPortalRegistry
    function setPortalMetadata(
        bytes32 clusterId,
        uint256 portalIndex,
        string calldata metadata
    ) external {
        Cluster storage cluster = _clusters[clusterId];
        if (cluster.clusterAddress == address(0)) {
            revert PortalRegistryErrors.ClusterNotRegistered();
        }
        if (msg.sender != cluster.operator) {
            revert PortalRegistryErrors.NotClusterOperator();
        }
        if (portalIndex >= cluster.portals.length) {
            revert PortalRegistryErrors.InvalidPortalIndex();
        }

        cluster.portals[portalIndex].metadata = metadata;

        emit PortalMetadataUpdated(clusterId, portalIndex, metadata);
    }

    /// @inheritdoc IPortalRegistry
    function setClusterMetadata(bytes32 clusterId, string calldata metadata) external {
        Cluster storage cluster = _clusters[clusterId];
        if (cluster.clusterAddress == address(0)) {
            revert PortalRegistryErrors.ClusterNotRegistered();
        }
        if (msg.sender != cluster.operator) {
            revert PortalRegistryErrors.NotClusterOperator();
        }

        cluster.metadata = metadata;

        emit ClusterMetadataUpdated(clusterId, metadata);
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
    function getComputationUnits(bytes32 clusterId) external view returns (uint256) {
        Cluster storage cluster = _clusters[clusterId];

        if (!cluster.active) return 0;

        uint256 epochLength = networkController.workerEpochLength();
        uint256 boostFactor = 30000;

        // Use FullMath for 512-bit precision to prevent overflow
        // Formula: (totalStaked * epochLength * mana * boostFactor) / (10000 * 1e18 * 1000)
        uint256 cus = FullMath.mulDiv(
            cluster.totalStaked * epochLength,
            mana * boostFactor,
            10000 * 1e18 * 1000
        );

        return cus;
    }

    /// @inheritdoc IPortalRegistry
    function isCluster(address clusterAddress) external view returns (bool) {
        return _isCluster[clusterAddress];
    }

    /// @inheritdoc IPortalRegistry
    function stakePoolFunds(uint256 amount) external whenNotPaused {
        bytes32 clusterId = addressToClusterId[msg.sender];
        Cluster storage cluster = _clusters[clusterId];

        if (cluster.clusterAddress == address(0)) {
            revert PortalRegistryErrors.ClusterNotRegistered();
        }
        if (cluster.clusterType != ClusterType.POOL) {
            revert PortalRegistryErrors.OnlyPoolCluster();
        }

        SQD.safeTransferFrom(msg.sender, address(this), amount);

        cluster.totalStaked += amount;

        emit Staked(clusterId, msg.sender, amount);
    }

    /// @inheritdoc IPortalRegistry
    function unstakeFromPool(address provider, uint256 amount) external whenNotPaused {
        bytes32 clusterId = addressToClusterId[msg.sender];
        Cluster storage cluster = _clusters[clusterId];

        if (cluster.clusterAddress == address(0)) {
            revert PortalRegistryErrors.ClusterNotRegistered();
        }
        if (cluster.clusterType != ClusterType.POOL) {
            revert PortalRegistryErrors.OnlyPoolCluster();
        }
        if (cluster.totalStaked < amount) {
            revert PortalRegistryErrors.InsufficientAllocation();
        }

        // Reduce total stake
        cluster.totalStaked -= amount;

        // Check if cluster should be deactivated
        uint256 minStakeThreshold = networkController.minStakeThreshold();
        if (cluster.active && cluster.totalStaked < minStakeThreshold) {
            cluster.active = false;
            emit ClusterDeactivated(clusterId);
        }

        // Transfer SQD to provider
        SQD.safeTransfer(provider, amount);

        emit Unstaked(clusterId, provider, amount);
    }

    /// @inheritdoc IPortalRegistry
    function activateCluster() external whenNotPaused {
        bytes32 clusterId = addressToClusterId[msg.sender];
        Cluster storage cluster = _clusters[clusterId];

        if (cluster.clusterAddress == address(0)) {
            revert PortalRegistryErrors.ClusterNotRegistered();
        }
        if (cluster.clusterType != ClusterType.POOL) {
            revert PortalRegistryErrors.OnlyPoolCluster();
        }
        if (cluster.active) {
            return; // Already active, no-op
        }

        cluster.active = true;
        emit ClusterActivated(clusterId);
    }

    /// @inheritdoc IPortalRegistry
    function withdrawFailedPortal(address provider, uint256 amount) external whenNotPaused {
        bytes32 clusterId = addressToClusterId[msg.sender];
        Cluster storage cluster = _clusters[clusterId];

        if (cluster.clusterAddress == address(0)) {
            revert PortalRegistryErrors.ClusterNotRegistered();
        }
        if (providerAllocations[clusterId][provider] < amount) {
            revert PortalRegistryErrors.InsufficientAllocation();
        }

        // Reduce provider allocation and total stake
        providerAllocations[clusterId][provider] -= amount;
        cluster.totalStaked -= amount;

        // Check if cluster should be deactivated
        uint256 minStakeThreshold = networkController.minStakeThreshold();
        if (cluster.active && cluster.totalStaked < minStakeThreshold) {
            cluster.active = false;
            emit ClusterDeactivated(clusterId);
        }

        // Return SQD to provider
        SQD.safeTransfer(provider, amount);

        emit Withdrawn(provider, amount);
    }

    /// @inheritdoc IPortalRegistry
    function immediateUnlock(address provider, uint256 amount) external whenNotPaused {
        bytes32 clusterId = addressToClusterId[msg.sender];
        Cluster storage cluster = _clusters[clusterId];

        if (cluster.clusterAddress == address(0)) {
            revert PortalRegistryErrors.ClusterNotRegistered();
        }
        if (providerAllocations[clusterId][provider] < amount) {
            revert PortalRegistryErrors.InsufficientAllocation();
        }

        // Reduce provider allocation and total stake (bypasses exit queue)
        providerAllocations[clusterId][provider] -= amount;
        cluster.totalStaked -= amount;

        // Check if cluster should be deactivated
        uint256 minStakeThreshold = networkController.minStakeThreshold();
        if (cluster.active && cluster.totalStaked < minStakeThreshold) {
            cluster.active = false;
            emit ClusterDeactivated(clusterId);
        }

        // Return SQD to provider immediately
        SQD.safeTransfer(provider, amount);

        emit Withdrawn(provider, amount);
    }

    /// @inheritdoc IPortalRegistry
    function stakeToDirectCluster(uint256 amount) external whenNotPaused {
        if (amount == 0) revert PortalRegistryErrors.InvalidAmount();

        bytes32 clusterId = operatorToDirectCluster[msg.sender];
        if (clusterId == bytes32(0)) revert PortalRegistryErrors.NoDirectCluster();

        Cluster storage cluster = _clusters[clusterId];
        uint256 minStakeThreshold = networkController.minStakeThreshold();

        // If cluster is inactive (closed), require reactivation with total >= threshold
        if (!cluster.active) {
            uint256 newTotal = cluster.totalStaked + amount;
            if (newTotal < minStakeThreshold) {
                revert PortalRegistryErrors.BelowMinimumStake();
            }
        }

        SQD.safeTransferFrom(msg.sender, address(this), amount);

        providerAllocations[clusterId][msg.sender] += amount;
        cluster.totalStaked += amount;

        // Reactivate if was inactive
        if (!cluster.active) {
            cluster.active = true;
            emit ClusterActivated(clusterId);
        }

        emit Staked(clusterId, msg.sender, amount);
    }

    /// @inheritdoc IPortalRegistry
    /// @notice Partial unstake - cannot reduce below minimum threshold. Use closeDirectCluster() for full withdrawal.
    function unstakeFromDirectCluster(uint256 amount) external whenNotPaused {
        if (amount == 0) revert PortalRegistryErrors.InvalidAmount();

        bytes32 clusterId = operatorToDirectCluster[msg.sender];
        if (clusterId == bytes32(0)) revert PortalRegistryErrors.NoDirectCluster();

        uint256 allocation = providerAllocations[clusterId][msg.sender];
        if (allocation < amount) revert PortalRegistryErrors.InsufficientAllocation();

        Cluster storage cluster = _clusters[clusterId];
        uint256 minStakeThreshold = networkController.minStakeThreshold();
        uint256 newTotal = cluster.totalStaked - amount;

        // Cannot reduce below minimum threshold - use closeDirectCluster() for full withdrawal
        if (newTotal < minStakeThreshold) {
            revert PortalRegistryErrors.BelowMinimumStake();
        }

        // Reduce allocation (immediate - no waiting period for direct clusters)
        providerAllocations[clusterId][msg.sender] -= amount;
        cluster.totalStaked = newTotal;

        // Transfer SQD back to operator
        SQD.safeTransfer(msg.sender, amount);

        emit Unstaked(clusterId, msg.sender, amount);
    }

    /// @inheritdoc IPortalRegistry
    /// @notice Close cluster and withdraw all stake
    function closeDirectCluster() external whenNotPaused {
        bytes32 clusterId = operatorToDirectCluster[msg.sender];
        if (clusterId == bytes32(0)) revert PortalRegistryErrors.NoDirectCluster();

        Cluster storage cluster = _clusters[clusterId];
        uint256 totalAmount = cluster.totalStaked;

        if (totalAmount == 0) revert PortalRegistryErrors.InvalidAmount();

        // Clear allocation and stake
        providerAllocations[clusterId][msg.sender] = 0;
        cluster.totalStaked = 0;
        cluster.active = false;

        // Transfer all SQD back to operator
        SQD.safeTransfer(msg.sender, totalAmount);

        emit ClusterDeactivated(clusterId);
        emit Unstaked(clusterId, msg.sender, totalAmount);
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

    /// @notice Generates a unique cluster ID from address, chain, and block
    function _generateClusterId(address clusterAddress) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(clusterAddress, block.chainid, block.number));
    }

    /// @notice Required by UUPS - only admin can authorize upgrades
    function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}

