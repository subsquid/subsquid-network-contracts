// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.16;

import "forge-std/Test.sol";
import "../../src/RewardsDistribution.sol";
import "../../src/tSQD.sol";
import "../../src/RewardTreasury.sol";

contract RewardsDistributionTest is Test {
  uint256 epochRewardAmount = 1000;
  RewardsDistribution rewardsDistribution;
  RewardTreasury treasury;
  IERC20 token;

  event NewReward(address indexed sender, uint256 amount);
  event Claimed(address indexed who, uint256 amount);

  function setUp() public {
    uint256[] memory shares = new uint256[](1);
    shares[0] = 100;
    address[] memory holders = new address[](1);
    holders[0] = address(this);

    token = new tSQD(holders, shares);
    WorkerRegistration workerRegistration = new WorkerRegistration(token, 2);
    rewardsDistribution = new RewardsDistribution(address(this), workerRegistration);
    treasury = new RewardTreasury(address(this), token);
    rewardsDistribution.grantRole(rewardsDistribution.REWARDS_DISTRIBUTOR_ROLE(), address(this));
    rewardsDistribution.grantRole(rewardsDistribution.REWARDS_TREASURY_ROLE(), address(treasury));
    treasury.setWhitelistedDistributor(rewardsDistribution, true);
    token.transfer(address(treasury), epochRewardAmount * 10);
  }

  function prepareRewards(uint256 n) internal view returns (address[] memory recipients, uint256[] memory amounts) {
    amounts = new uint256[](n);
    recipients = new address[](n);
    for (uint160 i = 0; i < n; i++) {
      amounts[i] = epochRewardAmount / n;
      recipients[i] = address(i + 1);
    }
  }
}
