// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import "./BaseTest.sol";
import "../src/Vesting.sol";

contract SubsquidVestingTest is BaseTest {
  SubsquidVesting vesting;
  tSQD token;
  Router router;
  uint64 month = 30 days;

  function setUp() public {
    (token, router) = deployAll();
    vesting = new SubsquidVesting(token, router, address(this), uint64(block.timestamp + 6 * month), 30 * month);
  }

  function test_NothingIsVestedIfNothingWasDeposited() public {
    vm.warp(block.timestamp + 200 days);
    assertEq(vesting.releasable(address(token)), 0);
    vm.warp(block.timestamp + 50 * month);
    assertEq(vesting.releasable(address(token)), 0);
  }

  uint256 vestedMonthly = 10_000;
  //                 6 months cliff     70k/30 80k*2/30 90k*3/30 100k*4/30
  uint256[] year1 = [0, 0, 0, 0, 0, 0, 0, 2_333, 5_333, 9_000, 13_333, 18_333, 24_000];
  uint256[] year2 = [30333, 37333, 45000, 53333, 62333, 72000, 82333, 93333, 105000, 117333, 130333, 144000];
  uint256[] year3 = [158333, 173333, 189000, 205333, 222333, 240000, 258333, 277333, 297000, 317333, 338333, 360000];
  uint256[] year4 = [360000, 360000, 360000, 360000, 360000, 360000];

  function test_NormalVestingSchedule() public {
    uint256[] memory vestedAmounts = _concatArrays(year1, year2, year3, year4);
    for (uint256 i = 0; i < vestedAmounts.length; i++) {
      assertEq(vesting.releasable(address(token)), vestedAmounts[i]);
      vm.warp(block.timestamp + month);
      if (i < 36) {
        token.transfer(address(vesting), vestedMonthly);
      }
    }
  }

  function test_RegisteringAWorker() public {
    token.transfer(address(vesting), 10 ether);
    bytes memory call = abi.encodeCall(IWorkerRegistration.register, ("test-peer-id-1", "metadata"));
    vesting.execute(address(router.workerRegistration()), call, 10 ether);
    assertEq(router.workerRegistration().getOwnedWorkers(address(vesting)).length, 1);
  }

  function test_RetiringAWorker() public {
    token.transfer(address(vesting), 10 ether);
    bytes memory call = abi.encodeWithSelector(IWorkerRegistration.register.selector, "test-peer-id-1", "metadata");
    vesting.execute(address(router.workerRegistration()), call, 10 ether);
    bytes memory call2 = abi.encodeWithSelector(WorkerRegistration.deregister.selector, "test-peer-id-1");
    vm.roll(block.number + 10);
    vesting.execute(address(router.workerRegistration()), call2);
    vm.roll(block.number + 10);
    bytes memory call3 = abi.encodeWithSelector(WorkerRegistration.withdraw.selector, "test-peer-id-1");
    vesting.execute(address(router.workerRegistration()), call3);
    assertEq(router.workerRegistration().getActiveWorkerCount(), 0);
  }

  function test_StakeAndClaimRewards() public {
    token.transfer(address(vesting), 30 ether);
    token.transfer(router.rewardTreasury(), 30 ether);
    bytes memory call = abi.encodeWithSelector(IWorkerRegistration.register.selector, "test-peer-id-1", "metadata");
    vesting.execute(address(router.workerRegistration()), call, 10 ether);
    bytes memory call2 = abi.encodeWithSelector(Staking.deposit.selector, 0, 1 ether);
    vesting.execute(address(router.staking()), call2, 1 ether);
    Staking staking = Staking(address(router.staking()));
    MockRewardsDistribution rewardsDistribution = new MockRewardsDistribution();
    staking.grantRole(staking.REWARDS_DISTRIBUTOR_ROLE(), address(rewardsDistribution));
    RewardTreasury(router.rewardTreasury()).setWhitelistedDistributor(rewardsDistribution, true);
    address receiver = address(2137);
    bytes memory call3 =
      abi.encodeWithSelector(RewardTreasury.claimFor.selector, address(rewardsDistribution), receiver);
    vesting.execute(address(router.rewardTreasury()), call3);
    assertEq(token.balanceOf(receiver), 69);
  }

  function test_RevertsIf_CallToUnallowedContract() public {
    vm.expectRevert("Target is not allowed");
    bytes memory call = abi.encodeWithSelector(IERC20.transfer.selector, address(this), 10);
    vesting.execute(address(token), call);
  }

  function _concatArrays(uint256[] memory a, uint256[] memory b, uint256[] memory c, uint256[] memory d)
    internal
    pure
    returns (uint256[] memory)
  {
    uint256[] memory result = new uint[](a.length + b.length + c.length + d.length);
    uint256 counter = 0;
    for (uint256 i = 0; i < a.length; i++) {
      result[counter] = a[i];
      counter++;
    }
    for (uint256 i = 0; i < b.length; i++) {
      result[counter] = b[i];
      counter++;
    }
    for (uint256 i = 0; i < c.length; i++) {
      result[counter] = c[i];
      counter++;
    }
    for (uint256 i = 0; i < d.length; i++) {
      result[counter] = d[i];
      counter++;
    }
    return result;
  }
}
