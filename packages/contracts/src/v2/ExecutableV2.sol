// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../interfaces/IRouter.sol";

/**
 * @title ExecutableV2
 * @dev Abstract contract that can execute arbitrary calldata.
 *      Fixes from V1:
 *      - SQD renamed to token
 *      - ReentrancyGuard added (nonReentrant on execute)
 *      - Approval reset to 0 after external call
 */
abstract contract ExecutableV2 is ReentrancyGuard {
  using Address for address;
  using SafeERC20 for IERC20;

  IERC20 public token;
  IRouter public router;
  /// @dev Amount of tokens deposited into protocol through this contract
  uint256 public depositedIntoProtocol;

  function _canExecute(address executor) internal view virtual returns (bool);

  function execute(address to, bytes calldata data) external {
    execute(to, data, 0);
  }

  /**
   * @dev Execute arbitrary calldata with reentrancy protection
   * @param to Target address, must be allowed by network controller
   * @param data Calldata to execute
   * @param requiredApprove Amount of tokens to approve before transaction
   */
  function execute(address to, bytes calldata data, uint256 requiredApprove) public nonReentrant returns (bytes memory) {
    require(_canExecute(msg.sender), "Not allowed to execute");
    require(router.networkController().isAllowedVestedTarget(to), "Target is not allowed");
    require(to != address(this), "Cannot call self");
    require(to != address(token), "Cannot call token");

    if (requiredApprove > 0) {
      token.forceApprove(to, requiredApprove);
    }
    depositedIntoProtocol += token.balanceOf(address(this));
    bytes memory result = to.functionCall(data);
    uint256 balanceAfter = token.balanceOf(address(this));
    if (balanceAfter > depositedIntoProtocol) {
      depositedIntoProtocol = 0;
    } else {
      depositedIntoProtocol -= balanceAfter;
    }
    // Reset approval to 0 after call to prevent dangling allowance
    if (requiredApprove > 0) {
      token.forceApprove(to, 0);
    }
    return result;
  }
}
