pragma solidity 0.8.20;

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
    assertStake(0, 100, 200);
    gatewayRegistry.stake(1000, 2000);
    assertStake(1, 1000, 2000);
  }

  function test_StakingIncreasesStakedAmount() public {
    gatewayRegistry.stake(100, 200);
    assertEq(gatewayRegistry.staked(address(this)), 100);
    gatewayRegistry.stake(1000, 2000);
    assertEq(gatewayRegistry.staked(address(this)), 1100);
  }

  function test_IncreasesComputationalUnits() public {
    gatewayRegistry.stake(10 ether, 150);
    assertEq(gatewayRegistry.computationUnitsAvailable(address(this)), 10_000); // 10 * 150 = 1500 total
    gatewayRegistry.stake(5 ether, 900);
    assertEq(gatewayRegistry.computationUnitsAvailable(address(this)), 20_000); // 10 * 900 + 1500 = 10500 total
    gatewayRegistry.stake(1 ether, 450);
    assertEq(gatewayRegistry.computationUnitsAvailable(address(this)), 21_250); // 1.250 * 450 + 10500 = 11062.5 total
  }

  function test_EmitsEvent() public {
    vm.expectEmit(address(gatewayRegistry));
    emit Staked(address(this), 100, 200, 200, 0);
    gatewayRegistry.stake(100, 200);
  }

  function test_RevertsIf_NotRegistered() public {
    gatewayRegistry.unregister();
    vm.expectRevert("Gateway not registered");
    gatewayRegistry.stake(100, 200);
  }

  function test_computationUnitsExpireAfterStakeUnlocks() public {
    gatewayRegistry.stake(10 ether, 150);
    assertEq(gatewayRegistry.computationUnitsAvailable(address(this)), 10_000);
    gatewayRegistry.stake(20 ether, 200);
    assertEq(gatewayRegistry.computationUnitsAvailable(address(this)), 30_000);
    gatewayRegistry.stake(40 ether, 100);
    assertEq(gatewayRegistry.computationUnitsAvailable(address(this)), 70_000);
    vm.roll(block.number + 99 * router.networkController().epochLength());
    assertEq(gatewayRegistry.computationUnitsAvailable(address(this)), 70_000);
    vm.roll(block.number + router.networkController().epochLength());
    assertEq(gatewayRegistry.computationUnitsAvailable(address(this)), 30_000);
    vm.roll(block.number + 50 * router.networkController().epochLength());
    assertEq(gatewayRegistry.computationUnitsAvailable(address(this)), 20_000);
    vm.roll(block.number + 50 * router.networkController().epochLength());
    assertEq(gatewayRegistry.computationUnitsAvailable(address(this)), 0);
  }
}
