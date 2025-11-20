// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockNetworkController {
    
    uint256 private _epochNumber;
    uint256 public workerEpochLength;
    uint256 public minStakeThreshold;
    address public workerRewardPool;
    
    constructor(
        uint256 _workerEpochLength,
        uint256 _minStakeThreshold,
        address _workerRewardPool
    ) {
        _epochNumber = 1;
        workerEpochLength = _workerEpochLength;
        minStakeThreshold = _minStakeThreshold;
        workerRewardPool = _workerRewardPool;
    }
    
    function epochNumber() external view returns (uint256) {
        return _epochNumber;
    }
    
    function incrementEpoch() external {
        _epochNumber++;
    }
    
    function setEpochNumber(uint256 epoch) external {
        _epochNumber = epoch;
    }
    
    function setWorkerEpochLength(uint256 length) external {
        workerEpochLength = length;
    }
    
    function setMinStakeThreshold(uint256 threshold) external {
        minStakeThreshold = threshold;
    }
    
    function setWorkerRewardPool(address pool) external {
        workerRewardPool = pool;
    }
}
