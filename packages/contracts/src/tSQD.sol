// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IL1CustomGateway {
  function registerTokenToL2(
    address _l2Address,
    uint256 _maxGas,
    uint256 _gasPriceBid,
    uint256 _maxSubmissionCost,
    address _creditBackAddress
  ) external payable returns (uint256);
}

interface IGatewayRouter2 {
  function setGateway(
    address _gateway,
    uint256 _maxGas,
    uint256 _gasPriceBid,
    uint256 _maxSubmissionCost,
    address _creditBackAddress
  ) external payable returns (uint256);
}

contract tSQD is ERC20 {
  bool internal shouldRegisterGateway;
  IL1CustomGateway gateway;
  IGatewayRouter2 router;

  constructor(
    address[] memory recipients,
    uint256[] memory percentages,
    IL1CustomGateway _gateway,
    IGatewayRouter2 _router
  ) ERC20("tSQD Token", "tSQD") {
    gateway = _gateway;
    router = _router;

    require(recipients.length == percentages.length, "Recipients and percentages arrays must have the same length");

    uint256 initialSupply = 1337 * (10 ** 6) * (10 ** decimals());
    uint256 totalPercentage;

    for (uint256 i = 0; i < recipients.length; i++) {
      uint256 tokenAmount = initialSupply * percentages[i];
      _mint(recipients[i], tokenAmount);
      totalPercentage += percentages[i];
    }

    require(totalPercentage == 100, "Percentages must sum up to 100");
  }

  /// @dev we only set shouldRegisterGateway to true when in `registerTokenOnL2`
  function isArbitrumEnabled() external view returns (uint8) {
    require(shouldRegisterGateway, "NOT_EXPECTED_CALL");
    return uint8(0xb1);
  }

  function registerTokenOnL2(
    address l2CustomTokenAddress,
    uint256 maxSubmissionCostForCustomGateway,
    uint256 maxSubmissionCostForRouter,
    uint256 maxGasForCustomGateway,
    uint256 maxGasForRouter,
    uint256 gasPriceBid,
    uint256 valueForGateway,
    uint256 valueForRouter,
    address creditBackAddress
  ) public payable {
    require(!shouldRegisterGateway, "ALREADY_REGISTERED");
    shouldRegisterGateway = true;

    gateway.registerTokenToL2{value: valueForGateway}(
      l2CustomTokenAddress, maxGasForCustomGateway, gasPriceBid, maxSubmissionCostForCustomGateway, creditBackAddress
    );

    router.setGateway{value: valueForRouter}(
      address(gateway), maxGasForRouter, gasPriceBid, maxSubmissionCostForRouter, creditBackAddress
    );

    shouldRegisterGateway = false;
  }
}
