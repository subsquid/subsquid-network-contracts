// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import "../interfaces/INetworkController.sol";
import "../interfaces/IWorkerRegistration.sol";
import "../interfaces/IRouter.sol";
import "../interfaces/IRewardCalculationHook.sol";
import "./AccessControlledPausableUpgradeableV2.sol";

/**
 * @title WorkerRegistrationV2
 * @dev UUPS-upgradeable worker registration with:
 *      - SafeERC20 on all transfers
 *      - queue-based deregistration cleanup
 *      - O(eventful epochs) active worker count
 *      - additive paginated active-worker getter
 */
contract WorkerRegistrationV2 is AccessControlledPausableUpgradeableV2, IWorkerRegistration {
  using EnumerableSet for EnumerableSet.UintSet;
  using SafeERC20 for IERC20;

  uint256 private workerIdTracker;

  struct Worker {
    address creator;
    bytes peerId;
    uint256 bond;
    uint128 registeredAt;
    uint128 deregisteredAt;
    string metadata;
  }

  IERC20 public token;
  IRouter public router;
  mapping(uint256 => Worker) public workers;
  mapping(bytes peerId => uint256 id) public workerIds;
  EnumerableSet.UintSet internal activeWorkerIds;
  mapping(address creator => EnumerableSet.UintSet) internal ownedWorkers;

  uint256 public settledActiveWorkerCount;
  uint128[] internal activationEpochs;
  mapping(uint128 epoch => uint256 count) internal scheduledActivations;
  uint256 internal activationCursor;

  uint128[] internal deactivationEpochs;
  mapping(uint128 epoch => uint256 count) internal scheduledDeactivations;
  uint256 internal deactivationCursor;

  uint128[] internal cleanupEpochs;
  mapping(uint128 epoch => uint256[] workerIds) internal cleanupQueueByEpoch;
  uint256 internal cleanupEpochCursor;
  uint256 internal cleanupQueueCursor;

  function initialize(IERC20 _token, IRouter _router) external initializer {
    __AccessControlledPausableUpgradeableV2_init();
    token = _token;
    router = _router;
  }

  function register(bytes calldata peerId) external {
    register(peerId, "");
  }

  function register(bytes calldata peerId, string memory metadata) public whenNotPaused {
    _settleActiveWorkerCount();

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
    uint128 activationBlock = nextEpoch();

    workers[workerId] = Worker({
      creator: msg.sender,
      peerId: peerId,
      bond: _bondAmount,
      registeredAt: activationBlock,
      deregisteredAt: 0,
      metadata: metadata
    });

    workerIds[peerId] = workerId;
    activeWorkerIds.add(workerId);
    ownedWorkers[msg.sender].add(workerId);
    _scheduleActivation(activationBlock);

    token.safeTransferFrom(msg.sender, address(this), _bondAmount);

    _rewardCalculation().onWorkerRegistered(workerId, activationBlock);

    emit WorkerRegistered(workerId, peerId, msg.sender, activationBlock, metadata);
  }

  function deregister(bytes calldata peerId) external whenNotPaused {
    _settleActiveWorkerCount();

    uint256 workerId = workerIds[peerId];
    require(workerId != 0, "Worker not registered");
    require(_isWorkerActive(workers[workerId]), "Worker not active");
    require(workers[workerId].creator == msg.sender, "Not worker creator");

    uint128 deactivationBlock = nextEpoch();
    workers[workerId].deregisteredAt = deactivationBlock;

    _scheduleDeactivation(deactivationBlock);
    _enqueueCleanup(workerId, deactivationBlock);
    _rewardCalculation().onWorkerDeregistered(workerId, deactivationBlock);

    emit WorkerDeregistered(workerId, msg.sender, deactivationBlock);
  }

  /**
   * @dev Removes matured deregistrations from the backing set without scanning the whole worker universe.
   *      `maxProcess` bounds queue entries processed, not just successful removals.
   */
  function cleanupDeregistered(uint256 maxProcess) external returns (uint256 cleaned, uint256 processed) {
    (cleaned, processed) = _cleanupDeregistered(maxProcess);
  }

  function withdraw(bytes calldata peerId) external whenNotPaused {
    _settleActiveWorkerCount();

    uint256 workerId = workerIds[peerId];
    require(workerId != 0, "Worker not registered");
    Worker storage worker = workers[workerId];
    require(!_isWorkerActive(worker), "Worker is active");
    require(worker.creator == msg.sender, "Not worker creator");
    require(worker.deregisteredAt > 0 && block.number >= worker.deregisteredAt + lockPeriod(), "Worker is locked");

    activeWorkerIds.remove(workerId);

    uint256 bond = worker.bond;
    delete workers[workerId];

    token.safeTransfer(msg.sender, bond);

    emit WorkerWithdrawn(workerId, msg.sender);
  }

  function updateMetadata(bytes calldata peerId, string memory metadata) external whenNotPaused {
    uint256 workerId = workerIds[peerId];
    require(workers[workerId].creator == msg.sender, "Not worker creator");
    workers[workerId].metadata = metadata;

    emit MetadataUpdated(workerId, metadata);
  }

  function returnExcessiveBond(bytes calldata peerId) external whenNotPaused {
    uint256 workerId = workerIds[peerId];
    require(workerId != 0, "Worker not registered");
    require(workers[workerId].creator == msg.sender, "Not worker creator");
    uint256 _bondAmount = bondAmount();
    require(workers[workerId].bond > _bondAmount, "No excessive bond");

    uint256 excessiveBond = workers[workerId].bond - _bondAmount;
    workers[workerId].bond = _bondAmount;

    token.safeTransfer(msg.sender, excessiveBond);

    emit ExcessiveBondReturned(workerId, excessiveBond);
  }

  function nextEpoch() public view returns (uint128) {
    return router.networkController().nextEpoch();
  }

  function getActiveWorkers() external view returns (Worker[] memory) {
    uint256 count = getActiveWorkerCount();
    Worker[] memory result = new Worker[](count);
    uint256 idx = 0;
    uint256 rawCount = activeWorkerIds.length();
    for (uint256 i = 0; i < rawCount; i++) {
      uint256 workerId = activeWorkerIds.at(i);
      if (_isWorkerActive(workers[workerId])) {
        result[idx++] = workers[workerId];
      }
    }
    return result;
  }

  function getActiveWorkerIds() public view returns (uint256[] memory) {
    uint256 count = getActiveWorkerCount();
    uint256[] memory result = new uint256[](count);
    uint256 idx = 0;
    uint256 rawCount = activeWorkerIds.length();
    for (uint256 i = 0; i < rawCount; i++) {
      uint256 workerId = activeWorkerIds.at(i);
      if (_isWorkerActive(workers[workerId])) {
        result[idx++] = workerId;
      }
    }
    return result;
  }

  function getActiveWorkerIdsPage(uint256 start, uint256 limit)
    external
    view
    returns (uint256[] memory page, uint256 nextCursor)
  {
    uint256 rawCount = activeWorkerIds.length();
    if (start >= rawCount || limit == 0) {
      return (new uint256[](0), rawCount);
    }

    uint256[] memory tmp = new uint256[](limit);
    uint256 found = 0;
    uint256 cursor = start;
    while (cursor < rawCount && found < limit) {
      uint256 workerId = activeWorkerIds.at(cursor);
      if (_isWorkerActive(workers[workerId])) {
        tmp[found++] = workerId;
      }
      cursor++;
    }

    page = new uint256[](found);
    for (uint256 i = 0; i < found; i++) {
      page[i] = tmp[i];
    }
    return (page, cursor);
  }

  function isWorkerActive(uint256 workerId) external view returns (bool) {
    return _isWorkerActive(workers[workerId]);
  }

  function _isWorkerActive(Worker storage worker) internal view returns (bool) {
    return worker.registeredAt > 0 && worker.registeredAt <= block.number
      && (worker.deregisteredAt == 0 || worker.deregisteredAt > block.number);
  }

  function getActiveWorkerCount() public view returns (uint256 count) {
    count = settledActiveWorkerCount;

    for (uint256 i = activationCursor; i < activationEpochs.length; i++) {
      uint128 epoch = activationEpochs[i];
      if (epoch > block.number) break;
      count += scheduledActivations[epoch];
    }

    for (uint256 i = deactivationCursor; i < deactivationEpochs.length; i++) {
      uint128 epoch = deactivationEpochs[i];
      if (epoch > block.number) break;
      count -= scheduledDeactivations[epoch];
    }
  }

  function getWorker(uint256 workerId) external view returns (Worker memory) {
    return workers[workerId];
  }

  function getOwnedWorkers(address owner) external view returns (uint256[] memory) {
    return ownedWorkers[owner].values();
  }

  function ownsWorker(address owner, uint256 workerId) external view returns (bool) {
    return ownedWorkers[owner].contains(workerId);
  }

  function getAllWorkersCount() external view returns (uint256) {
    return activeWorkerIds.length();
  }

  function getMetadata(bytes calldata peerId) external view returns (string memory) {
    uint256 workerId = workerIds[peerId];
    require(workerId != 0, "Worker not registered");
    return workers[workerId].metadata;
  }

  function bondAmount() public view returns (uint256) {
    return router.networkController().bondAmount();
  }

  function epochLength() public view returns (uint128) {
    return router.networkController().epochLength();
  }

  function lockPeriod() public view returns (uint128) {
    return router.networkController().epochLength();
  }

  function nextWorkerId() external view returns (uint256) {
    return workerIdTracker + 1;
  }

  function _scheduleActivation(uint128 epoch) internal {
    if (activationEpochs.length == 0 || activationEpochs[activationEpochs.length - 1] != epoch) {
      activationEpochs.push(epoch);
    }
    scheduledActivations[epoch] += 1;
  }

  function _scheduleDeactivation(uint128 epoch) internal {
    if (deactivationEpochs.length == 0 || deactivationEpochs[deactivationEpochs.length - 1] != epoch) {
      deactivationEpochs.push(epoch);
    }
    scheduledDeactivations[epoch] += 1;
  }

  function _enqueueCleanup(uint256 workerId, uint128 epoch) internal {
    if (cleanupEpochs.length == 0 || cleanupEpochs[cleanupEpochs.length - 1] != epoch) {
      cleanupEpochs.push(epoch);
    }
    cleanupQueueByEpoch[epoch].push(workerId);
  }

  function _settleActiveWorkerCount() internal {
    while (activationCursor < activationEpochs.length && activationEpochs[activationCursor] <= block.number) {
      settledActiveWorkerCount += scheduledActivations[activationEpochs[activationCursor]];
      activationCursor++;
    }

    while (deactivationCursor < deactivationEpochs.length && deactivationEpochs[deactivationCursor] <= block.number) {
      settledActiveWorkerCount -= scheduledDeactivations[deactivationEpochs[deactivationCursor]];
      deactivationCursor++;
    }
  }

  function _cleanupDeregistered(uint256 maxProcess) internal returns (uint256 cleaned, uint256 processed) {
    while (cleanupEpochCursor < cleanupEpochs.length && processed < maxProcess) {
      uint128 epoch = cleanupEpochs[cleanupEpochCursor];
      if (epoch > block.number) break;

      uint256[] storage queue = cleanupQueueByEpoch[epoch];
      while (cleanupQueueCursor < queue.length && processed < maxProcess) {
        uint256 workerId = queue[cleanupQueueCursor];
        Worker storage worker = workers[workerId];
        if (worker.registeredAt > 0 && worker.deregisteredAt == epoch) {
          if (activeWorkerIds.remove(workerId)) {
            cleaned++;
          }
        }
        cleanupQueueCursor++;
        processed++;
      }

      if (cleanupQueueCursor == queue.length) {
        cleanupEpochCursor++;
        cleanupQueueCursor = 0;
      }
    }
  }

  function _rewardCalculation() internal view returns (IRewardCalculationHook) {
    return IRewardCalculationHook(address(router.rewardCalculation()));
  }

  uint256[33] private __gap;
}
