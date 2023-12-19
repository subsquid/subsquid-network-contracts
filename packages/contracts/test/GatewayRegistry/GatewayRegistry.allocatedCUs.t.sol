pragma solidity 0.8.20;

import "forge-std/Test.sol";
import "./GatewayRegistryTest.sol";

contract GatewayRegistryAllocatedCUTest is GatewayRegistryTest {
  function expectedCUs(uint256 amount, uint256 duration) public view returns (uint256) {
    return uint256(amount * duration * 1200 * 4000 * rewardCalc.boostFactor(duration) / 10000 / 360 days / 10000);
  }

  function test_availableCUs() public {
    assertEq(gatewayRegistry.availableCUs(100 ether, 360 days), expectedCUs(100, 360 days));
    assertEq(gatewayRegistry.availableCUs(200 ether, 180 days), expectedCUs(200, 180 days));
    assertEq(gatewayRegistry.availableCUs(400 ether, 89 days), expectedCUs(400, 89 days));
  }
}
