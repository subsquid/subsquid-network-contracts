import "../interfaces/IGatewayStrategy.sol";
import "../interfaces/IWorkerRegistration.sol";
import "../interfaces/IGatewayRegistry.sol";

contract EqualStrategy is IGatewayStrategy {
  IWorkerRegistration public workerRegistration;
  IGatewayRegistry public gatewayRegistry;

  constructor(IWorkerRegistration _workerRegistration, IGatewayRegistry _gatewayRegistry) {
    workerRegistration = _workerRegistration;
    gatewayRegistry = _gatewayRegistry;
  }

  function computationUnitsPerEpoch(bytes calldata gatewayId, uint256) external view returns (uint256) {
    return gatewayRegistry.computationUnitsAvailable(gatewayId) / workerRegistration.getActiveWorkerCount();
  }
}
