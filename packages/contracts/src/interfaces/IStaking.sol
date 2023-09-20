// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.18;

interface IStaking {
  function deposit(address worker, uint256 amount) external;

  function withdraw(address worker, uint256 amount) external;

  function claim(address worker) external returns (uint256);

  function claimable(address worker) external view returns (uint256);

  function distribute(address[] memory workers, uint256[] memory amounts) external;
}
