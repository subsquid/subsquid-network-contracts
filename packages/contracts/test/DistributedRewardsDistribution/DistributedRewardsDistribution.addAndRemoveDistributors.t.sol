pragma solidity 0.8.20;

import "./DistributedRewardsDistribution.sol";

contract RewardsDistributionAddRemoveDistributorsTest is RewardsDistributionTest {
  function test_RevertsIf_NonAdminAddsDistributor() public {
    hoax(address(1));
    expectNotAdminRevert();
    rewardsDistribution.addDistributor(address(1));
  }

  function test_RevertsIf_NonAdminRemovesDistributor() public {
    rewardsDistribution.addDistributor(address(1));
    hoax(address(1));
    expectNotAdminRevert();
    rewardsDistribution.removeDistributor(address(1));
  }

  function test_RevertsIf_AddingSameDistributorTwice() public {
    rewardsDistribution.addDistributor(address(1));
    vm.expectRevert("Distributor already added");
    rewardsDistribution.addDistributor(address(1));
  }

  function test_RevertsIf_RemovingUnknownDistributor() public {
    rewardsDistribution.addDistributor(address(1));
    vm.expectRevert("Distributor does not exist");
    rewardsDistribution.removeDistributor(address(2));
  }

  function test_RevertsIf_AmountOfDistributorsBelowRequiredApproves() public {
    rewardsDistribution.addDistributor(address(1));
    rewardsDistribution.setApprovesRequired(2);
    vm.expectRevert("Not enough distributors to approve distribution");
    rewardsDistribution.removeDistributor(address(1));
  }
}
