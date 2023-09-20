// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.16;

import "forge-std/Test.sol";
import "../../src/DistributedRewardDistribution.sol";
import "../../src/tSQD.sol";
import "../../src/RewardTreasury.sol";
import "../../src/NetworkController.sol";
import "../../src/Staking.sol";

contract RewardsDistributionTest is Test {
  uint256 epochRewardAmount = 1000;
  DistributedRewardsDistribution rewardsDistribution;
  RewardTreasury treasury;
  Staking staking;
  IERC20 token;

  event NewReward(address indexed sender, uint256 amount);
  event Claimed(address indexed who, uint256 amount);

  function setUp() public {
    uint256[] memory shares = new uint256[](1);
    shares[0] = 100;
    address[] memory holders = new address[](1);
    holders[0] = address(this);

    token = new tSQD(holders, shares);
    staking = new Staking(token);
    token.approve(address(staking), type(uint256).max);
    rewardsDistribution = new DistributedRewardsDistribution(address(this), staking);
    staking.grantRole(staking.REWARDS_DISTRIBUTOR_ROLE(), address(rewardsDistribution));
    treasury = new RewardTreasury(address(this), token);
    rewardsDistribution.addDistributor(address(this));
    rewardsDistribution.grantRole(rewardsDistribution.REWARDS_TREASURY_ROLE(), address(treasury));
    treasury.setWhitelistedDistributor(rewardsDistribution, true);
    token.transfer(address(treasury), epochRewardAmount * 10);
  }

  function prepareRewards(uint256 n)
    internal
    returns (address[] memory recipients, uint256[] memory workerAmounts, uint256[] memory stakerAmounts)
  {
    workerAmounts = new uint256[](n);
    stakerAmounts = new uint256[](n);
    recipients = new address[](n);
    for (uint160 i = 0; i < n; i++) {
      staking.deposit(address(i + 1), 1);
      workerAmounts[i] = epochRewardAmount / n;
      stakerAmounts[i] = 1;
      recipients[i] = address(i + 1);
    }
  }
}
