pragma solidity 0.8.20;

import "../BaseTest.sol";
import "../../src/GatewayRegistry.sol";
import "../../src/gateway-strategies/EqualStrategy.sol";

contract EqualStrategyTest is BaseTest {
  bytes peerId = "gateway-peerId";

  function test_EquallyDividesComputationUnits() public {
    (IERC20 token, Router router) = deployAll();

    vm.mockCall(
      address(gatewayRegistry.router().workerRegistration()),
      abi.encodeWithSelector(WorkerRegistration.getActiveWorkerCount.selector),
      abi.encode(15)
    );
    vm.mockCall(
      address(gatewayRegistry),
      abi.encodeWithSelector(IGatewayRegistry.computationUnitsAvailable.selector, peerId),
      abi.encode(300_000)
    );
    EqualStrategy strategy = new EqualStrategy(gatewayRegistry.router(), gatewayRegistry);
    assertEq(strategy.computationUnitsPerEpoch(peerId, 0), 20_000);
  }
}
