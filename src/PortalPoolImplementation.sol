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

    /// @notice Precision for reward calculations (1e18)
    uint256 public constant ACC = 1e18;

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
        if (params.usdc == address(0)) revert PortalErrors.InvalidAddress();
        if (params.portalRegistry == address(0)) revert PortalErrors.InvalidAddress();
        if (params.feeRouter == address(0)) revert PortalErrors.InvalidAddress();
        if (params.networkController == address(0)) revert PortalErrors.InvalidAddress();

        __AccessControl_init();
        __Pausable_init();

        _peerId = params.peerId;
        _sqd = IERC20(params.sqd);
        _usdc = IERC20(params.usdc);
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

        uint256 newTotal = _portalInfo.totalStaked + amount;
        if (newTotal > _portalInfo.capacity) revert PortalErrors.CapacityExceeded();

        _sqd.safeTransferFrom(msg.sender, address(this), amount);

        _settleFees(msg.sender);

        // Accrue global state and update user BEFORE changing stake
        _accrueGlobal(block.timestamp);
        _updateUser(msg.sender);

        _stakes[msg.sender] = newUserStake;
        _portalInfo.totalStaked = newTotal;

        // Update user's reward debt for new activeStake
        uint256 activeStake = _getUserActiveStake(msg.sender);
        _rewardDebt[msg.sender] = FullMath.mulDiv(activeStake, rewardPerStakeStored, ACC);

        _updateFeeDebt(msg.sender);

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
            _sqd.approve(address(_portalRegistry), _portalInfo.totalStaked);
            _portalRegistry.stakePoolFunds(_portalInfo.totalStaked);
            _portalRegistry.activatePortalPool();

            emit StateChanged(PortalState.COLLECTING, PortalState.ACTIVE);
        } else if (currentState != PortalState.COLLECTING) {
            _sqd.approve(address(_portalRegistry), amount);
            _portalRegistry.stake(address(this), msg.sender, amount);

            if (isRecoveringFromIdle) {
                _portalRegistry.activatePortalPool();
                emit StateChanged(PortalState.IDLE, PortalState.ACTIVE);
            }
        }

        lptToken.mint(msg.sender, amount);

        // Emit event AFTER all operations (strict CEI)
        emit Staked(msg.sender, amount, _portalInfo.totalStaked);
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

        _settleFees(msg.sender);

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

        _updateFeeDebt(msg.sender);

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

        _portalRegistry.immediateUnlock(msg.sender, amount);

        emit ExitClaimed(msg.sender, amount);
    }

    function onAllocationReduced(address provider, uint256 amount) external {
        if (msg.sender != address(_portalRegistry)) revert PortalErrors.NotPortalRegistry();

        // Accrue global state and update user BEFORE changing stake
        _accrueGlobal(block.timestamp);
        _updateUser(provider);
        _settleFees(provider);

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

        _updateFeeDebt(provider);

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

        _settleFees(from);
        _settleFees(to);

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

        _updateFeeDebt(from);
        _updateFeeDebt(to);

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

        (uint256 toProviders, uint256 toWorkerPool, ) = _feeRouter.calculateSplit(amount);

        // Get worker pool address from factory (global setting)
        address workerPool = _factory.workerPoolAddress();

        // If FeeRouter has workerPool split > 0%, validate and send
        if (toWorkerPool > 0) {
            if (workerPool == address(0)) revert PortalErrors.InvalidAddress();
        }

        _usdc.safeTransferFrom(msg.sender, address(this), amount);

        if (toWorkerPool > 0) {
            _usdc.safeTransfer(workerPool, toWorkerPool);
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
            _usdc.safeTransfer(msg.sender, amount);
        }

        emit RewardsClaimed(msg.sender, amount);
        return amount;
    }

    function setDistributionRate(uint256 newRatePerSecond) external onlyOperator {
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
        if (newCapacity > 0) {
            perStakeRateWad = FullMath.mulDiv(delegatorRatePerSec, ACC, newCapacity);
        }

        emit CapacityUpdated(oldCapacity, newCapacity);
    }

    function distributeFees(address token, uint256 amount) external onlyOperator whenNotPaused {
        PortalState currentState = getState();
        if (currentState != PortalState.ACTIVE) revert PortalErrors.InvalidState();

        if (amount == 0) revert PortalErrors.InvalidAmount();
        if (token == address(0)) revert PortalErrors.InvalidAddress();
        if (!_factory.isAllowedPaymentToken(token)) revert PortalErrors.TokenNotAllowed();

        IERC20 paymentToken = IERC20(token);

        (uint256 toProviders, uint256 toWorkerPool, uint256 toBurn) = _feeRouter.calculateSplit(amount);

        uint256 activeStake =
            _portalInfo.totalStaked > _totalExitAmounts ? _portalInfo.totalStaked - _totalExitAmounts : 0;
        if (activeStake > 0) {
            _cumulativeFeesPerShare[token] += FullMath.mulDiv(toProviders, 1e18, activeStake);
        }

        totalFeesDistributed[token] += toProviders;
        lastDistributionTime[token] = block.timestamp;

        paymentToken.safeTransferFrom(msg.sender, address(this), amount);

        // If FeeRouter has workerPool split > 0%, validate and send
        if (toWorkerPool > 0) {
            address workerPool = _factory.workerPoolAddress();
            if (workerPool == address(0)) revert PortalErrors.InvalidAddress();
            paymentToken.safeTransfer(workerPool, toWorkerPool);
        }

        if (toBurn > 0) {
            paymentToken.safeTransfer(address(0xdead), toBurn);
        }

        emit FeesDistributed(token, amount, toProviders, toWorkerPool, toBurn);
    }

    function claimFees(address token) external whenNotPaused returns (uint256 claimed) {
        if (token == address(0)) revert PortalErrors.InvalidAddress();
        if (!_factory.isAllowedPaymentToken(token)) revert PortalErrors.TokenNotAllowed();

        _settleFees(msg.sender);

        claimed = _unclaimedFees[token][msg.sender];
        if (claimed == 0) revert PortalErrors.NothingToClaim();

        _unclaimedFees[token][msg.sender] = 0;

        _providerTotalClaimed[token][msg.sender] += claimed;

        IERC20(token).safeTransfer(msg.sender, claimed);

        emit FeesClaimed(msg.sender, token, claimed);
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

    function getClaimableFees(address provider, address token) external view returns (uint256) {
        return _calculateClaimableFees(provider, token);
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
    function getRewardStatus() external view returns (
        int256 balance,
        uint256 currentDebt,
        int256 runwayTimestamp,
        bool isDry
    ) {
        (uint256 currentCredit, uint256 cDebt) = _currentCreditDebt(block.timestamp);
        balance = int256(currentCredit) - int256(cDebt);
        currentDebt = cDebt;
        runwayTimestamp = getRunway();
        isDry = currentCredit == 0;
    }

    /// @notice get current credit (available funds for distribution)
    function getCredit() external view returns (uint256) {
        (uint256 currentCredit, ) = _currentCreditDebt(block.timestamp);
        return currentCredit;
    }

    /// @notice get current debt (owed but unpaid rewards)
    function getDebt() external view returns (uint256) {
        (, uint256 currentDebt) = _currentCreditDebt(block.timestamp);
        return currentDebt;
    }

    /// @notice check if pool has run out of rewards (credit exhausted)
    function isOutOfMoney() external view returns (bool) {
        (uint256 currentCredit, ) = _currentCreditDebt(block.timestamp);
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
    function getPoolStatusWithRewards(address user) external view returns (
        uint256 poolCredit,
        uint256 poolDebt,
        int256 poolBalance,
        int256 runway,
        bool outOfMoney,
        uint256 userRewards,
        uint256 userStake
    ) {
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
        return _totalDrainRate();
    }

    function getRunway() public view returns (int256) {
        uint256 drainRate = _totalDrainRate();
        if (drainRate == 0) return type(int256).max;

        // if already in debt, runway is in the past
        if (debt > 0) {
            // time when credit ran out: balanceTs - (debt / drainRate)
            return int256(uint256(balanceTs)) - int256(debt / drainRate);
        }

        // runway = balanceTs + credit / drainRate
        return int256(uint256(balanceTs)) + int256(credit / drainRate);
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

    function getAllowedPaymentTokens() external view returns (address[] memory) {
        return _factory.getAllowedPaymentTokens();
    }

    function getQueueStatus(address user, uint256 ticketId)
        external
        view
        returns (uint256 processed, uint256 userEndPos, uint256 secondsRemaining, bool ready)
    {
        ExitQueueLib.Ticket storage ticket = _exitTickets[user][ticketId];
        return ExitQueueLib.getStatus(_exitQueue, ticket);
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

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function _calculateClaimableFees(address provider, address token) internal view returns (uint256) {
        uint256 unclaimed = _unclaimedFees[token][provider];

        uint256 providerStake = _stakes[provider];
        uint256 exitAmount = _exitAmounts[provider];
        uint256 activeStake = providerStake > exitAmount ? providerStake - exitAmount : 0;

        if (activeStake == 0) return unclaimed;

        uint256 cumulative = _cumulativeFeesPerShare[token];
        uint256 debt = _feeDebt[token][provider];

        uint256 accumulated = FullMath.mulDiv(activeStake, cumulative, 1e18);
        uint256 pending = accumulated > debt ? accumulated - debt : 0;

        return unclaimed + pending;
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
        uint256 drained = FullMath.mulDiv(elapsed, drainRate, 1);

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
        if (activeStake < minStake) return 0;
        // treasuryRate + (delegatorRate * activeStake / capacity)
        uint256 capacity = _portalInfo.capacity;
        if (capacity == 0) return 0;
        uint256 delegatorDrain = FullMath.mulDiv(delegatorRatePerSec, activeStake, capacity);
        return treasuryRatePerSec + delegatorDrain;
    }


    function _setDistributionRate(uint256 newRatePerSec) internal {
        totalDistributionRatePerSec = newRatePerSec;

        delegatorRatePerSec = newRatePerSec;
        treasuryRatePerSec = 0;
        // Update per-stake rate
        uint256 capacity = _portalInfo.capacity;
        if (capacity > 0) {
            perStakeRateWad = FullMath.mulDiv(delegatorRatePerSec, ACC, capacity);
        }
    }


    function _simulateGlobalAccrual(uint256 timestamp)
        internal
        view
        returns (uint256 newRPS, uint64 newEffectiveTs)
    {
        newRPS = rewardPerStakeStored;
        newEffectiveTs = lastEffectiveRewardTs;

        uint256 activeStake = _getActiveStake();
        uint256 minStake = _networkController.minStakeThreshold();
        if (activeStake < minStake || perStakeRateWad == 0) {
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

        if (activeStake >= minStake && perStakeRateWad > 0) {
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

        if (activeStake >= minStake && perStakeRateWad > 0) {
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

    function _settleFees(address user) internal {
        uint256 userStake = _stakes[user];
        uint256 exitAmount = _exitAmounts[user];
        uint256 activeStake = userStake > exitAmount ? userStake - exitAmount : 0;

        address[] memory tokens = _factory.getAllowedPaymentTokens();
        uint256 tokenCount = tokens.length;

        for (uint256 i = 0; i < tokenCount;) {
            address token = tokens[i];
            uint256 cumulative = _cumulativeFeesPerShare[token];
            uint256 debt = _feeDebt[token][user];

            if (activeStake > 0 && cumulative > 0) {
                uint256 accumulated = FullMath.mulDiv(activeStake, cumulative, 1e18);
                if (accumulated > debt) {
                    _unclaimedFees[token][user] += accumulated - debt;
                }
                _feeDebt[token][user] = accumulated;
            } else {
                // If stake is 0, reset debt to 0 to keep state clean
                _feeDebt[token][user] = 0;
            }
            unchecked {
                ++i;
            }
        }
    }

    function _updateFeeDebt(address user) internal {
        uint256 userStake = _stakes[user];
        uint256 exitAmount = _exitAmounts[user];
        uint256 activeStake = userStake > exitAmount ? userStake - exitAmount : 0;

        address[] memory tokens = _factory.getAllowedPaymentTokens();
        uint256 tokenCount = tokens.length;

        for (uint256 i = 0; i < tokenCount;) {
            address token = tokens[i];
            uint256 cumulative = _cumulativeFeesPerShare[token];
            _feeDebt[token][user] = FullMath.mulDiv(activeStake, cumulative, 1e18);
            unchecked {
                ++i;
            }
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
