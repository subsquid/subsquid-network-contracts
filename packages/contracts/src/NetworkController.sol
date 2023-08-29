// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "./interfaces/INetworkController.sol";

contract NetworkController is AccessControl, INetworkController {
  uint128 public epochLength;
  uint256 public bondAmount;

  event EpochLengthUpdated(uint128 epochLength);
  event BondAmountUpdated(uint256 bondAmount);

  constructor(uint128 _epochLength, uint256 _bondAmount) {
    _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
    epochLength = _epochLength;
    bondAmount = _bondAmount;
  }

  function setEpochLength(uint128 _epochLength) external onlyRole(DEFAULT_ADMIN_ROLE) {
    epochLength = _epochLength;
    emit EpochLengthUpdated(_epochLength);
  }

  function setBondAmount(uint256 _bondAmount) external onlyRole(DEFAULT_ADMIN_ROLE) {
    bondAmount = _bondAmount;
    emit BondAmountUpdated(_bondAmount);
  }
}
