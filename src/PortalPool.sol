// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {FeeRouterModule} from "./FeeRouterModule.sol";
import {GatewayRegistry} from "./GatewayRegistry.sol";
import {Errors} from "./libs/Errors.sol";

contract PortalPool is ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    enum State {
        Collecting,
        Active,
        Failed,
        Closed
    }

    struct ExitTicket {
        address owner;
        uint256 amount;
        uint64 unlockTimestamp;
        bool fulfilled;
    }

    address public immutable factory;
    address public immutable consumer;
    IERC20 public immutable SQD;
    IERC20 public immutable paymentToken;
    FeeRouterModule public immutable feeRouter;
    GatewayRegistry public immutable gatewayRegistry;

    uint256 public immutable targetSQD;
    uint256 public immutable minimumSQD;
    uint64 public immutable depositDeadline;
    uint256 public immutable epochLength;
    uint256 public immutable baseExitDelay;
    uint256 public immutable avgBlockTime;

    uint256 public constant MIN_SQD_DEPOSIT = 1e18;
    uint256 public constant MAX_WHALE_PERCENT = 2000;

    State public state;
    uint256 public budget;
    uint64 public activatedAt;

    mapping(address => uint256) public activeBalances;
    mapping(address => uint256) public exitingBalances;
    mapping(address => uint256) public rewardsClaimed;

    uint256 public totalActiveSQD;
    uint256 public totalExitingSQD;
    uint256 public totalRewardsDistributed;
    uint256 public totalRewardsClaimed;

    mapping(uint256 => ExitTicket) public exitTickets;
    uint256[] public exitQueue;
    uint256 public exitQueueHead;
    uint256 public nextTicketId;

    event Initialized();
    event CollectingStarted(uint256 budget);
    event SQDDeposited(address indexed provider, uint256 amount, uint256 newBalance);
    event Activated(uint64 timestamp, uint256 stakedAmount);
    event Failed();
    event Closed(string reason);
    event Distributed(uint256 total, uint256 toProviders, uint256 toWorkers);
    event RewardsClaimed(address indexed provider, uint256 amount);
    event ExitTicketCreated(uint256 indexed ticketId, address indexed owner, uint256 amount, uint64 unlockTime);
    event ExitTicketFulfilled(uint256 indexed ticketId, address indexed owner, uint256 amount);
    event StakeAdjustedInRegistry(int256 delta, uint256 newRegistryStake);

    modifier onlyConsumer() {
        if (msg.sender != consumer) revert Errors.NotConsumer();
        _;
    }

    modifier onlyFactory() {
        if (msg.sender != factory) revert Errors.NotFactory();
        _;
    }

    modifier inState(State requiredState) {
        if (state != requiredState) revert Errors.InvalidState();
        _;
    }

    constructor(
        address _factory,
        address _consumer,
        address _sqdToken,
        address _paymentToken,
        address _feeRouter,
        address _gatewayRegistry,
        uint256 _targetSQD,
        uint256 _minimumSQD,
        uint64 _depositDeadline,
        uint256 _epochLength,
        uint256 _baseExitDelay,
        uint256 _avgBlockTime
    ) {
        factory = _factory;
        consumer = _consumer;
        SQD = IERC20(_sqdToken);
        paymentToken = IERC20(_paymentToken);
        feeRouter = FeeRouterModule(_feeRouter);
        gatewayRegistry = GatewayRegistry(_gatewayRegistry);
        targetSQD = _targetSQD;
        minimumSQD = _minimumSQD;
        depositDeadline = _depositDeadline;
        epochLength = _epochLength;
        baseExitDelay = _baseExitDelay;
        avgBlockTime = _avgBlockTime;
        nextTicketId = 1;
    }

    function initialize() external onlyFactory {
        if (budget != 0) revert Errors.AlreadyInitialized();
        budget = paymentToken.balanceOf(address(this));
        emit Initialized();
        emit CollectingStarted(budget);
    }

    function pause() external onlyFactory {
        _pause();
    }

    function unpause() external onlyFactory {
        _unpause();
    }

    function depositSQD(uint256 amount) external nonReentrant whenNotPaused inState(State.Collecting) {
        if (amount == 0) revert Errors.ZeroAmount();
        if (amount < MIN_SQD_DEPOSIT) revert Errors.BelowMinimumDeposit();

        uint256 newBalance = activeBalances[msg.sender] + amount;
        uint256 newTotal = totalActiveSQD + amount;

        if (newBalance * 10000 > targetSQD * MAX_WHALE_PERCENT) {
            revert Errors.ExceedsMaximumDeposit();
        }

        SQD.safeTransferFrom(msg.sender, address(this), amount);

        activeBalances[msg.sender] = newBalance;
        totalActiveSQD = newTotal;

        emit SQDDeposited(msg.sender, amount, newBalance);

        if (newTotal >= minimumSQD && block.timestamp <= depositDeadline) {
            _tryActivate();
        }
    }

    function activate() external nonReentrant whenNotPaused inState(State.Collecting) {
        if (block.timestamp > depositDeadline) revert Errors.PastDeadline();
        if (totalActiveSQD < minimumSQD) revert Errors.TargetNotMet();

        _tryActivate();
    }

    function _tryActivate() internal {
        state = State.Active;
        activatedAt = uint64(block.timestamp);

        uint256 amountToStake = totalActiveSQD;
        SQD.approve(address(gatewayRegistry), amountToStake);
        gatewayRegistry.adjustStake(int256(amountToStake));

        emit Activated(activatedAt, amountToStake);
        emit StakeAdjustedInRegistry(int256(amountToStake), amountToStake);
    }

    function markFailed() external nonReentrant whenNotPaused inState(State.Collecting) {
        if (block.timestamp <= depositDeadline) revert Errors.DeadlineNotReached();
        if (totalActiveSQD >= minimumSQD) revert Errors.InvalidState();

        state = State.Failed;
        emit Failed();
    }

    function distribute(uint256 amount) external onlyConsumer nonReentrant whenNotPaused inState(State.Active) {
        if (amount == 0) revert Errors.ZeroAmount();

        _checkMinimumThreshold();

        paymentToken.safeTransferFrom(consumer, address(this), amount);

        paymentToken.approve(address(feeRouter), amount);
        (uint256 toProviders, uint256 toWorkers,) = feeRouter.routeFees(
            address(this),
            paymentToken,
            amount
        );

        totalRewardsDistributed += toProviders;

        emit Distributed(amount, toProviders, toWorkers);
    }

    function claimRewards() external nonReentrant whenNotPaused returns (uint256 claimed) {
        uint256 pending = pendingRewards(msg.sender);
        if (pending == 0) revert Errors.NothingToClaim();

        rewardsClaimed[msg.sender] += pending;
        totalRewardsClaimed += pending;

        paymentToken.safeTransfer(msg.sender, pending);

        emit RewardsClaimed(msg.sender, pending);
        return pending;
    }

    function pendingRewards(address user) public view returns (uint256) {
        uint256 balance = activeBalances[user];
        if (balance == 0 || totalActiveSQD == 0) return 0;

        uint256 totalEarned = (balance * totalRewardsDistributed) / totalActiveSQD;
        uint256 claimed = rewardsClaimed[user];

        return totalEarned > claimed ? totalEarned - claimed : 0;
    }

    function requestExit(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert Errors.ZeroAmount();
        if (activeBalances[msg.sender] < amount) revert Errors.InsufficientBalance();

        activeBalances[msg.sender] -= amount;
        exitingBalances[msg.sender] += amount;
        totalActiveSQD -= amount;
        totalExitingSQD += amount;

        uint256 totalLiquidity = totalActiveSQD + totalExitingSQD;
        uint256 percentageOfPool = (amount * 10000) / totalLiquidity;
        uint256 percentageEpochs = percentageOfPool / 100;
        uint256 delayEpochs = baseExitDelay + percentageEpochs;
        uint256 delaySeconds = delayEpochs * epochLength * avgBlockTime;
        uint64 unlockTimestamp = uint64(block.timestamp) + uint64(delaySeconds);

        uint256 ticketId = nextTicketId++;
        exitTickets[ticketId] = ExitTicket({
            owner: msg.sender,
            amount: amount,
            unlockTimestamp: unlockTimestamp,
            fulfilled: false
        });

        exitQueue.push(ticketId);

        emit ExitTicketCreated(ticketId, msg.sender, amount, unlockTimestamp);

        _checkAndUnstake();
    }

    function processExits(uint256 maxToProcess) external nonReentrant whenNotPaused {
        if (maxToProcess == 0) revert Errors.ZeroAmount();

        uint256 liquidSQD = SQD.balanceOf(address(this));
        uint256 processedCount = 0;

        while (liquidSQD > 0 && exitQueueHead < exitQueue.length && processedCount < maxToProcess) {
            uint256 ticketId = exitQueue[exitQueueHead];
            ExitTicket storage ticket = exitTickets[ticketId];

            if (ticket.fulfilled) {
                exitQueueHead++;
                continue;
            }

            if (block.timestamp < ticket.unlockTimestamp) {
                break;
            }

            uint256 amountToFulfill = ticket.amount;

            if (liquidSQD >= amountToFulfill) {
                liquidSQD -= amountToFulfill;
                exitingBalances[ticket.owner] -= amountToFulfill;
                totalExitingSQD -= amountToFulfill;

                SQD.safeTransfer(ticket.owner, amountToFulfill);

                ticket.fulfilled = true;

                exitQueueHead++;
                processedCount++;

                emit ExitTicketFulfilled(ticketId, ticket.owner, amountToFulfill);
            } else {
                _checkAndUnstake();
                break;
            }
        }

        _checkMinimumThreshold();
    }

    function _checkAndUnstake() internal {
        uint256 liquidSQD = SQD.balanceOf(address(this));
        uint256 pendingExits = totalExitingSQD;

        if (pendingExits > liquidSQD) {
            uint256 deficit = pendingExits - liquidSQD;

            gatewayRegistry.adjustStake(-int256(deficit));

            emit StakeAdjustedInRegistry(-int256(deficit), gatewayRegistry.stakedAmount(address(this)));
        }
    }

    function _checkMinimumThreshold() internal {
        uint256 totalStake = totalActiveSQD + totalExitingSQD;

        if (totalStake < minimumSQD && state == State.Active) {
            state = State.Closed;
            emit Closed("Dropped below minimum threshold");

            uint256 registryStake = gatewayRegistry.stakedAmount(address(this));
            if (registryStake > 0) {
                gatewayRegistry.adjustStake(-int256(registryStake));
                emit StakeAdjustedInRegistry(-int256(registryStake), 0);
            }
        }
    }

    function refundOnFailure() external nonReentrant inState(State.Failed) {
        uint256 balance = activeBalances[msg.sender];
        if (balance == 0) revert Errors.NothingToClaim();

        activeBalances[msg.sender] = 0;
        totalActiveSQD -= balance;

        SQD.safeTransfer(msg.sender, balance);
    }

    function refundConsumerOnFailure() external onlyConsumer nonReentrant inState(State.Failed) {
        uint256 amount = paymentToken.balanceOf(address(this));
        if (amount == 0) revert Errors.NothingToClaim();

        paymentToken.safeTransfer(consumer, amount);
    }

    function getCurrentEpoch() public view returns (uint256) {
        return block.number / epochLength;
    }

    function getTicket(uint256 ticketId) external view returns (
        address owner,
        uint256 amount,
        uint64 unlockTimestamp,
        bool fulfilled
    ) {
        ExitTicket memory ticket = exitTickets[ticketId];
        return (ticket.owner, ticket.amount, ticket.unlockTimestamp, ticket.fulfilled);
    }

    function getExitQueueLength() external view returns (uint256) {
        return exitQueue.length - exitQueueHead;
    }
}
