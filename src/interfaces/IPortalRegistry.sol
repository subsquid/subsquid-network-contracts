// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IPortalRegistry
 * @notice core registry for all portals - supports both direct portals (BYO stake) and pool-based portals (crowdfunded)
 */
interface IPortalRegistry {
    enum PortalType {
        POOL,
        DIRECT
    }

    struct Portal {
        bytes peerId;
        address portalAddress;
        address operator;
        uint256 totalStaked;
        uint256 registeredAt;
        bool active;
        PortalType portalType;
        string metadata;
    }

    // Events
    event PortalRegistered(address indexed portal, bytes peerId, address operator, PortalType portalType);
    event PortalActivated(address indexed portal);
    event PortalDeactivated(address indexed portal);
    event Staked(address indexed portal, address indexed provider, uint256 amount);
    event Unstaked(address indexed portal, address indexed provider, uint256 amount);
    event Withdrawn(address indexed provider, uint256 amount);
    event MinStakeUpdated(uint256 oldValue, uint256 newValue);
    event ManaUpdated(uint256 oldValue, uint256 newValue);
    event PortalStatusChanged(address indexed portal, bool status);
    event MetadataChanged(address indexed portal, string metadata);

    function registerDirectPortal(bytes calldata peerId, string calldata metadata) external returns (address portalId);

    function stakeToDirectPortal(uint256 amount) external;

    function unstakeFromDirectPortal(uint256 amount) external;

    function getDirectPortalId(address operator) external view returns (address);

    function registerPortalPool(
        bytes calldata peerId,
        address portalAddress,
        address operator,
        string calldata metadata
    ) external;

    function stake(address portalAddress, address provider, uint256 amount) external;

    function withdrawFailedPortal(address provider, uint256 amount) external;

    function immediateUnlock(address provider, uint256 amount) external;

    function activatePortalPool() external;

    function stakePoolFunds(uint256 amount) external;

    function getComputationUnits(address portalAddress) external view returns (uint256);
    function getPortal(address portalAddress) external view returns (Portal memory);
    function isDirectPortal(address portalAddress) external view returns (bool);
    function isPortal(address portalAddress) external view returns (bool);

    function setMetadata(address portalAddress, string calldata metadata) external;
    function getMetadata(address portalAddress) external view returns (string memory);

    function pause() external;
    function unpause() external;
    function setMinStake(uint256 minStake) external;
    function setMana(uint256 mana) external;
    function setPortalStatus(address portal, bool status) external;
}
