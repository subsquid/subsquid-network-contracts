pragma solidity 0.8.28;

import "../../src/interfaces/INetworkController.sol";

contract MockNetworkController is INetworkController {
    uint256 public epochNumber = 1;
    uint256 public workerEpochLength;
    uint256 public minStakeThreshold;
    address public workerRewardPool;

    constructor(uint256 _workerEpochLength, uint256 _minStakeThreshold, address _workerRewardPool) {
        workerEpochLength = _workerEpochLength;
        minStakeThreshold = _minStakeThreshold;
        workerRewardPool = _workerRewardPool;
    }

    function setEpochNumber(uint256 _epochNumber) external {
        epochNumber = _epochNumber;
    }

    function setWorkerEpochLength(uint256 _length) external {
        workerEpochLength = _length;
    }

    function setMinStakeThreshold(uint256 _threshold) external {
        minStakeThreshold = _threshold;
    }

    function setWorkerRewardPool(address _pool) external {
        workerRewardPool = _pool;
    }
}
