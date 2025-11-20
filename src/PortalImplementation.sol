// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {PortalStorage} from "./storage/PortalStorage.sol";
import {IGatewayRegistry} from "./interfaces/IGatewayRegistry.sol";
import {IFeeRouter} from "./interfaces/IFeeRouter.sol";
import {INetworkController} from "./interfaces/INetworkController.sol";
import {PortalErrors} from "./libs/PortalErrors.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract PortalImplementation is
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
    uint256 public constant MAX_EXIT_PER_EPOCH_BPS = 100;
    
    event Staked(address indexed provider, uint256 amount, uint256 newTotal);
    event ExitRequested(address indexed provider, uint256 amount, uint256 unlockEpoch);
    event Withdrawn(address indexed provider, uint256 amount);
    event FeesDistributed(address indexed token, uint256 totalAmount, uint256 toProviders, uint256 toWorkers, uint256 toBurn);
    event FeesClaimed(address indexed provider, address indexed token, uint256 amount);
    event StateChanged(PortalState oldState, PortalState newState);
    event AllocationReduced(address indexed provider, uint256 amount);
    event PaymentTokensInitialized(address[] paymentTokens);
    
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
        require(operator != address(0), "Invalid operator");
        require(depositDeadline > block.number, "Invalid deadline");

        __AccessControl_init();
        __Pausable_init();

        _peerId = peerId;
        _sqd = IERC20(sqd);
        _gatewayRegistry = IGatewayRegistry(gatewayRegistry);
        _feeRouter = IFeeRouter(feeRouter);
        _networkController = INetworkController(networkController);
        
        require(maxCapacity >= _networkController.minStakeThreshold(), "Below minimum");
        
        _portalInfo.operator = operator;
        _portalInfo.maxCapacity = uint96(maxCapacity);
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
    
    /**
     * @notice Initialize payment tokens - can be called after initialize() to set multiple tokens
     * @param paymentTokens Array of ERC20 token addresses to allow for fee distribution
     */
    function initializePaymentTokens(address[] calldata paymentTokens) external {
        require(hasRole(FACTORY_ROLE, msg.sender) || hasRole(DEFAULT_ADMIN_ROLE, msg.sender), "Not authorized");
        require(paymentTokens.length > 0, "No tokens provided");
        require(paymentTokensList.length == 0, "Tokens already initialized");
        
        for (uint256 i = 0; i < paymentTokens.length; i++) {
            require(paymentTokens[i] != address(0), "Invalid token");
            require(!allowedPaymentTokens[paymentTokens[i]], "Token already added");
            allowedPaymentTokens[paymentTokens[i]] = true;
            paymentTokensList.push(paymentTokens[i]);
        }
        
        emit PaymentTokensInitialized(paymentTokens);
    }
    
    function stake(uint256 amount)
        external
        whenNotPaused
        whenPortalNotPaused
    {
        if (amount == 0) revert PortalErrors.InvalidAmount();
        
        if (_portalInfo.state != PortalState.COLLECTING && 
            _portalInfo.state != PortalState.ACTIVE) {
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
        _portalInfo.totalStaked += uint96(amount);

        // GatewayRegistry handles the transfer directly from provider
        _gatewayRegistry.stake(address(this), msg.sender, amount);
        
        // automatically activate when capacity is reached
        if (_portalInfo.state == PortalState.COLLECTING && _portalInfo.totalStaked >= _portalInfo.maxCapacity) {
            PortalState oldState = _portalInfo.state;
            _portalInfo.state = PortalState.ACTIVE;
            _portalInfo.activationTime = uint64(block.number);
            emit StateChanged(oldState, PortalState.ACTIVE);
        }
        
        emit Staked(msg.sender, amount, _portalInfo.totalStaked);
    }
    
    function activate()
        external
        onlyOperator
        inState(PortalState.COLLECTING)
    {
        // Portal is already registered in GatewayRegistry during initialize()
        // GatewayRegistry will mark portal as "active" once minStake is reached during staking
        // This function transitions the portal state from COLLECTING to ACTIVE
        
        PortalState oldState = _portalInfo.state;
        _portalInfo.state = PortalState.ACTIVE;
        _portalInfo.activationTime = uint64(block.number);

        emit StateChanged(oldState, PortalState.ACTIVE);
    }
    
    function requestExit(uint256 amount)
        external
        whenNotPaused
    {
        if (_stakes[msg.sender] < amount) revert PortalErrors.InsufficientStake();

        // Calculate exit delay: 1 base epoch + percentage epochs
        // Formula: 1 + (amount / totalStaked * 100)
        // Example: 10% exit = 1 + 10 = 11 epochs
        uint256 currentEpoch = _networkController.epochNumber();
        uint256 percentage = (_portalInfo.totalStaked > 0)
            ? (amount * 100) / _portalInfo.totalStaked
            : 0;
        uint256 requiredEpochs = 1 + percentage; // 1 base + percentage

        ExitRequest storage request = _exitRequests[msg.sender];
        request.amount += uint128(amount);
        request.requestEpoch = uint64(currentEpoch);
        request.unlockEpoch = uint64(currentEpoch + requiredEpochs);

        // Track exit amount to stop earning rewards
        _exitAmounts[msg.sender] += amount;

        _gatewayRegistry.requestUnlock(msg.sender, amount);

        emit ExitRequested(msg.sender, amount, request.unlockEpoch);
    }
    
    function onAllocationReduced(address provider, uint256 amount)
        external
    {
        if (msg.sender != address(_gatewayRegistry)) revert PortalErrors.NotGatewayRegistry();

        _stakes[provider] -= amount;
        _portalInfo.totalStaked -= uint96(amount);

        // Reduce exit amount tracking (provider has withdrawn from exit queue)
        if (_exitAmounts[provider] > 0) {
            if (_exitAmounts[provider] >= amount) {
                _exitAmounts[provider] -= amount;
            } else {
                _exitAmounts[provider] = 0;
            }
        }

        emit AllocationReduced(provider, amount);
    }

    function withdrawFromFailed() external {
        if (_portalInfo.state != PortalState.FAILED) revert PortalErrors.PortalNotFailed();

        uint256 amount = _stakes[msg.sender];
        if (amount == 0) revert PortalErrors.NoStakeToWithdraw();

        // Clear provider state
        _stakes[msg.sender] = 0;
        _portalInfo.totalStaked -= uint96(amount);

        // Clear exit amounts if any
        if (_exitAmounts[msg.sender] > 0) {
            _exitAmounts[msg.sender] = 0;
        }

        // Request immediate withdrawal from GatewayRegistry for FAILED portal
        _gatewayRegistry.withdrawFailedPortal(msg.sender, amount);

        emit Withdrawn(msg.sender, amount);
    }

    function withdrawForMove(address provider, uint256 amount)
        external
        onlyRole(FACTORY_ROLE)
    {
        if (_stakes[provider] < amount) revert PortalErrors.InsufficientStake();

        _stakes[provider] -= amount;
        _portalInfo.totalStaked -= uint96(amount);
    }
    
    function depositFromMove(address provider, uint256 amount) 
        external 
        onlyRole(FACTORY_ROLE)
    {
        _stakes[provider] += amount;
        _portalInfo.totalStaked += uint96(amount);
    }
    
    function distributeFees(address token, uint256 amount)
        external
        onlyOperator
        inState(PortalState.ACTIVE)
    {
        // CHECKS
        if (amount == 0) revert PortalErrors.InvalidAmount();
        if (token == address(0)) revert PortalErrors.InvalidAmount();
        if (!allowedPaymentTokens[token]) revert PortalErrors.TokenNotAllowed();

        IERC20 paymentToken = IERC20(token);

        (uint256 toProviders, uint256 toWorkerPool, uint256 toBurn) =
            _feeRouter.calculateSplit(amount);

        // EFFECTS - Update state BEFORE external calls
        if (_portalInfo.totalStaked > 0) {
            _cumulativeFeesPerShare[token] += (toProviders * 1e18) / _portalInfo.totalStaked;
        }

        totalFeesDistributed[token] += toProviders;
        lastDistributionTime[token] = block.timestamp;

        // INTERACTIONS - External calls AFTER state updates
        paymentToken.safeTransferFrom(msg.sender, address(this), amount);

        address workerPool = _networkController.workerRewardPool();
        paymentToken.safeTransfer(workerPool, toWorkerPool);

        paymentToken.safeTransfer(address(0xdead), toBurn);

        emit FeesDistributed(token, amount, toProviders, toWorkerPool, toBurn);
    }
    
    function claimFees(address token) external returns (uint256 claimed) {
        if (token == address(0)) revert PortalErrors.InvalidAmount();
        if (!allowedPaymentTokens[token]) revert PortalErrors.TokenNotAllowed();
        
        claimed = _calculateClaimable(msg.sender, token);
        if (claimed == 0) revert PortalErrors.InvalidAmount();
        
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
    
    /**
     * @notice Get exit request information for a provider
     * @param provider Address of the provider
     * @return ExitRequest struct containing amount, requestEpoch, and unlockEpoch
     */
    function getExitRequest(address provider) external view returns (ExitRequest memory) {
        return _exitRequests[provider];
    }
    
    /**
     * @notice Get claimable fees for a provider (deprecated - use getClaimableFees(provider, token))
     * @dev Returns 0 - kept for backward compatibility. Use getClaimableFees(provider, token) instead.
     */
    function getClaimableFees(address provider) external view returns (uint256) {
        // Deprecated - returns 0. Use getClaimableFees(provider, token) for specific token.
        return 0;
    }
    
    /**
     * @notice Get claimable fees for a provider for a specific token
     * @param provider Address of the provider
     * @param token Address of the payment token
     * @return Claimable amount for the token
     */
    function getClaimableFees(address provider, address token) external view returns (uint256) {
        return _calculateClaimable(provider, token);
    }
    
    function _calculateClaimable(address provider, address token) internal view returns (uint256) {
        uint256 providerStake = _stakes[provider];
        if (providerStake == 0) return 0;

        // Only active stake earns rewards (exclude exit amounts)
        uint256 exitAmount = _exitAmounts[provider];
        uint256 activeStake = providerStake > exitAmount ? providerStake - exitAmount : 0;

        if (activeStake == 0) return 0;

        uint256 checkpoint = _providerCheckpoint[token][provider];
        uint256 accumulated = _cumulativeFeesPerShare[token] - checkpoint;

        return (activeStake * accumulated) / 1e18;
    }
    
    function getPeerId() external view returns (bytes memory) {
        return _peerId;
    }
    
    /**
     * @notice Get current APY for a specific payment token
     * @param token Address of the payment token
     * @return apy APY in basis points (10000 = 100%)
     */
    function getCurrentAPY(address token) external view returns (uint256 apy) {
        if (_portalInfo.totalStaked == 0) return 0;
        if (totalFeesDistributed[token] == 0) return 0;
        
        uint256 timeElapsed = block.timestamp - lastDistributionTime[token];
        if (timeElapsed == 0) return 0;
        
        uint256 annualFees = (totalFeesDistributed[token] * 365 days) / timeElapsed;
        apy = (annualFees * 10000) / _portalInfo.totalStaked;
    }
    
    /**
     * @notice Get all allowed payment tokens for this portal
     * @return tokens Array of allowed payment token addresses
     */
    function getAllowedPaymentTokens() external view returns (address[] memory tokens) {
        return paymentTokensList;
    }
    
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _portalInfo.paused = true;
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _portalInfo.paused = false;
    }

    /**
     * @notice Upgrade to new implementation (convenience wrapper for upgradeToAndCall)
     * @param newImplementation Address of new implementation
     * @dev Can be called by operator (DEFAULT_ADMIN_ROLE) or Factory (FACTORY_ROLE) for batch upgrades
     */
    function upgradeTo(address newImplementation) external {
        require(
            hasRole(DEFAULT_ADMIN_ROLE, msg.sender) || hasRole(FACTORY_ROLE, msg.sender),
            "Caller must be admin or factory"
        );
        upgradeToAndCall(newImplementation, "");
    }

    function _authorizeUpgrade(address) internal override {
        // Allow upgrades from operator (DEFAULT_ADMIN_ROLE) or Factory (FACTORY_ROLE)
        require(
            hasRole(DEFAULT_ADMIN_ROLE, msg.sender) || hasRole(FACTORY_ROLE, msg.sender),
            "Caller must be admin or factory"
        );
    }
    
    function _handleDeadlinePassed() internal {
        if (_portalInfo.totalStaked < _networkController.minStakeThreshold()) {
            _portalInfo.state = PortalState.FAILED;
            emit StateChanged(PortalState.COLLECTING, PortalState.FAILED);
        }
    }

    function checkAndFailPortal() external {
        if (_portalInfo.state != PortalState.COLLECTING) revert PortalErrors.InvalidState();
        if (block.number <= _portalInfo.depositDeadline) revert("Deadline not passed");

        _handleDeadlinePassed();
    }
}
