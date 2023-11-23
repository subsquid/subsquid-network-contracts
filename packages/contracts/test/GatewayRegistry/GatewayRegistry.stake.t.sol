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

  function test_SortsStakesFromLeastOptimalStake() public {
    gatewayRegistry.stake(10 ether, 30 days);
    gatewayRegistry.stake(5 ether, 180 days);
    gatewayRegistry.stake(1 ether, 90 days);
    assertStake(0, 10 ether, block.timestamp + 30 days);
    assertStake(1, 1 ether, block.timestamp + 90 days);
    assertStake(2, 5 ether, block.timestamp + 180 days);
  }

  function test_StakingIncreasesStakedAmount() public {
    gatewayRegistry.stake(100, 200);
    assertEq(gatewayRegistry.staked(address(this)), 100);
    gatewayRegistry.stake(1000, 2000);
    assertEq(gatewayRegistry.staked(address(this)), 1100);
  }

  function test_IncreasesComputationalUnits() public {
    gatewayRegistry.stake(10 ether, 30 days);
    assertEq(gatewayRegistry.computationUnits(address(this)), 400);
    gatewayRegistry.stake(5 ether, 180 days);
    assertEq(gatewayRegistry.computationUnits(address(this)), 2800);
    gatewayRegistry.stake(1 ether, 90 days);
    assertEq(gatewayRegistry.computationUnits(address(this)), 2800 + 168);
  }

  function test_EmitsEvent() public {
    vm.expectEmit(address(gatewayRegistry));
    emit Staked(address(this), 100, 200, block.timestamp + 200);
    gatewayRegistry.stake(100, 200);
  }

  function test_RevertsIf_NotRegistered() public {
    gatewayRegistry.unregister();
    vm.expectRevert("Gateway not registered");
    gatewayRegistry.stake(100, 200);
  }
}
