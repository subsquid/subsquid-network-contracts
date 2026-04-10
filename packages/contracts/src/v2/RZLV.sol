// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title RZLV - Rezolve Token
 * @dev Simple ERC20 token for the V2 network. Replaces SQD.
 */
contract RZLV is ERC20 {
  constructor(address[] memory recipients, uint256[] memory amounts) ERC20("Rezolve Token", "RZLV") {
    require(recipients.length == amounts.length, "Length mismatch");
    for (uint256 i = 0; i < recipients.length; i++) {
      _mint(recipients[i], amounts[i]);
    }
  }

  function decimals() public pure override returns (uint8) {
    return 18;
  }
}
