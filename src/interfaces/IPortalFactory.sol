// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IPortalFactory Interface
/// @notice Interface for the portal pool factory contract
interface IPortalFactory {
    event PoolCreated(
        address indexed portal,
        address indexed operator,
        address indexed rewardToken,
        uint256 capacity,
        uint256 distributionRatePerSecond,
        uint256 initialDeposit,
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
    event FeeRouterUpdated(address indexed oldValue, address indexed newValue);
    event MaxDistributionRateUpdated(uint256 oldValue, uint256 newValue);
    event MinDistributionRateUpdated(uint256 oldValue, uint256 newValue);
    event MinStakeThresholdUpdated(uint256 oldValue, uint256 newValue);
    event WorkerEpochLengthUpdated(uint256 oldValue, uint256 newValue);
    event WhitelistFeatureEnabledUpdated(bool oldValue, bool newValue);
    event DefaultWhitelistEnabledUpdated(bool oldValue, bool newValue);
    event PoolDeploymentOpenUpdated(bool oldValue, bool newValue);

    struct CreatePortalPoolParams {
        address operator;
        uint256 capacity;
        string tokenSuffix;
        /// @dev scaled by RATE_PRECISION (1000). To set 1 token/sec, pass 1000.
        uint256 distributionRatePerSecond;
        /// @dev initial reward deposit. Must be >= distributionRatePerSecond * 1 day / RATE_PRECISION
        uint256 initialDeposit;
        string metadata;
        address rewardToken;
    }

    function initialize(
        address _implementation,
        address _portalRegistry,
        address _feeRouter,
        address _sqd,
        uint256 _defaultMaxStakePerWallet,
        uint256 _minStakeThreshold,
        uint256 _workerEpochLength
    ) external;

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
    function setMaxDistributionRate(uint256 ratePerSecond) external;
    function setMinDistributionRate(uint256 ratePerSecond) external;
    function setMinStakeThreshold(uint256 _minStakeThreshold) external;
    function setWorkerEpochLength(uint256 _workerEpochLength) external;
    function feeRouter() external view returns (address);
    function setFeeRouter(address _feeRouter) external;
    function maxDistributionRatePerSecond() external view returns (uint256);
    function minDistributionRatePerSecond() external view returns (uint256);
    function minStakeThreshold() external view returns (uint256);
    function workerEpochLength() external view returns (uint256);

    function whitelistFeatureEnabled() external view returns (bool);
    function defaultWhitelistEnabled() external view returns (bool);
    function poolDeploymentOpen() external view returns (bool);
    function setWhitelistFeatureEnabled(bool enabled) external;
    function setDefaultWhitelistEnabled(bool enabled) external;
    function setPoolDeploymentOpen(bool open) external;

    function pause() external;
    function unpause() external;
}
