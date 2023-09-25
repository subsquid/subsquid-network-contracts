// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.18;

interface IStaking {
  event Distributed(uint256 epoch);
  event Deposited(uint256 indexed worker, address indexed staker, uint256 amount);
  event Withdrawn(uint256 indexed worker, address indexed staker, uint256 amount);
  event Claimed(address indexed staker, uint256 amount);

  function deposit(uint256 worker, uint256 amount) external;

  function withdraw(uint256 worker, uint256 amount) external;

  function claim(address staker) external returns (uint256);

  function claimable(address staker) external view returns (uint256);

  function distribute(uint256[] memory workers, uint256[] memory amounts) external;
}
