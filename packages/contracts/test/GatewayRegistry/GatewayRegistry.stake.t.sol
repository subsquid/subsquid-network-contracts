pragma solidity 0.8.18;

import "forge-std/Test.sol";
import "./GatewayRegistryTest.sol";

contract GatewayRegistryStakeTest is GatewayRegistryTest {
  function test_StakingTransfersTokensToContract() public {
    uint256 balanceBefore = token.balanceOf(address(this));
    gatewayRegistry.stake(100, 200);
    assertEq(token.balanceOf(address(this)), balanceBefore - 100);
    assertEq(token.balanceOf(address(gatewayRegistry)), 100);
  }

  function test_StakingStoresStakedAmountAndUnlockTimestamp() public {
    gatewayRegistry.stake(100, 200);
    assertStake(0, 100, block.timestamp + 200);
    gatewayRegistry.stake(1000, 2000);
    assertStake(1, 1000, block.timestamp + 2000);
  }

  function test_StakingIncreasesStakedAmount() public {
    gatewayRegistry.stake(100, 200);
    assertEq(gatewayRegistry.staked(address(this)), 100);
    gatewayRegistry.stake(1000, 2000);
    assertEq(gatewayRegistry.staked(address(this)), 1100);
  }

  function test_EmitsEvent() public {
    vm.expectEmit(address(gatewayRegistry));
    emit Staked(address(this), 100, 200, block.timestamp + 200);
    gatewayRegistry.stake(100, 200);
  }
}
