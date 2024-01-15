// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./Executable.sol";
import "./interfaces/IRouter.sol";

/**
 * @title Temporary Holding Contract
 * @dev Contract that holds tSQD tokens for a beneficiary to interact with the network
 * The tokens are unlocked after lockedUntil timestamp
 * The beneficiary can execute contracts, allowed by network controller through this contract
 */
contract TemporaryHolding is Executable {
  address public immutable beneficiary;
  address public immutable admin;
  uint256 public immutable lockedUntil;
  uint256 public immutable expectedAmount;

  constructor(
    IERC20 _tSQD,
    IRouter _router,
    address _beneficiary,
    address _admin,
    uint256 _lockedUntil,
    uint256 _expectedAmount
  ) {
    tSQD = _tSQD;
    router = _router;
    beneficiary = _beneficiary;
    admin = _admin;
    lockedUntil = _lockedUntil;
    expectedAmount = _expectedAmount;
  }

  function release() external {
    require(block.timestamp >= lockedUntil, "Funds are locked");
    tSQD.transfer(admin, balanceOf());
  }

  function balanceOf() public view returns (uint256) {
    return tSQD.balanceOf(address(this));
  }

  function _canExecute(address executor) internal view override returns (bool) {
    if (block.timestamp < lockedUntil) {
      return executor == beneficiary;
    }
    return executor == admin;
  }
}
