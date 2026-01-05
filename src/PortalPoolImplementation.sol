// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PortalPoolStorage} from "./storage/PortalPoolStorage.sol";
import {IPortalRegistry} from "./interfaces/IPortalRegistry.sol";
import {IFeeRouter} from "./interfaces/IFeeRouter.sol";
import {INetworkController} from "./interfaces/INetworkController.sol";
import {IPortalFactory} from "./interfaces/IPortalFactory.sol";
import {IPortalPool} from "./interfaces/IPortalPool.sol";
import {PortalErrors} from "./libs/PortalErrors.sol";
import {ExitQueueLib} from "./libs/ExitQueueLib.sol";
import {FullMath} from "./libs/FullMath.sol";
import {LiquidPortalToken} from "./LiquidPortalToken.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract PortalPoolImplementation is
    IPortalPool,
    PortalPoolStorage,
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

    modifier onlyOperator() {
        if (!hasRole(OPERATOR_ROLE, msg.sender)) revert PortalErrors.NotOperator();
        _;
    }

    function initialize(InitParams calldata params) external initializer {
        if (params.operator == address(0)) revert PortalErrors.InvalidAddress();
        if (params.sqd == address(0)) revert PortalErrors.InvalidAddress();
        if (params.rewardToken == address(0)) revert PortalErrors.InvalidAddress();
        if (params.portalRegistry == address(0)) revert PortalErrors.InvalidAddress();
        if (params.feeRouter == address(0)) revert PortalErrors.InvalidAddress();
        if (params.networkController == address(0)) revert PortalErrors.InvalidAddress();

        __AccessControl_init();
        __Pausable_init();

        _peerId = params.peerId;
        _sqd = IERC20(params.sqd);
        _rewardToken = IERC20(params.rewardToken);
        _portalRegistry = IPortalRegistry(params.portalRegistry);
        _feeRouter = IFeeRouter(params.feeRouter);
        _networkController = INetworkController(params.networkController);

        if (params.capacity < _networkController.minStakeThreshold()) revert PortalErrors.BelowMinimum();

        _factory = IPortalFactory(msg.sender);

        _portalInfo.operator = params.operator;
        _portalInfo.capacity = params.capacity;
        _portalInfo.totalStaked = 0;
        _portalInfo.depositDeadline = uint64(block.timestamp + _factory.collectionDeadlineSeconds());
        _portalInfo.activationTime = 0;
        _portalInfo.state = PortalState.COLLECTING;
        _portalInfo.paused = false;
        _portalInfo.firstActivated = false;

        // Initialize runway model state (credit/debt pattern)
        credit = 0;
        debt = 0;
        balanceTs = uint64(block.timestamp);
        rewardPerStakeStored = 0;
        lastEffectiveRewardTs = uint64(block.timestamp);

        // Set distribution rate with 50/50 split
        _setDistributionRate(params.distributionRatePerSecond);

        _exitQueue.initialize(_factory.exitUnlockRatePerSecond());

        burnAddress = address(0xdead);

        _grantRole(DEFAULT_ADMIN_ROLE, params.operator);
        _grantRole(OPERATOR_ROLE, params.operator);
        _grantRole(FACTORY_ROLE, msg.sender);

        // deploy the LPT token for this portal using tokenSuffix
        string memory tokenName = string(abi.encodePacked("Portal Locked SQD ", params.tokenSuffix));
        string memory tokenSymbol = string(abi.encodePacked("plSQD-", params.tokenSuffix));
        lptToken = new LiquidPortalToken(tokenName, tokenSymbol, address(this));
    }

    function deposit(uint256 amount) external whenNotPaused {
        if (amount == 0) revert PortalErrors.InvalidAmount();

        PortalState currentState = getState();
        if (
            currentState != PortalState.COLLECTING && currentState != PortalState.ACTIVE
                && currentState != PortalState.IDLE
        ) {
            revert PortalErrors.InvalidState();
        }

        if (currentState == PortalState.COLLECTING) {
            if (block.timestamp > _portalInfo.depositDeadline) {
                // don't revert
                // just mark as FAILED and return. User's stake is not accepted.
                _handleDeadlinePassed();
                return;
            }
        }

        uint256 newUserStake = _stakes[msg.sender] + amount;
        if (newUserStake > _factory.defaultMaxStakePerWallet()) revert PortalErrors.ExceedsWalletLimit();

        uint256 newActiveStake = _getActiveStake() + amount;
        if (newActiveStake > _portalInfo.capacity) revert PortalErrors.CapacityExceeded();

        uint256 newTotal = _portalInfo.totalStaked + amount;

        _sqd.safeTransferFrom(msg.sender, address(this), amount);

        // Accrue global state and update user BEFORE changing stake
        _accrueGlobal(block.timestamp);
        _updateUser(msg.sender);

        _stakes[msg.sender] = newUserStake;
        _portalInfo.totalStaked = newTotal;

        // Update user's reward debt for new activeStake
        uint256 activeStake = _getUserActiveStake(msg.sender);
        _rewardDebt[msg.sender] = FullMath.mulDiv(activeStake, rewardPerStakeStored, ACC);

        bool shouldActivate = !_portalInfo.firstActivated && _portalInfo.totalStaked >= _portalInfo.capacity;

        uint256 minStakeThreshold = _networkController.minStakeThreshold();
        bool isRecoveringFromIdle = currentState == PortalState.IDLE && _portalInfo.totalStaked >= minStakeThreshold;

        if (shouldActivate) {
            _portalInfo.state = PortalState.ACTIVE;
            _portalInfo.firstActivated = true;
            _portalInfo.activationTime = uint64(block.timestamp);
        }

        // Route funds based on state
        if (shouldActivate) {
            // activation: Push ALL accumulated funds to Registry
            // Use forceApprove for USDT-style token compatibility (reset to 0 first)
            _sqd.forceApprove(address(_portalRegistry), _portalInfo.totalStaked);
            _portalRegistry.stakePoolFunds(_portalInfo.totalStaked);
            _portalRegistry.activatePortalPool();

            emit StateChanged(PortalState.COLLECTING, PortalState.ACTIVE);
        } else if (currentState != PortalState.COLLECTING) {
            // Use forceApprove for USDT-style token compatibility
            _sqd.forceApprove(address(_portalRegistry), amount);
            _portalRegistry.stake(address(this), msg.sender, amount);

            if (isRecoveringFromIdle) {
                _portalRegistry.activatePortalPool();
                emit StateChanged(PortalState.IDLE, PortalState.ACTIVE);
            }
        }

        lptToken.mint(msg.sender, amount);

        // Emit event AFTER all operations (strict CEI)
        emit Deposited(msg.sender, amount, _portalInfo.totalStaked);
    }

    function requestExit(uint256 amount) external whenNotPaused returns (uint256 ticketId) {
        if (amount == 0) revert PortalErrors.InvalidAmount();
        if (_stakes[msg.sender] < amount) revert PortalErrors.InsufficientStake();

        PortalState currentState = getState();
        if (currentState == PortalState.FAILED) {
            revert PortalErrors.UseWithdrawFromFailed();
        }
        if (currentState == PortalState.COLLECTING) {
            revert PortalErrors.WaitForActivationOrDeadline();
        }

        // Accrue global state and update user BEFORE changing exit amounts
        _accrueGlobal(block.timestamp);
        _updateUser(msg.sender);

        uint256 endPos = _exitQueue.enqueue(amount);

        ticketId = _nextTicketId[msg.sender];
        _exitTickets[msg.sender][ticketId] =
            ExitQueueLib.Ticket({endPosition: endPos, amount: amount, withdrawn: false});
        ++_nextTicketId[msg.sender];

        _exitAmounts[msg.sender] += amount;
        _totalExitAmounts += amount;

        // Update user's reward debt for new activeStake
        uint256 activeStake = _getUserActiveStake(msg.sender);
        _rewardDebt[msg.sender] = FullMath.mulDiv(activeStake, rewardPerStakeStored, ACC);

        lptToken.burn(msg.sender, amount);

        emit ExitRequested(msg.sender, amount, endPos);
    }

    function withdrawExit(uint256 ticketId) external whenNotPaused {
        ExitQueueLib.Ticket storage ticket = _exitTickets[msg.sender][ticketId];
        if (ticket.amount == 0) revert PortalErrors.NoActiveExitRequest();
        if (ticket.withdrawn) revert PortalErrors.AlreadyWithdrawn();

        // ccheck if ticket is unlocked using library (timestamp-based)
        if (!ExitQueueLib.isUnlocked(_exitQueue, ticket)) revert PortalErrors.StillInQueue();

        ticket.withdrawn = true;

        uint256 amount = ticket.amount;
        _stakes[msg.sender] -= amount;
        _portalInfo.totalStaked -= amount;
        _exitAmounts[msg.sender] -= amount;
        _totalExitAmounts -= amount;

        _portalRegistry.unstakeFromPool(msg.sender, amount);

        emit ExitClaimed(msg.sender, amount);
    }

    function onAllocationReduced(address provider, uint256 amount) external {
        if (msg.sender != address(_portalRegistry)) revert PortalErrors.NotPortalRegistry();

        // Accrue global state and update user BEFORE changing stake
        _accrueGlobal(block.timestamp);
        _updateUser(provider);

        // Calculate LPT to burn (amount minus any already burned via exit requests)
        uint256 exitAmount = _exitAmounts[provider];
        uint256 lptToBurn = amount > exitAmount ? amount - exitAmount : 0;

        _stakes[provider] -= amount;
        _portalInfo.totalStaked -= amount;

        if (exitAmount > 0) {
            uint256 reduction = exitAmount >= amount ? amount : exitAmount;
            _exitAmounts[provider] -= reduction;
            _totalExitAmounts -= reduction;
            // note: tickets remain in mapping but their amounts are tracked via _exitAmounts
        }

        // burn LPT tokens for the portion not already in exit queue
        if (lptToBurn > 0) {
            lptToken.burn(provider, lptToBurn);
        }

        emit AllocationReduced(provider, amount);
    }

    function onLPTTransfer(address from, address to, uint256 amount) external nonReentrant {
        if (msg.sender != address(lptToken)) revert PortalErrors.NotLPTToken();

        uint256 senderStake = _stakes[from];
        uint256 senderExitAmount = _exitAmounts[from];
        uint256 transferableStake = senderStake > senderExitAmount ? senderStake - senderExitAmount : 0;

        if (amount > transferableStake) revert PortalErrors.InsufficientTransferableStake();

        uint256 receiverNewStake = _stakes[to] + amount;
        if (receiverNewStake > _factory.defaultMaxStakePerWallet()) revert PortalErrors.ExceedsWalletLimit();

        // Accrue global state and update both users BEFORE changing stakes
        _accrueGlobal(block.timestamp);
        _updateUser(from);
        _updateUser(to);

        _stakes[from] -= amount;
        _stakes[to] = receiverNewStake;

        // Update reward debts for new activeStakes
        uint256 fromActiveStake = _getUserActiveStake(from);
        uint256 toActiveStake = _getUserActiveStake(to);
        _rewardDebt[from] = FullMath.mulDiv(fromActiveStake, rewardPerStakeStored, ACC);
        _rewardDebt[to] = FullMath.mulDiv(toActiveStake, rewardPerStakeStored, ACC);

        emit StakeTransferred(from, to, amount);
    }

    function withdrawFromFailed() external {
        if (getState() != PortalState.FAILED) revert PortalErrors.PortalNotFailed();

        uint256 amount = _stakes[msg.sender];
        if (amount == 0) revert PortalErrors.NoStakeToWithdraw();

        // Calculate LPT to burn (stake minus any already burned via exit requests)
        uint256 exitAmount = _exitAmounts[msg.sender];
        uint256 lptToBurn = amount > exitAmount ? amount - exitAmount : 0;

        uint256 userLptBalance = lptToken.balanceOf(msg.sender);
        if (lptToBurn > userLptBalance) {
            lptToBurn = userLptBalance;
        }

        _stakes[msg.sender] = 0;
        _portalInfo.totalStaked -= amount;

        if (exitAmount > 0) {
            _totalExitAmounts -= exitAmount;
            _exitAmounts[msg.sender] = 0;
            // note: tickets remain in mapping, they're just not withdrawable
        }

        if (lptToBurn > 0) {
            lptToken.burn(msg.sender, lptToBurn);
        }

        _sqd.safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, amount);
    }

    function topUpRewards(uint256 amount) external onlyOperator {
        if (totalDistributionRatePerSec == 0) revert PortalErrors.DistributionTurnedOff();
        if (amount == 0) revert PortalErrors.InvalidAmount();

        if (getState() != PortalState.ACTIVE) revert PortalErrors.InvalidState();

        // measure actual received for fee-on-transfer token safety
        uint256 balanceBefore = _rewardToken.balanceOf(address(this));
        _rewardToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = _rewardToken.balanceOf(address(this)) - balanceBefore;

        // split based on actual received amount
        (uint256 toProviders, uint256 toWorkerPool,) = _feeRouter.calculateSplit(received);

        address workerPool = _factory.workerPoolAddress();
        if (toWorkerPool > 0) {
            if (workerPool == address(0)) revert PortalErrors.InvalidAddress();
            _rewardToken.safeTransfer(workerPool, toWorkerPool);
        }

        // Update credit/debt: checkpoint current state then add toProviders
        (uint256 currentCredit, uint256 currentDebt) = _currentCreditDebt(block.timestamp);

        // Apply topup: pay off debt first, remainder goes to credit
        if (toProviders <= currentDebt) {
            // All goes to paying off debt
            credit = currentCredit;
            debt = currentDebt - toProviders;
        } else {
            // Pay off all debt, remainder goes to credit
            credit = currentCredit + (toProviders - currentDebt);
            debt = 0;
        }
        balanceTs = uint64(block.timestamp);

        _accrueGlobalAfterTopUp(block.timestamp);

        emit RewardsToppedUp(msg.sender, amount, credit);
    }

    function claimRewards() external whenNotPaused returns (uint256) {
        if (totalDistributionRatePerSec == 0) revert PortalErrors.DistributionTurnedOff();

        _accrueGlobal(block.timestamp);
        _updateUser(msg.sender);

        uint256 amount = _unclaimedRewards[msg.sender];
        if (amount == 0) revert PortalErrors.NothingToClaim();

        _unclaimedRewards[msg.sender] = 0;

        if (amount > 0) {
            _rewardToken.safeTransfer(msg.sender, amount);
        }

        emit RewardsClaimed(msg.sender, amount);
        return amount;
    }

    function setDistributionRate(uint256 newRatePerSecond) external onlyOperator {
        if (newRatePerSecond > _factory.maxDistributionRatePerSecond()) {
            revert PortalErrors.RateExceedsMaximum();
        }
        if (newRatePerSecond != 0 && newRatePerSecond < _factory.minDistributionRatePerSecond()) {
            revert PortalErrors.RateBelowMinimum();
        }

        _accrueGlobal(block.timestamp);

        // Cannot change rate while pool has debt
        if (debt > 0) revert PortalErrors.PoolHasDebt();

        uint256 oldRate = totalDistributionRatePerSec;
        _setDistributionRate(newRatePerSecond);

        emit DistributionRateChanged(oldRate, newRatePerSecond);
    }

    function setCapacity(uint256 newCapacity) external onlyOperator {
        if (!_portalInfo.firstActivated) revert PortalErrors.NotActivated();
        if (newCapacity == _portalInfo.capacity) revert PortalErrors.NoChange();
        uint256 minCapacity = _networkController.minStakeThreshold();
        if (newCapacity < minCapacity) revert PortalErrors.BelowMinimum();
        if (newCapacity < _portalInfo.totalStaked) revert PortalErrors.BelowCurrentStake();

        _accrueGlobal(block.timestamp);

        // Cannot change capacity while pool has debt
        if (debt > 0) revert PortalErrors.PoolHasDebt();

        uint256 oldCapacity = _portalInfo.capacity;
        _portalInfo.capacity = newCapacity;

        // Recalculate per-stake rate
        // Note: delegatorRatePerSec is scaled by RATE_PRECISION, divide to get actual rate
        if (newCapacity > 0) {
            perStakeRateWad = FullMath.mulDiv(delegatorRatePerSec, ACC, newCapacity * RATE_PRECISION);
        }

        emit CapacityUpdated(oldCapacity, newCapacity);
    }

    function setBurnAddress(address newBurnAddress) external onlyOperator {
        burnAddress = newBurnAddress;
        emit BurnAddressUpdated(newBurnAddress);
    }

    function getState() public view returns (PortalState) {
        PortalInfo memory info = _portalInfo;

        if (info.state == PortalState.FAILED) {
            return PortalState.FAILED;
        }

        if (info.state == PortalState.COLLECTING) {
            if (block.timestamp > info.depositDeadline && !info.firstActivated) {
                return PortalState.FAILED;
            }
            return PortalState.COLLECTING;
        }

        if (info.firstActivated) {
            uint256 minStake = _networkController.minStakeThreshold();
            if (info.totalStaked < minStake) {
                return PortalState.IDLE;
            }
            return PortalState.ACTIVE;
        }

        return info.state;
    }

    function getPortalInfo() external view returns (PortalInfo memory) {
        PortalInfo memory info = _portalInfo;
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
     * @notice Get claimable rewards for a delegator
     * @dev Uses global RPS model with simulated accrual
     */
    function getClaimableRewards(address delegator) external view returns (uint256) {
        uint256 activeStake = _getUserActiveStake(delegator);
        if (activeStake == 0) return _unclaimedRewards[delegator];

        // Simulate global accrual
        (uint256 newRPS,) = _simulateGlobalAccrual(block.timestamp);

        // Calculate pending based on activeStake
        uint256 accumulated = FullMath.mulDiv(activeStake, newRPS, ACC);
        uint256 debt = _rewardDebt[delegator];
        uint256 pending = accumulated > debt ? accumulated - debt : 0;

        return _unclaimedRewards[delegator] + pending;
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
        (uint256 currentCredit, uint256 cDebt) = _currentCreditDebt(block.timestamp);
        balance = int256(currentCredit) - int256(cDebt);
        currentDebt = cDebt;
        runwayTimestamp = getRunway();
        isDry = currentCredit == 0;
    }

    /// @notice get current credit (available funds for distribution)
    function getCredit() external view returns (uint256) {
        (uint256 currentCredit,) = _currentCreditDebt(block.timestamp);
        return currentCredit;
    }

    /// @notice get current debt (owed but unpaid rewards)
    function getDebt() external view returns (uint256) {
        (, uint256 currentDebt) = _currentCreditDebt(block.timestamp);
        return currentDebt;
    }

    /// @notice check if pool has run out of rewards (credit exhausted)
    function isOutOfMoney() external view returns (bool) {
        (uint256 currentCredit,) = _currentCreditDebt(block.timestamp);
        return currentCredit == 0;
    }

    /// @notice get user's pending rewards
    function getUserRewards(address user) external view returns (uint256) {
        uint256 activeStake = _getUserActiveStake(user);
        if (activeStake == 0) return _unclaimedRewards[user];

        // simulate global accrual
        (uint256 newRPS,) = _simulateGlobalAccrual(block.timestamp);

        // calculate pending based on activeStake
        uint256 accumulated = FullMath.mulDiv(activeStake, newRPS, ACC);
        uint256 userDebt = _rewardDebt[user];
        uint256 pending = accumulated > userDebt ? accumulated - userDebt : 0;

        return _unclaimedRewards[user] + pending;
    }

    /// @notice get consolidated pool status with user rewards
    function getPoolStatusWithRewards(address user)
        external
        view
        returns (
            uint256 poolCredit,
            uint256 poolDebt,
            int256 poolBalance,
            int256 runway,
            bool outOfMoney,
            uint256 userRewards,
            uint256 userStake
        )
    {
        (poolCredit, poolDebt) = _currentCreditDebt(block.timestamp);
        poolBalance = int256(poolCredit) - int256(poolDebt);
        runway = getRunway();
        outOfMoney = poolCredit == 0;

        userStake = _getUserActiveStake(user);
        if (userStake == 0) {
            userRewards = _unclaimedRewards[user];
        } else {
            (uint256 newRPS,) = _simulateGlobalAccrual(block.timestamp);
            uint256 accumulated = FullMath.mulDiv(userStake, newRPS, ACC);
            uint256 userDebt = _rewardDebt[user];
            uint256 pending = accumulated > userDebt ? accumulated - userDebt : 0;
            userRewards = _unclaimedRewards[user] + pending;
        }
    }

    function getRewardDebt() external view returns (uint256) {
        (, uint256 currentDebt) = _currentCreditDebt(block.timestamp);
        return currentDebt;
    }

    function getTotalDrainRate() external view returns (uint256) {
        // Returns the scaled drain rate (multiplied by RATE_PRECISION)
        return _totalDrainRate();
    }

    function getRunway() public view returns (int256) {
        uint256 drainRate = _totalDrainRate();
        if (drainRate == 0) return type(int256).max;

        // if already in debt, runway is in the past
        // drainRate is scaled by RATE_PRECISION, so multiply credit/debt by RATE_PRECISION before dividing
        if (debt > 0) {
            // time when credit ran out: balanceTs - (debt * RATE_PRECISION / drainRate)
            return int256(uint256(balanceTs)) - int256(FullMath.mulDiv(debt, RATE_PRECISION, drainRate));
        }

        // runway = balanceTs + credit * RATE_PRECISION / drainRate
        return int256(uint256(balanceTs)) + int256(FullMath.mulDiv(credit, RATE_PRECISION, drainRate));
    }

    function getPeerId() external view returns (bytes memory) {
        return _peerId;
    }

    function getActiveStake() external view returns (uint256) {
        return _portalInfo.totalStaked > _totalExitAmounts ? _portalInfo.totalStaked - _totalExitAmounts : 0;
    }

    function getComputationUnits() external view returns (uint256) {
        return _portalRegistry.getComputationUnits(address(this));
    }

    function getRewardToken() external view returns (address) {
        return address(_rewardToken);
    }

    function getQueueStatus(address user, uint256 ticketId)
        external
        view
        returns (uint256 processed, uint256 userEndPos, uint256 secondsRemaining, bool ready)
    {
        ExitQueueLib.Ticket storage ticket = _exitTickets[user][ticketId];
        return ExitQueueLib.getStatus(_exitQueue, ticket);
    }

    function getQueueStatusWithTimestamp(address user, uint256 ticketId)
        external
        view
        returns (
            uint256 processed,
            uint256 userEndPos,
            uint256 secondsRemaining,
            bool ready,
            uint256 unlockTimestamp
        )
    {
        ExitQueueLib.Ticket storage ticket = _exitTickets[user][ticketId];
        (processed, userEndPos, secondsRemaining, ready) = ExitQueueLib.getStatus(_exitQueue, ticket);
        unlockTimestamp = ready ? block.timestamp : block.timestamp + secondsRemaining;
    }

    function getTotalProcessed() external view returns (uint256) {
        return _exitQueue.totalProcessed();
    }

    function getMetadata() external view returns (string memory) {
        return _portalRegistry.getMetadata(address(this));
    }

    function getMinCapacity() external view returns (uint256) {
        return _networkController.minStakeThreshold();
    }

    function getWithdrawalWaitingTimestamp(uint256 amount) external view returns (uint256 unlockTimestamp) {
        if (amount == 0) revert PortalErrors.InvalidAmount();
        return ExitQueueLib.getSimulatedUnlockTimestamp(_exitQueue, amount);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function currentBalance(uint256 timestamp) public view returns (int256) {
        (uint256 currentCredit, uint256 currentDebt) = _currentCreditDebt(timestamp);
        return int256(currentCredit) - int256(currentDebt);
    }

    /// @notice get current credit and debt at a given timestamp (view helper)
    function _currentCreditDebt(uint256 timestamp) internal view returns (uint256 currentCredit, uint256 currentDebt) {
        uint256 drainRate = _totalDrainRate();

        // no drain rate = no changes
        if (drainRate == 0) {
            return (credit, debt);
        }

        // handle case where timestamp might be before balanceTs
        if (timestamp < uint256(balanceTs)) {
            return (credit, debt);
        }

        uint256 elapsed = timestamp - uint256(balanceTs);
        // drainRate is scaled by RATE_PRECISION, so divide to get actual drained amount
        uint256 drained = FullMath.mulDiv(elapsed, drainRate, RATE_PRECISION);

        // apply drain: first reduce credit, then increase debt
        if (drained <= credit) {
            currentCredit = credit - drained;
            currentDebt = debt;
        } else {
            // credit exhausted, remainder goes to debt
            currentCredit = 0;
            currentDebt = debt + (drained - credit);
        }
    }

    function _getUserActiveStake(address user) internal view returns (uint256) {
        uint256 stake = _stakes[user];
        uint256 exitAmount = _exitAmounts[user];
        return stake > exitAmount ? stake - exitAmount : 0;
    }

    function _getActiveStake() internal view returns (uint256) {
        return _portalInfo.totalStaked > _totalExitAmounts ? _portalInfo.totalStaked - _totalExitAmounts : 0;
    }

    function _totalDrainRate() internal view returns (uint256) {
        uint256 activeStake = _getActiveStake();
        uint256 minStake = _networkController.minStakeThreshold();
        if (_portalInfo.totalStaked < minStake) return 0;
        if (activeStake == 0) return 0;
        // treasuryRate + (delegatorRate * activeStake / capacity)
        // Note: rates are scaled by RATE_PRECISION, returned value is also scaled
        uint256 capacity = _portalInfo.capacity;
        if (capacity == 0) return 0;
        // Return scaled drain rate (still multiplied by RATE_PRECISION)
        uint256 delegatorDrain = FullMath.mulDiv(delegatorRatePerSec, activeStake, capacity);
        return treasuryRatePerSec + delegatorDrain;
    }

    function _setDistributionRate(uint256 newRatePerSec) internal {
        totalDistributionRatePerSec = newRatePerSec;

        delegatorRatePerSec = newRatePerSec;
        treasuryRatePerSec = 0;
        // Update per-stake rate
        // Note: delegatorRatePerSec is scaled by RATE_PRECISION, divide to get actual rate
        uint256 capacity = _portalInfo.capacity;
        if (capacity > 0) {
            perStakeRateWad = FullMath.mulDiv(delegatorRatePerSec, ACC, capacity * RATE_PRECISION);
        }
    }

    function _simulateGlobalAccrual(uint256 timestamp) internal view returns (uint256 newRPS, uint64 newEffectiveTs) {
        newRPS = rewardPerStakeStored;
        newEffectiveTs = lastEffectiveRewardTs;

        uint256 activeStake = _getActiveStake();
        uint256 minStake = _networkController.minStakeThreshold();
        if (_portalInfo.totalStaked < minStake || activeStake == 0 || perStakeRateWad == 0) {
            return (newRPS, uint64(timestamp));
        }

        // Calculate runway from current state
        int256 runway = getRunway();

        if (runway >= int256(timestamp)) {
            if (timestamp > uint256(newEffectiveTs)) {
                uint256 delta = timestamp - uint256(newEffectiveTs);
                newRPS += FullMath.mulDiv(perStakeRateWad, delta, 1);
                newEffectiveTs = uint64(timestamp);
            }
        } else if (runway > int256(uint256(newEffectiveTs))) {
            uint256 delta = uint256(runway) - uint256(newEffectiveTs);
            newRPS += FullMath.mulDiv(perStakeRateWad, delta, 1);
            newEffectiveTs = uint64(uint256(runway));
        }
        // If runway <= newEffectiveTs, no additional accrual (we're dry and checkpointed)

        return (newRPS, newEffectiveTs);
    }

    function _accrueGlobal(uint256 timestamp) internal {
        uint256 activeStake = _getActiveStake();
        uint256 minStake = _networkController.minStakeThreshold();

        if (_portalInfo.totalStaked >= minStake && activeStake > 0 && perStakeRateWad > 0) {
            int256 runway = getRunway();

            if (runway >= int256(timestamp)) {
                if (timestamp > uint256(lastEffectiveRewardTs)) {
                    uint256 delta = timestamp - uint256(lastEffectiveRewardTs);
                    rewardPerStakeStored += FullMath.mulDiv(perStakeRateWad, delta, 1);
                    lastEffectiveRewardTs = uint64(timestamp);
                }
            } else if (runway > int256(uint256(lastEffectiveRewardTs))) {
                uint256 delta = uint256(runway) - uint256(lastEffectiveRewardTs);
                rewardPerStakeStored += FullMath.mulDiv(perStakeRateWad, delta, 1);
                lastEffectiveRewardTs = uint64(uint256(runway));
            }
        } else {
            lastEffectiveRewardTs = uint64(timestamp);
        }

        // Checkpoint credit/debt at current timestamp
        (uint256 currentCredit, uint256 currentDebt) = _currentCreditDebt(timestamp);
        credit = currentCredit;
        debt = currentDebt;
        balanceTs = uint64(timestamp);
    }

    function _accrueGlobalAfterTopUp(uint256 timestamp) internal {
        uint256 activeStake = _getActiveStake();
        uint256 minStake = _networkController.minStakeThreshold();

        if (_portalInfo.totalStaked >= minStake && activeStake > 0 && perStakeRateWad > 0) {
            int256 runway = getRunway();

            if (runway >= int256(timestamp)) {
                if (timestamp > uint256(lastEffectiveRewardTs)) {
                    uint256 delta = timestamp - uint256(lastEffectiveRewardTs);
                    rewardPerStakeStored += FullMath.mulDiv(perStakeRateWad, delta, 1);
                    lastEffectiveRewardTs = uint64(timestamp);
                }
            } else if (runway > int256(uint256(lastEffectiveRewardTs))) {
                uint256 delta = uint256(runway) - uint256(lastEffectiveRewardTs);
                rewardPerStakeStored += FullMath.mulDiv(perStakeRateWad, delta, 1);
                lastEffectiveRewardTs = uint64(uint256(runway));
            }
        } else {
            lastEffectiveRewardTs = uint64(timestamp);
        }

        // Don't update balance again - already done in topUpRewards
    }

    function _updateUser(address user) internal {
        uint256 activeStake = _getUserActiveStake(user);
        if (activeStake > 0) {
            uint256 accumulated = FullMath.mulDiv(activeStake, rewardPerStakeStored, ACC);
            uint256 debt = _rewardDebt[user];
            uint256 pending = accumulated > debt ? accumulated - debt : 0;
            _unclaimedRewards[user] += pending;
            _rewardDebt[user] = accumulated;
        } else if (_stakes[user] > 0) {
            _rewardDebt[user] = 0;
        }
    }

    function _handleDeadlinePassed() internal {
        if (!_portalInfo.firstActivated) {
            _portalInfo.state = PortalState.FAILED;
            emit StateChanged(PortalState.COLLECTING, PortalState.FAILED);
        }
    }

    function checkAndFailPortal() external {
        if (_portalInfo.state != PortalState.COLLECTING) revert PortalErrors.InvalidState();
        if (block.timestamp <= _portalInfo.depositDeadline) revert PortalErrors.DeadlineNotPassed();

        _handleDeadlinePassed();
    }
}
