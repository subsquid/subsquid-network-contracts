// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IGatewayRegistry {
    // Structs
    struct Portal {
        bytes peerId;
        address portalAddress;
        uint256 totalStaked;
        uint256 registeredAt;
        bool active;
    }

    struct UnlockRequest {
        uint256 amount;
        uint256 requestedAt;
        uint256 withdrawn;
    }

    // Events
    event PortalRegistered(address indexed portal, bytes peerId, address operator);
    event PortalActivated(address indexed portal);
    event Staked(address indexed portal, address indexed provider, uint256 amount);
    event UnlockRequested(address indexed provider, uint256 amount, uint256 requestedAt);
    event Withdrawn(address indexed provider, uint256 amount);
    event MinStakeUpdated(uint256 oldValue, uint256 newValue);
    event ManaUpdated(uint256 oldValue, uint256 newValue);
    event BaseExitEpochsUpdated(uint256 oldValue, uint256 newValue);

    // Functions
    function registerPortal(bytes calldata peerId, address portalAddress, address operator) external;
    function stake(address portalAddress, address provider, uint256 amount) external;
    function requestUnlock(address provider, uint256 amount) external returns (uint256 unlockEpoch);
    function withdrawUnlocked() external;
    function withdrawFailedPortal(address provider, uint256 amount) external;

    function getComputationUnits(address portalAddress) external view returns (uint256);
    function getTotalAllocation(address provider) external view returns (uint256);
    function getProviderPortals(address provider) external view returns (address[] memory);

    function pause() external;
    function unpause() external;
    function setMinStake(uint256 minStake) external;
    function setMana(uint256 mana) external;
    function setBaseExitEpochs(uint256 baseExitEpochs) external;
}
