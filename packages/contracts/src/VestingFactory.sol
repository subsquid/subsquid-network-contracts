// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/IRouter.sol";
import "./Vesting.sol";

contract VestingFactory {
  IERC20 public immutable token;
  IRouter public immutable router;

  event VestingCreated(address indexed vesting, address indexed beneficiary, uint64 startTimestamp, uint64 durationSeconds, uint256 expectedTotalAmount);

  constructor(IERC20 _token, IRouter _router) {
    token = _token;
    router = _router;
  }

  // TODO add access control
  function createVesting(
    address beneficiaryAddress,
    uint64 startTimestamp,
    uint64 durationSeconds,
    uint256 expectedTotalAmount
  ) external returns (address) {
    address vesting = address(new SubsquidVesting(token, router, beneficiaryAddress, startTimestamp, durationSeconds, expectedTotalAmount));
    emit VestingCreated(vesting, beneficiaryAddress, startTimestamp, durationSeconds, expectedTotalAmount);
    return vesting;
  }
}
