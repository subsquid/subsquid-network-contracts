// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface INetworkController {
    function epochNumber() external view returns (uint256);
    function workerEpochLength() external view returns (uint256);
    function minStakeThreshold() external view returns (uint256);
    function workerRewardPool() external view returns (address);
}
