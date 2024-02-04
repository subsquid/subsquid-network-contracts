pragma solidity 0.8.20;

import "forge-std/Test.sol";
import "./GatewayRegistryTest.sol";

contract GatewayRegistryStakeTest is GatewayRegistryTest {
  function goToNextEpoch() internal {
    uint128 nextEpoch = router.networkController().nextEpoch();
    vm.roll(nextEpoch);
  }

  function test_StakingTransfersTokensToContract() public {
    uint256 balanceBefore = token.balanceOf(address(this));
    gatewayRegistry.stake(100, 200);
    assertEq(token.balanceOf(address(this)), balanceBefore - 100);
    assertEq(token.balanceOf(address(gatewayRegistry)), 100);
  }

  function test_StakingStoresStakedAmountAndUnlockTimestamp() public {
    gatewayRegistry.stake(100, 200);
    assertStake(0, 100, 205);
    gatewayRegistry.stake(1000, 2000);
    assertStake(1, 1000, 2005);
  }

  function test_StakingIncreasesStakedAmount() public {
    gatewayRegistry.stake(100, 200);
    assertEq(gatewayRegistry.staked(address(this)), 100);
    gatewayRegistry.stake(1000, 2000);
    assertEq(gatewayRegistry.staked(address(this)), 1100);
  }

  function test_IncreasesComputationalUnits() public {
    gatewayRegistry.stake(10 ether, 150_000);
    goToNextEpoch();
    assertEq(gatewayRegistry.computationUnitsAvailable(peerId), 50);
    gatewayRegistry.stake(5 ether, 900_000);
    goToNextEpoch();
    assertEq(gatewayRegistry.computationUnitsAvailable(peerId), 90);
    gatewayRegistry.stake(1 ether, 450_000);
    goToNextEpoch();
    assertEq(gatewayRegistry.computationUnitsAvailable(peerId), 96);
  }

  function test_EmitsEvent() public {
    vm.expectEmit(address(gatewayRegistry));
    uint128 nextEpoch = router.networkController().nextEpoch();
    emit Staked(address(this), 100, nextEpoch, nextEpoch + 200, 0);
    gatewayRegistry.stake(100, 200);
  }

  function test_computationUnitsExpireAfterStakeUnlocks() public {
    gatewayRegistry.stake(10 ether, 7500);
    gatewayRegistry.stake(20 ether, 100000);
    gatewayRegistry.stake(40 ether, 200000);
    uint256 nextEpochStart = router.networkController().nextEpoch();
    vm.roll(nextEpochStart + 7500 - 1);
    assertEq(gatewayRegistry.computationUnitsAvailable(peerId), 350);
    vm.roll(block.number + 1);
    assertEq(gatewayRegistry.computationUnitsAvailable(peerId), 300);
    vm.roll(block.number + 92500);
    assertEq(gatewayRegistry.computationUnitsAvailable(peerId), 200);
    vm.roll(block.number + 100000);
    assertEq(gatewayRegistry.computationUnitsAvailable(peerId), 0);
  }
}
