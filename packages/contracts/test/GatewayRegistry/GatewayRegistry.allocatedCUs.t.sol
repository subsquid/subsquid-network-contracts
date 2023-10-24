pragma solidity 0.8.18;

import "forge-std/Test.sol";
import "./GatewayRegistryTest.sol";

contract GatewayRegistryAllocatedCUTest is GatewayRegistryTest {
  function test_AllocatedCUs() public {
    uint expected = uint256(100 * 360 days * 4000 * 25000 / 10000 / 365 days);
    console2.log(expected);
    assertEq(gatewayRegistry.allocatedCUs(100, 360 days), expected);
  }
}
