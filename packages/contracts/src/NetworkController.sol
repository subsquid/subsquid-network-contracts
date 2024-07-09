// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "./interfaces/INetworkController.sol";

/**
 * @title Network Controller Contract
 * @dev Contract that controls network parameters
 * All setters can only be called by admin
 * See getters descriptions in interface
 */
contract NetworkController is AccessControl, INetworkController {
  uint256 internal constant ONE_BASIS_POINT = 10_000;

  /// @notice deprecated
  uint128 public epochLength;

  uint128 public workerEpochLength;
  uint128 public firstEpochBlock;
  uint256 public bondAmount;
  uint256 public stakingDeadlock = 2;
  uint128 internal epochCheckpoint;
  uint128 public storagePerWorkerInGb = 1000;
  uint256 public override targetCapacityGb = 100_000;
  uint256 public override yearlyRewardCapCoefficient = 3000;
  mapping(address => bool) public isAllowedVestedTarget;

  constructor(uint128 _epochLength, uint128 _firstEpochBlock, uint128 _epochCheckpoint, uint256 _bondAmount, address[] memory _allowedVestedTargets) {
    require(_epochLength > 1, "Epoch length too short");
    require(_epochLength < 100000, "Epoch length too long");

    _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    for (uint256 i = 0; i < _allowedVestedTargets.length; i++) {
      setAllowedVestedTarget(_allowedVestedTargets[i], true);
    }
    workerEpochLength = _epochLength;
    if (_firstEpochBlock > 0) {
      firstEpochBlock = _firstEpochBlock;
    } else {
      firstEpochBlock = nextEpoch();
    }
    epochCheckpoint = _epochCheckpoint;
    emit EpochLengthUpdated(_epochLength);

    setBondAmount(_bondAmount);
  }

  /// @dev Set amount of blocks in one epoch
  function setEpochLength(uint128 _epochLength) external onlyRole(DEFAULT_ADMIN_ROLE) {
    require(_epochLength > 1, "Epoch length too short");
    require(_epochLength < 100000, "Epoch length too long");

    uint128 nextEpochStart = nextEpoch();
    epochCheckpoint = epochNumber();
    firstEpochBlock = nextEpochStart;
    workerEpochLength = _epochLength;

    emit EpochLengthUpdated(_epochLength);
  }

  /// @dev Set how long the
  function setLockPeriod(uint128 _lockPeriod) external onlyRole(DEFAULT_ADMIN_ROLE) {
    require(_lockPeriod > 1, "Lock period too short");
    require(_lockPeriod < 100000, "Lock period too long");

    epochLength = _lockPeriod;

    emit LockPeriodUpdated(_lockPeriod);
  }

  function lockPeriod() external view returns (uint128) {
    return epochLength;
  }

  /// @dev Set amount of tokens required to register a worker
  function setBondAmount(uint256 _bondAmount) public onlyRole(DEFAULT_ADMIN_ROLE) {
    require(_bondAmount > 0, "Bond cannot be 0");
    require(_bondAmount < 1_000_000 ether, "Bond too large");

    bondAmount = _bondAmount;
    emit BondAmountUpdated(_bondAmount);
  }

  /// @dev Set amount of storage in Gigabytes each worker is expected to provide
  function setStoragePerWorkerInGb(uint128 _storagePerWorkerInGb) external onlyRole(DEFAULT_ADMIN_ROLE) {
    require(_storagePerWorkerInGb > 0, "Storage cannot be 0");
    require(_storagePerWorkerInGb < 1_000_000, "Storage per worker too large");

    storagePerWorkerInGb = _storagePerWorkerInGb;

    emit StoragePerWorkerInGbUpdated(_storagePerWorkerInGb);
  }

  /// @dev Set delegation limit coefficient in basis points
  function setStakingDeadlock(uint256 _newDeadlock) external onlyRole(DEFAULT_ADMIN_ROLE) {
    require(_newDeadlock > 1, "Deadlock should be more than 1 epoch");
    stakingDeadlock = _newDeadlock;

    emit StakingDeadlockUpdated(_newDeadlock);
  }

  /// @dev Set if the `target` can be used as a called by the vesting contract
  function setAllowedVestedTarget(address target, bool isAllowed) public onlyRole(DEFAULT_ADMIN_ROLE) {
    isAllowedVestedTarget[target] = isAllowed;

    emit AllowedVestedTargetUpdated(target, isAllowed);
  }

  /// @dev Set target capacity in gigabytes
  function setTargetCapacity(uint256 target) public onlyRole(DEFAULT_ADMIN_ROLE) {
    targetCapacityGb = target;

    emit TargetCapacityUpdated(target);
  }

  /// @dev Set yearly reward cap coefficient
  function setYearlyRewardCapCoefficient(uint256 coefficient) public onlyRole(DEFAULT_ADMIN_ROLE) {
    yearlyRewardCapCoefficient = coefficient;

    emit RewardCoefficientUpdated(coefficient);
  }

  /// @inheritdoc INetworkController
  function nextEpoch() public view returns (uint128) {
    uint128 blockNumber = uint128(block.number);
    if (blockNumber < firstEpochBlock) return firstEpochBlock;
    return ((blockNumber - firstEpochBlock) / workerEpochLength + 1) * workerEpochLength + firstEpochBlock;
  }

  /// @inheritdoc INetworkController
  function epochNumber() public view returns (uint128) {
    uint128 blockNumber = uint128(block.number);
    if (blockNumber < firstEpochBlock) return epochCheckpoint;
    return (blockNumber - firstEpochBlock) / workerEpochLength + epochCheckpoint + 1;
  }
}
