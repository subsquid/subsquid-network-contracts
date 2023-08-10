// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/Counters.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";

contract WorkerRegistration {
  using Counters for Counters.Counter;
  using SafeMath for uint256;

  uint256 public constant BOND_AMOUNT = 100000 * 10 ** 18;
  // uint256 public constant EPOCH_LENGTH = 20700; // approximately 72 hours in blocks
  // uint256 public constant LOCK_PERIOD = EPOCH_LENGTH;

  IERC20 public tSQD;
  uint256 public storagePerWorkerInGb = 1000;

  uint128 public immutable epochLength;
  uint128 public immutable lockPeriod;

  Counters.Counter private workerIdTracker;

  struct Worker {
    address creator;
    bytes peerId;
    uint256 bond;
    // the worker is registered at the start
    // of the next epoch, after register() is called
    uint128 registeredAt;
    // the worker is de-registered at the start of
    // the next epoch, after deregister() is called
    uint128 deregisteredAt;
  }

  mapping(uint256 => Worker) public workers;
  mapping(bytes peerId => uint256 id) public workerIds;
  mapping(address staker => mapping(uint256 workerId => uint256 amount)) public stakedAmounts;
  uint256[] public activeWorkerIds;
  uint256 public totalStaked;

  event WorkerRegistered(
    uint256 indexed workerId, bytes indexed peerId, address indexed registrar, uint256 registeredAt
  );
  event WorkerDeregistered(uint256 indexed workerId, address indexed account, uint256 deregistedAt);
  event WorkerWithdrawn(uint256 indexed workerId, address indexed account);
  event Delegated(uint256 indexed workerId, address indexed staker, uint256 amount);
  event Unstaked(uint256 indexed workerId, address indexed staker, uint256 amount);

  constructor(IERC20 _tSQD, uint128 _epochLengthBlocks) {
    tSQD = _tSQD;
    epochLength = _epochLengthBlocks;
    lockPeriod = _epochLengthBlocks;
  }

  function register(bytes calldata peerId) external {
    require(peerId.length <= 64, "Peer ID too large");
    require(workerIds[peerId] == 0, "Worker already registered");

    workerIdTracker.increment();
    uint256 workerId = workerIdTracker.current();

    workers[workerId] =
      Worker({creator: msg.sender, peerId: peerId, bond: BOND_AMOUNT, registeredAt: nextEpoch(), deregisteredAt: 0});

    workerIds[peerId] = workerId;
    activeWorkerIds.push(workerId);

    tSQD.transferFrom(msg.sender, address(this), BOND_AMOUNT);
    emit WorkerRegistered(workerId, peerId, msg.sender, workers[workerId].registeredAt);
  }

  function deregister(bytes calldata peerId) external {
    uint256 workerId = workerIds[peerId];
    require(workerId != 0, "Worker not registered");
    require(isWorkerActive(workers[workerId]), "Worker not active");
    require(workers[workerId].creator == msg.sender, "Not worker creator");

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

  function withdraw(bytes calldata peerId) external {
    uint256 workerId = workerIds[peerId];
    require(workerId != 0, "Worker not registered");
    Worker storage worker = workers[workerId];
    require(!isWorkerActive(worker), "Worker is active");
    require(worker.creator == msg.sender, "Not worker creator");
    require(block.number >= worker.deregisteredAt + lockPeriod, "Worker is locked");

    uint256 bond = worker.bond;
    delete workers[workerId];

    tSQD.transfer(msg.sender, bond);

    emit WorkerWithdrawn(workerId, msg.sender);
  }

  function delegate(address creator, bytes calldata peerId, uint256 amount) external {
    uint256 workerId = workerIds[peerId];
    require(workerId != 0, "Worker not registered");
    require(isWorkerActive(workers[workerId]), "Worker not active");

    tSQD.transferFrom(msg.sender, address(this), amount);
    stakedAmounts[msg.sender][workerId] += amount;
    totalStaked += amount;

    emit Delegated(workerId, msg.sender, amount);
  }

  function unstake(address creator, bytes calldata peerId, uint256 amount) external {
    uint256 workerId = workerIds[peerId];
    require(workerId != 0, "Worker not registered");

    uint256 stakedAmount = stakedAmounts[msg.sender][workerId];
    require(stakedAmount >= amount, "Insufficient staked amount");

    stakedAmounts[msg.sender][workerId] -= amount;
    totalStaked -= amount;
    tSQD.transfer(msg.sender, amount);

    emit Unstaked(workerId, msg.sender, amount);
  }

  function nextEpoch() public view returns (uint128) {
    return (uint128(block.number) / epochLength + 1) * epochLength;
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

  function effectiveTVL() external view returns (uint256) {
    return activeWorkerIds.length * BOND_AMOUNT + totalStaked;
  }
}
