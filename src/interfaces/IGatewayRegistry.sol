// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IGatewayRegistry {
    
    struct Portal {
        bytes peerId;
        address portalAddress;
        uint256 totalStaked;
        uint256 registeredAt;
        bool active;
        string metadata;
    }
    
    struct UnlockRequest {
        uint256 amount;
        uint256 requestedAt;
        uint256 withdrawn;
    }
    
    event PortalRegistered(address indexed portal, bytes peerId, address operator);
    event PortalActivated(address indexed portal);
    event Staked(address indexed portal, address indexed provider, uint256 amount);
    event StakeReallocated(
        address indexed fromPortal,
        address indexed toPortal,
        address indexed provider,
        uint256 amount
    );
    event UnlockRequested(address indexed provider, uint256 amount, uint256 requestedAt);
    event Withdrawn(address indexed provider, uint256 amount);
    
    function registerPortal(
        bytes calldata peerId,
        address portalAddress,
        address operator
    ) external;
    
    function stake(
        address portalAddress,
        address provider,
        uint256 amount
    ) external;
    
    function reallocate(
        address fromPortal,
        address toPortal,
        address provider,
        uint256 amount
    ) external;
    
    function requestUnlock(address provider, uint256 amount) external;
    function withdrawUnlocked() external;
    function withdrawFailedPortal(address provider, uint256 amount) external;

    function getComputationUnits(address portalAddress) external view returns (uint256);
    function getTotalAllocation(address provider) external view returns (uint256);
    function getProviderPortals(address provider) external view returns (address[] memory);
}
