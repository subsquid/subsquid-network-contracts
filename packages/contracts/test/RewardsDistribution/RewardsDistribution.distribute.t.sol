pragma solidity 0.8.20;

import "./RewardsDistribution.sol";

contract RewardsDistributionDistributeTest is RewardsDistributionTest {
  function gasUsageForNWorkers(uint256 n) internal {
    (
      uint256[] memory recipients,
      uint256[] memory workerAmounts,
      uint256[] memory stakerAmounts,
      uint256[] memory allocationsUsed
    ) = prepareRewards(n);
    rewardsDistribution.addDistributor(address(1));
    rewardsDistribution.addDistributor(address(2));
    vm.roll(10);
    rewardsDistribution.commit(1, 4, recipients, workerAmounts, stakerAmounts, allocationsUsed);
    hoax(address(1));
    rewardsDistribution.approve(1, 4, recipients, workerAmounts, stakerAmounts, allocationsUsed);
    hoax(address(2));

    uint256 gasBefore = gasleft();
    rewardsDistribution.approve(1, 4, recipients, workerAmounts, stakerAmounts, allocationsUsed);
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

  function testDistributeEmitsEvent() public {
    (
      uint256[] memory recipients,
      uint256[] memory workerAmounts,
      uint256[] memory stakerAmounts,
      uint256[] memory allocationsUsed
    ) = prepareRewards(2);
    vm.expectEmit(address(rewardsDistribution));
    emit Distributed(6, 7);
    rewardsDistribution.distributeHelper(6, recipients, workerAmounts, stakerAmounts);
  }

  function test_RevertsIf_SomeBlocksSkipped() public {
    (
      uint256[] memory recipients,
      uint256[] memory workerAmounts,
      uint256[] memory stakerAmounts,
      uint256[] memory allocationsUsed
    ) = prepareRewards(2);
    rewardsDistribution.distributeHelper(1, recipients, workerAmounts, stakerAmounts);
    vm.expectRevert("Not all blocks covered");
    rewardsDistribution.distributeHelper(4, recipients, workerAmounts, stakerAmounts);
  }

  function testIncreasesClaimableAmount() public {
    (
      uint256[] memory recipients,
      uint256[] memory workerAmounts,
      uint256[] memory stakerAmounts,
      uint256[] memory allocationsUsed
    ) = prepareRewards(1);
    rewardsDistribution.distributeHelper(1, recipients, workerAmounts, stakerAmounts);
    assertEq(rewardsDistribution.claimable(workerOwner), epochRewardAmount);
    rewardsDistribution.distributeHelper(3, recipients, workerAmounts, stakerAmounts);
    assertEq(rewardsDistribution.claimable(workerOwner), epochRewardAmount * 2);
  }
}
