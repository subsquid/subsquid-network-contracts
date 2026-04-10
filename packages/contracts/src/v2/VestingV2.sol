// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/finance/VestingWallet.sol";

import "../interfaces/IRouter.sol";
import "./ExecutableV2.sol";

/**
 * @title SubsquidVestingV2
 * @dev Standalone per-user vesting contract inheriting ExecutableV2 fixes:
 *      - token (renamed from SQD)
 *      - ReentrancyGuard on execute()
 *      - Approval reset after execute()
 *      - Removed SQD-specific token check to support RZLV
 */
contract SubsquidVestingV2 is ExecutableV2, VestingWallet {
  uint256 public immutable expectedTotalAmount;
  uint256 public immutable immediateReleaseBIP;

  constructor(
    IERC20 _token,
    IRouter _router,
    address beneficiaryAddress,
    uint64 startTimestamp,
    uint64 durationSeconds,
    uint256 _immediateReleaseBIP,
    uint256 _expectedTotalAmount
  ) VestingWallet(beneficiaryAddress, startTimestamp, durationSeconds) {
    token = _token;
    router = _router;
    expectedTotalAmount = _expectedTotalAmount;
    immediateReleaseBIP = _immediateReleaseBIP;
  }

  receive() external payable override {
    revert("SubsquidVestingV2: cannot receive Ether");
  }

  function release() public override {
    release(address(token));
  }

  function balanceOf(IERC20 _token) public view returns (uint256) {
    return _token.balanceOf(address(this));
  }

  /// @dev Removed SQD-only check. Now supports any token set at construction (RZLV).
  function release(address releaseToken) public override onlyOwner {
    require(releaseToken == address(token), "Only configured token is supported");
    super.release(releaseToken);
  }

  function releasable(address releaseToken) public view override returns (uint256) {
    uint256 _releasable = super.releasable(releaseToken);
    uint256 currentBalance = balanceOf(IERC20(releaseToken));
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

  function _transferOwnership(address newOwner) internal override {
    require(owner() == address(0), "Ownership transfer is not allowed");
    super._transferOwnership(newOwner);
  }
}
