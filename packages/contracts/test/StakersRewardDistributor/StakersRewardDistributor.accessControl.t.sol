// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "./StakersRewardDistributorTest.sol";

contract StakingAccessControlTest is StakersRewardDistributionTest {
  function test_RevertsIf_NotRewardsDistributorCallDistribute() public {
    uint256[] memory amounts = new uint256[](1);
    amounts[0] = 100;
    bytes32 role = staking.REWARDS_DISTRIBUTOR_ROLE();
    hoax(address(1));
    expectNotRoleRevert(role);
    staking.distribute(workers, amounts);
  }

  function test_RevertsIf_NotRewardsDistributorCallClaim() public {
    bytes32 role = staking.REWARDS_DISTRIBUTOR_ROLE();
    hoax(address(1));
    expectNotRoleRevert(role);
    staking.claim(address(this));
  }
}
