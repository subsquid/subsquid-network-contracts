pragma solidity 0.8.20;

import "./DistributedRewardsDistribution.sol";

contract RewardsDistributionDistributeTest is RewardsDistributionTest {
  function gasUsageForNWorkers(uint256 n) internal {
    staking.setMaxDelegations(1000);
    (uint256[] memory recipients, uint256[] memory workerAmounts, uint256[] memory stakerAmounts) = prepareRewards(n);
    uint256 gasBefore = gasleft();
    rewardsDistribution.distributeHelper(1, recipients, workerAmounts, stakerAmounts);
    uint256 gasAfter = gasleft();
    uint256 gasUsed = gasBefore - gasAfter;
    emit log_named_uint("gasUsed", gasUsed);
  }

  function testDistributeGasUsageFor10Workers() public {
    gasUsageForNWorkers(10);
  }

  function testDistributeGasUsageFor100Workers() public {
    gasUsageForNWorkers(100);
  }

  function testDistributeGasUsageFor1000Workers() public {
    gasUsageForNWorkers(1000);
  }

  function test_RevertsIf_SomeBlocksSkipped() public {
    (uint256[] memory recipients, uint256[] memory workerAmounts, uint256[] memory stakerAmounts) = prepareRewards(2);
    rewardsDistribution.distributeHelper(1, recipients, workerAmounts, stakerAmounts);
    vm.expectRevert("Not all blocks covered");
    rewardsDistribution.distributeHelper(4, recipients, workerAmounts, stakerAmounts);
  }

  function testIncreasesClaimableAmount() public {
    (uint256[] memory recipients, uint256[] memory workerAmounts, uint256[] memory stakerAmounts) = prepareRewards(1);
    rewardsDistribution.distributeHelper(1, recipients, workerAmounts, stakerAmounts);
    assertEq(rewardsDistribution.claimable(workerOwner), epochRewardAmount);
    rewardsDistribution.distributeHelper(3, recipients, workerAmounts, stakerAmounts);
    assertEq(rewardsDistribution.claimable(workerOwner), epochRewardAmount * 2);
  }
}
