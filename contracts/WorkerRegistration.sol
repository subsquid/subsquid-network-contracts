// SPDX-License-Identifier: MIT
pragma solidity ^0.8.16;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/Counters.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";


contract WorkerRegistration {
    using Counters for Counters.Counter;
    using SafeMath for uint256;

    uint256 public constant BOND_AMOUNT = 100000 * 10**18;
    // uint256 public constant EPOCH_LENGTH = 20700; // approximately 72 hours in blocks
    // uint256 public constant LOCK_PERIOD = EPOCH_LENGTH;


    IERC20 public tSQD;
    uint128 public immutable epochLength;
    uint128 public immutable lockPeriod;

    Counters.Counter private workerIdTracker;

    struct Worker {
        address creator;
        bytes32[2] peers;
        uint256 bond;
        // the worker is registered at the start
        // of the next epoch, after register() is called
        uint128 registeredAt;
        // the worker is de-registered at the start of
        // the next epoch, after deregister() is called
        uint128 deregisteredAt;
    }

    mapping(uint256 => Worker) public workers;
    mapping(address creator => mapping(bytes32 peerId => uint256 id)) public workerIds;
    uint256[] public activeWorkerIds;

    event WorkerRegistered(uint256 indexed workerId, bytes32 indexed peerId, address indexed registrar, bytes32 peer0, bytes32 peer1, uint256 registeredAt);
    event WorkerDeregistered(uint256 indexed workerId, address indexed account, uint256 deregistedAt);
    event WorkerWithdrawn(uint256 indexed workerId, address indexed account);

    constructor(IERC20 _tSQT, uint128 _epochLengthBlocks) {
        tSQD = _tSQT;
        epochLength = _epochLengthBlocks;
        lockPeriod = _epochLengthBlocks;
    }

    function register(bytes32[2] calldata peers) external {
        bytes32 peerId = getPeerId(peers);
        require(workerIds[msg.sender][peerId] == 0, "Worker already registered");

        workerIdTracker.increment();
        uint256 workerId = workerIdTracker.current();

        workers[workerId] = Worker({
            creator: msg.sender,
            peers: peers,
            bond: BOND_AMOUNT,
            registeredAt: nextEpoch(),
            deregisteredAt: 0
        });

        workerIds[msg.sender][peerId] = workerId;
        activeWorkerIds.push(workerId);

        tSQD.transferFrom(msg.sender, address(this), BOND_AMOUNT);
        emit WorkerRegistered(workerId, peerId, msg.sender, peers[0], peers[1], workers[workerId].registeredAt);
    }

    function deregister(bytes32[2] calldata peers) external {
        uint256 workerId = workerIds[msg.sender][getPeerId(peers)];
        require(workerId != 0, "Worker not registered");
        require(isWorkerActive(workers[workerId]), "Worker not active");

        workers[workerId].deregisteredAt = nextEpoch();

        // Remove the workerId from the activeWorkerIds array
        for (uint256 i = 0; i < activeWorkerIds.length; i++) {
            if (activeWorkerIds[i] == workerId) {
                activeWorkerIds[i] = activeWorkerIds[activeWorkerIds.length - 1];
                activeWorkerIds.pop();
                break;
            }
        }

        emit WorkerDeregistered(workerId, msg.sender, workers[workerId].deregisteredAt);
    }

    function withdraw(bytes32[2] calldata peers) external {
        bytes32 peerId = getPeerId(peers);
        uint256 workerId = workerIds[msg.sender][peerId];
        require(workerId != 0, "Worker not registered");
        Worker storage worker = workers[workerId];
        require(!isWorkerActive(worker), "Worker is active");
        require(block.number >= worker.deregisteredAt + lockPeriod, "Worker is locked");

        uint256 bond = worker.bond;
        delete workers[workerId];
        delete workerIds[msg.sender][peerId];

        tSQD.transfer(msg.sender, bond);

        emit WorkerWithdrawn(workerId, msg.sender);
    }

    function nextEpoch() internal view returns (uint128) {
        return (uint128(block.number) / epochLength + 1) * epochLength;
    }

    function getPeerId(bytes32[2] calldata peerId) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(peerId[0], peerId[1]));
    }

    function getActiveWorkers() external view returns (Worker[] memory) {
        Worker[] memory activeWorkers = new Worker[](getActiveWorkerCount());

        uint256 activeIndex = 0;
        for (uint256 i = 0; i < activeWorkerIds.length; i++) {
            uint256 workerId = activeWorkerIds[i];
            Worker storage worker = workers[workerId];
            if (isWorkerActive(worker)) {
                activeWorkers[activeIndex] = worker;
                activeIndex++;
            }
        }

        return activeWorkers;
    }

    function isWorkerActive(Worker storage worker) internal view returns (bool) {
        return worker.registeredAt <= block.number && (worker.deregisteredAt == 0 || worker.deregisteredAt >= block.number);
    }

    function getActiveWorkerCount() public view returns (uint256) {
        uint256 activeCount = 0;
        for (uint256 i = 0; i < activeWorkerIds.length; i++) {
            uint256 workerId = activeWorkerIds[i];
            Worker storage worker = workers[workerId];
            if (isWorkerActive(worker)) {
                activeCount++;
            }
        }
        return activeCount;
    }

    function getWorkerByIndex(uint256 index) external view returns (Worker memory) {
        require(index < activeWorkerIds.length, "Index out of bounds");
        uint256 workerId = activeWorkerIds[index];
        return workers[workerId];
    }

    function getAllWorkersCount() external view returns (uint256) {
        return activeWorkerIds.length;
    }
}
