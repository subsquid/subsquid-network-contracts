// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IPortalFactory {
    event PortalCreated(address indexed portal, address indexed operator, bytes peerId);
    event BeaconUpgraded(address indexed newImplementation);
    event MaxPoolCapacityUpdated(uint256 oldValue, uint256 newValue);
    event DefaultMaxStakePerWalletUpdated(uint256 oldValue, uint256 newValue);
    event UsdcUpdated(address indexed oldUsdc, address indexed newUsdc);
    event PaymentTokenAdded(address indexed token);
    event PaymentTokenRemoved(address indexed token);
    event MaxPaymentTokensUpdated(uint256 oldValue, uint256 newValue);
    event ExitUnlockRateUpdated(uint256 oldValue, uint256 newValue);
    event CollectionDeadlineUpdated(uint256 oldValue, uint256 newValue);

    struct CreatePortalPoolParams {
        address operator;
        uint256 capacity;
        bytes peerId;
        string portalName;
        uint256 distributionRatePerSecond;
        string metadata;
    }

    function createPortalPool(CreatePortalPoolParams calldata params) external returns (address portal);

    function upgradeBeacon(address newImplementation) external;

    function getPortalCount() external view returns (uint256);
    function getOperatorPortals(address operator) external view returns (address[] memory);
    function isPortal(address portal) external view returns (bool);

    function addPaymentToken(address token) external;
    function removePaymentToken(address token) external;
    function isAllowedPaymentToken(address token) external view returns (bool);
    function getAllowedPaymentTokens() external view returns (address[] memory);

    function maxPaymentTokens() external view returns (uint256);
    function exitUnlockRatePerSecond() external view returns (uint256);
    function collectionDeadlineSeconds() external view returns (uint256);
    function maxPoolCapacity() external view returns (uint256);

    function setMaxPaymentTokens(uint256 value) external;
    function setExitUnlockRate(uint256 ratePerSecond) external;
    function setCollectionDeadline(uint256 seconds_) external;

    function pause() external;
    function unpause() external;
    function setMaxPoolCapacity(uint256 maxCapacity) external;
}
