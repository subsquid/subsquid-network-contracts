pragma solidity 0.8.20;

import "forge-std/Test.sol";
import "./GatewayRegistryTest.sol";

contract GatewayRegistryUnStakeTest is GatewayRegistryTest {
  function test_RevertsIf_UnstakedWithoutStake() public {
    vm.expectRevert("Not enough funds to unstake");
    gatewayRegistry.unstake(peerId, 100);
  }

  function test_RevertsIf_TryingToUnstakeLockedAmount() public {
    gatewayRegistry.stake(peerId, 100, 200);
    vm.expectRevert("Not enough funds to unstake");
    gatewayRegistry.unstake(peerId, 100);
  }

  function test_UnstakeDecreasesStakedAmount() public {
    gatewayRegistry.stake(peerId, 100, 200);
    vm.roll(block.number + 300);
    gatewayRegistry.unstake(peerId, 50);
    assertEq(gatewayRegistry.staked(peerId), 50);
  }

  function test_DoesNotChangeComputationalUnits() public {
    uint256 amount = 100 ether;
    gatewayRegistry.stake(peerId, amount, 300);
    gatewayRegistry.stake(peerId, amount, 600);
    vm.roll(block.number + 400);
    assertEq(gatewayRegistry.computationUnitsAvailable(peerId), 500);
    gatewayRegistry.unstake(peerId, amount / 3);
    assertEq(gatewayRegistry.computationUnitsAvailable(peerId), 500);
    gatewayRegistry.unstake(peerId, amount / 2);
    assertEq(gatewayRegistry.computationUnitsAvailable(peerId), 500);
  }
}
