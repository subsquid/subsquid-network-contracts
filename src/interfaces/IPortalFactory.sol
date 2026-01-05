// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IPortalFactory {
    event PortalCreated(
        address indexed portal,
        address indexed operator,
        uint256 capacity,
        uint256 distributionRatePerSecond,
        string tokenSuffix,
        string metadata
    );
    event BeaconUpgraded(address indexed newImplementation);
    event DefaultMaxStakePerWalletUpdated(uint256 oldValue, uint256 newValue);
    event PaymentTokenAdded(address indexed token);
    event PaymentTokenRemoved(address indexed token);
    event MaxPaymentTokensUpdated(uint256 oldValue, uint256 newValue);
    event ExitUnlockRateUpdated(uint256 oldValue, uint256 newValue);
    event CollectionDeadlineUpdated(uint256 oldValue, uint256 newValue);
    event WorkerPoolAddressUpdated(address indexed oldValue, address indexed newValue);
    event MaxDistributionRateUpdated(uint256 oldValue, uint256 newValue);
    event MinDistributionRateUpdated(uint256 oldValue, uint256 newValue);

    struct CreatePortalPoolParams {
        address operator;
        uint256 capacity;
        bytes peerId;
        string tokenSuffix;
        /// @dev scaled by RATE_PRECISION (1000). To set 1 token/sec, pass 1000.
        uint256 distributionRatePerSecond;
        string metadata;
        address rewardToken;
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
    function defaultMaxStakePerWallet() external view returns (uint256);
    function getMinCapacity() external view returns (uint256);

    function setMaxPaymentTokens(uint256 value) external;
    function setExitUnlockRate(uint256 ratePerSecond) external;
    function setCollectionDeadline(uint256 seconds_) external;
    function setWorkerPoolAddress(address _workerPoolAddress) external;
    function setMaxDistributionRate(uint256 ratePerSecond) external;
    function setMinDistributionRate(uint256 ratePerSecond) external;
    function workerPoolAddress() external view returns (address);
    function maxDistributionRatePerSecond() external view returns (uint256);
    function minDistributionRatePerSecond() external view returns (uint256);

    function pause() external;
    function unpause() external;
}
