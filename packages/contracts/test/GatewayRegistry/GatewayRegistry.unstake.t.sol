pragma solidity 0.8.18;

import "forge-std/Test.sol";
import "./GatewayRegistryTest.sol";

contract GatewayRegistryStakeTest is GatewayRegistryTest {
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

  function test_DecreasesStakedAmounts() public {
    gatewayRegistry.stake(100, 200);
    gatewayRegistry.stake(1000, 150);
    uint timeStart = block.timestamp;
    vm.warp(block.timestamp + 200);
    gatewayRegistry.unstake(150);
    assertStake(0, 0, timeStart + 200);
    assertStake(1, 950, timeStart + 150);
  }
}
