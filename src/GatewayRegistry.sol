// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Errors} from "./libs/Errors.sol";

contract GatewayRegistry is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum StakerType {
        None,
        Individual,
        Portal
    }

    struct Stake {
        StakerType stakerType;
        uint256 amount;
        uint128 lockEndBlock;
        uint128 lastAdjustmentBlock;
        uint256 durationBlocks;
    }

    uint256 public constant MIN_STAKE_AMOUNT = 1_000_000 * 1e18;
    uint256 public constant INDIVIDUAL_LOCK_DURATION_BLOCKS = 50400;
    uint256 public constant MANA_PER_SQD = 1000;
    uint256 public constant BASIS_POINT_MULTIPLIER = 10000;

    IERC20 public immutable SQD;
    address public portalFactory;
    uint256 public averageBlockTime;
    uint256 public workerEpochLength;

    mapping(address => Stake) public stakes;

    event Staked(address indexed operator, StakerType indexed stakerType, uint256 amount, uint128 lockEndBlock);
    event Unstaked(address indexed operator, uint256 amount);
    event StakeAdjusted(address indexed portal, int256 delta, uint256 newAmount);
    event PortalFactoryUpdated(address indexed oldFactory, address indexed newFactory);

    modifier onlyPortal() {
        if (stakes[msg.sender].stakerType != StakerType.Portal) revert Errors.InvalidCaller();
        _;
    }

    modifier onlyFactory() {
        if (msg.sender != portalFactory) revert Errors.NotFactory();
        _;
    }

    constructor(address _sqdToken, address _portalFactory) Ownable(msg.sender) {
        if (_sqdToken == address(0)) revert Errors.ZeroAddress();
        if (_portalFactory == address(0)) revert Errors.ZeroAddress();

        SQD = IERC20(_sqdToken);
        portalFactory = _portalFactory;
        averageBlockTime = 12;
        workerEpochLength = 7200;
    }

    function stake(uint256 amount) external nonReentrant {
        if (stakes[msg.sender].amount > 0) revert Errors.StakeAlreadyExists();
        if (amount < MIN_STAKE_AMOUNT) revert Errors.BelowMinimumDeposit();

        uint128 lockEnd = uint128(block.number) + uint128(INDIVIDUAL_LOCK_DURATION_BLOCKS);

        stakes[msg.sender] = Stake({
            stakerType: StakerType.Individual,
            amount: amount,
            lockEndBlock: lockEnd,
            lastAdjustmentBlock: uint128(block.number),
            durationBlocks: uint256(INDIVIDUAL_LOCK_DURATION_BLOCKS)
        });

        SQD.safeTransferFrom(msg.sender, address(this), amount);

        emit Staked(msg.sender, StakerType.Individual, amount, lockEnd);
    }

    function unstake() external nonReentrant {
        Stake memory userStake = stakes[msg.sender];

        if (userStake.stakerType != StakerType.Individual) revert Errors.InvalidCaller();
        if (userStake.amount == 0) revert Errors.NothingToUnstake();
        if (userStake.lockEndBlock > block.number) revert Errors.StakeIsLocked();

        uint256 amount = userStake.amount;
        delete stakes[msg.sender];

        SQD.safeTransfer(msg.sender, amount);

        emit Unstaked(msg.sender, amount);
    }

    function registerPortal(address portalAddress) external onlyFactory {
        if (portalAddress == address(0)) revert Errors.ZeroAddress();
        if (stakes[portalAddress].stakerType != StakerType.None) revert Errors.AlreadyInitialized();

        stakes[portalAddress] = Stake({
            stakerType: StakerType.Portal,
            amount: 0,
            lockEndBlock: 0,
            lastAdjustmentBlock: uint128(block.number),
            durationBlocks: 0
        });

        emit Staked(portalAddress, StakerType.Portal, 0, 0);
    }

    function adjustStake(int256 amountDelta) external nonReentrant onlyPortal {
        Stake storage portalStake = stakes[msg.sender];
        uint256 oldAmount = portalStake.amount;

        uint256 newAmount;
        if (amountDelta >= 0) {
            newAmount = oldAmount + uint256(amountDelta);
        } else {
            uint256 decrease = uint256(-amountDelta);
            if (decrease > oldAmount) revert Errors.InsufficientBalance();
            newAmount = oldAmount - decrease;
        }

        if (newAmount > 0 && newAmount < MIN_STAKE_AMOUNT) {
            revert Errors.BelowMinimumDeposit();
        }

        uint128 blocksStaked = uint128(block.number) - portalStake.lastAdjustmentBlock;
        if (blocksStaked > 0 && portalStake.amount > 0) {
            uint256 weightedDuration =
                (portalStake.durationBlocks * portalStake.amount + uint256(blocksStaked) * oldAmount)
                / (portalStake.amount > 0 ? portalStake.amount : 1);
            portalStake.durationBlocks = weightedDuration;
        }

        portalStake.amount = newAmount;
        portalStake.lastAdjustmentBlock = uint128(block.number);

        if (amountDelta > 0) {
            SQD.safeTransferFrom(msg.sender, address(this), uint256(amountDelta));
        } else if (amountDelta < 0) {
            SQD.safeTransfer(msg.sender, uint256(-amountDelta));
        }

        emit StakeAdjusted(msg.sender, amountDelta, newAmount);
    }

    function getStake(address operator) external view returns (Stake memory) {
        return stakes[operator];
    }

    function computationUnitsAvailable(address operator) external view returns (uint256) {
        Stake memory _stake = stakes[operator];

        if (_stake.amount == 0) return 0;

        if (_stake.stakerType == StakerType.Individual) {
            if (_stake.lockEndBlock <= block.number) return 0;

            uint256 totalCUs = computationUnitsAmount(_stake.amount, _stake.durationBlocks);

            if (_stake.durationBlocks <= workerEpochLength) {
                return totalCUs;
            }

            return totalCUs * workerEpochLength / _stake.durationBlocks;
        }

        if (_stake.stakerType == StakerType.Portal) {
            uint256 blocksStaked = block.number - _stake.lastAdjustmentBlock;
            uint256 effectiveDuration = blocksStaked > 0 ? blocksStaked : workerEpochLength;

            uint256 totalCUs = computationUnitsAmount(_stake.amount, effectiveDuration);

            if (effectiveDuration <= workerEpochLength) {
                return totalCUs;
            }

            return totalCUs * workerEpochLength / effectiveDuration;
        }

        return 0;
    }

    function computationUnitsAmount(uint256 amount, uint256 durationBlocks) public view returns (uint256) {
        uint256 durationSeconds = durationBlocks * averageBlockTime;
        uint256 boostFactor = calculateBoostFactor(durationSeconds);

        return amount * durationBlocks * MANA_PER_SQD * boostFactor
            / (BASIS_POINT_MULTIPLIER * 1e18 * 1000);
    }

    function calculateBoostFactor(uint256 durationSeconds) public pure returns (uint256) {
        if (durationSeconds < 30 days) return 10000;
        if (durationSeconds < 90 days) return 10500;
        if (durationSeconds < 180 days) return 11000;
        if (durationSeconds < 360 days) return 12000;
        return 15000;
    }

    function canUnstake(address operator) external view returns (bool) {
        Stake memory userStake = stakes[operator];
        if (userStake.stakerType != StakerType.Individual) return false;
        if (userStake.amount == 0) return false;
        return userStake.lockEndBlock <= block.number;
    }

    function isPortal(address operator) external view returns (bool) {
        return stakes[operator].stakerType == StakerType.Portal;
    }

    function stakedAmount(address operator) external view returns (uint256) {
        return stakes[operator].amount;
    }

    function setPortalFactory(address newFactory) external onlyOwner {
        if (newFactory == address(0)) revert Errors.ZeroAddress();

        address oldFactory = portalFactory;
        portalFactory = newFactory;

        emit PortalFactoryUpdated(oldFactory, newFactory);
    }

    function setAverageBlockTime(uint256 _newAverageBlockTime) external onlyOwner {
        averageBlockTime = _newAverageBlockTime;
    }

    function setWorkerEpochLength(uint256 _newWorkerEpochLength) external onlyOwner {
        workerEpochLength = _newWorkerEpochLength;
    }
}
