// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "../BaseTest.sol";
import "forge-std/StdJson.sol";
import "../../src/Vesting.sol";
import "../../src/VestingFactory.sol";

contract MockRewardsDistribution2 is IRewardsDistribution {
  uint256 reward;

  constructor(uint256 _reward) {
    reward = _reward;
  }

  function claimable(address) external view override returns (uint256) {
    return reward;
  }

  function claim(address) external view override returns (uint256) {
    return reward;
  }
}

contract SubsquidVestingTest is BaseTest {
  using stdJson for string;

  SubsquidVesting vesting;
  VestingFactory vestingFactory;
  SQD token;
  Router router;
  uint64 month = 30 days;

  function setUp() public {
    (token, router) = deployAll();
    vm.mockCall(
      address(router.workerRegistration()),
      abi.encodeWithSelector(WorkerRegistration.isWorkerActive.selector),
      abi.encode(true)
    );

    vestingFactory = new VestingFactory(token, router);
    vesting = vestingFactory.createVesting(address(this), uint64(block.timestamp + 6 * month), 30 * month, 0, 123);
  }

  function test_Constructor() public {
    assertEq(vesting.owner(), address(this));
    assertEq(vesting.start(), block.timestamp + 6 * month);
    assertEq(vesting.duration(), 30 * month);
    assertEq(vesting.expectedTotalAmount(), 123);
    assertEq(vesting.released(address(token)), 0);
  }

  function test_NothingIsVestedIfNothingWasDeposited() public {
    vm.warp(block.timestamp + 200 days);
    assertEq(vesting.releasable(address(token)), 0);
    vm.warp(block.timestamp + 50 * month);
    assertEq(vesting.releasable(address(token)), 0);
  }

  struct Schedule {
    uint256 cliff;
    uint256 length;
    uint256[] months;
    string name;
    uint256 release;
    uint256 total;
  }

  function readVestingSchedule(uint256 index) internal view returns (Schedule memory) {
    string memory root = vm.projectRoot();
    string memory path = string.concat(root, "/test/Vesting/vesting_schedules.json");
    string memory json = vm.readFile(path);
    bytes memory raw = json.parseRaw(".schedules");
    Schedule[] memory schedules = abi.decode(raw, (Schedule[]));
    return schedules[index];
  }

  function checkVesting(Schedule memory schedule) internal {
    SubsquidVesting v = vestingFactory.createVesting(
      address(this),
      uint64(block.timestamp + schedule.cliff * month),
      uint64((schedule.length) * month),
      schedule.release,
      schedule.total
    );
    token.transfer(address(v), schedule.total);
    uint256 total = 0;
    for (uint256 i = 0; i < schedule.months.length; i++) {
      total += schedule.months[i];
      assertApproxEqAbs(v.releasable(address(token)), total, 20);
      vm.warp(block.timestamp + month);
    }
    vm.warp(block.timestamp + 100 * month);
    assertEq(v.releasable(address(token)), schedule.total);
  }

  function test_PreseedSchedule() public {
    Schedule memory schedule = readVestingSchedule(0);
    checkVesting(schedule);
  }

  function test_SeedSchedule() public {
    Schedule memory schedule = readVestingSchedule(1);
    checkVesting(schedule);
  }

  function test_Strategic1Schedule() public {
    Schedule memory schedule = readVestingSchedule(2);
    checkVesting(schedule);
  }

  function test_Strategic2Schedule() public {
    Schedule memory schedule = readVestingSchedule(3);
    checkVesting(schedule);
  }

  function test_TeamSchedule() public {
    Schedule memory schedule = readVestingSchedule(4);
    checkVesting(schedule);
  }

  function test_TreasurySchedule() public {
    Schedule memory schedule = readVestingSchedule(5);
    checkVesting(schedule);
  }

  function test_CommunitySchedule() public {
    Schedule memory schedule = readVestingSchedule(6);
    checkVesting(schedule);
  }

  function test_NodeOperatorsSchedule() public {
    Schedule memory schedule = readVestingSchedule(7);
    checkVesting(schedule);
  }

  uint256 vestedMonthly = 10_000;
  //                 6 months cliff     70k/30 80k*2/30 90k*3/30 100k*4/30
  uint256[] year1 = [0, 0, 0, 0, 0, 0, 0, 2_333, 5_333, 9_000, 13_333, 18_333, 24_000];
  uint256[] year2 = [30333, 37333, 45000, 53333, 62333, 72000, 82333, 93333, 105000, 117333, 130333, 144000];
  uint256[] year3 = [158333, 173333, 189000, 205333, 222333, 240000, 258333, 277333, 297000, 317333, 338333, 360000];
  uint256[] year4 = [360000, 360000, 360000, 360000, 360000, 360000];

  function test_VestingWithGradualTransfers() public {
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
    vm.roll(block.number + 10);
    bytes memory call2 = abi.encodeWithSelector(Staking.deposit.selector, 1, 1 ether);
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

  function test_ReleasePossibleAfterSomeFundsWereStaked() public {
    NetworkController(address(router.networkController())).setBondAmount(100 ether);
    token.transfer(address(vesting), 10 ether);
    vm.warp(block.timestamp + 6 * month);
    vm.warp(block.timestamp + 15 * month);
    assertEq(vesting.releasable(address(token)), 5 ether);
    vesting.release(address(token));
    assertEq(vesting.releasable(address(token)), 0);
    bytes memory call = abi.encodeWithSelector(Staking.deposit.selector, 1, 4 ether);
    vesting.execute(address(router.staking()), call, 4 ether);
    vm.warp(block.timestamp + 6 * month);
    assertEq(vesting.releasable(address(token)), 1 ether);
    vesting.release(address(token));
    bytes memory call2 = abi.encodeWithSelector(Staking.withdraw.selector, 1, 4 ether);
    vm.roll(block.number + 100);
    vesting.execute(address(router.staking()), call2);
    assertEq(vesting.releasable(address(token)), 1 ether);
    vesting.release(address(token));
    assertEq(vesting.releasable(address(token)), 0 ether);
  }

  function test_ReceivingRewardsShouldNotBreakSchedule() public {
    NetworkController(address(router.networkController())).setBondAmount(100 ether);
    token.transfer(router.rewardTreasury(), 10 ether);
    token.transfer(address(vesting), 10 ether);
    vm.warp(block.timestamp + 6 * month);
    vm.warp(block.timestamp + 15 * month);
    assertEq(vesting.releasable(address(token)), 5 ether);
    vesting.release(address(token));
    assertEq(vesting.releasable(address(token)), 0);
    bytes memory call = abi.encodeWithSelector(Staking.deposit.selector, 1, 4 ether);
    vesting.execute(address(router.staking()), call, 4 ether);

    Staking staking = Staking(address(router.staking()));
    MockRewardsDistribution rewardsDistribution = new MockRewardsDistribution();
    staking.grantRole(staking.REWARDS_DISTRIBUTOR_ROLE(), address(rewardsDistribution));
    RewardTreasury(router.rewardTreasury()).setWhitelistedDistributor(rewardsDistribution, true);

    bytes memory call3 = abi.encodeWithSelector(RewardTreasury.claim.selector, address(rewardsDistribution));
    vesting.execute(address(router.rewardTreasury()), call3);

    vm.warp(block.timestamp + 3 * month);
    assertEq(vesting.releasable(address(token)), 1 ether);
    vm.warp(block.timestamp + 3 * month);
    assertEq(vesting.releasable(address(token)), 1 ether + 69);

    bytes memory call2 = abi.encodeWithSelector(Staking.withdraw.selector, 1, 4 ether);
    vm.roll(block.number + 100);
    vesting.execute(address(router.staking()), call2);
    assertEq(vesting.releasable(address(token)), 2 ether + 48);
  }

  function test_ReceivingHugeRewardShouldNotBreakSchedule() public {
    NetworkController(address(router.networkController())).setBondAmount(100 ether);
    token.transfer(router.rewardTreasury(), 10 ether);
    token.transfer(address(vesting), 10 ether);
    vm.warp(block.timestamp + 6 * month);
    vm.warp(block.timestamp + 15 * month);
    assertEq(vesting.releasable(address(token)), 5 ether);
    vesting.release(address(token));
    assertEq(vesting.releasable(address(token)), 0);
    bytes memory call = abi.encodeWithSelector(Staking.deposit.selector, 1, 4 ether);
    vesting.execute(address(router.staking()), call, 4 ether);

    Staking staking = Staking(address(router.staking()));
    MockRewardsDistribution2 rewardsDistribution = new MockRewardsDistribution2(4 ether);
    staking.grantRole(staking.REWARDS_DISTRIBUTOR_ROLE(), address(rewardsDistribution));
    RewardTreasury(router.rewardTreasury()).setWhitelistedDistributor(rewardsDistribution, true);

    bytes memory call3 = abi.encodeWithSelector(RewardTreasury.claim.selector, address(rewardsDistribution));
    vesting.execute(address(router.rewardTreasury()), call3);

    vm.warp(block.timestamp + 3 * month);
    assertEq(vesting.releasable(address(token)), 1 ether);
    vm.warp(block.timestamp + 3 * month);
    assertEq(vesting.releasable(address(token)), 2 ether);

    bytes memory call2 = abi.encodeWithSelector(Staking.withdraw.selector, 1, 4 ether);
    vm.roll(block.number + 100);
    vesting.execute(address(router.staking()), call2);
    assertEq(vesting.releasable(address(token)), 4.8 ether); // (10 + 4) * 21 / 30   - 5
      //                                                         total  month passed  released
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
    uint256[] memory result = new uint256[](a.length + b.length + c.length + d.length);
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
