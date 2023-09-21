// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "./interfaces/INetworkController.sol";

contract NetworkController is AccessControl, INetworkController {
  uint128 public epochLength;
  uint128 public firstEpochBlock;
  uint256 public bondAmount;
  uint128 internal epochCheckpoint;

  event EpochLengthUpdated(uint128 epochLength);
  event BondAmountUpdated(uint256 bondAmount);

  constructor(uint128 _epochLength, uint256 _bondAmount) {
    _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
    epochLength = _epochLength;
    bondAmount = _bondAmount;
    firstEpochBlock = nextEpoch();
  }

  function setEpochLength(uint128 _epochLength) external onlyRole(DEFAULT_ADMIN_ROLE) {
    epochCheckpoint = epochNumber();
    epochLength = _epochLength;
    firstEpochBlock = nextEpoch();
    emit EpochLengthUpdated(_epochLength);
  }

  function setBondAmount(uint256 _bondAmount) external onlyRole(DEFAULT_ADMIN_ROLE) {
    bondAmount = _bondAmount;
    emit BondAmountUpdated(_bondAmount);
  }

  function nextEpoch() public view returns (uint128) {
    return (uint128(block.number) / epochLength + 1) * epochLength;
  }

  function epochNumber() public view returns (uint128) {
    uint128 blockNumber = uint128(block.number);
    if (blockNumber < firstEpochBlock) return epochCheckpoint;
    return (blockNumber - firstEpochBlock) / epochLength + epochCheckpoint + 1;
  }
}
