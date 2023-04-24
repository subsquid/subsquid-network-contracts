// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/Counters.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "hardhat/console.sol";


contract WorkerRegistration is ReentrancyGuard {
    using Counters for Counters.Counter;
    using SafeMath for uint256;

    uint256 public constant BOND_AMOUNT = 100000 * 10**18;
    // uint256 public constant EPOCH_LENGTH = 20700; // approximately 72 hours in blocks
    // uint256 public constant LOCK_PERIOD = EPOCH_LENGTH;
    

    IERC20 public tSQD;
    uint256 public epochLength;
    uint256 public lockPeriod;
    uint256 public bondAmount;

    Counters.Counter private workerIdTracker;

    struct Worker {
        address account;
        bytes32[2] peerId;
        uint256 bond;
        // the worker is registered at the start
        // of the next epoch, after register() is called
        uint256 registeredAt;
        // the worker is de-registered at the start of 
        // the next epoch, after deregister() is called
        uint256 deregisteredAt;
    }

    mapping(uint256 => Worker) public workers;
    mapping(address => uint256) public workerIds;
    uint256[] public activeWorkerIds;

    event WorkerRegistered(uint256 indexed workerId, address indexed account, bytes32 peerId0, bytes32 peerId1, uint256 registeredAt);
    event WorkerDeregistered(uint256 indexed workerId, address indexed account, uint256 deregistedAt);
    event WorkerWithdrawn(uint256 indexed workerId, address indexed account);

    constructor(IERC20 _tSQT, uint256 _epochLengthBlocks) {
        tSQD = _tSQT;
        epochLength = _epochLengthBlocks;
        lockPeriod = epochLength;
    }

    function register(bytes32[2] calldata peerId) external nonReentrant {
        require(workerIds[msg.sender] == 0, "Worker already registered");

        tSQD.transferFrom(msg.sender, address(this), BOND_AMOUNT);
        workerIdTracker.increment();
        uint256 workerId = workerIdTracker.current();
         
        workers[workerId] = Worker({
            account: msg.sender,
            peerId: peerId,
            bond: BOND_AMOUNT,
            registeredAt: (block.number / epochLength + 1) * epochLength,
            deregisteredAt: 0
        });

        workerIds[msg.sender] = workerId;
        activeWorkerIds.push(workerId);
        console.log("contract: registered");
        emit WorkerRegistered(workerId, msg.sender, peerId[0], peerId[1], workers[workerId].registeredAt);
        console.log("contract: emitted");
    }

    function deregister() external nonReentrant {
        uint256 workerId = workerIds[msg.sender];
        require(workerId != 0, "Worker not registered");
        require(isWorkerActive(workers[workerId]), "Worker not active");

        workers[workerId].deregisteredAt = (block.number / epochLength + 1) * epochLength;

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

    function withdraw() external nonReentrant {
        uint256 workerId = workerIds[msg.sender];
        require(workerId != 0, "Worker not registered");
        require(!isWorkerActive(workers[workerId]), "Worker is active");
        require(block.number >= workers[workerId].deregisteredAt + lockPeriod, "Worker is locked");

        uint256 bond = workers[workerId].bond;
        delete workers[workerId];
        delete workerIds[msg.sender];

        tSQD.transfer(msg.sender, bond);

        emit WorkerWithdrawn(workerId, msg.sender);
    }

    function getActiveWorkers() external view returns (Worker[] memory) {
        uint256 activeCount = 0;
        for (uint256 i = 0; i < activeWorkerIds.length; i++) {
            uint256 workerId = activeWorkerIds[i];
            Worker storage worker = workers[workerId];
            if (isWorkerActive(worker)) {
                activeCount++;
            }
        }

        Worker[] memory activeWorkers = new Worker[](activeCount);
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

    function getActiveWorkerCount() external view returns (uint256) {
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
        Worker storage worker = workers[workerId];
        return worker;
    }

    function getAllWorkersCount() external view returns (uint256) { 
        return activeWorkerIds.length;
    }
}
