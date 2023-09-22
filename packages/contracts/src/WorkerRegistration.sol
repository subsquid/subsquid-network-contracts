// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/Counters.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import "./interfaces/INetworkController.sol";
import "./Staking.sol";

contract WorkerRegistration is AccessControl {
  using Counters for Counters.Counter;
  using EnumerableSet for EnumerableSet.AddressSet;
  using EnumerableSet for EnumerableSet.UintSet;

  IERC20 public tSQD;
  uint256 public storagePerWorkerInGb = 1000;

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

  INetworkController public networkController;
  Staking public staking;
  mapping(uint256 => Worker) public workers;
  mapping(bytes peerId => uint256 id) public workerIds;
  mapping(address staker => mapping(uint256 workerId => uint256 amount)) public stakedAmounts;
  mapping(uint256 workerId => uint256 amount) public stakedAmountsPerWorker;
  uint256[] public activeWorkerIds;
  mapping(address creator => EnumerableSet.UintSet) ownedWorkers;
  uint256 public totalStaked;

  event WorkerRegistered(
    uint256 indexed workerId, bytes indexed peerId, address indexed registrar, uint256 registeredAt
  );
  event WorkerDeregistered(uint256 indexed workerId, address indexed account, uint256 deregistedAt);
  event WorkerWithdrawn(uint256 indexed workerId, address indexed account);

  constructor(IERC20 _tSQD, INetworkController _networkController, Staking _staking) {
    _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
    tSQD = _tSQD;
    networkController = _networkController;
    staking = _staking;
  }

  function register(bytes calldata peerId) external {
    require(peerId.length <= 64, "Peer ID too large");
    require(workerIds[peerId] == 0, "Worker already registered");

    workerIdTracker.increment();
    uint256 workerId = workerIdTracker.current();
    uint256 _bondAmount = bondAmount();

    workers[workerId] =
      Worker({creator: msg.sender, peerId: peerId, bond: _bondAmount, registeredAt: nextEpoch(), deregisteredAt: 0});

    workerIds[peerId] = workerId;
    activeWorkerIds.push(workerId);
    ownedWorkers[msg.sender].add(workerId);

    tSQD.transferFrom(msg.sender, address(this), _bondAmount);
    emit WorkerRegistered(workerId, peerId, msg.sender, workers[workerId].registeredAt);
  }

  function deregister(bytes calldata peerId) external {
    uint256 workerId = workerIds[peerId];
    require(workerId != 0, "Worker not registered");
    require(isWorkerActive(workers[workerId]), "Worker not active");
    require(workers[workerId].creator == msg.sender, "Not worker creator");

    workers[workerId].deregisteredAt = nextEpoch();

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
    require(block.number >= worker.deregisteredAt + lockPeriod(), "Worker is locked");

    uint256 bond = worker.bond;
    delete workers[workerId];

    tSQD.transfer(msg.sender, bond);

    emit WorkerWithdrawn(workerId, msg.sender);
  }

  function returnExcessiveBond(bytes calldata peerId) external {
    uint256 workerId = workerIds[peerId];
    require(workerId != 0, "Worker not registered");
    uint256 _bondAmount = bondAmount();

    uint256 excessiveBond = workers[workerId].bond - _bondAmount;
    workers[workerId].bond = _bondAmount;

    tSQD.transfer(msg.sender, excessiveBond);
  }

  function nextEpoch() public view returns (uint128) {
    return networkController.nextEpoch();
  }

  function getActiveWorkers() public view returns (Worker[] memory) {
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

  function getActiveWorkerIds() public view returns (uint256[] memory) {
    uint256[] memory activeWorkers = new uint[](getActiveWorkerCount());

    uint256 activeIndex = 0;
    for (uint256 i = 0; i < activeWorkerIds.length; i++) {
      uint256 workerId = activeWorkerIds[i];
      Worker storage worker = workers[workerId];
      if (isWorkerActive(worker)) {
        activeWorkers[activeIndex] = workerId;
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

  function getOwnedWorkers(address owner) external view returns (uint256[] memory) {
    return ownedWorkers[owner].values();
  }

  function getAllWorkersCount() external view returns (uint256) {
    return activeWorkerIds.length;
  }

  function effectiveTVL() external view returns (uint256) {
    return getActiveWorkerCount() * bondAmount() + activeStake();
  }

  function activeStake() public view returns (uint256) {
    return staking.activeStake(getActiveWorkerIds());
  }

  function bondAmount() public view returns (uint256) {
    return networkController.bondAmount();
  }

  // Left for backwards compatibility, to be removed later
  function BOND_AMOUNT() external view returns (uint256) {
    return networkController.bondAmount();
  }

  function epochLength() public view returns (uint128) {
    return networkController.epochLength();
  }

  function lockPeriod() public view returns (uint128) {
    return networkController.epochLength();
  }
}
