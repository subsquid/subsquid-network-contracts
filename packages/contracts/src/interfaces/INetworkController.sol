// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

interface INetworkController {
  function epochLength() external view returns (uint128);

  function bondAmount() external view returns (uint256);
}
