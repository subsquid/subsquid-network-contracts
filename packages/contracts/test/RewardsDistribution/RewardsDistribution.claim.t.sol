pragma solidity ^0.8.16;

import "./RewardsDistribution.t.sol";

contract RewardsDistributionClaimTest is RewardsDistributionTest {
  function testTransfersClaimableRewardsToSender() public {
    (address[] memory recipients, uint256[] memory amounts) = prepareRewards(4);
    rewardsDistribution.distribute(recipients, amounts, epochRewardAmount);
    uint256 claimable = rewardsDistribution.claimable(recipients[0]);
    hoax(recipients[0]);
    rewardsDistribution.claim();
    assertEq(rewardsDistribution.claimable(recipients[0]), 0);
    assertEq(token.balanceOf(recipients[0]), claimable);
  }

  function testCannotClaimSameRewardTwice() public {
    (address[] memory recipients, uint256[] memory amounts) = prepareRewards(4);
    rewardsDistribution.distribute(recipients, amounts, epochRewardAmount);
    uint256 claimable = rewardsDistribution.claimable(recipients[0]);
    hoax(recipients[0]);
    rewardsDistribution.claim();
    assertEq(token.balanceOf(recipients[0]), claimable);

    hoax(recipients[0]);
    rewardsDistribution.claim();
    assertEq(token.balanceOf(recipients[0]), claimable);
  }

  function testClaimEmitsEvent() public {
    (address[] memory recipients, uint256[] memory amounts) = prepareRewards(4);
    rewardsDistribution.distribute(recipients, amounts, epochRewardAmount);
    uint256 claimable = rewardsDistribution.claimable(recipients[0]);
    hoax(recipients[0]);
    vm.expectEmit(address(rewardsDistribution));
    emit Claimed(recipients[0], claimable);
    rewardsDistribution.claim();
  }
}
