// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "./interfaces/IGatewayRegistry.sol";
import "./interfaces/IGatewayStrategy.sol";

contract AllocationsViewer {
  IGatewayRegistry public gatewayRegistry;

  constructor(IGatewayRegistry _gatewayRegistry) {
    gatewayRegistry = _gatewayRegistry;
  }

  struct Allocation {
    bytes gatewayId;
    uint256 allocated;
    address operator;
  }

  function getAllocations(uint256 workerId, uint256 pageNumber, uint256 perPage)
    external
    view
    returns (Allocation[] memory)
  {
    bytes[] memory gateways = gatewayRegistry.getActiveGateways(pageNumber, perPage);
    Allocation[] memory allocs = new Allocation[](gateways.length);
    for (uint256 i = 0; i < gateways.length; i++) {
      IGatewayStrategy strategy = IGatewayStrategy(gatewayRegistry.getUsedStrategy(gateways[i]));
      if (address(strategy) != address(0)) {
        uint256 cus = strategy.computationUnitsPerEpoch(gateways[i], workerId);
        address operator = gatewayRegistry.getGateway(gateways[i]).operator;
        allocs[i] = Allocation(gateways[i], cus, operator);
      }
    }
    return allocs;
  }
}
