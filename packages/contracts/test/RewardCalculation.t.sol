// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "../src/RewardCalculation.sol";
import "../src/WorkerRegistration.sol";
import "../src/tSQD.sol";
import "../src/NetworkController.sol";
import "../src/Staking.sol";
import "./BaseTest.sol";

contract RewardCalculationTest is BaseTest {
  RewardCalculation rewardCalculation;
  uint256 constant bondAmount = 10 ether;

  function setUp() public {
    (, Router router) = deployAll();
    rewardCalculation = new RewardCalculation(router);
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
      address(rewardCalculation.router().workerRegistration()),
      abi.encodeWithSelector(WorkerRegistration.getActiveWorkerCount.selector),
      abi.encode(n)
    );
    vm.mockCall(
      address(rewardCalculation.router().workerRegistration()),
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

  function test_BoostFactor() public {
    assertEq(rewardCalculation.boostFactor(1 days), 10000);
    assertEq(rewardCalculation.boostFactor(59 days), 10000);
    assertEq(rewardCalculation.boostFactor(60 days), 12000);
    assertEq(rewardCalculation.boostFactor(89 days), 12000);
    assertEq(rewardCalculation.boostFactor(90 days), 14000);
    assertEq(rewardCalculation.boostFactor(179 days), 18000);
    assertEq(rewardCalculation.boostFactor(180 days), 20000);
    assertEq(rewardCalculation.boostFactor(359 days), 20000);
    assertEq(rewardCalculation.boostFactor(360 days), 25000);
    assertEq(rewardCalculation.boostFactor(719 days), 25000);
    assertEq(rewardCalculation.boostFactor(720 days), 30000);
    assertEq(rewardCalculation.boostFactor(10000 days), 30000);
  }
}
