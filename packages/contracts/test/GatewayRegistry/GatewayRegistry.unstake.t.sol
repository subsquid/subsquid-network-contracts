pragma solidity 0.8.20;

import "forge-std/Test.sol";
import "./GatewayRegistryTest.sol";

contract GatewayRegistryUnStakeTest is GatewayRegistryTest {
  function test_RevertsIf_UnstakedWithoutStake() public {
    vm.expectRevert("Not enough funds to unstake");
    gatewayRegistry.unstake(100);
  }

  function test_RevertsIf_TryingToUnstakeLockedAmount() public {
    gatewayRegistry.stake(100, 200);
    vm.expectRevert("Not enough funds to unstake");
    gatewayRegistry.unstake(100);
  }

  function test_UnstakeDecreasesStakedAmount() public {
    gatewayRegistry.stake(100, 200);
    vm.warp(block.timestamp + 200);
    gatewayRegistry.unstake(50);
    assertEq(gatewayRegistry.staked(address(this)), 50);
  }

  function test_DoesNotChangeComputationalUnits() public {
    uint256 amount = 100 ether;
    gatewayRegistry.stake(amount, 30 days);
    vm.warp(block.timestamp + 30 days);
    assertEq(gatewayRegistry.computationUnits(address(this)), 4000);
    gatewayRegistry.unstake(amount / 3);
    assertEq(gatewayRegistry.computationUnits(address(this)), 4000);
    gatewayRegistry.unstake(amount / 2);
    assertEq(gatewayRegistry.computationUnits(address(this)), 4000);
  }
}
