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
    assertStake(0, 100, 205);
    goToNextEpoch();
    gatewayRegistry.addStake(1000);
    assertStake(0, 1100, 210);
  }

  function test_StakingIncreasesStakedAmount() public {
    gatewayRegistry.stake(100, 200);
    assertEq(gatewayRegistry.staked(address(this)), 100);
    goToNextEpoch();
    gatewayRegistry.addStake(1000);
    assertEq(gatewayRegistry.staked(address(this)), 1100);
  }

  function test_IncreasesComputationalUnits() public {
    gatewayRegistry.stake(10 ether, 150_000);
    goToNextEpoch();
    assertEq(gatewayRegistry.computationUnitsAvailable(peerId), 50);
    gatewayRegistry.addStake(5 ether);
    goToNextEpoch();
    assertEq(gatewayRegistry.computationUnitsAvailable(peerId), 75);
    gatewayRegistry.addStake(1 ether);
    goToNextEpoch();
    assertEq(gatewayRegistry.computationUnitsAvailable(peerId), 80);
  }

  function test_EmitsEvent() public {
    vm.expectEmit(address(gatewayRegistry));
    uint128 nextEpoch = router.networkController().nextEpoch();
    emit Staked(address(this), 100, nextEpoch, nextEpoch + 200, 0);
    gatewayRegistry.stake(100, 200);
  }
}
