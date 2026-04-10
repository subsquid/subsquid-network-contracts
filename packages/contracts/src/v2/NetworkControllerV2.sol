// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import {AccessControlUpgradeable} from
  "openzeppelin-contracts-upgradeable/contracts/access/AccessControlUpgradeable.sol";
import {UUPSUpgradeable} from "openzeppelin-contracts-upgradeable/contracts/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "openzeppelin-contracts-upgradeable/contracts/proxy/utils/Initializable.sol";
import "../interfaces/INetworkController.sol";

/**
 * @title NetworkControllerV2
 * @dev UUPS-upgradeable contract that controls network parameters.
 *      Bond cap raised to allow hard freeze in Phase 2.3.
 */
contract NetworkControllerV2 is Initializable, AccessControlUpgradeable, UUPSUpgradeable, INetworkController {
  uint256 internal constant ONE_BASIS_POINT = 10_000;

  /// @notice deprecated used ONLY for worker bond and delegation lock period
  uint128 public epochLength;

  uint128 public workerEpochLength;
  uint128 public firstEpochBlock;
  uint256 public bondAmount;
  uint256 public stakingDeadlock;
  uint128 internal epochCheckpoint;
  uint128 public storagePerWorkerInGb;
  uint256 public override targetCapacityGb;
  uint256 public override yearlyRewardCapCoefficient;
  mapping(address => bool) public isAllowedVestedTarget;

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor() {
    _disableInitializers();
  }

  function initialize(
    uint128 _epochLength,
    uint128 _firstEpochBlock,
    uint128 _epochCheckpoint,
    uint256 _bondAmount,
    address[] calldata _allowedVestedTargets
  ) external initializer {
    require(_epochLength > 1, "Epoch length too short");
    require(_epochLength < 100000, "Epoch length too long");

    __AccessControl_init();
    __UUPSUpgradeable_init();
    _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);

    for (uint256 i = 0; i < _allowedVestedTargets.length; i++) {
      _setAllowedVestedTarget(_allowedVestedTargets[i], true);
    }

    workerEpochLength = _epochLength;
    epochLength = _epochLength;
    if (_firstEpochBlock > 0) {
      firstEpochBlock = _firstEpochBlock;
    } else {
      firstEpochBlock = nextEpoch();
    }
    epochCheckpoint = _epochCheckpoint;
    stakingDeadlock = 2;
    storagePerWorkerInGb = 1000;
    targetCapacityGb = 100_000;
    yearlyRewardCapCoefficient = 3000;

    emit EpochLengthUpdated(_epochLength);

    _setBondAmount(_bondAmount);
  }

  function setEpochLength(uint128 _epochLength) external onlyRole(DEFAULT_ADMIN_ROLE) {
    require(_epochLength > 1, "Epoch length too short");
    require(_epochLength < 100000, "Epoch length too long");

    uint128 nextEpochStart = nextEpoch();
    epochCheckpoint = epochNumber();
    firstEpochBlock = nextEpochStart;
    workerEpochLength = _epochLength;

    emit EpochLengthUpdated(_epochLength);
  }

  /// @dev Set how long the lock period for workers and delegations is
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
  /// @notice Bond cap raised to type(uint256).max for Phase 2.3 hard-freeze capability
  function setBondAmount(uint256 _bondAmount) public onlyRole(DEFAULT_ADMIN_ROLE) {
    _setBondAmount(_bondAmount);
  }

  function _setBondAmount(uint256 _bondAmount) internal {
    require(_bondAmount > 0, "Bond cannot be 0");
    bondAmount = _bondAmount;
    emit BondAmountUpdated(_bondAmount);
  }

  function setStoragePerWorkerInGb(uint128 _storagePerWorkerInGb) external onlyRole(DEFAULT_ADMIN_ROLE) {
    require(_storagePerWorkerInGb > 0, "Storage cannot be 0");
    require(_storagePerWorkerInGb < 1_000_000, "Storage per worker too large");

    storagePerWorkerInGb = _storagePerWorkerInGb;

    emit StoragePerWorkerInGbUpdated(_storagePerWorkerInGb);
  }

  function setStakingDeadlock(uint256 _newDeadlock) external onlyRole(DEFAULT_ADMIN_ROLE) {
    require(_newDeadlock > 1, "Deadlock should be more than 1 epoch");
    stakingDeadlock = _newDeadlock;

    emit StakingDeadlockUpdated(_newDeadlock);
  }

  function setAllowedVestedTarget(address target, bool isAllowed) public onlyRole(DEFAULT_ADMIN_ROLE) {
    _setAllowedVestedTarget(target, isAllowed);
  }

  function _setAllowedVestedTarget(address target, bool isAllowed) internal {
    isAllowedVestedTarget[target] = isAllowed;
    emit AllowedVestedTargetUpdated(target, isAllowed);
  }

  function setTargetCapacity(uint256 target) public onlyRole(DEFAULT_ADMIN_ROLE) {
    require(target > 0, "Target capacity cannot be 0");
    targetCapacityGb = target;

    emit TargetCapacityUpdated(target);
  }

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

  function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

  uint256[40] private __gap;
}
