pragma solidity 0.8.20;

import "../interfaces/IGatewayStrategy.sol";
import "../interfaces/IGatewayRegistry.sol";
import "../interfaces/IRouter.sol";

contract SubequalStrategy is IGatewayStrategy {
  IRouter public router;
  IGatewayRegistry public gatewayRegistry;

  mapping(address gatewayOperator => mapping(uint256 workerId => bool)) public isWorkerSupported;
  mapping(address gatewayOperator => uint256) public workerCount;

  event WorkerSupported(address indexed gatewayOperator, uint256 indexed workerId);
  event WorkerUnsupported(address indexed gatewayOperator, uint256 indexed workerId);

  constructor(IRouter _router, IGatewayRegistry _gatewayRegistry) {
    router = _router;
    gatewayRegistry = _gatewayRegistry;
  }

  function supportWorkers(uint256[] calldata workerIds) external {
    for (uint256 i = 0; i < workerIds.length; i++) {
      if (isWorkerSupported[msg.sender][workerIds[i]]) {
        continue;
      }
      isWorkerSupported[msg.sender][workerIds[i]] = true;
      workerCount[msg.sender]++;
      emit WorkerSupported(msg.sender, workerIds[i]);
    }
  }

  function unsupportWorkers(uint256[] calldata workerIds) external {
    for (uint256 i = 0; i < workerIds.length; i++) {
      require(isWorkerSupported[msg.sender][workerIds[i]], "Worker is not supported");
      isWorkerSupported[msg.sender][workerIds[i]] = false;
      workerCount[msg.sender]--;
      emit WorkerUnsupported(msg.sender, workerIds[i]);
    }
  }

  function computationUnitsPerEpoch(bytes calldata gatewayId, uint256 workerId) external view returns (uint256) {
    address operator = gatewayRegistry.getGateway(gatewayId).operator;
    if (!isWorkerSupported[operator][workerId]) {
      return 0;
    }
    return gatewayRegistry.computationUnitsAvailable(gatewayId) / workerCount[operator];
  }
}
