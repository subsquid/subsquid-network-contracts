// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import "./interfaces/INetworkController.sol";
import "./interfaces/IStaking.sol";
import "./interfaces/IWorkerRegistration.sol";

/**
 * @title Worker Registration Contract
 * @dev Worker registration and managing
 * - A single account can register multiple workers
 * - Worker becomes active and eligible for rewards only after the next epoch after registration has started
 * - Active worker can be deregistered
 * - After worker is deregistered, it becomes inactive only after the next epoch has started
 * - Worker bond can be withdrawn after the lock period has passed after the worker has been deregistered
 */
contract WorkerRegistration is AccessControl, IWorkerRegistration {
  using EnumerableSet for EnumerableSet.AddressSet;
  using EnumerableSet for EnumerableSet.UintSet;

  uint256 private workerIdTracker;

  struct Worker {
    address creator;
    bytes peerId;
    uint256 bond;
    uint128 registeredAt;
    uint128 deregisteredAt;
  }

  IERC20 public immutable tSQD;
  INetworkController public immutable networkController;
  IStaking public immutable staking;
  mapping(uint256 => Worker) public workers;
  mapping(bytes peerId => uint256 id) public workerIds;
  uint256[] public activeWorkerIds;
  mapping(address creator => EnumerableSet.UintSet) internal ownedWorkers;

  event WorkerRegistered(
    uint256 indexed workerId, bytes indexed peerId, address indexed registrar, uint256 registeredAt
  );
  event WorkerDeregistered(uint256 indexed workerId, address indexed account, uint256 deregistedAt);
  event WorkerWithdrawn(uint256 indexed workerId, address indexed account);
  event ExcessiveBondReturned(uint256 indexed workerId, uint256 amount);

  /**
   * @param _tSQD tSQD token.
   * @param _networkController The network controller contract.
   * @param _staking The staking contract.
   */
  constructor(IERC20 _tSQD, INetworkController _networkController, IStaking _staking) {
    _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
    tSQD = _tSQD;
    networkController = _networkController;
    staking = _staking;
  }

  /**
   * @dev Registers a worker.
   * @param peerId The unique peer ID of the worker.
   * @notice Peer ID is a unique identifier of the worker. It is expected to be a hex representation of the libp2p peer ID of the worker
   * @notice bondAmount of tSQD tokens will be transferred from the caller to this contract
   */
  function register(bytes calldata peerId) external {
    require(peerId.length <= 64, "Peer ID too large");
    require(workerIds[peerId] == 0, "Worker already registered");

    workerIdTracker++;
    uint256 workerId = workerIdTracker;
    uint256 _bondAmount = bondAmount();

    workers[workerId] =
      Worker({creator: msg.sender, peerId: peerId, bond: _bondAmount, registeredAt: nextEpoch(), deregisteredAt: 0});

    workerIds[peerId] = workerId;
    activeWorkerIds.push(workerId);
    ownedWorkers[msg.sender].add(workerId);

    tSQD.transferFrom(msg.sender, address(this), _bondAmount);
    emit WorkerRegistered(workerId, peerId, msg.sender, workers[workerId].registeredAt);
  }

  /**
   * @dev Deregisters a worker.
   * @param peerId The unique peer ID of the worker.
   * @notice Worker must be active
   * @notice Worker must be registered by the caller
   * @notice Worker becomes inactive after current epoch ends
   */
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

  /**
   * @dev Withdraws the bond of a worker.
   * @param peerId The unique peer ID of the worker.
   * @notice Worker must be inactive
   * @notice Worker must be registered by the caller
   * @notice Worker must be deregistered for at least lockPeriod
   */
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

  /**
   * @dev Returns the excessive bond of a worker.
   * In case bond has been reduced, the difference can be returned to the worker creator.
   * @param peerId The unique peer ID of the worker.
   * @notice Worker must be registered by the caller
   */
  function returnExcessiveBond(bytes calldata peerId) external {
    uint256 workerId = workerIds[peerId];
    require(workerId != 0, "Worker not registered");
    require(workers[workerId].creator == msg.sender, "Not worker creator");
    uint256 _bondAmount = bondAmount();

    uint256 excessiveBond = workers[workerId].bond - _bondAmount;
    workers[workerId].bond = _bondAmount;

    tSQD.transfer(msg.sender, excessiveBond);

    emit ExcessiveBondReturned(workerId, excessiveBond);
  }

  /// @dev Next epoch start block number.
  function nextEpoch() public view returns (uint128) {
    return networkController.nextEpoch();
  }

  /// @dev Returns the list of active workers.
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

  /// @dev Returns the list of active worker IDs.
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

  /// @dev Returns true if worker is active.
  function isWorkerActive(Worker storage worker) internal view returns (bool) {
    return worker.registeredAt <= block.number && (worker.deregisteredAt == 0 || worker.deregisteredAt >= block.number);
  }

  /// @dev Returns the number of active workers.
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

  /// @dev Returns the ids of all worker created by the owner account
  function getOwnedWorkers(address owner) external view returns (uint256[] memory) {
    return ownedWorkers[owner].values();
  }

  function getAllWorkersCount() external view returns (uint256) {
    return activeWorkerIds.length;
  }

  /// @dev Returns the effective TVL which is as sum of all worker bonds and
  /// tokens staked for active workers
  function effectiveTVL() external view returns (uint256) {
    return getActiveWorkerCount() * bondAmount() + activeStake();
  }

  function activeStake() public view returns (uint256) {
    return staking.activeStake(getActiveWorkerIds());
  }

  function bondAmount() public view returns (uint256) {
    return networkController.bondAmount();
  }

  function epochLength() public view returns (uint128) {
    return networkController.epochLength();
  }

  function lockPeriod() public view returns (uint128) {
    return networkController.epochLength();
  }
}
