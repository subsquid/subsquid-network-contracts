pragma solidity 0.8.20;

import "./GatewayRegistryTest.sol";

contract GatewayRegistryStakeTest is GatewayRegistryTest {
  function compareCluster(bytes memory peerId, bytes[] memory expected) internal {
    bytes[] memory cluster = gatewayRegistry.getCluster(peerId);
    assertEq(cluster.length, expected.length, "Length not equal");
    for (uint256 i = 0; i < cluster.length; i++) {
      assertEq(cluster[i], expected[i]);
    }
  }

  /// Kinda lazy way to avoid merging arrays
  function compareCluster(bytes memory peerId, bytes memory expectedPrefix, bytes[] memory expected) internal {
    bytes[] memory cluster = gatewayRegistry.getCluster(peerId);
    assertEq(cluster.length - 1, expected.length, "Length not equal");
    assertEq(cluster[0], expectedPrefix);
    for (uint256 i = 1; i < cluster.length; i++) {
      assertEq(cluster[i], expected[i - 1]);
    }
  }

  function test_ClusterReturnsCorrectSetOfGateways() public {
    gatewayRegistry.register(myPeers, metadatas, addresses);
    hoax(address(2));
    gatewayRegistry.register(notMyPeers, metadatas, addresses);
    compareCluster(notMyPeers[0], notMyPeers);
    compareCluster(notMyPeers[2], notMyPeers);
    compareCluster(myPeers[2], peerId, myPeers);
    compareCluster(myPeers[0], peerId, myPeers);
    compareCluster(peerId, peerId, myPeers);
    gatewayRegistry.unregister(c(peerId, myPeers[2]));
    compareCluster(myPeers[0], c(myPeers[1], myPeers[0]));
    compareCluster(notMyPeers[2], notMyPeers);
  }
}
