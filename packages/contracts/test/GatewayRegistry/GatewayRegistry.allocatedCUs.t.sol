pragma solidity 0.8.20;

import "forge-std/Test.sol";
import "./GatewayRegistryTest.sol";

contract GatewayRegistryAllocatedCUTest is GatewayRegistryTest {
  function expectedCUs(uint256 amount, uint256 duration) public view returns (uint256) {
    return uint256(amount * duration * rewardCalc.boostFactor(duration * 12) / 10000);
  }

  function test_availableCUs() public {
    assertEq(gatewayRegistry.computationUnitsAmount(100 ether, 18000), expectedCUs(100, 18000));
    assertEq(gatewayRegistry.computationUnitsAmount(200 ether, 14500), expectedCUs(200, 14500));
    assertEq(gatewayRegistry.computationUnitsAmount(400 ether, 14000), expectedCUs(400, 14000));
  }

  function test_LockShorterThanEpochNotGreaterThanTotalCUAmount() public {
    gatewayRegistry.stake(10 ether, 5, true);
    NetworkController(address(router.networkController())).setEpochLength(150);
    goToNextEpoch();
    assertEq(gatewayRegistry.computationUnitsAvailable(peerId), 50);
  }
}
