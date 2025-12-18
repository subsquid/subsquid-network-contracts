// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {INetworkController} from "./interfaces/INetworkController.sol";
import {IPortalRegistry} from "./interfaces/IPortalRegistry.sol";
import {PortalRegistryErrors} from "./libs/PortalRegistryErrors.sol";
import {FullMath} from "./libs/FullMath.sol";

/**
 * @title PortalRegistry
 * @notice Core registry for all portals in the Subsquid network
 */
contract PortalRegistry is IPortalRegistry, AccessControl, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    IERC20 public immutable SQD;
    INetworkController public networkController;

    // Portal storage
    mapping(address => Portal) public portals;
    mapping(bytes32 => address) public peerIdToPortal;

    //  is this address a registered portal?
    mapping(address => bool) public isPortal;

    //  portal => provider => amount (for direct portals only)
    mapping(address => mapping(address => uint256)) public providerAllocations;

    // direct portal mapping: operator => portalId
    mapping(address => address) public operatorToDirectPortal;

    // counter for generating unique direct portal IDs
    uint256 private _directPortalNonce;

    // Configuration
    uint256 public minStake;
    uint256 public mana;

    constructor(address _sqd, address _networkController, uint256 _minStake, uint256 _mana) {
        if (_sqd == address(0)) revert PortalRegistryErrors.InvalidAddress();
        if (_networkController == address(0)) revert PortalRegistryErrors.InvalidAddress();

        SQD = IERC20(_sqd);
        networkController = INetworkController(_networkController);
        minStake = _minStake;
        mana = _mana;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
    }

    /// @inheritdoc IPortalRegistry
    function registerDirectPortal(bytes calldata peerId) external whenNotPaused returns (address portalId) {
        if (operatorToDirectPortal[msg.sender] != address(0)) {
            revert PortalRegistryErrors.AlreadyHasDirectPortal();
        }

        bytes32 peerIdHash = keccak256(peerId);
        if (peerIdToPortal[peerIdHash] != address(0)) {
            revert PortalRegistryErrors.PeerIdInUse();
        }

        // Generate unique portal ID for direct portals
        ++_directPortalNonce;
        portalId =
            address(uint160(uint256(keccak256(abi.encodePacked(msg.sender, _directPortalNonce, block.timestamp)))));

        portals[portalId] = Portal({
            peerId: peerId,
            portalAddress: portalId,
            operator: msg.sender,
            totalStaked: 0,
            registeredAt: block.number,
            active: false,
            portalType: PortalType.DIRECT
        });

        peerIdToPortal[peerIdHash] = portalId;
        operatorToDirectPortal[msg.sender] = portalId;
        isPortal[portalId] = true;

        emit PortalRegistered(portalId, peerId, msg.sender, PortalType.DIRECT);
    }

    /// @inheritdoc IPortalRegistry
    function stakeToDirectPortal(uint256 amount) external whenNotPaused {
        if (amount == 0) revert PortalRegistryErrors.InvalidAmount();

        address portalId = operatorToDirectPortal[msg.sender];
        if (portalId == address(0)) revert PortalRegistryErrors.NoDirectPortal();

        Portal storage portal = portals[portalId];

        SQD.safeTransferFrom(msg.sender, address(this), amount);

        providerAllocations[portalId][msg.sender] += amount;
        portal.totalStaked += amount;

        uint256 minStakeThreshold = networkController.minStakeThreshold();
        if (!portal.active && portal.totalStaked >= minStakeThreshold) {
            portal.active = true;
            emit PortalActivated(portalId);
        }

        emit Staked(portalId, msg.sender, amount);
    }

    /// @inheritdoc IPortalRegistry
    function unstakeFromDirectPortal(uint256 amount) external whenNotPaused {
        if (amount == 0) revert PortalRegistryErrors.InvalidAmount();

        address portalId = operatorToDirectPortal[msg.sender];
        if (portalId == address(0)) revert PortalRegistryErrors.NoDirectPortal();

        uint256 allocation = providerAllocations[portalId][msg.sender];
        if (allocation < amount) revert PortalRegistryErrors.InsufficientAllocation();

        Portal storage portal = portals[portalId];

        // Reduce allocation (immediate - no waiting period for direct portals)
        providerAllocations[portalId][msg.sender] -= amount;
        portal.totalStaked -= amount;

        // Check if portal should be deactivated
        uint256 minStakeThreshold = networkController.minStakeThreshold();
        if (portal.active && portal.totalStaked < minStakeThreshold) {
            portal.active = false;
            emit PortalDeactivated(portalId);
        }

        // Transfer SQD back to operator
        SQD.safeTransfer(msg.sender, amount);

        emit Unstaked(portalId, msg.sender, amount);
    }

    /// @inheritdoc IPortalRegistry
    function getDirectPortalId(address operator) external view returns (address) {
        return operatorToDirectPortal[operator];
    }

    /// @inheritdoc IPortalRegistry
    function registerPortalPool(bytes calldata peerId, address portalAddress, address operator) external whenNotPaused {
        if (msg.sender != portalAddress) revert PortalRegistryErrors.OnlyPortal();
        if (operator == address(0)) revert PortalRegistryErrors.InvalidAddress();
        if (peerId.length == 0) revert PortalRegistryErrors.InvalidPeerId();
        if (portals[portalAddress].portalAddress != address(0)) {
            revert PortalRegistryErrors.PortalAlreadyRegistered();
        }

        bytes32 peerIdHash = keccak256(peerId);
        if (peerIdToPortal[peerIdHash] != address(0)) {
            revert PortalRegistryErrors.PeerIdInUse();
        }

        portals[portalAddress] = Portal({
            peerId: peerId,
            portalAddress: portalAddress,
            operator: operator,
            totalStaked: 0,
            registeredAt: block.number,
            active: false,
            portalType: PortalType.POOL
        });

        peerIdToPortal[peerIdHash] = portalAddress;
        isPortal[portalAddress] = true;

        emit PortalRegistered(portalAddress, peerId, operator, PortalType.POOL);
    }

    /// @inheritdoc IPortalRegistry
    function stake(address portalAddress, address provider, uint256 amount) external whenNotPaused {
        if (msg.sender != portalAddress) revert PortalRegistryErrors.OnlyPortal();
        if (amount == 0) revert PortalRegistryErrors.InvalidAmount();
        if (portals[portalAddress].portalAddress == address(0)) {
            revert PortalRegistryErrors.PortalNotRegistered();
        }

        SQD.safeTransferFrom(msg.sender, address(this), amount);

        providerAllocations[portalAddress][provider] += amount;

        Portal storage portal = portals[portalAddress];
        portal.totalStaked += amount;

        emit Staked(portalAddress, provider, amount);
    }

    /// @inheritdoc IPortalRegistry
    function activatePortalPool() external whenNotPaused {
        address portalAddress = msg.sender;
        Portal storage portal = portals[portalAddress];

        if (portal.portalAddress == address(0)) {
            revert PortalRegistryErrors.PortalNotRegistered();
        }
        if (portal.portalType != PortalType.POOL) {
            revert PortalRegistryErrors.OnlyPoolPortal();
        }
        if (portal.active) {
            return; // Already active, no-op
        }

        portal.active = true;
        emit PortalActivated(portalAddress);
    }

    /// @inheritdoc IPortalRegistry
    function stakePoolFunds(uint256 amount) external whenNotPaused {
        address portalAddress = msg.sender;
        Portal storage portal = portals[portalAddress];

        if (portal.portalAddress == address(0)) {
            revert PortalRegistryErrors.PortalNotRegistered();
        }
        if (portal.portalType != PortalType.POOL) {
            revert PortalRegistryErrors.OnlyPoolPortal();
        }

        // Pull SQD from the Pool (Pool must have approved this contract)
        SQD.safeTransferFrom(portalAddress, address(this), amount);

        // Update portal's total stake (individual allocations tracked in Pool)
        portal.totalStaked += amount;

        emit Staked(portalAddress, portalAddress, amount);
    }

    /// @inheritdoc IPortalRegistry
    function withdrawFailedPortal(address provider, uint256 amount) external whenNotPaused {
        address portalAddress = msg.sender;
        if (portals[portalAddress].portalAddress == address(0)) {
            revert PortalRegistryErrors.PortalNotRegistered();
        }
        if (providerAllocations[portalAddress][provider] < amount) {
            revert PortalRegistryErrors.InsufficientAllocation();
        }

        providerAllocations[portalAddress][provider] -= amount;
        portals[portalAddress].totalStaked -= amount;

        Portal storage portal = portals[portalAddress];
        uint256 minStakeThreshold = networkController.minStakeThreshold();
        if (portal.active && portal.totalStaked < minStakeThreshold) {
            portal.active = false;
            emit PortalDeactivated(portalAddress);
        }

        SQD.safeTransfer(provider, amount);

        emit Withdrawn(provider, amount);
    }

    /// @inheritdoc IPortalRegistry
    function immediateUnlock(address provider, uint256 amount) external whenNotPaused {
        address portalAddress = msg.sender;
        if (portals[portalAddress].portalAddress == address(0)) {
            revert PortalRegistryErrors.PortalNotRegistered();
        }
        if (providerAllocations[portalAddress][provider] < amount) {
            revert PortalRegistryErrors.InsufficientAllocation();
        }

        providerAllocations[portalAddress][provider] -= amount;
        portals[portalAddress].totalStaked -= amount;

        Portal storage portal = portals[portalAddress];
        uint256 minStakeThreshold = networkController.minStakeThreshold();
        if (portal.active && portal.totalStaked < minStakeThreshold) {
            portal.active = false;
            emit PortalDeactivated(portalAddress);
        }

        SQD.safeTransfer(provider, amount);

        emit Withdrawn(provider, amount);
    }

    /// @inheritdoc IPortalRegistry
    function getComputationUnits(address portalAddress) external view returns (uint256) {
        Portal storage portal = portals[portalAddress];

        if (!portal.active) return 0;

        uint256 epochLength = networkController.workerEpochLength();
        uint256 boostFactor = 30000;

        // Use FullMath for 512-bit precision to prevent overflow
        // Formula: (totalStaked * epochLength * mana * boostFactor) / (10000 * 1e18 * 1000)
        uint256 cus = FullMath.mulDiv(portal.totalStaked * epochLength, mana * boostFactor, 10000 * 1e18 * 1000);

        return cus;
    }

    /// @inheritdoc IPortalRegistry
    function getPortal(address portalAddress) external view returns (Portal memory) {
        return portals[portalAddress];
    }

    /// @inheritdoc IPortalRegistry
    function isDirectPortal(address portalAddress) external view returns (bool) {
        return portals[portalAddress].portalType == PortalType.DIRECT;
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
    function setPortalStatus(address portal, bool status) external onlyRole(DEFAULT_ADMIN_ROLE) {
        isPortal[portal] = status;
        emit PortalStatusChanged(portal, status);
    }
}
