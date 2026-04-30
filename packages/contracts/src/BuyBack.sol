// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

contract BuyBack is Pausable, AccessControl {
  bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
  IERC20 public immutable token;

  event Deposited(address indexed account, uint256 value);
  event Withdrawn(address indexed receiver, uint256 amount);

  constructor(IERC20 _token, address _admin) {
    token = _token;
    _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    _grantRole(PAUSER_ROLE, _admin);
  }

  function deposit(uint256 amount) external whenNotPaused {
    token.transferFrom(msg.sender, address(this), amount);

    emit Deposited(msg.sender, amount);
  }

  function withdraw(address receiver, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
    token.transfer(receiver, amount);

    emit Withdrawn(receiver, amount);
  }
}
