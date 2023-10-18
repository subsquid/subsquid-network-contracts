// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract tSQD is ERC20 {
  constructor(address[] memory recipients, uint256[] memory percentages) ERC20("tSQD Token", "tSQD") {
    require(recipients.length == percentages.length, "Recipients and percentages arrays must have the same length");

    uint256 initialSupply = 1337 * (10 ** 6) * (10 ** decimals());
    uint256 totalPercentage;

    for (uint256 i = 0; i < recipients.length; i++) {
      uint256 tokenAmount = initialSupply * percentages[i] / 100;
      _mint(recipients[i], tokenAmount);
      totalPercentage += percentages[i];
    }

    require(totalPercentage == 100, "Percentages must sum up to 100");
  }
}
