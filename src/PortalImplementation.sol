// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {PortalStorage} from "./storage/PortalStorage.sol";
import {IGatewayRegistry} from "./interfaces/IGatewayRegistry.sol";
import {IFeeRouter} from "./interfaces/IFeeRouter.sol";
import {INetworkController} from "./interfaces/INetworkController.sol";
import {IPortal} from "./interfaces/IPortal.sol";
import {PortalErrors} from "./libs/PortalErrors.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract PortalImplementation is
    IPortal,
    PortalStorage,
    Initializable,
    UUPSUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable
{
    using SafeERC20 for IERC20;

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant FACTORY_ROLE = keccak256("FACTORY_ROLE");
    uint256 public constant BASIS_POINTS = 10000;
    uint256 public constant MAX_PAYMENT_TOKENS = 10;

    modifier onlyOperator() {
        if (!hasRole(OPERATOR_ROLE, msg.sender)) revert PortalErrors.NotOperator();
        _;
    }

    modifier whenPortalNotPaused() {
        if (_portalInfo.paused) revert PortalErrors.PortalPaused();
        _;
    }

    modifier inState(PortalState expected) {
        if (_portalInfo.state != expected) revert PortalErrors.InvalidState();
        _;
    }

    function initialize(
        address operator,
        uint256 maxCapacity,
        uint256 depositDeadline,
        bytes calldata peerId,
        address sqd,
        address gatewayRegistry,
        address feeRouter,
        address networkController
    ) external initializer {
        if (operator == address(0)) revert PortalErrors.InvalidAddress();
        if (sqd == address(0)) revert PortalErrors.InvalidAddress();
        if (gatewayRegistry == address(0)) revert PortalErrors.InvalidAddress();
        if (feeRouter == address(0)) revert PortalErrors.InvalidAddress();
        if (networkController == address(0)) revert PortalErrors.InvalidAddress();
        if (depositDeadline <= block.number) revert PortalErrors.InvalidDeadline();

        __AccessControl_init();
        __Pausable_init();

        _peerId = peerId;
        _sqd = IERC20(sqd);
        _gatewayRegistry = IGatewayRegistry(gatewayRegistry);
        _feeRouter = IFeeRouter(feeRouter);
        _networkController = INetworkController(networkController);

        if (maxCapacity < _networkController.minStakeThreshold()) revert PortalErrors.BelowMinimum();

        _portalInfo.operator = operator;
        _portalInfo.maxCapacity = maxCapacity;
        _portalInfo.totalStaked = 0;
        _portalInfo.depositDeadline = uint64(depositDeadline);
        _portalInfo.activationTime = 0;
        _portalInfo.state = PortalState.COLLECTING;
        _portalInfo.paused = false;

        _grantRole(DEFAULT_ADMIN_ROLE, operator);
        _grantRole(OPERATOR_ROLE, operator);
        _grantRole(FACTORY_ROLE, msg.sender);

        _gatewayRegistry.registerPortal(_peerId, address(this), _portalInfo.operator);
    }

    function initializePaymentTokens(address[] calldata paymentTokens) external {
        if (!hasRole(FACTORY_ROLE, msg.sender) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert PortalErrors.NotAuthorized();
        }
        if (paymentTokens.length == 0) revert PortalErrors.InvalidAmount();
        if (paymentTokens.length > MAX_PAYMENT_TOKENS) revert PortalErrors.TooManyTokens();
        if (paymentTokensList.length != 0) revert PortalErrors.AlreadyInitialized();

        for (uint256 i = 0; i < paymentTokens.length; ++i) {
            if (paymentTokens[i] == address(0)) revert PortalErrors.InvalidAddress();
            if (allowedPaymentTokens[paymentTokens[i]]) revert PortalErrors.TokenAlreadyAdded();
            allowedPaymentTokens[paymentTokens[i]] = true;
            paymentTokensList.push(paymentTokens[i]);
        }

        emit PaymentTokensInitialized(paymentTokens);
    }

    function stake(uint256 amount) external whenNotPaused whenPortalNotPaused {
        if (amount == 0) revert PortalErrors.InvalidAmount();

        if (_portalInfo.state != PortalState.COLLECTING && _portalInfo.state != PortalState.ACTIVE) {
            revert PortalErrors.InvalidState();
        }

        if (_portalInfo.state == PortalState.COLLECTING) {
            if (block.number > _portalInfo.depositDeadline) {
                _handleDeadlinePassed();
                revert PortalErrors.DeadlinePassed();
            }
        }

        uint256 newTotal = _portalInfo.totalStaked + amount;
        if (newTotal > _portalInfo.maxCapacity) revert PortalErrors.CapacityExceeded();

        _stakes[msg.sender] += amount;
        _portalInfo.totalStaked = newTotal;

        _gatewayRegistry.stake(address(this), msg.sender, amount);

        if (_portalInfo.state == PortalState.COLLECTING && _portalInfo.totalStaked >= _portalInfo.maxCapacity) {
            PortalState oldState = _portalInfo.state;
            _portalInfo.state = PortalState.ACTIVE;
            _portalInfo.activationTime = uint64(block.number);
            emit StateChanged(oldState, PortalState.ACTIVE);
        }

        emit Staked(msg.sender, amount, _portalInfo.totalStaked);
    }

    function activate() external onlyOperator inState(PortalState.COLLECTING) {
        PortalState oldState = _portalInfo.state;
        _portalInfo.state = PortalState.ACTIVE;
        _portalInfo.activationTime = uint64(block.number);

        emit StateChanged(oldState, PortalState.ACTIVE);
    }

    function requestExit(uint256 amount) external whenNotPaused whenPortalNotPaused {
        if (amount == 0) revert PortalErrors.InvalidAmount();
        if (_stakes[msg.sender] < amount) revert PortalErrors.InsufficientStake();

        uint256 currentEpoch = _networkController.epochNumber();
        uint256 percentage = (_portalInfo.totalStaked > 0) ? (amount * 100) / _portalInfo.totalStaked : 0;
        uint256 requiredEpochs = 1 + percentage;

        ExitRequest storage request = _exitRequests[msg.sender];
        request.amount += amount;
        request.requestEpoch = uint64(currentEpoch);
        request.unlockEpoch = uint64(currentEpoch + requiredEpochs);

        _exitAmounts[msg.sender] += amount;
        _totalExitAmounts += amount;

        _gatewayRegistry.requestUnlock(msg.sender, _exitAmounts[msg.sender]);

        emit ExitRequested(msg.sender, amount, request.unlockEpoch);
    }

    function onAllocationReduced(address provider, uint256 amount) external {
        if (msg.sender != address(_gatewayRegistry)) revert PortalErrors.NotGatewayRegistry();

        _stakes[provider] -= amount;
        _portalInfo.totalStaked -= amount;

        if (_exitAmounts[provider] > 0) {
            uint256 reduction = _exitAmounts[provider] >= amount ? amount : _exitAmounts[provider];
            _exitAmounts[provider] -= reduction;
            _totalExitAmounts -= reduction;

            if (_exitAmounts[provider] == 0) {
                delete _exitRequests[provider];
            }
        }

        emit AllocationReduced(provider, amount);
    }

    function withdrawFromFailed() external {
        if (_portalInfo.state != PortalState.FAILED) revert PortalErrors.PortalNotFailed();

        uint256 amount = _stakes[msg.sender];
        if (amount == 0) revert PortalErrors.NoStakeToWithdraw();

        _stakes[msg.sender] = 0;
        _portalInfo.totalStaked -= amount;

        if (_exitAmounts[msg.sender] > 0) {
            _totalExitAmounts -= _exitAmounts[msg.sender];
            _exitAmounts[msg.sender] = 0;
            delete _exitRequests[msg.sender];
        }

        _gatewayRegistry.withdrawFailedPortal(msg.sender, amount);

        emit Withdrawn(msg.sender, amount);
    }

    function distributeFees(address token, uint256 amount)
        external
        onlyOperator
        inState(PortalState.ACTIVE)
        whenNotPaused
        whenPortalNotPaused
    {
        if (amount == 0) revert PortalErrors.InvalidAmount();
        if (token == address(0)) revert PortalErrors.InvalidAddress();
        if (!allowedPaymentTokens[token]) revert PortalErrors.TokenNotAllowed();

        IERC20 paymentToken = IERC20(token);

        (uint256 toProviders, uint256 toWorkerPool, uint256 toBurn) = _feeRouter.calculateSplit(amount);

        // Defensive check: ensure _totalExitAmounts never exceeds totalStaked
        uint256 activeStake =
            _portalInfo.totalStaked > _totalExitAmounts ? _portalInfo.totalStaked - _totalExitAmounts : 0;
        if (activeStake > 0) {
            _cumulativeFeesPerShare[token] += (toProviders * 1e18) / activeStake;
        }

        totalFeesDistributed[token] += toProviders;
        lastDistributionTime[token] = block.timestamp;

        paymentToken.safeTransferFrom(msg.sender, address(this), amount);

        address workerPool = _networkController.workerRewardPool();
        paymentToken.safeTransfer(workerPool, toWorkerPool);

        if (toBurn > 0) {
            paymentToken.safeTransfer(address(0), toBurn);
        }

        emit FeesDistributed(token, amount, toProviders, toWorkerPool, toBurn);
    }

    function claimFees(address token) external whenNotPaused whenPortalNotPaused returns (uint256 claimed) {
        if (token == address(0)) revert PortalErrors.InvalidAddress();
        if (!allowedPaymentTokens[token]) revert PortalErrors.TokenNotAllowed();

        claimed = _calculateClaimable(msg.sender, token);
        if (claimed == 0) revert PortalErrors.NothingToClaim();

        _providerCheckpoint[token][msg.sender] = _cumulativeFeesPerShare[token];
        _providerTotalClaimed[token][msg.sender] += claimed;

        IERC20(token).safeTransfer(msg.sender, claimed);

        emit FeesClaimed(msg.sender, token, claimed);
    }

    function getPortalInfo() external view returns (PortalInfo memory) {
        return _portalInfo;
    }

    function getProviderStake(address provider) external view returns (uint256) {
        return _stakes[provider];
    }

    function getExitRequest(address provider) external view returns (ExitRequest memory) {
        return _exitRequests[provider];
    }

    function getClaimableFees(address /* provider */ ) external pure returns (uint256) {
        return 0;
    }

    function getClaimableFees(address provider, address token) external view returns (uint256) {
        return _calculateClaimable(provider, token);
    }

    function _calculateClaimable(address provider, address token) internal view returns (uint256) {
        uint256 providerStake = _stakes[provider];
        if (providerStake == 0) return 0;

        uint256 exitAmount = _exitAmounts[provider];
        uint256 activeStake = providerStake > exitAmount ? providerStake - exitAmount : 0;

        if (activeStake == 0) return 0;

        uint256 checkpoint = _providerCheckpoint[token][provider];
        uint256 cumulative = _cumulativeFeesPerShare[token];

        // Defensive check: ensure checkpoint never exceeds cumulative
        if (checkpoint >= cumulative) return 0;
        uint256 accumulated = cumulative - checkpoint;

        return (activeStake * accumulated) / 1e18;
    }

    function getPeerId() external view returns (bytes memory) {
        return _peerId;
    }

    function getActiveStake() external view returns (uint256) {
        return _portalInfo.totalStaked > _totalExitAmounts ? _portalInfo.totalStaked - _totalExitAmounts : 0;
    }

    function getAllowedPaymentTokens() external view returns (address[] memory tokens) {
        return paymentTokensList;
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _portalInfo.paused = true;
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _portalInfo.paused = false;
    }

    function upgradeTo(address newImplementation) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender) && !hasRole(FACTORY_ROLE, msg.sender)) {
            revert PortalErrors.NotAuthorized();
        }
        upgradeToAndCall(newImplementation, "");
    }

    function _authorizeUpgrade(address) internal override {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender) && !hasRole(FACTORY_ROLE, msg.sender)) {
            revert PortalErrors.NotAuthorized();
        }
    }

    function _handleDeadlinePassed() internal {
        if (_portalInfo.totalStaked < _networkController.minStakeThreshold()) {
            _portalInfo.state = PortalState.FAILED;
            emit StateChanged(PortalState.COLLECTING, PortalState.FAILED);
        }
    }

    function checkAndFailPortal() external {
        if (_portalInfo.state != PortalState.COLLECTING) revert PortalErrors.InvalidState();
        if (block.number <= _portalInfo.depositDeadline) revert PortalErrors.DeadlineNotPassed();

        _handleDeadlinePassed();
    }
}
