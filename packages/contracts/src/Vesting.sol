// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/finance/VestingWallet.sol";
import "@openzeppelin/contracts/utils/Address.sol";

import {IRouter} from "./interfaces/IRouter.sol";

contract SubsquidVesting is VestingWallet {
  using Address for address;

  IERC20 public tSQD;
  IRouter public router;
  uint256 public expectedTotalAmount;
  uint256 public immediateReleaseBIP;

  constructor(
    IERC20 _tSQD,
    IRouter _router,
    address beneficiaryAddress,
    uint64 startTimestamp,
    uint64 durationSeconds,
    uint256 _immediateReleaseBIP,
    uint256 _expectedTotalAmount
  ) VestingWallet(beneficiaryAddress, startTimestamp, durationSeconds) {
    tSQD = _tSQD;
    router = _router;
    expectedTotalAmount = _expectedTotalAmount;
    immediateReleaseBIP = _immediateReleaseBIP;
  }

  receive() external payable override {
    revert("SubsquidVesting: cannot receive Ether");
  }

  function release() public override {
    release(address(tSQD));
  }

  function balanceOf(IERC20 token) public view returns (uint256) {
    return token.balanceOf(address(this));
  }

  function release(address token) public override onlyOwner {
    require(token == address(tSQD), "Only tSQD is supported");
    super.release(token);
  }

  function execute(address to, bytes calldata data) external {
    execute(to, data, 0);
  }

  function _vestingSchedule(uint256 totalAllocation, uint64 timestamp) internal view virtual override returns (uint256) {
    if (timestamp < start()) return 0;
    uint256 cliff = totalAllocation * immediateReleaseBIP / 10000;
    return cliff + super._vestingSchedule(totalAllocation - cliff, timestamp);
  }

  function execute(address to, bytes calldata data, uint256 requiredApprove) public onlyOwner returns (bytes memory) {
    require(router.networkController().isAllowedVestedTarget(to), "Target is not allowed");

    // It's not likely that following addresses will be allowed by network controller, but just in case
    require(to != address(this), "Cannot call self");
    require(to != address(tSQD), "Cannot call tSQD");

    if (requiredApprove > 0) {
      tSQD.approve(to, requiredApprove);
    }
    return to.functionCall(data);
  }
}
