// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import "./interfaces/INetworkController.sol";
import "./interfaces/IStaking.sol";
import "./interfaces/IWorkerRegistration.sol";
import "./interfaces/IRouter.sol";
import "./AccessControlledPausable.sol";

/**
 * @title Worker Registration Contract
 * @dev Worker registration and managing
 * - A single account can register multiple workers
 * - Worker becomes active and eligible for rewards only after the next epoch after registration has started
 * - Active worker can be deregistered
 * - After worker is deregistered, it becomes inactive only after the next epoch has started
 * - Worker bond can be withdrawn after the lock period has passed after the worker has been deregistered
 */
contract WorkerRegistration is AccessControlledPausable, IWorkerRegistration {
  using EnumerableSet for EnumerableSet.AddressSet;
  using EnumerableSet for EnumerableSet.UintSet;

  uint256 private workerIdTracker;

  struct Worker {
    address creator;
    bytes peerId;
    uint256 bond;
    uint128 registeredAt;
    uint128 deregisteredAt;
    string metadata;
  }

  IERC20 public immutable SQD;
  IRouter public immutable router;
  mapping(uint256 => Worker) public workers;
  mapping(bytes peerId => uint256 id) public workerIds;
  EnumerableSet.UintSet activeWorkerIds;
  mapping(address creator => EnumerableSet.UintSet) internal ownedWorkers;

  /**
   * @param _SQD SQD token.
   * @param _router Countract router
   */
  constructor(IERC20 _SQD, IRouter _router) {
    SQD = _SQD;
    router = _router;
  }

  function register(bytes calldata peerId) external {
    register(peerId, "");
  }

  /**
   * @dev Registers a worker.
   * @param peerId The unique peer ID of the worker.
   * @notice Peer ID is a unique identifier of the worker. It is expected to be a hex representation of the libp2p peer ID of the worker
   * @notice bondAmount of SQD tokens will be transferred from the caller to this contract
   */
  function register(bytes calldata peerId, string memory metadata) public whenNotPaused {
    require(peerId.length <= 64, "Peer ID too large");
    uint256 workerId;
    if (workerIds[peerId] != 0) {
      require(workers[workerIds[peerId]].registeredAt == 0, "Worker already exists");
      require(ownedWorkers[msg.sender].contains(workerIds[peerId]), "Worker already registered by different account");
      workerId = workerIds[peerId];
    } else {
      workerIdTracker++;
      workerId = workerIdTracker;
    }
    uint256 _bondAmount = bondAmount();

    workers[workerId] = Worker({
      creator: msg.sender,
      peerId: peerId,
      bond: _bondAmount,
      registeredAt: nextEpoch(),
      deregisteredAt: 0,
      metadata: metadata
    });

    workerIds[peerId] = workerId;
    activeWorkerIds.add(workerId);
    ownedWorkers[msg.sender].add(workerId);

    SQD.transferFrom(msg.sender, address(this), _bondAmount);
    emit WorkerRegistered(workerId, peerId, msg.sender, workers[workerId].registeredAt, metadata);
  }

  /**
   * @dev Deregisters a worker.
   * @param peerId The unique peer ID of the worker.
   * @notice Worker must be active
   * @notice Worker must be registered by the caller
   * @notice Worker becomes inactive after current epoch ends
   */
  function deregister(bytes calldata peerId) external whenNotPaused {
    uint256 workerId = workerIds[peerId];
    require(workerId != 0, "Worker not registered");
    require(isWorkerActive(workers[workerId]), "Worker not active");
    require(workers[workerId].creator == msg.sender, "Not worker creator");

    workers[workerId].deregisteredAt = nextEpoch();

    emit WorkerDeregistered(workerId, msg.sender, workers[workerId].deregisteredAt);
  }

  /**
   * @dev Withdraws the bond of a worker.
   * @param peerId The unique peer ID of the worker.
   * @notice Worker must be inactive
   * @notice Worker must be registered by the caller
   * @notice Worker must be deregistered for at least lockPeriod
   */
  function withdraw(bytes calldata peerId) external whenNotPaused {
    uint256 workerId = workerIds[peerId];
    require(workerId != 0, "Worker not registered");
    Worker storage worker = workers[workerId];
    require(!isWorkerActive(worker), "Worker is active");
    require(worker.creator == msg.sender, "Not worker creator");
    require(worker.deregisteredAt > 0 && block.number >= worker.deregisteredAt + lockPeriod(), "Worker is locked");

    activeWorkerIds.remove(workerId);

    uint256 bond = worker.bond;
    delete workers[workerId];

    SQD.transfer(msg.sender, bond);

    emit WorkerWithdrawn(workerId, msg.sender);
  }

  function updateMetadata(bytes calldata peerId, string memory metadata) external whenNotPaused {
    uint256 workerId = workerIds[peerId];
    require(workers[workerId].creator == msg.sender, "Not worker creator");
    workers[workerId].metadata = metadata;

    emit MetadataUpdated(workerId, metadata);
  }

  /**
   * @dev Returns the excessive bond of a worker.
   * In case bond has been reduced, the difference can be returned to the worker creator.
   * @param peerId The unique peer ID of the worker.
   * @notice Worker must be registered by the caller
   */
  function returnExcessiveBond(bytes calldata peerId) external whenNotPaused {
    uint256 workerId = workerIds[peerId];
    require(workerId != 0, "Worker not registered");
    require(workers[workerId].creator == msg.sender, "Not worker creator");
    uint256 _bondAmount = bondAmount();

    uint256 excessiveBond = workers[workerId].bond - _bondAmount;
    workers[workerId].bond = _bondAmount;

    SQD.transfer(msg.sender, excessiveBond);

    emit ExcessiveBondReturned(workerId, excessiveBond);
  }

  /// @dev Next epoch start block number.
  function nextEpoch() public view returns (uint128) {
    return router.networkController().nextEpoch();
  }

  /// @dev Returns the list of active workers.
  function getActiveWorkers() external view returns (Worker[] memory) {
    Worker[] memory activeWorkers = new Worker[](getActiveWorkerCount());
    uint256[] memory _activeWorkerIds = activeWorkerIds.values();

    uint256 activeIndex = 0;
    for (uint256 i = 0; i < _activeWorkerIds.length; i++) {
      uint256 workerId = _activeWorkerIds[i];
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
    uint256[] memory activeWorkers = new uint256[](getActiveWorkerCount());
    uint256[] memory _activeWorkerIds = activeWorkerIds.values();

    uint256 activeIndex = 0;
    for (uint256 i = 0; i < _activeWorkerIds.length; i++) {
      uint256 workerId = _activeWorkerIds[i];
      Worker storage worker = workers[workerId];
      if (isWorkerActive(worker)) {
        activeWorkers[activeIndex] = workerId;
        activeIndex++;
      }
    }

    return activeWorkers;
  }

  function isWorkerActive(uint256 workerId) external view returns (bool) {
    return isWorkerActive(workers[workerId]);
  }

  /// @dev Returns true if worker is active.
  /// @notice Worker is considered active if it has been registered and not deregistered yet
  function isWorkerActive(Worker storage worker) internal view returns (bool) {
    return worker.registeredAt > 0 && worker.registeredAt <= block.number
      && (worker.deregisteredAt == 0 || worker.deregisteredAt > block.number);
  }

  /// @dev Returns the number of active workers.
  /// @notice Worker is considered active if it has been registered and not deregistered yet
  function getActiveWorkerCount() public view returns (uint256) {
    uint256 activeCount = 0;
    uint256[] memory _activeWorkerIds = activeWorkerIds.values();
    for (uint256 i = 0; i < _activeWorkerIds.length; i++) {
      uint256 workerId = _activeWorkerIds[i];
      Worker storage worker = workers[workerId];
      if (isWorkerActive(worker)) {
        activeCount++;
      }
    }
    return activeCount;
  }

  /// @dev Get worker by index
  /// @param workerId ID of the worker
  /// @return Worker under the index
  function getWorker(uint256 workerId) external view returns (Worker memory) {
    return workers[workerId];
  }

  /// @dev Returns the ids of all worker created by the owner account
  function getOwnedWorkers(address owner) external view returns (uint256[] memory) {
    return ownedWorkers[owner].values();
  }

  /// @dev get count of all workers
  function getAllWorkersCount() external view returns (uint256) {
    return activeWorkerIds.length();
  }

  function getMetadata(bytes calldata peerId) external view returns (string memory) {
    uint256 workerId = workerIds[peerId];
    require(workerId != 0, "Worker not registered");
    return workers[workerId].metadata;
  }

  /// @dev Get current bond amount
  function bondAmount() public view returns (uint256) {
    return router.networkController().bondAmount();
  }

  /*
  * @dev Get current epoch length in blocks
  * @deprecated
  */
  function epochLength() public view returns (uint128) {
    return router.networkController().epochLength();
  }

  /// @dev Get current lock period for a worker which is equal to one epoch
  function lockPeriod() public view returns (uint128) {
    return router.networkController().epochLength();
  }

  function nextWorkerId() external view returns (uint256) {
    return workerIdTracker + 1;
  }
}
