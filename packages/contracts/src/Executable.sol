// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "./interfaces/IRouter.sol";

/// @dev Abstract contract that can execute arbitrary calldata
abstract contract Executable {
  using Address for address;

  IERC20 public SQD;
  IRouter public router;
  /// @dev Amount of SQD deposited into protocol through this contract, used to calculate total vesting balance
  uint256 public depositedIntoProtocol;

  function _canExecute(address executor) internal view virtual returns (bool);

  function execute(address to, bytes calldata data) external {
    execute(to, data, 0);
  }

  /**
   * @dev Execute arbitrary calldata
   * @param to Target address, must be allowed by network controller
   * @param data Calldata to execute
   * @param requiredApprove Amount of SQD to approve before transaction. If 0, no approval is done
   * In case of SQD balance change, depositedIntoProtocol is updated
   */
  function execute(address to, bytes calldata data, uint256 requiredApprove) public returns (bytes memory) {
    require(_canExecute(msg.sender), "Not allowed to execute");
    require(router.networkController().isAllowedVestedTarget(to), "Target is not allowed");

    // It's not likely that following addresses will be allowed by network controller, but just in case
    require(to != address(this), "Cannot call self");
    require(to != address(SQD), "Cannot call SQD");

    if (requiredApprove > 0) {
      SQD.approve(to, requiredApprove);
    }
    depositedIntoProtocol += SQD.balanceOf(address(this));
    bytes memory result = to.functionCall(data);
    uint256 balanceAfter = SQD.balanceOf(address(this));
    if (balanceAfter > depositedIntoProtocol) {
      depositedIntoProtocol = 0;
    } else {
      depositedIntoProtocol -= balanceAfter;
    }
    return result;
  }
}
