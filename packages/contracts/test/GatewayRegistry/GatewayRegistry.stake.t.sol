pragma solidity 0.8.20;

import "forge-std/Test.sol";
import "./GatewayRegistryTest.sol";

contract GatewayRegistryStakeTest is GatewayRegistryTest {
  function test_StakingTransfersTokensToContract() public {
    uint256 balanceBefore = token.balanceOf(address(this));
    gatewayRegistry.stake(peerId, 100, 200);
    assertEq(token.balanceOf(address(this)), balanceBefore - 100);
    assertEq(token.balanceOf(address(gatewayRegistry)), 100);
  }

  function test_StakingStoresStakedAmountAndUnlockTimestamp() public {
    gatewayRegistry.stake(peerId, 100, 200);
    assertStake(0, 100, 200);
    gatewayRegistry.stake(peerId, 1000, 2000);
    assertStake(1, 1000, 2000);
  }

  function test_StakingIncreasesStakedAmount() public {
    gatewayRegistry.stake(peerId, 100, 200);
    assertEq(gatewayRegistry.staked(peerId), 100);
    gatewayRegistry.stake(peerId, 1000, 2000);
    assertEq(gatewayRegistry.staked(peerId), 1100);
  }

  function test_IncreasesComputationalUnits() public {
    gatewayRegistry.stake(peerId, 10 ether, 150);
    assertEq(gatewayRegistry.computationUnitsAvailable(peerId), 10_000); // 10 * 150 = 1500 total
    gatewayRegistry.stake(peerId, 5 ether, 900);
    assertEq(gatewayRegistry.computationUnitsAvailable(peerId), 20_000); // 10 * 900 + 1500 = 10500 total
    gatewayRegistry.stake(peerId, 1 ether, 450);
    assertEq(gatewayRegistry.computationUnitsAvailable(peerId), 21_250); // 1.250 * 450 + 10500 = 11062.5 total
  }

  function test_EmitsEvent() public {
    vm.expectEmit(address(gatewayRegistry));
    emit Staked(address(this), peerId, 100, 200, 200, 0);
    gatewayRegistry.stake(peerId, 100, 200);
  }

  function test_RevertsIf_NotRegistered() public {
    gatewayRegistry.unregister(peerId);
    vm.expectRevert("Gateway not registered");
    gatewayRegistry.stake(peerId, 100, 200);
  }

  function test_computationUnitsExpireAfterStakeUnlocks() public {
    gatewayRegistry.stake(peerId, 10 ether, 150);
    assertEq(gatewayRegistry.computationUnitsAvailable(peerId), 10_000);
    gatewayRegistry.stake(peerId, 20 ether, 200);
    assertEq(gatewayRegistry.computationUnitsAvailable(peerId), 30_000);
    gatewayRegistry.stake(peerId, 40 ether, 100);
    assertEq(gatewayRegistry.computationUnitsAvailable(peerId), 70_000);
    vm.roll(block.number + 99 * router.networkController().epochLength());
    assertEq(gatewayRegistry.computationUnitsAvailable(peerId), 70_000);
    vm.roll(block.number + router.networkController().epochLength());
    assertEq(gatewayRegistry.computationUnitsAvailable(peerId), 30_000);
    vm.roll(block.number + 50 * router.networkController().epochLength());
    assertEq(gatewayRegistry.computationUnitsAvailable(peerId), 20_000);
    vm.roll(block.number + 50 * router.networkController().epochLength());
    assertEq(gatewayRegistry.computationUnitsAvailable(peerId), 0);
  }
}
