// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "forge-std/Script.sol";
import "../src/GatewayRegistry.sol";

contract RegisterGateway is Script {
  function run() public {
    uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
    vm.startBroadcast(deployerPrivateKey);
    bytes memory peerId = vm.envBytes("GATEWAY_ID");
    GatewayRegistry gatewayReg = GatewayRegistry(vm.envAddress("GATEWAY_REGISTRY"));
    IERC20 token = gatewayReg.token();
    gatewayReg.register(peerId);
    token.approve(address(gatewayReg), 100 ether);
    gatewayReg.stake(100 ether, 180 days);
    vm.stopBroadcast();

    console2.log("Gateway has", gatewayReg.computationUnits(vm.addr(deployerPrivateKey)), "CUs");
  }
}
