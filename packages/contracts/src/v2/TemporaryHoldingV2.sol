// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./ExecutableV2.sol";
import "../interfaces/IRouter.sol";

/**
 * @title TemporaryHoldingV2
 * @dev Standalone per-user holding contract inheriting ExecutableV2 fixes:
 *      - token (renamed from SQD)
 *      - ReentrancyGuard on execute()
 *      - Approval reset after execute()
 *      - SafeERC20 on release transfer
 */
contract TemporaryHoldingV2 is ExecutableV2 {
  using SafeERC20 for IERC20;

  address public immutable beneficiary;
  address public immutable admin;
  uint256 public immutable lockedUntil;
  uint256 public immutable expectedAmount;

  constructor(
    IERC20 _token,
    IRouter _router,
    address _beneficiary,
    address _admin,
    uint256 _lockedUntil,
    uint256 _expectedAmount
  ) {
    token = _token;
    router = _router;
    beneficiary = _beneficiary;
    admin = _admin;
    lockedUntil = _lockedUntil;
    expectedAmount = _expectedAmount;
  }

  function release() external {
    require(block.timestamp >= lockedUntil, "Funds are locked");
    token.safeTransfer(admin, balanceOf());
  }

  function balanceOf() public view returns (uint256) {
    return token.balanceOf(address(this));
  }

  function _canExecute(address executor) internal view override returns (bool) {
    if (block.timestamp < lockedUntil) {
      return executor == beneficiary;
    }
    return executor == admin;
  }
}
