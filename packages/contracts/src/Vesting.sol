// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/finance/VestingWallet.sol";

import "./interfaces/IRouter.sol";
import "./Executable.sol";

/**
 * @title Subsquid Vesting Contract
 * @dev Contract that holds SQD tokens for a beneficiary
 * The tokens are unlocked linearly with a cliff according to _vestingSchedule
 * The beneficiary can execute contracts, allowed by network controller through this contract
 */
contract SubsquidVesting is Executable, VestingWallet {
  uint256 public immutable expectedTotalAmount;
  uint256 public immutable immediateReleaseBIP;

  constructor(
    IERC20 _SQD,
    IRouter _router,
    address beneficiaryAddress,
    uint64 startTimestamp,
    uint64 durationSeconds,
    uint256 _immediateReleaseBIP,
    uint256 _expectedTotalAmount
  ) VestingWallet(beneficiaryAddress, startTimestamp, durationSeconds) {
    SQD = _SQD;
    router = _router;
    expectedTotalAmount = _expectedTotalAmount;
    immediateReleaseBIP = _immediateReleaseBIP;
  }

  receive() external payable override {
    revert("SubsquidVesting: cannot receive Ether");
  }

  function release() public override {
    release(address(SQD));
  }

  function balanceOf(IERC20 token) public view returns (uint256) {
    return token.balanceOf(address(this));
  }

  function release(address token) public override onlyOwner {
    require(token == address(SQD), "Only SQD is supported");
    super.release(token);
  }

  function releasable(address token) public view override returns (uint256) {
    uint256 _releasable = super.releasable(token);
    uint256 currentBalance = balanceOf(IERC20(token));
    if (currentBalance < _releasable) {
      return currentBalance;
    }
    return _releasable;
  }

  function _vestingSchedule(uint256 totalAllocation, uint64 timestamp) internal view virtual override returns (uint256) {
    if (timestamp < start()) return 0;
    uint256 cliff = totalAllocation * immediateReleaseBIP / 10000;
    return cliff + super._vestingSchedule(totalAllocation - cliff + depositedIntoProtocol, timestamp);
  }

  function _canExecute(address executor) internal view override returns (bool) {
    return executor == owner();
  }
}
