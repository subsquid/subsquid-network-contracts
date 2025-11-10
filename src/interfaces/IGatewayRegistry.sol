// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IGatewayRegistry {
    struct Stake {
        uint256 amount;
        uint128 lockStart;
        uint128 lockEnd;
        uint128 duration;
        bool autoExtension;
        uint256 oldCUs;
    }

    function stake(uint256 amount, uint128 durationBlocks) external;
    function unstake() external;
    function addStake(uint256 amount) external;
    function getStake(address operator) external view returns (Stake memory);
    function canUnstake(address operator) external view returns (bool);
}
