pragma solidity 0.8.20;

import "../interfaces/IGatewayStrategy.sol";
import "../interfaces/IGatewayRegistry.sol";
import "../interfaces/IRouter.sol";

contract EqualStrategy is IGatewayStrategy {
  IRouter public router;
  IGatewayRegistry public gatewayRegistry;

  constructor(IRouter _router, IGatewayRegistry _gatewayRegistry) {
    router = _router;
    gatewayRegistry = _gatewayRegistry;
  }

  function computationUnitsPerEpoch(bytes calldata gatewayId, uint256) external view returns (uint256) {
    return gatewayRegistry.computationUnitsAvailable(gatewayId) / router.workerRegistration().getActiveWorkerCount();
  }
}
