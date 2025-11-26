// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IPortalFactory {
    // Events
    event PortalCreated(address indexed portal, address indexed operator, bytes peerId);
    event PortalPaymentTokensSet(address indexed portal, address[] paymentTokens);
    event PortalUpgraded(address indexed portal, address indexed newImplementation);
    event ImplementationUpdated(address indexed oldImplementation, address indexed newImplementation);
    event MinStakeThresholdUpdated(uint256 oldValue, uint256 newValue);

    // Functions
    function createPortal(
        address operator,
        address[] calldata paymentTokens,
        uint256 maxCapacity,
        uint256 depositDeadline,
        bytes calldata peerId
    ) external returns (address portal);

    function upgradePortal(address portal, address newImplementation) external;
    function upgradeAllPortals(address newImplementation) external;
    function upgradePortalsBatch(address newImplementation, uint256 startIndex, uint256 endIndex) external;

    function getPortalCount() external view returns (uint256);
    function getOperatorPortals(address operator) external view returns (address[] memory);
    function isPortal(address portal) external view returns (bool);

    function pause() external;
    function unpause() external;
    function setImplementation(address implementation) external;
    function setMinStakeThreshold(uint256 threshold) external;
}
