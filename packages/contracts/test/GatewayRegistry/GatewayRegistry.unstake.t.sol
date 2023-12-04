pragma solidity 0.8.19;

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

  function test_ProportionallyDecreasesComputationalUnits() public {
    uint256 amount = 100 ether;
    gatewayRegistry.stake(amount, 30 days);
    vm.warp(block.timestamp + 30 days);
    assertEq(gatewayRegistry.computationUnits(address(this)), 4000);
    gatewayRegistry.unstake(amount / 3);
    assertEq(gatewayRegistry.computationUnits(address(this)), 2667);
  }

  function test_DecreasesStakedAmounts() public {
    gatewayRegistry.stake(100, 200);
    gatewayRegistry.stake(1000, 150);
    uint256 timeStart = block.timestamp;
    vm.warp(block.timestamp + 200);
    gatewayRegistry.unstake(150);
    assertStake(0, 0, timeStart + 200);
    assertStake(1, 950, timeStart + 150);
  }
}
