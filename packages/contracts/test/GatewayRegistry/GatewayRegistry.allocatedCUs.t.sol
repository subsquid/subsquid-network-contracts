pragma solidity 0.8.20;

import "forge-std/Test.sol";
import "./GatewayRegistryTest.sol";

contract GatewayRegistryAllocatedCUTest is GatewayRegistryTest {
  function expectedCUs(uint256 amount, uint256 duration) public view returns (uint256) {
    return uint256(amount * duration * 1_000 * rewardCalc.boostFactor(duration) / 10000);
  }

  function test_availableCUs() public {
    assertEq(gatewayRegistry.computationUnitsAmount(100 ether, 1800), expectedCUs(100, 1800));
    assertEq(gatewayRegistry.computationUnitsAmount(200 ether, 900), expectedCUs(200, 900));
    assertEq(gatewayRegistry.computationUnitsAmount(400 ether, 899), expectedCUs(400, 899));
  }
}
