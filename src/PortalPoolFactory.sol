// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {IPortalPool} from "./interfaces/IPortalPool.sol";
import {IPortalFactory} from "./interfaces/IPortalFactory.sol";
import {IPortalRegistry} from "./interfaces/IPortalRegistry.sol";
import {IFeeRouter} from "./interfaces/IFeeRouter.sol";
import {PortalPoolBeacon} from "./PortalPoolBeacon.sol";
import {PoolErrors} from "./libs/PoolErrors.sol";
import {Constants} from "./libs/Constants.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title Portal Pool Factory Contract
/// @notice This contract creates and manages portal pool instances.
/// @dev uses UUPS proxy pattern for upgradability and beacon proxy for pool implementations.
contract PortalPoolFactory is
    IPortalFactory,
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant POOL_DEPLOYER_ROLE = keccak256("POOL_DEPLOYER_ROLE");

    PortalPoolBeacon public beacon;
    address public portalRegistry;
    address public feeRouter;
    address public sqd;
    uint256 public minStakeThreshold;
    uint256 public workerEpochLength;

    mapping(uint256 => address) public allPortals;
    uint256 public portalCount;
    mapping(address => mapping(uint256 => address)) public operatorPortalPools;
    mapping(address => uint256) public operatorPortalCount;
    mapping(address => bool) public isPortal;

    mapping(address => bool) public isAllowedPaymentToken;
    address[] public paymentTokensList;

    uint256 public defaultMaxStakePerWallet;

    uint256 public maxPaymentTokens;
    uint256 public exitUnlockRatePerSecond;
    uint256 public collectionDeadlineSeconds;
    uint256 public maxDistributionRatePerSecond;
    uint256 public minDistributionRatePerSecond;

    bool public whitelistFeatureEnabled;
    bool public defaultWhitelistEnabled;
    bool public poolDeploymentOpen;

    uint256[50] private __gap;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @dev initializes the factory with required addresses and default values.
     * @param _implementation address of the pool implementation.
     * @param _portalRegistry address of the portal registry.
     * @param _feeRouter address of the fee router.
     * @param _sqd address of the SQD token.
     * @param _defaultMaxStakePerWallet maximum stake per wallet.
     * @param _minStakeThreshold minimum stake threshold for pools.
     * @param _workerEpochLength worker epoch length in seconds.
     */
    function initialize(
        address _implementation,
        address _portalRegistry,
        address _feeRouter,
        address _sqd,
        uint256 _defaultMaxStakePerWallet,
        uint256 _minStakeThreshold,
        uint256 _workerEpochLength
    ) external initializer {
        if (_implementation == address(0)) revert PoolErrors.InvalidAddress();
        if (_portalRegistry == address(0)) revert PoolErrors.InvalidAddress();
        if (_feeRouter == address(0)) revert PoolErrors.InvalidAddress();
        if (_sqd == address(0)) revert PoolErrors.InvalidAddress();

        __AccessControl_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
        _grantRole(POOL_DEPLOYER_ROLE, msg.sender);

        beacon = new PortalPoolBeacon(_implementation, address(this));
        portalRegistry = _portalRegistry;
        feeRouter = _feeRouter;
        sqd = _sqd;
        defaultMaxStakePerWallet = _defaultMaxStakePerWallet;
        minStakeThreshold = _minStakeThreshold;
        workerEpochLength = _workerEpochLength;

        maxPaymentTokens = Constants.MAX_PAYMENT_TOKENS;
        exitUnlockRatePerSecond = 1e18;
        collectionDeadlineSeconds = 30 days;
        maxDistributionRatePerSecond = Constants.MAX_DISTRIBUTION_RATE_PER_SECOND;
        minDistributionRatePerSecond = Constants.MIN_DISTRIBUTION_RATE_PER_SECOND;

        whitelistFeatureEnabled = true;
        defaultWhitelistEnabled = true;
    }

    /**
     * @dev creates a new portal pool with the given parameters.
     * @notice Deploy a new staking pool with specified operator and configuration.
     * @param params struct containing operator, capacity, tokenSuffix, distributionRate, and metadata.
     * @return portal address of the newly created pool.
     */
    function createPortalPool(CreatePortalPoolParams calldata params) external whenNotPaused returns (address portal) {
        // If pool deployment is not open, only POOL_DEPLOYER_ROLE can create pools
        if (!poolDeploymentOpen && !hasRole(POOL_DEPLOYER_ROLE, msg.sender)) {
            revert PoolErrors.NotAuthorized();
        }

        if (params.operator == address(0)) revert PoolErrors.InvalidAddress();
        if (params.rewardToken == address(0)) revert PoolErrors.InvalidAddress();
        if (!isAllowedPaymentToken[params.rewardToken]) revert PoolErrors.TokenNotAllowed();
        if (params.capacity < minStakeThreshold) revert PoolErrors.BelowMinimum();
        if (params.distributionRatePerSecond > maxDistributionRatePerSecond) {
            revert PoolErrors.RateExceedsMaximum();
        }
        if (params.distributionRatePerSecond != 0 && params.distributionRatePerSecond < minDistributionRatePerSecond) {
            revert PoolErrors.RateBelowMinimum();
        }

        if (params.distributionRatePerSecond > 0) {
            uint256 perStakeRate =
                (params.distributionRatePerSecond * Constants.PRECISION) / (params.capacity * Constants.RATE_PRECISION);
            if (perStakeRate < Constants.MIN_PER_STAKE_RATE) {
                revert PoolErrors.InsufficientRewardPrecision();
            }
        }

        IFeeRouter.FeeConfig memory feeConfig = IFeeRouter(feeRouter).getFeeConfig();
        if (feeConfig.toWorkerPoolBPS > 0 && IFeeRouter(feeRouter).getWorkerPoolAddress() == address(0)) {
            revert PoolErrors.InvalidAddress();
        }

        IPortalPool.InitParams memory initParams = IPortalPool.InitParams({
            operator: params.operator,
            capacity: params.capacity,
            depositDeadline: 0,
            tokenSuffix: params.tokenSuffix,
            sqd: sqd,
            rewardToken: params.rewardToken,
            portalRegistry: portalRegistry,
            feeRouter: feeRouter,
            distributionRatePerSecond: params.distributionRatePerSecond,
            metadata: params.metadata
        });

        bytes memory initData = abi.encodeWithSelector(IPortalPool.initialize.selector, initParams);

        portal = address(new BeaconProxy(address(beacon), initData));

        if (params.distributionRatePerSecond > 0) {
            uint256 minDeposit = params.distributionRatePerSecond * 1 days / Constants.RATE_PRECISION;
            if (params.initialDeposit < minDeposit) revert PoolErrors.BelowMinimum();

            uint256 balanceBefore = IERC20(params.rewardToken).balanceOf(portal);
            IERC20(params.rewardToken).safeTransferFrom(msg.sender, portal, params.initialDeposit);
            uint256 actualReceived = IERC20(params.rewardToken).balanceOf(portal) - balanceBefore;
            IPortalPool(portal).initializeCredit(actualReceived);
        }

        IPortalRegistry(portalRegistry).registerCluster(portal, params.operator, params.metadata);

        allPortals[portalCount] = portal;
        ++portalCount;
        operatorPortalPools[params.operator][operatorPortalCount[params.operator]] = portal;
        ++operatorPortalCount[params.operator];
        isPortal[portal] = true;

        emit PoolCreated(
            portal,
            params.operator,
            params.rewardToken,
            params.capacity,
            params.distributionRatePerSecond,
            params.initialDeposit,
            params.tokenSuffix,
            params.metadata
        );
    }

    /**
     * @dev upgrades the beacon to point to a new implementation.
     * @param newImplementation address of the new pool implementation.
     */
    function upgradeBeacon(address newImplementation) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newImplementation == address(0)) revert PoolErrors.InvalidAddress();
        beacon.upgradeTo(newImplementation);
        emit BeaconUpgraded(newImplementation);
    }

    /**
     * @dev returns total number of portal pools created.
     */
    function getPortalCount() external view returns (uint256) {
        return portalCount;
    }

    /**
     * @dev returns minimum stake threshold for pools.
     */
    function getMinCapacity() external view returns (uint256) {
        return minStakeThreshold;
    }

    /**
     * @dev returns all pools created by an operator.
     * @param operator the operator address.
     */
    function getOperatorPortals(address operator) external view returns (address[] memory) {
        uint256 count = operatorPortalCount[operator];
        address[] memory portals = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            portals[i] = operatorPortalPools[operator][i];
        }
        return portals;
    }

    /**
     * @dev returns paginated list of pools for an operator.
     * @param operator the operator address.
     * @param offset starting index.
     * @param limit maximum number of results.
     */
    function getOperatorPortalsPaginated(address operator, uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory)
    {
        uint256 total = operatorPortalCount[operator];
        if (offset >= total) {
            return new address[](0);
        }

        uint256 end = offset + limit;
        if (end > total) {
            end = total;
        }

        uint256 size = end - offset;
        address[] memory portals = new address[](size);
        for (uint256 i = 0; i < size; i++) {
            portals[i] = operatorPortalPools[operator][offset + i];
        }
        return portals;
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function setDefaultMaxStakePerWallet(uint256 _maxStake) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 oldValue = defaultMaxStakePerWallet;
        defaultMaxStakePerWallet = _maxStake;
        emit DefaultMaxStakePerWalletUpdated(oldValue, _maxStake);
    }

    function setMaxPaymentTokens(uint256 value) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 oldValue = maxPaymentTokens;
        maxPaymentTokens = value;
        emit MaxPaymentTokensUpdated(oldValue, value);
    }

    function setExitUnlockRate(uint256 ratePerSecond) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (ratePerSecond == 0) revert PoolErrors.InvalidExitRate();
        uint256 oldValue = exitUnlockRatePerSecond;
        exitUnlockRatePerSecond = ratePerSecond;
        emit ExitUnlockRateUpdated(oldValue, ratePerSecond);
    }

    function setCollectionDeadline(uint256 seconds_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 oldValue = collectionDeadlineSeconds;
        collectionDeadlineSeconds = seconds_;
        emit CollectionDeadlineUpdated(oldValue, seconds_);
    }

    function setFeeRouter(address _feeRouter) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_feeRouter == address(0)) revert PoolErrors.InvalidAddress();
        address oldValue = feeRouter;
        feeRouter = _feeRouter;
        emit FeeRouterUpdated(oldValue, _feeRouter);
    }

    function setMaxDistributionRate(uint256 ratePerSecond) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 oldValue = maxDistributionRatePerSecond;
        maxDistributionRatePerSecond = ratePerSecond;
        emit MaxDistributionRateUpdated(oldValue, ratePerSecond);
    }

    function setMinDistributionRate(uint256 ratePerSecond) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 oldValue = minDistributionRatePerSecond;
        minDistributionRatePerSecond = ratePerSecond;
        emit MinDistributionRateUpdated(oldValue, ratePerSecond);
    }

    function setMinStakeThreshold(uint256 _minStakeThreshold) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 oldValue = minStakeThreshold;
        minStakeThreshold = _minStakeThreshold;
        emit MinStakeThresholdUpdated(oldValue, _minStakeThreshold);
    }

    function setWorkerEpochLength(uint256 _workerEpochLength) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 oldValue = workerEpochLength;
        workerEpochLength = _workerEpochLength;
        emit WorkerEpochLengthUpdated(oldValue, _workerEpochLength);
    }

    function setWhitelistFeatureEnabled(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        bool oldValue = whitelistFeatureEnabled;
        whitelistFeatureEnabled = enabled;
        emit WhitelistFeatureEnabledUpdated(oldValue, enabled);
    }

    function setDefaultWhitelistEnabled(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        bool oldValue = defaultWhitelistEnabled;
        defaultWhitelistEnabled = enabled;
        emit DefaultWhitelistEnabledUpdated(oldValue, enabled);
    }

    function setPoolDeploymentOpen(bool open) external onlyRole(DEFAULT_ADMIN_ROLE) {
        bool oldValue = poolDeploymentOpen;
        poolDeploymentOpen = open;
        emit PoolDeploymentOpenUpdated(oldValue, open);
    }

    /**
     * @dev adds a token to the allowed payment tokens list.
     * @param token address of the token to allow.
     */
    function addPaymentToken(address token) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert PoolErrors.InvalidAddress();
        if (isAllowedPaymentToken[token]) revert PoolErrors.TokenAlreadyAdded();
        if (paymentTokensList.length >= maxPaymentTokens) revert PoolErrors.TooManyTokens();

        isAllowedPaymentToken[token] = true;
        paymentTokensList.push(token);

        emit PaymentTokenAdded(token);
    }

    /**
     * @dev removes a token from the allowed payment tokens list.
     * @param token address of the token to remove.
     */
    function removePaymentToken(address token) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!isAllowedPaymentToken[token]) revert PoolErrors.TokenNotAllowed();

        isAllowedPaymentToken[token] = false;

        uint256 length = paymentTokensList.length;
        bool found = false;
        for (uint256 i = 0; i < length;) {
            if (paymentTokensList[i] == token) {
                paymentTokensList[i] = paymentTokensList[length - 1];
                paymentTokensList.pop();
                found = true;
                break;
            }
            unchecked {
                ++i;
            }
        }

        emit PaymentTokenRemoved(token);
    }

    /**
     * @dev returns list of all allowed payment tokens.
     */
    function getAllowedPaymentTokens() external view returns (address[] memory) {
        return paymentTokensList;
    }

    /// @dev authorizes contract upgrades (UUPS pattern).
    function _authorizeUpgrade(address newImplementation) internal virtual override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
