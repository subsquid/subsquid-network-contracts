// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IPortalFactory {
    
    event PortalCreated(
        address indexed portal,
        address indexed operator,
        address paymentToken,
        bytes peerId
    );
    
    event PortalUpgraded(
        address indexed portal,
        address indexed newImplementation
    );
    
    event StakeMoved(
        address indexed fromPortal,
        address indexed toPortal,
        address indexed provider,
        uint256 amount
    );
    
    function createPortal(
        address operator,
        address paymentToken,
        uint256 maxCapacity,
        uint256 depositDeadline,
        bytes calldata peerId,
        string calldata metadata
    ) external returns (address portal);
    
    function moveStake(
        address fromPortal,
        address toPortal,
        uint256 amount
    ) external;
    
    function upgradePortal(
        address portal,
        address newImplementation
    ) external;
    
    function upgradeAllPortals(
        address newImplementation
    ) external;
    
    function getPortalCount() external view returns (uint256);
    function getOperatorPortals(address operator) external view returns (address[] memory);
    function isPortal(address portal) external view returns (bool);
}
