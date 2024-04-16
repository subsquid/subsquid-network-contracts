pragma solidity 0.8.20;

import "./GatewayRegistryTest.sol";

contract GatewayRegistryActiveGatewaysTest is GatewayRegistryTest {
  function test_GetActiveGatewaysPagination() public {
    NetworkController(address(router.networkController())).setEpochLength(2);
    bytes memory gatewayId = "gatewayId";
    gatewayRegistry.register(abi.encodePacked(gatewayId, "3"));
    gatewayRegistry.register(abi.encodePacked(gatewayId, "4"));
    gatewayRegistry.register(abi.encodePacked(gatewayId, "5"));
    gatewayRegistry.register(abi.encodePacked(gatewayId, "6"));
    gatewayRegistry.register(abi.encodePacked(gatewayId, "7"));
    assertEq(gatewayRegistry.getActiveGatewaysCount(), 0);
    assertEq(gatewayRegistry.getActiveGateways(0, 100).length, 0);
    gatewayRegistry.stake(1, 10);
    assertEq(gatewayRegistry.getActiveGatewaysCount(), 6);
    assertEq(gatewayRegistry.getActiveGateways(0, 100).length, 6);

    assertEq(gatewayRegistry.getActiveGateways(1, 2).length, 2);
    assertEq(gatewayRegistry.getActiveGateways(1, 2)[0], abi.encodePacked(gatewayId, "4"));
    assertEq(gatewayRegistry.getActiveGateways(1, 2)[1], abi.encodePacked(gatewayId, "5"));

    assertEq(gatewayRegistry.getActiveGateways(1, 4).length, 2);
    assertEq(gatewayRegistry.getActiveGateways(1, 4)[0], abi.encodePacked(gatewayId, "6"));
    assertEq(gatewayRegistry.getActiveGateways(1, 4)[1], abi.encodePacked(gatewayId, "7"));

    assertEq(gatewayRegistry.getActiveGateways(2, 4).length, 0);
  }

  function test_NewGatewaysAreAddedToActiveGateways() public {
    bytes memory gatewayId = "gatewayId";
    gatewayRegistry.stake(1, 5);
    assertEq(gatewayRegistry.getActiveGatewaysCount(), 1);
    gatewayRegistry.register(gatewayId);
    assertEq(gatewayRegistry.getActiveGatewaysCount(), 2);
  }

  function test_WholeClusterIsRemovedFromListAfterUnstake() public {
    bytes memory gatewayId = "gatewayId";
    gatewayRegistry.stake(1, 5);
    gatewayRegistry.register(gatewayId);
    assertEq(gatewayRegistry.getActiveGatewaysCount(), 2);
    vm.roll(block.number + 10);
    gatewayRegistry.unstake();
    assertEq(gatewayRegistry.getActiveGatewaysCount(), 0);
  }

  function test_GatewayRemovedAfterUnregister() public {
    bytes memory gatewayId = "gatewayId";
    gatewayRegistry.stake(1, 5);
    gatewayRegistry.register(gatewayId);
    assertEq(gatewayRegistry.getActiveGatewaysCount(), 2);
    gatewayRegistry.unregister(gatewayId);
    assertEq(gatewayRegistry.getActiveGatewaysCount(), 1);
  }
}
