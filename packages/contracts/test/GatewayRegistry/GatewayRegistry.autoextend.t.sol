pragma solidity 0.8.20;

import "forge-std/Test.sol";
import "./GatewayRegistryTest.sol";

contract GatewayRegistryAutoExtensionTest is GatewayRegistryTest {
  function test_stakeNeverExpiresWhenAutoextendIsOn() public {
    gatewayRegistry.stake(100 ether, 100, true);
    goToNextEpoch();
    assertEq(gatewayRegistry.computationUnitsAvailable(peerId), 500);
    vm.roll(block.number + 10000);
    assertEq(gatewayRegistry.computationUnitsAvailable(peerId), 500);
    gatewayRegistry.disableAutoExtension();
    vm.roll(block.number + 100);
    assertEq(gatewayRegistry.computationUnitsAvailable(peerId), 0);
  }

  function test_disablingAutoextendWillUnlockStakeAtNextUnlockPeriod() public {
    gatewayRegistry.stake(100 ether, 100, true);
    goToNextEpoch();
    vm.roll(block.number + 10000);
    vm.roll(block.number + 33);
    gatewayRegistry.disableAutoExtension();
    uint128 lockStart = gatewayRegistry.getStake(address(this)).lockStart;
    uint128 lockEnd = gatewayRegistry.getStake(address(this)).lockEnd;
    assertEq(lockEnd - block.number, 67);
    assertEq((lockEnd - lockStart) % 100, 0);
  }

  function test_CanEnableAndDisableAutoextendForNotStartedStakes() public {
    gatewayRegistry.stake(100 ether, 100, true);
    gatewayRegistry.disableAutoExtension();
    uint128 lockStart = gatewayRegistry.getStake(address(this)).lockStart;
    uint128 lockEnd = gatewayRegistry.getStake(address(this)).lockEnd;
    assertEq(lockEnd - lockStart, 100);
    gatewayRegistry.enableAutoExtension();

    goToNextEpoch();
    gatewayRegistry.disableAutoExtension();
    lockStart = gatewayRegistry.getStake(address(this)).lockStart;
    lockEnd = gatewayRegistry.getStake(address(this)).lockEnd;
    assertEq(lockEnd - lockStart, 100);
    gatewayRegistry.enableAutoExtension();

    vm.roll(block.number + 1);
    gatewayRegistry.disableAutoExtension();
    lockStart = gatewayRegistry.getStake(address(this)).lockStart;
    lockEnd = gatewayRegistry.getStake(address(this)).lockEnd;
    assertEq(lockEnd - lockStart, 100);
    gatewayRegistry.enableAutoExtension();

    vm.roll(lockStart + 99);
    gatewayRegistry.disableAutoExtension();
    lockStart = gatewayRegistry.getStake(address(this)).lockStart;
    lockEnd = gatewayRegistry.getStake(address(this)).lockEnd;
    assertEq(lockEnd - lockStart, 100);
    gatewayRegistry.enableAutoExtension();

    vm.roll(block.number + 1);
    gatewayRegistry.disableAutoExtension();
    lockStart = gatewayRegistry.getStake(address(this)).lockStart;
    lockEnd = gatewayRegistry.getStake(address(this)).lockEnd;
    assertEq(lockEnd - lockStart, 200);
    gatewayRegistry.enableAutoExtension();
  }
}
