// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PoolStorage} from "./storage/PoolStorage.sol";
import {IPortalRegistry} from "./interfaces/IPortalRegistry.sol";
import {IFeeRouter} from "./interfaces/IFeeRouter.sol";
import {IPortalFactory} from "./interfaces/IPortalFactory.sol";
import {IPortalPool} from "./interfaces/IPortalPool.sol";
import {PoolErrors} from "./libs/PoolErrors.sol";
import {ExitQueueLib} from "./libs/ExitQueueLib.sol";
import {FullMath} from "./libs/FullMath.sol";
import {Constants} from "./libs/Constants.sol";
import {LiquidPortalToken} from "./LiquidPortalToken.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/// @title Portal Pool Implementation Contract
/// @notice This contract manages staking pools where users can deposit SQD tokens to earn rewards.
/// @dev uses beacon proxy pattern for upgradability. Implements credit/debt model for reward distribution.
contract PortalPoolImplementation is
    IPortalPool,
    PoolStorage,
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuard
{
    using SafeERC20 for IERC20;
    using ExitQueueLib for ExitQueueLib.Queue;

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant FACTORY_ROLE = keccak256("FACTORY_ROLE");

    uint256 public constant ACC = 1e27;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @dev ensures that the caller has the OPERATOR_ROLE.
    modifier onlyOperator() {
        if (!hasRole(OPERATOR_ROLE, msg.sender)) revert PoolErrors.NotOperator();
        _;
    }

    /// @dev ensures that the caller is a Factory admin.
    modifier onlyFactoryAdmin() {
        if (!IAccessControl(address(_factory)).hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert PoolErrors.NotAdmin();
        }
        _;
    }

    /**
     * @dev initializes the pool with the given parameters.
     * @param params struct containing operator, capacity, peerId, tokens, and distribution rate.
     */
    function initialize(InitParams calldata params) external initializer {
        if (params.operator == address(0)) revert PoolErrors.InvalidAddress();
        if (params.sqd == address(0)) revert PoolErrors.InvalidAddress();
        if (params.rewardToken == address(0)) revert PoolErrors.InvalidAddress();
        if (params.portalRegistry == address(0)) revert PoolErrors.InvalidAddress();
        // Note: feeRouter is now fetched dynamically from factory, not stored per-pool

        __AccessControl_init();
        __Pausable_init();

        _sqd = IERC20(params.sqd);
        _rewardToken = IERC20(params.rewardToken);
        _portalRegistry = IPortalRegistry(params.portalRegistry);
        _factory = IPortalFactory(msg.sender);

        // Rate interpretation: rate is in "raw units per second" scaled by RATE_PRECISION
        // Example: For USDC (6 decimals), rate=386000 gives ~$1000/month at full capacity
        uint8 rewardDecimals = IERC20Metadata(params.rewardToken).decimals();
        if (rewardDecimals > 18) revert PoolErrors.InvalidDecimals();
        _rewardTokenDecimalScale = 10 ** rewardDecimals;

        // read minStakeThreshold from factory (globally configurable)
        if (params.capacity < _factory.minStakeThreshold()) revert PoolErrors.BelowMinimum();

        _poolInfo.operator = params.operator;
        _poolInfo.capacity = params.capacity;
        _poolInfo.totalStaked = 0;
        _poolInfo.depositDeadline = uint64(block.timestamp + _factory.collectionDeadlineSeconds());
        _poolInfo.activationTime = 0;
        _poolInfo.state = PoolState.COLLECTING;
        _poolInfo.paused = false;
        _poolInfo.firstActivated = false;

        credit = 0;
        totalRewardsPaid = 0;
        rewardPerStakeStored = 0;
        lastEffectiveRewardTs = uint64(block.timestamp);

        _setDistributionRate(params.distributionRatePerSecond);

        _exitQueue.initialize(_factory.exitUnlockRatePerSecond());

        whitelistEnabled = _factory.defaultWhitelistEnabled();
        if (whitelistEnabled) {
            whitelist[params.operator] = true;
        }

        _grantRole(OPERATOR_ROLE, params.operator);
        _grantRole(FACTORY_ROLE, msg.sender);

        string memory tokenName = string(abi.encodePacked("Portal Pool Locked SQD ", params.tokenSuffix));
        string memory tokenSymbol = string(abi.encodePacked("plSQD-", params.tokenSuffix));
        lptToken = new LiquidPortalToken(tokenName, tokenSymbol, address(this));
    }

    /**
     * @dev allows users to deposit SQD tokens into the pool. Mints LPT tokens as receipt.
     * @notice Stakes SQD tokens and receives liquid portal tokens (LPT) in return.
     * @param amount the amount of SQD tokens to deposit.
     */
    function deposit(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert PoolErrors.InvalidAmount();
        if (whitelistEnabled && !whitelist[msg.sender]) revert PoolErrors.NotWhitelisted();

        // Handle deposit deadline before state check so pool transitions
        // gracefully to FAILED instead of reverting with InvalidState()
        if (
            _poolInfo.state == PoolState.COLLECTING && !_poolInfo.firstActivated
                && block.timestamp > _poolInfo.depositDeadline
        ) {
            _handleDeadlinePassed();
            return;
        }

        PoolState currentState = getState();
        if (currentState != PoolState.COLLECTING && currentState != PoolState.ACTIVE && currentState != PoolState.IDLE)
        {
            revert PoolErrors.InvalidState();
        }
        if (
            currentState != PoolState.COLLECTING && totalDistributionRatePerSec > 0
                && _stakes[msg.sender] == 0 && currentBalance(block.timestamp) <= 0
        ) {
            revert PoolErrors.PoolHasDebt();
        }

        // Auto-cap deposit to remaining capacity to prevent dust frontrunning DoS
        uint256 remainingCapacity = _poolInfo.capacity > _getActiveStake() ? _poolInfo.capacity - _getActiveStake() : 0;
        if (remainingCapacity == 0) revert PoolErrors.CapacityExceeded();
        if (amount > remainingCapacity) {
            amount = remainingCapacity;
        }

        // Validate against requested amount (upper bound check)
        uint256 newUserStake = _stakes[msg.sender] + amount;
        if (newUserStake > _factory.defaultMaxStakePerWallet()) revert PoolErrors.ExceedsWalletLimit();

        // FoT-safe transfer: measure actual received amount
        uint256 balanceBefore = _sqd.balanceOf(address(this));
        _sqd.safeTransferFrom(msg.sender, address(this), amount);
        uint256 actualReceived = _sqd.balanceOf(address(this)) - balanceBefore;
        if (actualReceived != amount) revert PoolErrors.InvalidStakeTransfer();

        // use actualReceived for all state updates (FoT protection)
        uint256 actualNewUserStake = _stakes[msg.sender] + actualReceived;
        uint256 actualNewTotal = _poolInfo.totalStaked + actualReceived;

        // Accrue global state and update user BEFORE changing stake
        _accrueGlobal(block.timestamp);
        _updateProvider(msg.sender);

        _stakes[msg.sender] = actualNewUserStake;
        _poolInfo.totalStaked = actualNewTotal;

        // Update user's reward checkpoint for new activeStake
        uint256 activeStake = _getProviderActiveStake(msg.sender);
        _rewardCheckpoint[msg.sender] = FullMath.mulDiv(activeStake, rewardPerStakeStored, ACC);

        bool shouldActivate = !_poolInfo.firstActivated && _poolInfo.totalStaked >= _poolInfo.capacity;

        uint256 minStakeThreshold = _factory.minStakeThreshold();
        bool isRecoveringFromIdle = currentState == PoolState.IDLE && _poolInfo.totalStaked >= minStakeThreshold;

        if (shouldActivate) {
            _poolInfo.state = PoolState.ACTIVE;
            _poolInfo.firstActivated = true;
            _poolInfo.activationTime = uint64(block.timestamp);
        }

        // Route funds based on state
        if (shouldActivate) {
            // activation: Push ALL accumulated funds to Registry
            // Use forceApprove for USDT-style token compatibility (reset to 0 first)
            _sqd.forceApprove(address(_portalRegistry), _poolInfo.totalStaked);
            _portalRegistry.stake(_poolInfo.totalStaked);

            emit StateChanged(PoolState.COLLECTING, PoolState.ACTIVE);
        } else if (currentState != PoolState.COLLECTING) {
            // Use forceApprove for USDT-style token compatibility
            // Use actualReceived for FoT safety
            _sqd.forceApprove(address(_portalRegistry), actualReceived);
            _portalRegistry.stake(actualReceived);

            if (isRecoveringFromIdle) {
                emit StateChanged(PoolState.IDLE, PoolState.ACTIVE);
            }
        }

        // Mint LPT based on actualReceived (FoT safety)
        lptToken.mint(msg.sender, actualReceived);

        // Emit event AFTER all operations (strict CEI)
        emit Deposited(msg.sender, actualReceived, _poolInfo.totalStaked);
    }

    /**
     * @dev requests to exit the pool. Burns LPT and creates an exit ticket.
     * @notice Request to withdraw staked SQD. Subject to exit queue waiting period.
     * @param amount the amount of SQD to withdraw.
     * @return ticketId the unique identifier for this exit request.
     */
    function requestExit(uint256 amount) external whenNotPaused nonReentrant returns (uint256 ticketId) {
        if (amount == 0) revert PoolErrors.InvalidAmount();
        if (_stakes[msg.sender] < amount) revert PoolErrors.InsufficientStake();

        PoolState currentState = getState();
        if (currentState == PoolState.CLOSED) {
            revert PoolErrors.PoolClosed();
        }
        if (currentState == PoolState.FAILED) {
            revert PoolErrors.UseWithdrawFromFailed();
        }
        if (currentState == PoolState.COLLECTING) {
            revert PoolErrors.WaitForActivationOrDeadline();
        }

        // Accrue global state and update user BEFORE changing exit amounts
        _accrueGlobal(block.timestamp);
        _updateProvider(msg.sender);

        uint256 endPos = _exitQueue.enqueue(amount, _factory.exitUnlockRatePerSecond());

        ticketId = _nextTicketId[msg.sender];
        _exitTickets[msg.sender][ticketId] =
            ExitQueueLib.Ticket({endPosition: endPos, amount: amount, withdrawn: false});
        ++_nextTicketId[msg.sender];

        _exitAmounts[msg.sender] += amount;
        _totalExitAmounts += amount;

        // Update user's reward debt for new activeStake
        uint256 activeStake = _getProviderActiveStake(msg.sender);
        _rewardCheckpoint[msg.sender] = FullMath.mulDiv(activeStake, rewardPerStakeStored, ACC);

        lptToken.burn(msg.sender, amount);

        emit ExitRequested(msg.sender, amount, endPos);
    }

    /**
     * @dev withdraws SQD after the exit queue waiting period has passed.
     * @notice Claim your SQD after the exit request has been processed.
     * @param ticketId the exit ticket identifier from requestExit.
     */
    function withdrawExit(uint256 ticketId) external whenNotPaused nonReentrant {
        ExitQueueLib.Ticket storage ticket = _exitTickets[msg.sender][ticketId];
        if (ticket.amount == 0) revert PoolErrors.NoActiveExitRequest();
        if (ticket.withdrawn) revert PoolErrors.AlreadyWithdrawn();

        // check if ticket is unlocked using library (timestamp-based)
        uint256 unlockRate = _factory.exitUnlockRatePerSecond();
        if (!ExitQueueLib.isUnlocked(_exitQueue, ticket, unlockRate)) revert PoolErrors.StillInQueue();

        _accrueGlobal(block.timestamp);

        ticket.withdrawn = true;

        uint256 amount = ticket.amount;
        _stakes[msg.sender] -= amount;
        _poolInfo.totalStaked -= amount;
        _exitAmounts[msg.sender] -= amount;
        _totalExitAmounts -= amount;

        _portalRegistry.unstake(msg.sender, amount);

        emit ExitClaimed(msg.sender, amount);
    }

    /**
     * @dev callback from LPT token on transfer. Updates stake ownership between users.
     * @param from the sender of the LPT tokens.
     * @param to the receiver of the LPT tokens.
     * @param amount the amount of LPT being transferred.
     */
    function onLPTTransfer(address from, address to, uint256 amount) external whenNotPaused nonReentrant {
        if (msg.sender != address(lptToken)) revert PoolErrors.NotLPTToken();

        // Prevent self-transfer stake inflation attack
        if (from == to) return;

        if (whitelistEnabled && !whitelist[to]) revert PoolErrors.NotWhitelisted();

        uint256 senderStake = _stakes[from];
        uint256 senderExitAmount = _exitAmounts[from];
        uint256 transferableStake = senderStake > senderExitAmount ? senderStake - senderExitAmount : 0;

        if (amount > transferableStake) revert PoolErrors.InsufficientTransferableStake();

        uint256 receiverNewStake = _stakes[to] + amount;
        if (receiverNewStake > _factory.defaultMaxStakePerWallet()) revert PoolErrors.ExceedsWalletLimit();

        // Accrue global state and update both users BEFORE changing stakes
        _accrueGlobal(block.timestamp);
        if (totalDistributionRatePerSec > 0 && _stakes[to] == 0 && currentBalance(block.timestamp) <= 0) {
            revert PoolErrors.PoolHasDebt();
        }
        _updateProvider(from);
        _updateProvider(to);

        _stakes[from] -= amount;
        _stakes[to] = receiverNewStake;

        // Update reward checkpoints for new activeStakes
        uint256 fromActiveStake = _getProviderActiveStake(from);
        uint256 toActiveStake = _getProviderActiveStake(to);
        _rewardCheckpoint[from] = FullMath.mulDiv(fromActiveStake, rewardPerStakeStored, ACC);
        _rewardCheckpoint[to] = FullMath.mulDiv(toActiveStake, rewardPerStakeStored, ACC);

        emit StakeTransferred(from, to, amount);
    }

    /**
     * @dev allows users to withdraw their stake if the pool failed to activate before deadline.
     * @notice Withdraw your SQD from a failed pool that never activated.
     */
    function withdrawFromFailed() external nonReentrant {
        if (getState() != PoolState.FAILED) revert PoolErrors.PoolNotFailed();

        uint256 amount = _stakes[msg.sender];
        if (amount == 0) revert PoolErrors.NoStakeToWithdraw();

        _clearUserStake(amount);
        _sqd.safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, amount);
    }

    /**
     * @dev allows operator to recover reward tokens from a FAILED pool.
     * @notice Recover unused reward tokens when pool fails to activate.
     * @return amount the amount of reward tokens recovered.
     */
    function recoverRewards() external onlyOperator nonReentrant returns (uint256) {
        if (getState() != PoolState.FAILED) revert PoolErrors.InvalidState();

        uint256 amount = _rewardToken.balanceOf(address(this));
        if (amount == 0) revert PoolErrors.NothingToClaim();

        _rewardToken.safeTransfer(msg.sender, amount);

        emit RewardsRecovered(msg.sender, amount);
        return amount;
    }

    /**
     * @dev allows the operator to add reward tokens to the pool.
     * @notice Top up the reward pool to extend the runway for staker rewards.
     * @param amount the amount of reward tokens to add.
     */
    function topUpRewards(uint256 amount) external onlyOperator nonReentrant {
        if (totalDistributionRatePerSec == 0) revert PoolErrors.DistributionTurnedOff();
        if (amount == 0) revert PoolErrors.InvalidAmount();
        PoolState currentState = getState();
        if (currentState != PoolState.ACTIVE && currentState != PoolState.IDLE) revert PoolErrors.InvalidState();

        // measure actual received for fee-on-transfer token safety
        uint256 balanceBefore = _rewardToken.balanceOf(address(this));
        _rewardToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = _rewardToken.balanceOf(address(this)) - balanceBefore;

        (uint256 toProviders, uint256 toWorkerPool, uint256 toBurn) = _routeFees(received);

        _accrueGlobal(block.timestamp);
        bool wasDry = uint256(lastEffectiveRewardTs) < block.timestamp;
        credit += toProviders;
        if (wasDry && toProviders > 0) {
            lastEffectiveRewardTs = uint64(block.timestamp);
        }

        emit RewardsToppedUp(msg.sender, received, toProviders, toWorkerPool, toBurn);
    }

    /**
     * @dev called by factory to set initial credit when pool is created with distribution rate.
     * @param amount the initial reward amount to seed the pool.
     */
    function initializeCredit(uint256 amount) external {
        if (msg.sender != address(_factory)) revert PoolErrors.NotFactory();
        if (credit > 0) revert PoolErrors.AlreadyInitialized();

        (uint256 toProviders, uint256 toWorkerPool, uint256 toBurn) = _routeFees(amount);

        credit = toProviders;

        emit RewardsToppedUp(address(_factory), amount, toProviders, toWorkerPool, toBurn);
    }

    function _routeFees(uint256 amount) internal returns (uint256 toProviders, uint256 toWorkerPool, uint256 toBurn) {
        address feeRouter = _factory.feeRouter();
        (toProviders, toWorkerPool, toBurn) = IFeeRouter(feeRouter).calculateSplit(amount);
        uint256 toRoute = toWorkerPool + toBurn;
        if (toRoute > 0) {
            _rewardToken.forceApprove(feeRouter, toRoute);
        }
        if (toWorkerPool > 0) {
            IFeeRouter(feeRouter).routeToWorkerPool(address(_rewardToken), toWorkerPool);
        }
        if (toBurn > 0) {
            IFeeRouter(feeRouter).routeToBurn(address(_rewardToken), toBurn);
        }
    }

    /**
     * @dev allows stakers to claim their accumulated rewards.
     * @notice Claim your earned reward tokens.
     * @return the amount of rewards claimed.
     */
    function claimRewards() external whenNotPaused nonReentrant returns (uint256) {
        // always allow claiming - users should be able to claim earned rewards
        // even if distribution is turned off
        _accrueGlobal(block.timestamp);
        _updateProvider(msg.sender);

        uint256 amount = _unclaimedRewards[msg.sender];
        if (amount == 0) revert PoolErrors.NothingToClaim();

        _unclaimedRewards[msg.sender] = 0;
        _rewardToken.safeTransfer(msg.sender, amount);

        emit RewardsClaimed(msg.sender, amount);
        return amount;
    }

    /**
     * @dev allows operator to change the reward distribution rate.
     * @param newRatePerSecond the new rate scaled by RATE_PRECISION.
     */
    function setDistributionRate(uint256 newRatePerSecond) external onlyOperator {
        PoolState currentState = getState();
        if (currentState == PoolState.COLLECTING || currentState == PoolState.CLOSED) {
            revert PoolErrors.InvalidState();
        }
        if (newRatePerSecond > _factory.maxDistributionRatePerSecond()) {
            revert PoolErrors.RateExceedsMaximum();
        }
        if (newRatePerSecond != 0 && newRatePerSecond < _factory.minDistributionRatePerSecond()) {
            revert PoolErrors.RateBelowMinimum();
        }

        if (newRatePerSecond > 0) {
            uint256 perStakeRate = (newRatePerSecond * Constants.PRECISION) / (_poolInfo.capacity * RATE_PRECISION);
            if (perStakeRate < Constants.MIN_PER_STAKE_RATE) {
                revert PoolErrors.InsufficientRewardPrecision();
            }
        }

        _accrueGlobal(block.timestamp);

        if (credit > 0 && totalRewardsPaid >= credit) revert PoolErrors.PoolHasDebt();

        _setDistributionRate(newRatePerSecond);
    }

    /**
     * @dev allows operator to change the pool capacity after activation.
     * @param newCapacity the new maximum stake capacity.
     */
    function setCapacity(uint256 newCapacity) external onlyOperator {
        if (getState() == PoolState.CLOSED) revert PoolErrors.PoolClosed();
        if (!_poolInfo.firstActivated) revert PoolErrors.NotActivated();
        if (newCapacity == _poolInfo.capacity) revert PoolErrors.NoChange();
        uint256 minCapacity = _factory.minStakeThreshold();
        if (newCapacity < minCapacity) revert PoolErrors.BelowMinimum();
        if (newCapacity < _poolInfo.totalStaked) revert PoolErrors.BelowCurrentStake();

        if (totalDistributionRatePerSec > 0) {
            uint256 perStakeRate = (totalDistributionRatePerSec * Constants.PRECISION) / (newCapacity * RATE_PRECISION);
            if (perStakeRate < Constants.MIN_PER_STAKE_RATE) {
                revert PoolErrors.InsufficientRewardPrecision();
            }
        }

        _accrueGlobal(block.timestamp);

        if (credit > 0 && totalRewardsPaid >= credit) revert PoolErrors.PoolHasDebt();

        uint256 oldCapacity = _poolInfo.capacity;
        _poolInfo.capacity = newCapacity;

        // Recalculate per-stake rate
        // Note: providerRatePerSec is scaled by RATE_PRECISION, divide to get actual rate
        if (newCapacity > 0) {
            perStakeRateWad = FullMath.mulDiv(providerRatePerSec, ACC, newCapacity * RATE_PRECISION);
        }

        emit CapacityUpdated(oldCapacity, newCapacity);
    }

    /**
     * @dev enables or disables the whitelist feature for deposits.
     * @param enabled true to enable whitelist, false to disable.
     */
    function setWhitelistEnabled(bool enabled) external onlyOperator {
        if (enabled && !_factory.whitelistFeatureEnabled()) {
            revert PoolErrors.WhitelistFeatureDisabled();
        }
        whitelistEnabled = enabled;
        emit WhitelistEnabledChanged(enabled);
    }

    /**
     * @dev adds addresses to the whitelist.
     * @param users array of addresses to whitelist.
     */
    function addToWhitelist(address[] calldata users) external onlyOperator {
        for (uint256 i = 0; i < users.length;) {
            whitelist[users[i]] = true;
            emit WhitelistUpdated(users[i], true);
            unchecked {
                ++i;
            }
        }
    }

    /**
     * @dev removes addresses from the whitelist.
     * @param users array of addresses to remove.
     */
    function removeFromWhitelist(address[] calldata users) external onlyOperator {
        for (uint256 i = 0; i < users.length;) {
            whitelist[users[i]] = false;
            emit WhitelistUpdated(users[i], false);
            unchecked {
                ++i;
            }
        }
    }

    /**
     * @dev checks if an address is whitelisted.
     */
    function isWhitelisted(address user) external view returns (bool) {
        return whitelist[user];
    }

    /**
     * @dev allows the operator to transfer their role to a new address.
     * @notice Transfer operator role to a new wallet. Only callable by current operator.
     * @param newOperator the address of the new operator.
     */
    function transferOperator(address newOperator) external onlyOperator whenNotPaused {
        if (newOperator == address(0)) revert PoolErrors.InvalidAddress();

        PoolState currentState = getState();
        if (currentState == PoolState.CLOSED) revert PoolErrors.PoolClosed();
        if (currentState == PoolState.FAILED) revert PoolErrors.InvalidState();

        address previousOperator = _poolInfo.operator;
        if (newOperator == previousOperator) revert PoolErrors.NoChange();

        // Update pool info
        _poolInfo.operator = newOperator;

        // Transfer OPERATOR_ROLE from old operator to new operator
        _revokeRole(OPERATOR_ROLE, previousOperator);
        _grantRole(OPERATOR_ROLE, newOperator);

        // Update operator in registry (updates cluster.operator and ownerClusters mapping)
        _portalRegistry.updateClusterOperator(newOperator);

        // Update factory mappings (keeps getOperatorPortals in sync)
        _factory.notifyOperatorTransfer(previousOperator, newOperator);

        // If whitelist is enabled, add new operator to whitelist
        if (whitelistEnabled) {
            whitelist[newOperator] = true;
            emit WhitelistUpdated(newOperator, true);
        }

        emit OperatorTransferred(previousOperator, newOperator);
    }

    /**
     * @dev allows the operator to update the pool's metadata in the registry.
     * @notice Update pool metadata. Only callable by operator.
     * @param metadata the new metadata string.
     */
    function setMetadata(string calldata metadata) external onlyOperator {
        _portalRegistry.setClusterMetadataByPool(metadata);
    }

    /**
     * @dev returns the current operator of the pool.
     */
    function getOperator() external view returns (address) {
        return _poolInfo.operator;
    }

    /**
     * @dev returns the current state of the pool.
     */
    function getState() public view returns (PoolState) {
        PoolInfo memory info = _poolInfo;

        // CLOSED state takes precedence - emergency shutdown
        if (info.state == PoolState.CLOSED) {
            return PoolState.CLOSED;
        }

        if (info.state == PoolState.FAILED) {
            return PoolState.FAILED;
        }

        if (info.state == PoolState.COLLECTING) {
            if (block.timestamp > info.depositDeadline && !info.firstActivated) {
                return PoolState.FAILED;
            }
            return PoolState.COLLECTING;
        }

        if (info.firstActivated) {
            uint256 minStake = _factory.minStakeThreshold();
            if (info.totalStaked < minStake) {
                return PoolState.IDLE;
            }
            return PoolState.ACTIVE;
        }

        return info.state;
    }

    function getPoolInfo() external view returns (PoolInfo memory) {
        PoolInfo memory info = _poolInfo;
        info.state = getState();
        return info;
    }

    function getProviderStake(address provider) external view returns (uint256) {
        return _stakes[provider];
    }

    function getExitTicket(address provider, uint256 ticketId) external view returns (ExitTicket memory) {
        ExitQueueLib.Ticket storage ticket = _exitTickets[provider][ticketId];
        return ExitTicket({endPosition: ticket.endPosition, amount: ticket.amount, withdrawn: ticket.withdrawn});
    }

    function getTicketCount(address provider) external view returns (uint256) {
        return _nextTicketId[provider];
    }

    /**
     * @notice Get claimable rewards for a provider
     * @dev Uses global RPS model with simulated accrual
     */
    function getClaimableRewards(address provider) external view returns (uint256) {
        uint256 activeStake = _getProviderActiveStake(provider);
        if (activeStake == 0) return _unclaimedRewards[provider];

        // Simulate global accrual
        (uint256 newRPS,) = _simulateGlobalAccrual(block.timestamp);

        // Calculate pending based on activeStake
        uint256 accumulated = FullMath.mulDiv(activeStake, newRPS, ACC);
        uint256 checkpoint = _rewardCheckpoint[provider];
        uint256 pending = accumulated > checkpoint ? accumulated - checkpoint : 0;

        return _unclaimedRewards[provider] + pending;
    }

    function getCurrentRewardBalance() external view returns (int256) {
        return currentBalance(block.timestamp);
    }

    /// @notice Get pool reward status (consolidated view)
    function getRewardStatus()
        external
        view
        returns (int256 balance, uint256 currentDebt, int256 runwayTimestamp, bool isDry)
    {
        balance = currentBalance(block.timestamp);
        currentDebt = 0;
        runwayTimestamp = getRunway();
        isDry = balance <= 0;
    }

    /// @notice get remaining reward budget
    function getCredit() external view returns (uint256) {
        int256 bal = currentBalance(block.timestamp);
        return bal > 0 ? uint256(bal) : 0;
    }

    /// @notice returns 0 (debt concept removed, kept for interface compat)
    function getDebt() external view returns (uint256) {
        return 0;
    }

    /// @notice get consolidated pool status with provider rewards
    function getPoolStatusWithRewards(address provider)
        external
        view
        returns (
            uint256 poolCredit,
            uint256 poolDebt,
            int256 poolBalance,
            int256 runway,
            bool outOfMoney,
            uint256 providerRewards,
            uint256 providerStake
        )
    {
        poolBalance = currentBalance(block.timestamp);
        poolCredit = poolBalance > 0 ? uint256(poolBalance) : 0;
        poolDebt = 0;
        runway = getRunway();
        outOfMoney = poolBalance <= 0;

        providerStake = _getProviderActiveStake(provider);
        if (providerStake == 0) {
            providerRewards = _unclaimedRewards[provider];
        } else {
            (uint256 newRPS,) = _simulateGlobalAccrual(block.timestamp);
            uint256 accumulated = FullMath.mulDiv(providerStake, newRPS, ACC);
            uint256 checkpoint = _rewardCheckpoint[provider];
            uint256 pending = accumulated > checkpoint ? accumulated - checkpoint : 0;
            providerRewards = _unclaimedRewards[provider] + pending;
        }
    }

    function getTotalDrainRate() external view returns (uint256) {
        // Returns the scaled drain rate (multiplied by RATE_PRECISION)
        return _totalDrainRate();
    }

    function getRunway() public view returns (int256) {
        if (totalRewardsPaid >= credit) {
            return int256(uint256(lastEffectiveRewardTs));
        }
        uint256 remaining = credit - totalRewardsPaid;
        uint256 activeStake = _getActiveStake();
        if (activeStake == 0 || perStakeRateWad == 0) return type(int256).max;
        uint256 tokenRate = FullMath.mulDiv(perStakeRateWad, activeStake, ACC);
        if (tokenRate == 0) return type(int256).max;
        return int256(uint256(lastEffectiveRewardTs)) + int256(remaining / tokenRate);
    }

    function getActiveStake() external view returns (uint256) {
        return _poolInfo.totalStaked > _totalExitAmounts ? _poolInfo.totalStaked - _totalExitAmounts : 0;
    }

    function getComputationUnits() external view returns (uint256) {
        bytes32 clusterId = _portalRegistry.getClusterIdByAddress(address(this));
        return _portalRegistry.getComputationUnits(clusterId);
    }

    function getRewardToken() external view returns (address) {
        return address(_rewardToken);
    }

    function getQueueStatusWithTimestamp(address provider, uint256 ticketId)
        external
        view
        returns (
            uint256 processed,
            uint256 providerEndPos,
            uint256 secondsRemaining,
            bool ready,
            uint256 unlockTimestamp
        )
    {
        ExitQueueLib.Ticket storage ticket = _exitTickets[provider][ticketId];
        uint256 unlockRate = _factory.exitUnlockRatePerSecond();
        (processed, providerEndPos, secondsRemaining, ready) = ExitQueueLib.getStatus(_exitQueue, ticket, unlockRate);

        if (ready) {
            unlockTimestamp = block.timestamp;
        } else if (secondsRemaining == type(uint256).max) {
            unlockTimestamp = type(uint256).max;
        } else {
            unlockTimestamp = block.timestamp + secondsRemaining;
        }
    }

    function getTotalProcessed() external view returns (uint256) {
        return _exitQueue.totalProcessed(_factory.exitUnlockRatePerSecond());
    }

    function getMinCapacity() external view returns (uint256) {
        return _factory.minStakeThreshold();
    }

    function getWithdrawalWaitingTimestamp(uint256 amount) external view returns (uint256 unlockTimestamp) {
        if (amount == 0) revert PoolErrors.InvalidAmount();
        return ExitQueueLib.getSimulatedUnlockTimestamp(_exitQueue, amount, _factory.exitUnlockRatePerSecond());
    }

    function pause() external onlyFactoryAdmin {
        _pause();
    }

    function unpause() external onlyFactoryAdmin {
        _unpause();
    }

    function currentBalance(uint256 timestamp) public view returns (int256) {
        (uint256 newRPS,) = _simulateGlobalAccrual(timestamp);
        uint256 rpsDelta = newRPS - rewardPerStakeStored;
        uint256 simulatedPaid = totalRewardsPaid;
        if (rpsDelta > 0) {
            uint256 activeStake = _getActiveStake();
            simulatedPaid += FullMath.mulDiv(rpsDelta, activeStake, ACC);
            if (simulatedPaid > credit) simulatedPaid = credit;
        }
        return int256(credit) - int256(simulatedPaid);
    }

    function _getProviderActiveStake(address provider) internal view returns (uint256) {
        uint256 stake = _stakes[provider];
        uint256 exitAmount = _exitAmounts[provider];
        return stake > exitAmount ? stake - exitAmount : 0;
    }

    function _getActiveStake() internal view returns (uint256) {
        return _poolInfo.totalStaked > _totalExitAmounts ? _poolInfo.totalStaked - _totalExitAmounts : 0;
    }

    function _totalDrainRate() internal view returns (uint256) {
        if (!_poolInfo.firstActivated) return 0;
        uint256 activeStake = _getActiveStake();
        uint256 minStake = _factory.minStakeThreshold();
        if (_poolInfo.totalStaked < minStake) return 0;
        if (activeStake == 0) return 0;
        uint256 capacity = _poolInfo.capacity;
        if (capacity == 0) return 0;
        uint256 providerDrain = FullMath.mulDiv(providerRatePerSec, activeStake, capacity);
        return treasuryRatePerSec + providerDrain;
    }

    function _setDistributionRate(uint256 newRatePerSec) internal {
        uint256 oldRate = totalDistributionRatePerSec;
        totalDistributionRatePerSec = newRatePerSec;

        providerRatePerSec = newRatePerSec;
        treasuryRatePerSec = 0;
        // Note: providerRatePerSec is scaled by RATE_PRECISION, divide to get actual rate
        // Rate is in "raw token units per second" - caller must account for token decimals
        uint256 capacity = _poolInfo.capacity;
        if (capacity > 0) {
            perStakeRateWad = FullMath.mulDiv(providerRatePerSec, ACC, capacity * RATE_PRECISION);
        }

        emit DistributionRateChanged(oldRate, newRatePerSec);
    }

    function _simulateGlobalAccrual(uint256 timestamp) internal view returns (uint256 newRPS, uint64 newEffectiveTs) {
        newRPS = rewardPerStakeStored;
        newEffectiveTs = lastEffectiveRewardTs;

        uint256 activeStake = _getActiveStake();
        uint256 minStake = _factory.minStakeThreshold();
        if (!_poolInfo.firstActivated || _poolInfo.totalStaked < minStake || activeStake == 0 || perStakeRateWad == 0) {
            return (newRPS, uint64(timestamp));
        }

        if (timestamp <= uint256(newEffectiveTs)) return (newRPS, newEffectiveTs);

        uint256 remaining = credit > totalRewardsPaid ? credit - totalRewardsPaid : 0;
        if (remaining == 0) return (newRPS, newEffectiveTs);

        uint256 dt = timestamp - uint256(newEffectiveTs);
        uint256 tokenRate = FullMath.mulDiv(perStakeRateWad, activeStake, ACC);
        if (tokenRate == 0) return (newRPS, uint64(timestamp));

        uint256 maxDt = remaining / tokenRate;

        if (dt <= maxDt) {
            newRPS += FullMath.mulDiv(perStakeRateWad, dt, 1);
            newEffectiveTs = uint64(timestamp);
        } else {
            newRPS += FullMath.mulDiv(remaining, ACC, activeStake);
            newEffectiveTs = uint64(uint256(newEffectiveTs) + maxDt);
        }

        return (newRPS, newEffectiveTs);
    }

    function _accrueGlobal(uint256 timestamp) internal {
        (uint256 newRPS, uint64 newEffectiveTs) = _simulateGlobalAccrual(timestamp);

        uint256 rpsDelta = newRPS - rewardPerStakeStored;
        if (rpsDelta > 0) {
            uint256 activeStake = _getActiveStake();
            totalRewardsPaid += FullMath.mulDiv(rpsDelta, activeStake, ACC);
            if (totalRewardsPaid > credit) totalRewardsPaid = credit;
        }

        rewardPerStakeStored = newRPS;
        lastEffectiveRewardTs = newEffectiveTs;
    }

    function _updateProvider(address provider) internal {
        uint256 activeStake = _getProviderActiveStake(provider);
        if (activeStake > 0) {
            uint256 accumulated = FullMath.mulDiv(activeStake, rewardPerStakeStored, ACC);
            uint256 checkpoint = _rewardCheckpoint[provider];
            uint256 pending = accumulated > checkpoint ? accumulated - checkpoint : 0;
            _unclaimedRewards[provider] += pending;
            _rewardCheckpoint[provider] = accumulated;
        } else if (_stakes[provider] > 0) {
            _rewardCheckpoint[provider] = 0;
        }
    }

    function _handleDeadlinePassed() internal {
        if (!_poolInfo.firstActivated) {
            _poolInfo.state = PoolState.FAILED;
            emit StateChanged(PoolState.COLLECTING, PoolState.FAILED);
        }
    }

    function _clearUserStake(uint256 amount) internal {
        uint256 exitAmount = _exitAmounts[msg.sender];
        uint256 lptToBurn = amount > exitAmount ? amount - exitAmount : 0;
        uint256 userLptBalance = lptToken.balanceOf(msg.sender);
        if (lptToBurn > userLptBalance) lptToBurn = userLptBalance;

        _stakes[msg.sender] = 0;
        _poolInfo.totalStaked -= amount;

        if (exitAmount > 0) {
            _totalExitAmounts -= exitAmount;
            _exitAmounts[msg.sender] = 0;
        }
        if (lptToBurn > 0) lptToken.burn(msg.sender, lptToBurn);
    }

    function checkAndFailPortal() external {
        if (_poolInfo.state != PoolState.COLLECTING) revert PoolErrors.InvalidState();
        if (block.timestamp <= _poolInfo.depositDeadline) revert PoolErrors.DeadlineNotPassed();

        _handleDeadlinePassed();
    }

    /* EMERGENCY SHUTDOWN (CLOSE POOL)*/

    /// @notice Emergency shutdown - closes the pool, stops debt, allows immediate withdrawals
    /// @dev Only callable by Factory admin (not pool operator)
    function closePool() external onlyFactoryAdmin {
        // Cannot close already closed or failed pools
        PoolState currentState = getState();
        if (currentState == PoolState.CLOSED) revert PoolErrors.PoolClosed();
        if (currentState == PoolState.FAILED) revert PoolErrors.InvalidState();

        // Checkpoint current reward state before stopping accrual
        _accrueGlobal(block.timestamp);

        // Store previous state for event
        PoolState previousState = _poolInfo.state;

        // Set pool to CLOSED state
        _poolInfo.state = PoolState.CLOSED;

        // Stop all reward distribution (prevents further debt accumulation)
        totalDistributionRatePerSec = 0;
        providerRatePerSec = 0;
        treasuryRatePerSec = 0;
        perStakeRateWad = 0;

        emit StateChanged(previousState, PoolState.CLOSED);
        emit PoolClosed(msg.sender, block.timestamp);
    }

    /// @notice Emergency withdraw - allows immediate stake withdrawal when pool is closed
    /// @dev Bypasses exit queue, users get their full stake back immediately
    function emergencyWithdraw() external nonReentrant {
        if (getState() != PoolState.CLOSED) revert PoolErrors.PoolNotClosed();

        uint256 userStake = _stakes[msg.sender];
        if (userStake == 0) revert PoolErrors.NoStakeToWithdraw();

        _updateProvider(msg.sender);
        _clearUserStake(userStake);

        // Transfer SQD based on whether pool was ever activated
        if (_poolInfo.firstActivated) {
            _portalRegistry.unstake(msg.sender, userStake);
        } else {
            _sqd.safeTransfer(msg.sender, userStake);
        }

        emit Withdrawn(msg.sender, userStake);
    }

    /// @notice Claim any pending rewards when pool is closed
    /// @dev Can be called separately from emergencyWithdraw
    function claimRewardsFromClosed() external nonReentrant returns (uint256) {
        if (getState() != PoolState.CLOSED) revert PoolErrors.PoolNotClosed();

        _updateProvider(msg.sender);

        uint256 amount = _unclaimedRewards[msg.sender];
        if (amount == 0) revert PoolErrors.NothingToClaim();

        _unclaimedRewards[msg.sender] = 0;

        if (amount > 0) {
            _rewardToken.safeTransfer(msg.sender, amount);
        }

        emit RewardsClaimed(msg.sender, amount);
        return amount;
    }
}
