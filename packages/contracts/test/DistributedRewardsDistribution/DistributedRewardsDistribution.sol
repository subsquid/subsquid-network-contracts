// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "../../src/DistributedRewardDistribution.sol";
import "../../src/tSQD.sol";
import "../../src/RewardTreasury.sol";
import "../../src/NetworkController.sol";
import "../../src/Staking.sol";
import "../../src/WorkerRegistration.sol";
import "../BaseTest.sol";

contract DistributionHelper is DistributedRewardsDistribution {
  constructor(IRouter router) DistributedRewardsDistribution(router) {}

  function distributeHelper(
    uint256 fromBlock,
    uint256[] calldata recipients,
    uint256[] calldata workerRewards,
    uint256[] calldata _stakerRewards,
    uint256[] calldata usedCUs
  ) public {
    distribute(fromBlock, fromBlock + 1, recipients, workerRewards, _stakerRewards, usedCUs);
  }
}

contract RewardsDistributionTest is BaseTest {
  bytes workerId = "1337";
  uint256 epochRewardAmount = 1000;
  address workerOwner = address(1);
  DistributionHelper rewardsDistribution;
  RewardTreasury treasury;
  Staking staking;
  WorkerRegistration workerRegistration;
  IERC20 token;

  event Claimed(address indexed who, uint256 indexed workerId, uint256 amount);

  function setUp() public {
    (tSQD _token, Router router) = deployAll();
    token = _token;
    staking = Staking(address(router.staking()));
    workerRegistration = WorkerRegistration(address(router.workerRegistration()));
    treasury = RewardTreasury(router.rewardTreasury());
    token.transfer(workerOwner, token.totalSupply() / 2);
    NetworkController(address(router.networkController())).setEpochLength(2);
    token.approve(address(staking), type(uint256).max);
    hoax(workerOwner);
    token.approve(address(workerRegistration), type(uint256).max);
    hoax(workerOwner);
    workerRegistration.register(workerId);
    rewardsDistribution = new DistributionHelper(router);
    staking.grantRole(staking.REWARDS_DISTRIBUTOR_ROLE(), address(rewardsDistribution));
    rewardsDistribution.addDistributor(address(this));
    rewardsDistribution.grantRole(rewardsDistribution.REWARDS_TREASURY_ROLE(), address(treasury));
    treasury.setWhitelistedDistributor(rewardsDistribution, true);
    token.transfer(address(treasury), epochRewardAmount * 10);
  }

  function prepareRewards(uint256 n)
    internal
    returns (
      uint256[] memory recipients,
      uint256[] memory workerAmounts,
      uint256[] memory stakerAmounts,
      uint256[] memory usedCUs
    )
  {
    workerAmounts = new uint256[](n);
    stakerAmounts = new uint256[](n);
    usedCUs = new uint256[](n);
    recipients = new uint256[](n);
    for (uint160 i = 0; i < n; i++) {
      staking.deposit(i + 1, 1);
      workerAmounts[i] = epochRewardAmount / n;
      stakerAmounts[i] = 1;
      recipients[i] = i + 1;
    }
  }
}
