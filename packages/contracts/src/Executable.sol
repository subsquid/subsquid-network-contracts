// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "./interfaces/IRouter.sol";

abstract contract Executable {
  using Address for address;

  IERC20 public tSQD;
  IRouter public router;
  uint256 public depositedIntoProtocol;

  function _canExecute(address executor) internal view virtual returns (bool);

  function execute(address to, bytes calldata data) external {
    execute(to, data, 0);
  }

  function execute(address to, bytes calldata data, uint256 requiredApprove) public returns (bytes memory) {
    require(_canExecute(msg.sender), "Not allowed to execute");
    require(router.networkController().isAllowedVestedTarget(to), "Target is not allowed");

    // It's not likely that following addresses will be allowed by network controller, but just in case
    require(to != address(this), "Cannot call self");
    require(to != address(tSQD), "Cannot call tSQD");

    if (requiredApprove > 0) {
      tSQD.approve(to, requiredApprove);
    }
    depositedIntoProtocol += tSQD.balanceOf(address(this));
    bytes memory result = to.functionCall(data);
    uint256 balanceAfter = tSQD.balanceOf(address(this));
    if (balanceAfter > depositedIntoProtocol) {
      depositedIntoProtocol = 0;
    } else {
      depositedIntoProtocol -= balanceAfter;
    }
    return result;
  }
}
