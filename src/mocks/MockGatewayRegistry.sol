// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IGatewayRegistry} from "../interfaces/IGatewayRegistry.sol";
import {Errors} from "../libs/Errors.sol";

contract MockGatewayRegistry is IGatewayRegistry {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    mapping(address => Stake) public stakes;

    uint256 public constant MIN_STAKE = 10_000e18;
    uint256 public constant AVERAGE_BLOCK_TIME = 12;
    uint256 public constant MANA = 10;
    uint256 public constant MAX_GATEWAYS_PER_CLUSTER = 10;
    uint256 public epochLength = 7200;

    constructor(address _token) {
        token = IERC20(_token);
    }

    function minStake() external pure returns (uint256) {
        return MIN_STAKE;
    }

    function averageBlockTime() external pure returns (uint256) {
        return AVERAGE_BLOCK_TIME;
    }

    function mana() external pure returns (uint256) {
        return MANA;
    }

    function maxGatewaysPerCluster() external pure returns (uint256) {
        return MAX_GATEWAYS_PER_CLUSTER;
    }

    function stake(uint256 amount, uint128 durationBlocks) external override {
        if (stakes[msg.sender].amount > 0) revert Errors.StakeAlreadyExists();
        if (amount == 0) revert Errors.ZeroAmount();
        if (amount < MIN_STAKE) revert Errors.BelowMinimumDeposit();
        if (durationBlocks < epochLength) revert Errors.DurationTooShort();

        uint128 lockStart = uint128(block.number);
        uint128 lockEnd = lockStart + durationBlocks;

        stakes[msg.sender] = Stake({
            amount: amount,
            lockStart: lockStart,
            lockEnd: lockEnd,
            duration: durationBlocks,
            autoExtension: false,
            oldCUs: 0
        });

        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    function unstake() external override {
        Stake memory userStake = stakes[msg.sender];
        if (userStake.amount == 0) revert Errors.NothingToUnstake();
        if (userStake.lockEnd > block.number) revert Errors.StakeIsLocked();

        uint256 amount = userStake.amount;
        delete stakes[msg.sender];

        token.safeTransfer(msg.sender, amount);
    }

    function addStake(uint256 amount) external override {
        Stake storage userStake = stakes[msg.sender];
        if (userStake.amount == 0) revert Errors.NoExistingStake();

        userStake.amount += amount;
        userStake.lockStart = uint128(block.number);
        userStake.lockEnd = userStake.lockStart + userStake.duration;

        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    function getStake(address operator) external view override returns (Stake memory) {
        return stakes[operator];
    }

    function canUnstake(address operator) external view override returns (bool) {
        return stakes[operator].lockEnd < block.number + 1;
    }

    function setEpochLength(uint256 _epochLength) external {
        epochLength = _epochLength;
    }
}
