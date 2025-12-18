// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PortalPoolStorage} from "./storage/PortalPoolStorage.sol";
import {IPortalRegistry} from "./interfaces/IPortalRegistry.sol";
import {IFeeRouter} from "./interfaces/IFeeRouter.sol";
import {INetworkController} from "./interfaces/INetworkController.sol";
import {IPortalFactory} from "./interfaces/IPortalFactory.sol";
import {IPortalPool} from "./interfaces/IPortalPool.sol";
import {PortalErrors} from "./libs/PortalErrors.sol";
import {Constants} from "./libs/Constants.sol";
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

        if (params.maxCapacity < _networkController.minStakeThreshold()) revert PortalErrors.BelowMinimum();

        _factory = IPortalFactory(msg.sender);

        _portalInfo.operator = params.operator;
        _portalInfo.maxCapacity = params.maxCapacity;
        _portalInfo.totalStaked = 0;
        _portalInfo.depositDeadline = uint64(block.timestamp + _factory.collectionDeadlineSeconds());
        _portalInfo.activationTime = 0;
        _portalInfo.state = PortalState.COLLECTING;
        _portalInfo.paused = false;
        _portalInfo.firstActivated = false;

        maxStakePerWallet = params.maxStakePerWallet;
        distributionRateScaled = params.distributionRatePerSecond * Constants.PRECISION;
        lastRewardTimestamp = block.timestamp;

        _exitQueue.initialize(_factory.exitUnlockRatePerSecond());

        _grantRole(DEFAULT_ADMIN_ROLE, params.operator);
        _grantRole(OPERATOR_ROLE, params.operator);
        _grantRole(FACTORY_ROLE, msg.sender);

        _portalRegistry.registerPortal(_peerId, address(this), _portalInfo.operator);

        // deploy the LPT token for this portal using portalName
        string memory tokenName = string(abi.encodePacked(params.portalName, " Liquidity Portal Token"));
        string memory tokenSymbol = string(abi.encodePacked(params.portalName, "-LPT"));
        lptToken = new LiquidPortalToken(tokenName, tokenSymbol, address(this));
    }

    function deposit(uint256 amount) external whenNotPaused {
        if (amount == 0) revert PortalErrors.InvalidAmount();

        PortalState currentState = getState();
        if (currentState != PortalState.COLLECTING && currentState != PortalState.ACTIVE && currentState != PortalState.IDLE) {
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
        if (newUserStake > maxStakePerWallet) revert PortalErrors.ExceedsWalletLimit();

        uint256 newTotal = _portalInfo.totalStaked + amount;
        if (newTotal > _portalInfo.maxCapacity) revert PortalErrors.CapacityExceeded();

        _sqd.safeTransferFrom(msg.sender, address(this), amount);

        _settleFees(msg.sender);
        _updateDelegatorCheckpoint(msg.sender);

        _stakes[msg.sender] = newUserStake;
        _portalInfo.totalStaked = newTotal;

        _updateFeeDebt(msg.sender);

        bool shouldActivate = !_portalInfo.firstActivated && _portalInfo.totalStaked >= _portalInfo.maxCapacity;

        uint256 minStakeThreshold = _networkController.minStakeThreshold();
        bool isRecoveringFromIdle = currentState == PortalState.IDLE &&
                                    _portalInfo.totalStaked >= minStakeThreshold;

        if (shouldActivate) {
            _portalInfo.state = PortalState.ACTIVE;
            _portalInfo.firstActivated = true;
            _portalInfo.activationTime = uint64(block.timestamp);
        }

        // Route funds based on state
        if (currentState == PortalState.COLLECTING && !shouldActivate) {
        } else if (shouldActivate) {
            // activation: Push ALL accumulated funds to Registry
            _sqd.approve(address(_portalRegistry), _portalInfo.totalStaked);
            _portalRegistry.stakePoolFunds(_portalInfo.totalStaked);
            _portalRegistry.activatePortal();

            emit StateChanged(PortalState.COLLECTING, PortalState.ACTIVE);
        } else {
            _sqd.approve(address(_portalRegistry), amount);
            _portalRegistry.stake(address(this), msg.sender, amount);

            if (isRecoveringFromIdle) {
                _portalRegistry.activatePortal();
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

        _settleFees(msg.sender);
        _updateDelegatorCheckpoint(msg.sender);

        uint256 endPos = _exitQueue.enqueue(amount);

        ticketId = _nextTicketId[msg.sender];
        _exitTickets[msg.sender][ticketId] = ExitQueueLib.Ticket({
            endPosition: endPos,
            amount: amount,
            withdrawn: false
        });
        _nextTicketId[msg.sender]++;

        _exitAmounts[msg.sender] += amount;
        _totalExitAmounts += amount;

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

        _updateDelegatorCheckpoint(provider);
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
        if (receiverNewStake > maxStakePerWallet) revert PortalErrors.ExceedsWalletLimit();

        _settleFees(from);
        _settleFees(to);

        _updateDelegatorCheckpoint(from);
        _updateDelegatorCheckpoint(to);

        _stakes[from] -= amount;
        _stakes[to] = receiverNewStake;

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
        if (amount == 0) revert PortalErrors.InvalidAmount();

        if (getState() != PortalState.ACTIVE) revert PortalErrors.InvalidState();

        _updateGlobalRewardCheckpoint();

        _usdc.safeTransferFrom(msg.sender, address(this), amount);

        lastRewardBalanceScaled += amount * Constants.PRECISION;

        emit RewardsToppedUp(msg.sender, amount, lastRewardBalanceScaled);
    }

    function claimRewards() external whenNotPaused returns (uint256) {
        _updateDelegatorCheckpoint(msg.sender);

        DelegatorCheckpoint storage checkpoint = _delegatorCheckpoints[msg.sender];
        uint256 claimableScaled = checkpoint.lastClaimedBalanceScaled;

        if (claimableScaled == 0) revert PortalErrors.NothingToClaim();

        checkpoint.lastClaimedBalanceScaled = 0;

        uint256 claimable = claimableScaled / Constants.PRECISION;
        if (claimable > 0) {
            _usdc.safeTransfer(msg.sender, claimable);
        }

        emit RewardsClaimed(msg.sender, claimable);
        return claimable;
    }

    function setDistributionRate(uint256 newRatePerSecond) external onlyOperator {
        _updateGlobalRewardCheckpoint();

        uint256 oldRate = distributionRateScaled;
        distributionRateScaled = newRatePerSecond * Constants.PRECISION;

        emit DistributionRateChanged(oldRate / Constants.PRECISION, newRatePerSecond);
    }

    function distributeFees(address token, uint256 amount)
        external
        onlyOperator
        whenNotPaused
    {
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

        address workerPool = _networkController.workerRewardPool();
        paymentToken.safeTransfer(workerPool, toWorkerPool);

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
        return ExitTicket({
            endPosition: ticket.endPosition,
            amount: ticket.amount,
            withdrawn: ticket.withdrawn
        });
    }

    function getTicketCount(address provider) external view returns (uint256) {
        return _nextTicketId[provider];
    }

    function getClaimableFees(address provider, address token) external view returns (uint256) {
        return _calculateClaimableFees(provider, token);
    }

    function getClaimableRewards(address delegator) external view returns (uint256) {
        uint256 delegatorStake = _stakes[delegator];
        if (delegatorStake == 0) return 0;

        uint256 exitAmount = _exitAmounts[delegator];
        uint256 activeStake = delegatorStake > exitAmount ? delegatorStake - exitAmount : 0;
        if (activeStake == 0) return 0;

        DelegatorCheckpoint memory checkpoint = _delegatorCheckpoints[delegator];

        if (getState() != PortalState.ACTIVE) {
            return checkpoint.lastClaimedBalanceScaled / Constants.PRECISION;
        }

        uint256 timeDelta = block.timestamp - checkpoint.lastTimestamp;
        uint256 runway = _calculateRunway();
        uint256 effectiveTime = timeDelta < runway ? timeDelta : runway;

        uint256 totalCapacity = _portalInfo.maxCapacity;
        if (totalCapacity == 0) return checkpoint.lastClaimedBalanceScaled / Constants.PRECISION;

        uint256 accruedScaled = effectiveTime * distributionRateScaled * activeStake / totalCapacity;

        return (checkpoint.lastClaimedBalanceScaled + accruedScaled) / Constants.PRECISION;
    }

    function getCurrentRewardBalance() external view returns (uint256) {
        uint256 timeDelta = block.timestamp - lastRewardTimestamp;
        uint256 spent = timeDelta * distributionRateScaled;
        if (spent >= lastRewardBalanceScaled) return 0;
        return (lastRewardBalanceScaled - spent) / Constants.PRECISION;
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

    function getQueueStatus(address user, uint256 ticketId) external view returns (
        uint256 processed,
        uint256 userEndPos,
        uint256 secondsRemaining,
        bool ready
    ) {
        ExitQueueLib.Ticket storage ticket = _exitTickets[user][ticketId];
        return ExitQueueLib.getStatus(_exitQueue, ticket);
    }

    function getTotalProcessed() external view returns (uint256) {
        return _exitQueue.totalProcessed();
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

    function _calculateRunway() internal view returns (uint256) {
        if (distributionRateScaled == 0) return type(uint256).max;
        return lastRewardBalanceScaled / distributionRateScaled;
    }

    function _updateGlobalRewardCheckpoint() internal {
        if (getState() != PortalState.ACTIVE) {
            lastRewardTimestamp = block.timestamp;
            return;
        }

        uint256 timeDelta = block.timestamp - lastRewardTimestamp;
        if (timeDelta > 0) {
            uint256 spent = timeDelta * distributionRateScaled;
            if (spent >= lastRewardBalanceScaled) {
                lastRewardBalanceScaled = 0;
            } else {
                lastRewardBalanceScaled -= spent;
            }
            lastRewardTimestamp = block.timestamp;
        }
    }

    function _updateDelegatorCheckpoint(address delegator) internal {
        _updateGlobalRewardCheckpoint();

        DelegatorCheckpoint storage checkpoint = _delegatorCheckpoints[delegator];

        if (checkpoint.lastTimestamp == 0) {
            checkpoint.lastTimestamp = block.timestamp;
            return;
        }

        uint256 delegatorStake = _stakes[delegator];
        if (delegatorStake == 0) {
            checkpoint.lastTimestamp = block.timestamp;
            return;
        }

        uint256 exitAmount = _exitAmounts[delegator];
        uint256 activeStake = delegatorStake > exitAmount ? delegatorStake - exitAmount : 0;

        // only accrue rewards if portal is ACTIVE (not IDLE, COLLECTING, or FAILED)
        // this prevents reward leak when portal drops below minimum stake
        if (activeStake > 0 && _portalInfo.maxCapacity > 0 && getState() == PortalState.ACTIVE) {
            uint256 timeDelta = block.timestamp - checkpoint.lastTimestamp;
            uint256 runway = _calculateRunway();
            uint256 effectiveTime = timeDelta < runway ? timeDelta : runway;

            uint256 accruedScaled = effectiveTime * distributionRateScaled * activeStake / _portalInfo.maxCapacity;
            checkpoint.lastClaimedBalanceScaled += accruedScaled;
        }

        checkpoint.lastTimestamp = block.timestamp;
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
            unchecked { ++i; }
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
            unchecked { ++i; }
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
