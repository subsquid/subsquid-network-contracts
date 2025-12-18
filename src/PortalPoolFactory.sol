// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {IPortalPool} from "./interfaces/IPortalPool.sol";
import {IPortalFactory} from "./interfaces/IPortalFactory.sol";
import {INetworkController} from "./interfaces/INetworkController.sol";
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
    address public usdc;

    mapping(uint256 => address) public allPortals;
    uint256 public portalCount;
    mapping(address => address[]) public operatorPortals;
    mapping(address => bool) public isPortal;

    mapping(address => bool) public isAllowedPaymentToken;
    address[] public paymentTokensList;

    uint256 public maxPoolCapacity;
    uint256 public defaultMaxStakePerWallet;

    uint256 public maxPaymentTokens;
    uint256 public exitUnlockRatePerSecond;
    uint256 public collectionDeadlineSeconds;

    constructor(
        address _implementation,
        address _portalRegistry,
        address _feeRouter,
        address _networkController,
        address _sqd,
        address _usdc,
        uint256 _maxPoolCapacity,
        uint256 _defaultMaxStakePerWallet
    ) {
        if (_implementation == address(0)) revert PortalErrors.InvalidAddress();
        if (_portalRegistry == address(0)) revert PortalErrors.InvalidAddress();
        if (_feeRouter == address(0)) revert PortalErrors.InvalidAddress();
        if (_networkController == address(0)) revert PortalErrors.InvalidAddress();
        if (_sqd == address(0)) revert PortalErrors.InvalidAddress();
        if (_usdc == address(0)) revert PortalErrors.InvalidAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);

        beacon = new PortalPoolBeacon(_implementation, address(this));
        portalRegistry = _portalRegistry;
        feeRouter = _feeRouter;
        networkController = _networkController;
        sqd = _sqd;
        usdc = _usdc;
        maxPoolCapacity = _maxPoolCapacity;
        defaultMaxStakePerWallet = _defaultMaxStakePerWallet;

        maxPaymentTokens = Constants.MAX_PAYMENT_TOKENS;
        exitUnlockRatePerSecond = Constants.EXIT_UNLOCK_RATE_PER_SECOND;
        collectionDeadlineSeconds = Constants.COLLECTION_DEADLINE_SECONDS;
    }

    function createPortalPool(CreatePortalPoolParams calldata params) external whenNotPaused returns (address portal) {
        if (params.operator == address(0)) revert PortalErrors.InvalidAddress();
        if (paymentTokensList.length == 0) revert PortalErrors.NoPaymentTokens();
        uint256 minCapacity = INetworkController(networkController).minStakeThreshold();
        if (params.capacity < minCapacity) revert PortalErrors.BelowMinimum();
        if (params.capacity > maxPoolCapacity) revert PortalErrors.AboveMaximum();
        if (params.peerId.length == 0) revert PortalErrors.EmptyPeerId();

        IPortalPool.InitParams memory initParams = IPortalPool.InitParams({
            operator: params.operator,
            maxCapacity: params.capacity,
            depositDeadline: 0,
            peerId: params.peerId,
            portalName: params.portalName,
            sqd: sqd,
            usdc: usdc,
            portalRegistry: portalRegistry,
            feeRouter: feeRouter,
            networkController: networkController,
            distributionRatePerSecond: params.distributionRatePerSecond,
            maxStakePerWallet: defaultMaxStakePerWallet,
            metadata: params.metadata
        });

        bytes memory initData = abi.encodeWithSelector(IPortalPool.initialize.selector, initParams);

        portal = address(new BeaconProxy(address(beacon), initData));

        allPortals[portalCount] = portal;
        ++portalCount;
        operatorPortals[params.operator].push(portal);
        isPortal[portal] = true;

        emit PortalCreated(portal, params.operator, params.peerId);
    }

    function upgradeBeacon(address newImplementation) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newImplementation == address(0)) revert PortalErrors.InvalidAddress();
        beacon.upgradeTo(newImplementation);
        emit BeaconUpgraded(newImplementation);
    }

    function getPortalCount() external view returns (uint256) {
        return portalCount;
    }

    function getOperatorPortals(address operator) external view returns (address[] memory) {
        return operatorPortals[operator];
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function setMaxPoolCapacity(uint256 _maxCapacity) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 oldValue = maxPoolCapacity;
        maxPoolCapacity = _maxCapacity;
        emit MaxPoolCapacityUpdated(oldValue, _maxCapacity);
    }

    function setDefaultMaxStakePerWallet(uint256 _maxStake) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 oldValue = defaultMaxStakePerWallet;
        defaultMaxStakePerWallet = _maxStake;
        emit DefaultMaxStakePerWalletUpdated(oldValue, _maxStake);
    }

    function setUsdc(address _usdc) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_usdc == address(0)) revert PortalErrors.InvalidAddress();
        address oldUsdc = usdc;
        usdc = _usdc;
        emit UsdcUpdated(oldUsdc, _usdc);
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
