// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "forge-std/Script.sol";
import "../src/GatewayRegistry.sol";

contract RegisterGateway is Script {
  function run() public {
    uint256 deployerPrivateKey = vm.envOr("PRIVATE_KEY", uint256(0));
    bytes memory peerId = vm.envOr("GATEWAY_ID", bytes(""));
    if (deployerPrivateKey == 0) {
      console2.log("PRIVATE_KEY env var is required");
      return;
    }
    if (peerId.length == 0) {
      console2.log("GATEWAY_ID env var is required");
      return;
    }
    uint256 stakeAmount = vm.envOr("STAKE_AMOUNT", uint256(100)) * 1 ether;
    uint128 duration = uint128(vm.envOr("STAKE_DURATION", uint256(180)));
    GatewayRegistry gatewayReg =
      GatewayRegistry(vm.envOr("GATEWAY_REGISTRY", address(0xC168fD9298141E3a19c624DF5692ABeeb480Fb94)));
    IERC20 token = gatewayReg.token();
    vm.startBroadcast(deployerPrivateKey);
    if (gatewayReg.peerIds(msg.sender).length == 0) {
      gatewayReg.register(peerId);
    } else {
      console2.log("Gateway already registered");
    }
    token.approve(address(gatewayReg), stakeAmount);
    gatewayReg.stake(stakeAmount, duration);
    vm.stopBroadcast();
  }
}
