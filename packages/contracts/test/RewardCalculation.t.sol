// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.18;

import "forge-std/Test.sol";
import "../src/RewardCalculation.sol";
import "../src/WorkerRegistration.sol";
import "../src/testnet/tSQD.sol";
import "../src/NetworkController.sol";
import "../src/Staking.sol";

contract RewardCalculationTest is Test {
  RewardCalculation rewardCalculation;
  uint256 constant bondAmount = 10 ether;

  function setUp() public {
    uint256[] memory shares = new uint256[](1);
    shares[0] = 100;
    address[] memory holders = new address[](1);
    holders[0] = address(this);

    tSQD token = new tSQD(holders, shares);
    NetworkController nc = new NetworkController(2, bondAmount);
    WorkerRegistration workerRegistration = new WorkerRegistration(token, nc, new Staking(token, nc));

    rewardCalculation = new RewardCalculation(workerRegistration, nc);
  }

  function test_Apy() public {
    assertEq(rewardCalculation.apy(10, 0), 7000);
    assertEq(rewardCalculation.apy(1000, 0), 7000);
    assertEq(rewardCalculation.apy(1000, 100), 7000);
    assertEq(rewardCalculation.apy(1000, 150), 6750);
    assertEq(rewardCalculation.apy(1000, 200), 6500);
    assertEq(rewardCalculation.apy(1000, 250), 6250);
    assertEq(rewardCalculation.apy(1000, 300), 6000);
    assertEq(rewardCalculation.apy(1000, 900), 3000);
    assertEq(rewardCalculation.apy(1000, 1000), 2500);
    assertEq(rewardCalculation.apy(1000, 1001), 2000);
    assertEq(rewardCalculation.apy(1000, 2000), 1500);
    assertEq(rewardCalculation.apy(1000, 3000), 1000);
    assertEq(rewardCalculation.apy(1000, 4000), 500);
    assertEq(rewardCalculation.apy(1000, 5000), 0);
    assertEq(rewardCalculation.apy(1000, 6000), 0);
    assertEq(rewardCalculation.apy(1000, 30000), 0);
  }

  function mockWorkersCount(uint256 n) internal {
    vm.mockCall(
      address(rewardCalculation.workerRegistration()),
      abi.encodeWithSelector(WorkerRegistration.getActiveWorkerCount.selector),
      abi.encode(n)
    );
    vm.mockCall(
      address(rewardCalculation.workerRegistration()),
      abi.encodeWithSelector(WorkerRegistration.effectiveTVL.selector),
      abi.encode(n * bondAmount)
    );
  }

  function test_currentApy() public {
    mockWorkersCount(0);
    assertEq(rewardCalculation.currentApy(1000), 7000);
    mockWorkersCount(1);
    assertEq(rewardCalculation.currentApy(1000), 2500);
    mockWorkersCount(2);
    assertEq(rewardCalculation.currentApy(1000), 1500);
    mockWorkersCount(3);
    assertEq(rewardCalculation.currentApy(1000), 1000);
    mockWorkersCount(4);
    assertEq(rewardCalculation.currentApy(1000), 500);
    mockWorkersCount(10);
    assertEq(rewardCalculation.currentApy(1000), 0);
  }

  function test_EpochLengthLinearlyDependsOnEpochTime() public {
    mockWorkersCount(5);
    assertEq(rewardCalculation.epochReward(5000, 10 * 60) / 1e12, 237);
    assertEq(rewardCalculation.epochReward(5000, 20 * 60) / 1e12, 475);
    assertEq(rewardCalculation.epochReward(5000, 40 * 60) / 1e12, 951);
  }
}
