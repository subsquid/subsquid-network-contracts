pragma solidity 0.8.20;

import "forge-std/Test.sol";
import "./GatewayRegistryTest.sol";

contract GatewayRegistryUnStakeTest is GatewayRegistryTest {
  function test_RevertsIf_UnstakedWithoutStake() public {
    vm.expectRevert("Not enough funds to unstake");
    gatewayRegistry.unstake();
  }

  function test_RevertsIf_TryingToUnstakeLockedAmount() public {
    gatewayRegistry.stake(100, 200);
    vm.expectRevert("Not enough funds to unstake");
    gatewayRegistry.unstake();
  }

  function test_UnstakeDecreasesStakedAmount() public {
    gatewayRegistry.stake(100, 200);
    vm.roll(block.number + 300);
    gatewayRegistry.unstake();
    assertEq(gatewayRegistry.staked(address(this)), 50);
  }
}
