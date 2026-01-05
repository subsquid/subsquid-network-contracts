// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {IPortalPool} from "./interfaces/IPortalPool.sol";
import {IPortalFactory} from "./interfaces/IPortalFactory.sol";
import {INetworkController} from "./interfaces/INetworkController.sol";
import {IPortalRegistry} from "./interfaces/IPortalRegistry.sol";
import {PortalPoolBeacon} from "./PortalPoolBeacon.sol";
import {PortalErrors} from "./libs/PortalErrors.sol";
import {Constants} from "./libs/Constants.sol";

contract PortalPoolFactory is IPortalFactory, AccessControl, Pausable {
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    PortalPoolBeacon public immutable beacon;
    address public portalRegistry;
    address public feeRouter;
    address public networkController;
    address public sqd;

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
    address public workerPoolAddress;
    uint256 public maxDistributionRatePerSecond;
    uint256 public minDistributionRatePerSecond;

    constructor(
        address _implementation,
        address _portalRegistry,
        address _feeRouter,
        address _networkController,
        address _sqd,
        uint256 _defaultMaxStakePerWallet
    ) {
        if (_implementation == address(0)) revert PortalErrors.InvalidAddress();
        if (_portalRegistry == address(0)) revert PortalErrors.InvalidAddress();
        if (_feeRouter == address(0)) revert PortalErrors.InvalidAddress();
        if (_networkController == address(0)) revert PortalErrors.InvalidAddress();
        if (_sqd == address(0)) revert PortalErrors.InvalidAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);

        beacon = new PortalPoolBeacon(_implementation, address(this));
        portalRegistry = _portalRegistry;
        feeRouter = _feeRouter;
        networkController = _networkController;
        sqd = _sqd;
        defaultMaxStakePerWallet = _defaultMaxStakePerWallet;

        maxPaymentTokens = Constants.MAX_PAYMENT_TOKENS;
        exitUnlockRatePerSecond = Constants.EXIT_UNLOCK_RATE_PER_SECOND;
        collectionDeadlineSeconds = Constants.COLLECTION_DEADLINE_SECONDS;
        maxDistributionRatePerSecond = Constants.MAX_DISTRIBUTION_RATE_PER_SECOND;
        minDistributionRatePerSecond = Constants.MIN_DISTRIBUTION_RATE_PER_SECOND;
    }

    function createPortalPool(CreatePortalPoolParams calldata params) external whenNotPaused returns (address portal) {
        if (params.operator == address(0)) revert PortalErrors.InvalidAddress();
        if (params.rewardToken == address(0)) revert PortalErrors.InvalidAddress();
        if (!isAllowedPaymentToken[params.rewardToken]) revert PortalErrors.TokenNotAllowed();
        uint256 minCapacity = INetworkController(networkController).minStakeThreshold();
        if (params.capacity < minCapacity) revert PortalErrors.BelowMinimum();
        if (params.peerId.length == 0) revert PortalErrors.EmptyPeerId();
        // Validate distribution rate scale (protects against misconfigured decimals)
        // Rate must be 0 (disabled) or >= minimum (for precision)
        if (params.distributionRatePerSecond > maxDistributionRatePerSecond) {
            revert PortalErrors.RateExceedsMaximum();
        }
        if (params.distributionRatePerSecond != 0 && params.distributionRatePerSecond < minDistributionRatePerSecond) {
            revert PortalErrors.RateBelowMinimum();
        }

        IPortalPool.InitParams memory initParams = IPortalPool.InitParams({
            operator: params.operator,
            capacity: params.capacity,
            depositDeadline: 0,
            peerId: params.peerId,
            tokenSuffix: params.tokenSuffix,
            sqd: sqd,
            rewardToken: params.rewardToken,
            portalRegistry: portalRegistry,
            feeRouter: feeRouter,
            networkController: networkController,
            distributionRatePerSecond: params.distributionRatePerSecond,
            metadata: params.metadata
        });

        bytes memory initData = abi.encodeWithSelector(IPortalPool.initialize.selector, initParams);

        portal = address(new BeaconProxy(address(beacon), initData));

        // Register the portal in the registry
        IPortalRegistry(portalRegistry).registerPortalPool(params.peerId, portal, params.operator, params.metadata);

        allPortals[portalCount] = portal;
        ++portalCount;
        operatorPortalPools[params.operator][operatorPortalCount[params.operator]] = portal;
        ++operatorPortalCount[params.operator];
        isPortal[portal] = true;

        emit PortalCreated(
            portal,
            params.operator,
            params.capacity,
            params.distributionRatePerSecond,
            params.tokenSuffix,
            params.metadata
        );
    }

    function upgradeBeacon(address newImplementation) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newImplementation == address(0)) revert PortalErrors.InvalidAddress();
        beacon.upgradeTo(newImplementation);
        emit BeaconUpgraded(newImplementation);
    }

    function getPortalCount() external view returns (uint256) {
        return portalCount;
    }

    function getMinCapacity() external view returns (uint256) {
        return INetworkController(networkController).minStakeThreshold();
    }

    function getOperatorPortals(address operator) external view returns (address[] memory) {
        uint256 count = operatorPortalCount[operator];
        address[] memory portals = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            portals[i] = operatorPortalPools[operator][i];
        }
        return portals;
    }

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
        uint256 oldValue = exitUnlockRatePerSecond;
        exitUnlockRatePerSecond = ratePerSecond;
        emit ExitUnlockRateUpdated(oldValue, ratePerSecond);
    }

    function setCollectionDeadline(uint256 seconds_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 oldValue = collectionDeadlineSeconds;
        collectionDeadlineSeconds = seconds_;
        emit CollectionDeadlineUpdated(oldValue, seconds_);
    }

    function setWorkerPoolAddress(address _workerPoolAddress) external onlyRole(DEFAULT_ADMIN_ROLE) {
        address oldValue = workerPoolAddress;
        workerPoolAddress = _workerPoolAddress;
        emit WorkerPoolAddressUpdated(oldValue, _workerPoolAddress);
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

    function addPaymentToken(address token) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert PortalErrors.InvalidAddress();
        if (isAllowedPaymentToken[token]) revert PortalErrors.TokenAlreadyAdded();
        if (paymentTokensList.length >= maxPaymentTokens) revert PortalErrors.TooManyTokens();

        isAllowedPaymentToken[token] = true;
        paymentTokensList.push(token);

        emit PaymentTokenAdded(token);
    }

    function removePaymentToken(address token) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!isAllowedPaymentToken[token]) revert PortalErrors.TokenNotAllowed();

        isAllowedPaymentToken[token] = false;

        uint256 length = paymentTokensList.length;
        for (uint256 i = 0; i < length;) {
            if (paymentTokensList[i] == token) {
                paymentTokensList[i] = paymentTokensList[length - 1];
                paymentTokensList.pop();
                break;
            }
            unchecked {
                ++i;
            }
        }

        emit PaymentTokenRemoved(token);
    }

    function getAllowedPaymentTokens() external view returns (address[] memory) {
        return paymentTokensList;
    }
}
