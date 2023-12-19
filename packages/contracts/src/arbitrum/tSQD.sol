// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract tSQDArbitrum is ERC20 {
  address public immutable l2Gateway;
  address public immutable l1Address;

  modifier onlyL2Gateway() {
    require(msg.sender == l2Gateway, "NOT_GATEWAY");
    _;
  }

  constructor(address _l2Gateway, address _l1TokenAddress) ERC20("tSQD Token", "tSQD") {
    l2Gateway = _l2Gateway;
    l1Address = _l1TokenAddress;
  }

  /**
 * @notice should increase token supply by amount, and should only be callable by the L2Gateway.
     */
  function bridgeMint(address account, uint256 amount) external onlyL2Gateway {
    _mint(account, amount);
  }

  /**
   * @notice should decrease token supply by amount, and should only be callable by the L2Gateway.
     */
  function bridgeBurn(address account, uint256 amount) external onlyL2Gateway {
    _burn(account, amount);
  }
}
