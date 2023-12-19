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

  uint128 public epochLength;
  uint128 public firstEpochBlock;
  uint256 public bondAmount;
  uint128 internal epochCheckpoint;
  uint128 public storagePerWorkerInGb = 1000;
  uint256 public delegationLimitCoefficientInBP = 2_000;
  mapping(address => bool) public isAllowedVestedTarget;

  constructor(uint128 _epochLength, uint256 _bondAmount, address[] memory _allowedVestedTargets) {
    require(_epochLength > 1, "Epoch length too short");
    require(_epochLength < 100 days, "Epoch length too long");

    _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    for (uint256 i = 0; i < _allowedVestedTargets.length; i++) {
      setAllowedVestedTarget(_allowedVestedTargets[i], true);
    }
    epochLength = _epochLength;
    firstEpochBlock = nextEpoch();
    setBondAmount(_bondAmount);
  }

  /// @dev Set amount of blocks in one epoch
  function setEpochLength(uint128 _epochLength) external onlyRole(DEFAULT_ADMIN_ROLE) {
    require(_epochLength > 1, "Epoch length too short");
    require(_epochLength < 100 days, "Epoch length too long");

    epochCheckpoint = epochNumber();
    epochLength = _epochLength;
    firstEpochBlock = nextEpoch();

    emit EpochLengthUpdated(_epochLength);
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

  function setDelegationLimitCoefficient(uint256 _delegationLimitCoefficientInBP) external onlyRole(DEFAULT_ADMIN_ROLE) {
    delegationLimitCoefficientInBP = _delegationLimitCoefficientInBP;

    emit DelegationLimitCoefficientInBPUpdated(_delegationLimitCoefficientInBP);
  }

  function setAllowedVestedTarget(address target, bool isAllowed) public onlyRole(DEFAULT_ADMIN_ROLE) {
    isAllowedVestedTarget[target] = isAllowed;

    emit AllowedVestedTargetUpdated(target, isAllowed);
  }

  /// @inheritdoc INetworkController
  function nextEpoch() public view returns (uint128) {
    return (uint128(block.number) / epochLength + 1) * epochLength;
  }

  /// @inheritdoc INetworkController
  function epochNumber() public view returns (uint128) {
    uint128 blockNumber = uint128(block.number);
    if (blockNumber < firstEpochBlock) return epochCheckpoint;
    return (blockNumber - firstEpochBlock) / epochLength + epochCheckpoint + 1;
  }

  function delegationLimit() external view returns (uint256) {
    return delegationLimitCoefficientInBP * bondAmount / ONE_BASIS_POINT;
  }
}
