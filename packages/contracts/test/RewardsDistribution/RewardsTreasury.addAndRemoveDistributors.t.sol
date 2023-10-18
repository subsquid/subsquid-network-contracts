pragma solidity 0.8.19;

import "./RewardsDistribution.t.sol";

contract RewardsDistributionAddRemoveDistributorsTest is RewardsDistributionTest {
  function test_RevertsIf_NonAdminAddsDistributor() public {
    vm.expectRevert(
      "AccessControl: account 0x0000000000000000000000000000000000000001 is missing role 0x0000000000000000000000000000000000000000000000000000000000000000"
    );
    hoax(address(1));
    rewardsDistribution.addDistributor(address(1));
  }

  function test_RevertsIf_NonAdminRemovesDistributor() public {
    rewardsDistribution.addDistributor(address(1));
    hoax(address(1));
    vm.expectRevert(
      "AccessControl: account 0x0000000000000000000000000000000000000001 is missing role 0x0000000000000000000000000000000000000000000000000000000000000000"
    );
    rewardsDistribution.removeDistributor(address(1));
  }
}
