pragma solidity 0.8.20;

import "./GatewayRegistryTest.sol";

contract GatewayRegistryRegisterTest is GatewayRegistryTest {
  function test_CannotRegisterSamePeerIdTwice() public {
    gatewayRegistry.register(myPeers, metadatas, addresses);
    startHoax(address(2));
    vm.expectRevert("PeerId already registered");
    gatewayRegistry.register(c(notMyPeers[0], notMyPeers[1], peerId), metadatas, addresses);
    vm.expectRevert("PeerId already registered");
    gatewayRegistry.register(c(notMyPeers[0], notMyPeers[1], notMyPeers[0]), metadatas, addresses);
  }

  function test_CannotUnregisterNotOwnGateway() public {
    hoax(address(2));
    vm.expectRevert("Only operator can call this function");
    gatewayRegistry.unregister(peerId);
  }

  function test_DoesNotChangeStrategyAfterFirstRegistration() public {
    assertEq(gatewayRegistry.getUsedStrategy(peerId), defaultStrategy);
    gatewayRegistry.setIsStrategyAllowed(address(0), true, true);
    gatewayRegistry.register(myPeers, metadatas, addresses);
    assertEq(gatewayRegistry.getUsedStrategy(peerId), defaultStrategy);
  }

  function test_CorrectlySetsMetadataAndAddress() public {
    gatewayRegistry.register(myPeers, metadatas, addresses);
    assertEq(gatewayRegistry.getMetadata(myPeers[1]), "some test metadata");
    assertEq(gatewayRegistry.gatewayByAddress(addresses[2]), keccak256(myPeers[2]));
    assertEq(gatewayRegistry.getGateway(myPeers[2]).ownAddress, addresses[2]);
    assertEq(gatewayRegistry.gatewayByAddress(address(0)), bytes32(0));
  }
}
