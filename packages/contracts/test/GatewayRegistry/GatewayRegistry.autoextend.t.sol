pragma solidity 0.8.20;

import "forge-std/Test.sol";
import "./GatewayRegistryTest.sol";

contract GatewayRegistryAutoExtensionTest is GatewayRegistryTest {
  function goToNextEpoch() internal {
    uint128 nextEpoch = router.networkController().nextEpoch();
    vm.roll(nextEpoch);
  }

  function test_stakeNeverExpiresWhenAutoextendIsOn() public {
    gatewayRegistry.stake(100 ether, 100, true);
    goToNextEpoch();
    assertEq(gatewayRegistry.computationUnitsAvailable(peerId), 500);
    vm.roll(block.number + 10000);
    assertEq(gatewayRegistry.computationUnitsAvailable(peerId), 500);
    gatewayRegistry.disableAllAutoExtensions();
    vm.roll(block.number + 100);
    assertEq(gatewayRegistry.computationUnitsAvailable(peerId), 0);
  }

  function test_disablingAutoextendWillUnlockStakeAtNextUnlockPeriod() public {
    gatewayRegistry.stake(100 ether, 100, true);
    goToNextEpoch();
    vm.roll(block.number + 10000);
    vm.roll(block.number + 33);
    gatewayRegistry.disableAllAutoExtensions();
    uint128 lockStart = gatewayRegistry.getStakes(address(this))[0].lockStart;
    uint128 lockEnd = gatewayRegistry.getStakes(address(this))[0].lockEnd;
    assertEq(lockEnd - block.number, 67);
    assertEq((lockEnd - lockStart) % 100, 0);
  }

  function test_CanEnableAndDisableAutoextendForNotStartedStakes() public {
    gatewayRegistry.stake(100 ether, 100, true);
    gatewayRegistry.disableAllAutoExtensions();
    uint128 lockStart = gatewayRegistry.getStakes(address(this))[0].lockStart;
    uint128 lockEnd = gatewayRegistry.getStakes(address(this))[0].lockEnd;
    assertEq(lockEnd - lockStart, 100);
    gatewayRegistry.enableAllAutoExtensions();

    goToNextEpoch();
    gatewayRegistry.disableAutoExtension(0);
    lockStart = gatewayRegistry.getStakes(address(this))[0].lockStart;
    lockEnd = gatewayRegistry.getStakes(address(this))[0].lockEnd;
    assertEq(lockEnd - lockStart, 100);
    gatewayRegistry.enableAutoExtension(0);

    vm.roll(block.number + 1);
    gatewayRegistry.disableAutoExtension(0);
    lockStart = gatewayRegistry.getStakes(address(this))[0].lockStart;
    lockEnd = gatewayRegistry.getStakes(address(this))[0].lockEnd;
    assertEq(lockEnd - lockStart, 100);
    gatewayRegistry.enableAutoExtension(0);

    vm.roll(lockStart + 99);
    gatewayRegistry.disableAutoExtension(0);
    lockStart = gatewayRegistry.getStakes(address(this))[0].lockStart;
    lockEnd = gatewayRegistry.getStakes(address(this))[0].lockEnd;
    assertEq(lockEnd - lockStart, 100);
    gatewayRegistry.enableAutoExtension(0);

    vm.roll(block.number + 1);
    gatewayRegistry.disableAutoExtension(0);
    lockStart = gatewayRegistry.getStakes(address(this))[0].lockStart;
    lockEnd = gatewayRegistry.getStakes(address(this))[0].lockEnd;
    assertEq(lockEnd - lockStart, 200);
    gatewayRegistry.enableAutoExtension(0);
  }

  function test_RevertsIfOutOfRange() public {
    gatewayRegistry.stake(100 ether, 100, true);
    vm.expectRevert();
    gatewayRegistry.disableAutoExtension(1);
  }
}
