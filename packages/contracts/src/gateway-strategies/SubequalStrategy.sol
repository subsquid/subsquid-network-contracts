pragma solidity 0.8.20;

import "../interfaces/IGatewayStrategy.sol";
import "../interfaces/IGatewayRegistry.sol";
import "../interfaces/IRouter.sol";

contract SubequalStrategy is IGatewayStrategy {
  IRouter public router;
  IGatewayRegistry public gatewayRegistry;

  mapping(address gatewayOperator => mapping(uint256 workerId => bool)) public isWorkerSupported;
  mapping(address gatewayOperator => uint256) public workerCount;

  event WorkerSupported(address gatewayOperator, uint256 workerId);
  event WorkerUnsupported(address gatewayOperator, uint256 workerId);

  constructor(IRouter _router, IGatewayRegistry _gatewayRegistry) {
    router = _router;
    gatewayRegistry = _gatewayRegistry;
  }

  function supportWorkers(uint256[] calldata workerIds) external {
    for (uint256 i = 0; i < workerIds.length; i++) {
      isWorkerSupported[msg.sender][workerIds[i]] = true;
      emit WorkerSupported(msg.sender, workerIds[i]);
    }
    workerCount[msg.sender] += workerIds.length;
  }

  function unsupportWorkers(uint256[] calldata workerIds) external {
    for (uint256 i = 0; i < workerIds.length; i++) {
      isWorkerSupported[msg.sender][workerIds[i]] = false;
      emit WorkerUnsupported(msg.sender, workerIds[i]);
    }
    workerCount[msg.sender] -= workerIds.length;
  }

  function computationUnitsPerEpoch(bytes calldata gatewayId, uint256 workerId) external view returns (uint256) {
    address operator = gatewayRegistry.getGateway(gatewayId).operator;
    if (!isWorkerSupported[operator][workerId]) {
      return 0;
    }
    return gatewayRegistry.computationUnitsAvailable(gatewayId) / workerCount[operator];
  }
}
