// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.16;

import "forge-std/Test.sol";
import "../src/RewardCalculation.sol";
import "../src/WorkerRegistration.sol";
import "../src/tSQD.sol";
import "../src/NetworkController.sol";

contract RewardCalculationTest is Test {
  RewardCalculation rewardCalculation;

  function setUp() public {
    uint256[] memory shares = new uint256[](1);
    shares[0] = 100;
    address[] memory holders = new address[](1);
    holders[0] = address(this);

    tSQD token = new tSQD(holders, shares);
    NetworkController nc = new NetworkController(2, 100);
    WorkerRegistration workerRegistration =
      new WorkerRegistration(token, nc, new Staking(token, nc));

    rewardCalculation = new RewardCalculation(workerRegistration);
  }

  function testApy() public {
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
  }
}
