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
    gatewayRegistry.stake(peerId, 100, 200);
    assertEq(token.balanceOf(address(this)), balanceBefore - 100);
    assertEq(token.balanceOf(address(gatewayRegistry)), 100);
  }

  function test_StakingStoresStakedAmountAndUnlockTimestamp() public {
    gatewayRegistry.stake(peerId, 100, 200);
    assertStake(0, 100, 205);
    gatewayRegistry.stake(peerId, 1000, 2000);
    assertStake(1, 1000, 2005);
  }

  function test_StakingIncreasesStakedAmount() public {
    gatewayRegistry.stake(peerId, 100, 200);
    assertEq(gatewayRegistry.staked(peerId), 100);
    gatewayRegistry.stake(peerId, 1000, 2000);
    assertEq(gatewayRegistry.staked(peerId), 1100);
  }

  function test_IncreasesComputationalUnits() public {
    gatewayRegistry.stake(peerId, 10 ether, 150_000);
    goToNextEpoch();
    assertEq(gatewayRegistry.computationUnitsAvailable(peerId), 50);
    gatewayRegistry.stake(peerId, 5 ether, 900_000);
    goToNextEpoch();
    assertEq(gatewayRegistry.computationUnitsAvailable(peerId), 90);
    gatewayRegistry.stake(peerId, 1 ether, 450_000);
    goToNextEpoch();
    assertEq(gatewayRegistry.computationUnitsAvailable(peerId), 96);
  }

  function test_EmitsEvent() public {
    vm.expectEmit(address(gatewayRegistry));
    uint128 nextEpoch = router.networkController().nextEpoch();
    emit Staked(address(this), peerId, 100, nextEpoch, nextEpoch + 200, 0);
    gatewayRegistry.stake(peerId, 100, 200);
  }

  function test_RevertsIf_NotRegistered() public {
    gatewayRegistry.unregister(peerId);
    vm.expectRevert("Gateway not registered");
    gatewayRegistry.stake(peerId, 100, 200);
  }

  function test_computationUnitsExpireAfterStakeUnlocks() public {
    gatewayRegistry.stake(peerId, 10 ether, 7500);
    gatewayRegistry.stake(peerId, 20 ether, 100000);
    gatewayRegistry.stake(peerId, 40 ether, 200000);
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
