// SPDX-License-Identifier: MIT
pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/Counters.sol";

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

interface ILegacyWorkerRegistration {
  function tSQD() external view returns (IERC20);
  function epochLength() external view returns (uint128);
  function lockPeriod() external view returns (uint128);
  function workerIds(address creator, bytes memory peerId) external view returns (uint256);
  function workers(uint256 id) external view returns (address, bytes memory, uint256, uint128, uint128);
  function getAllWorkersCount() external view returns (uint256);
  function getActiveWorkerCount() external view returns (uint256);
  function getActiveWorkers() external view returns (Worker[] memory);
  function nextEpoch() external view returns (uint128);
  function getWorkerByIndex(uint256 index) external view returns (Worker memory);
  function activeWorkerIds(uint256 index) external view returns (uint256);
}

contract WorkerRegistrationFacade {
  uint256 public constant BOND_AMOUNT = 100000 * 10 ** 18;
  // uint256 public constant EPOCH_LENGTH = 20700; // approximately 72 hours in blocks
  // uint256 public constant LOCK_PERIOD = EPOCH_LENGTH;

  IERC20 public tSQD;
  uint256 public storagePerWorkerInGb = 1000;

  uint128 public immutable epochLength;
  uint128 public immutable lockPeriod;

  mapping(address staker => mapping(uint256 workerId => uint256 amount)) public stakedAmounts;
  mapping(uint256 workerId => uint256 amount) public stakedAmountsPerWorker;
  uint256 public totalStaked;
  ILegacyWorkerRegistration public legacyWorker;

  event WorkerRegistered(
    uint256 indexed workerId, bytes indexed peerId, address indexed registrar, uint256 registeredAt
  );
  event WorkerDeregistered(uint256 indexed workerId, address indexed account, uint256 deregistedAt);
  event WorkerWithdrawn(uint256 indexed workerId, address indexed account);
  event Delegated(uint256 indexed workerId, address indexed staker, uint256 amount);
  event Unstaked(uint256 indexed workerId, address indexed staker, uint256 amount);

  constructor(ILegacyWorkerRegistration _legacyWorker) {
    legacyWorker = _legacyWorker;
    tSQD = _legacyWorker.tSQD();
    epochLength = _legacyWorker.epochLength();
    lockPeriod = _legacyWorker.lockPeriod();
  }

  function getWorkerId(bytes calldata peerId) public view returns (uint256) {
    uint256 workersCount = legacyWorker.getAllWorkersCount();
    for (uint256 i = 0; i < workersCount; i++) {
      Worker memory worker = workers(i);
      if (keccak256(worker.peerId) == keccak256(peerId)) {
        return i;
      }
    }
    return 0;
  }

  function workers(uint256 i) public view returns (Worker memory) {
    (address creator, bytes memory peerId, uint256 a, uint128 b, uint128 c) = legacyWorker.workers(i);
    return Worker(creator, peerId, a, b, c);
  }

  function delegate(bytes calldata peerId, uint256 amount) external {
    uint256 workerId = getWorkerId(peerId);
    require(workerId != 0, "Worker not registered");

    tSQD.transferFrom(msg.sender, address(this), amount);
    stakedAmounts[msg.sender][workerId] += amount;
    totalStaked += amount;
    stakedAmountsPerWorker[workerId] += amount;

    emit Delegated(workerId, msg.sender, amount);
  }

  function unstake(bytes calldata peerId, uint256 amount) external {
    uint256 workerId = getWorkerId(peerId);
    require(workerId != 0, "Worker not registered");

    uint256 stakedAmount = stakedAmounts[msg.sender][workerId];
    require(stakedAmount >= amount, "Insufficient staked amount");

    stakedAmounts[msg.sender][workerId] -= amount;
    totalStaked -= amount;
    stakedAmountsPerWorker[workerId] -= amount;
    tSQD.transfer(msg.sender, amount);

    emit Unstaked(workerId, msg.sender, amount);
  }

  function nextEpoch() public view returns (uint128) {
    return legacyWorker.nextEpoch();
  }

  function getActiveWorkers() public view returns (Worker[] memory) {
    return legacyWorker.getActiveWorkers();
  }

  function getActiveWorkerCount() public view returns (uint256) {
    return legacyWorker.getActiveWorkerCount();
  }

  function getWorkerByIndex(uint256 index) external view returns (Worker memory) {
    return legacyWorker.getWorkerByIndex(index);
  }

  function getAllWorkersCount() external view returns (uint256) {
    return legacyWorker.getAllWorkersCount();
  }

  function effectiveTVL() external view returns (uint256) {
    return legacyWorker.getActiveWorkerCount() * BOND_AMOUNT + activeStake();
  }

  function isWorkerActive(Worker memory worker) internal view returns (bool) {
    return worker.registeredAt <= block.number && (worker.deregisteredAt == 0 || worker.deregisteredAt >= block.number);
  }

  function activeStake() public view returns (uint256) {
    uint256 stake = 0;
    uint256 count = legacyWorker.getActiveWorkerCount();
    for (uint256 i = 0; i < count; i++) {
      uint256 workerId = legacyWorker.activeWorkerIds(i);
      Worker memory worker = workers(workerId);
      if (isWorkerActive(worker)) {
        stake += stakedAmountsPerWorker[workerId];
      }
    }

    return stake;
  }
}
