pragma solidity ^0.8.16;

import "./RewardsDistribution.t.sol";

contract RewardsDistributionClaimTest is RewardsDistributionTest {
  function testTransfersClaimableRewardsToSender() public {
    (address[] memory recipients, uint256[] memory amounts) = prepareRewards(4);
    rewardsDistribution.distribute(recipients, amounts);
    uint256 claimable = rewardsDistribution.claimable(recipients[0]);
    hoax(recipients[0]);
    treasury.claim(rewardsDistribution);
    assertEq(rewardsDistribution.claimable(recipients[0]), 0);
    assertEq(token.balanceOf(recipients[0]), claimable);
  }

  function testCannotClaimSameRewardTwice() public {
    (address[] memory recipients, uint256[] memory amounts) = prepareRewards(4);
    rewardsDistribution.distribute(recipients, amounts);
    uint256 claimable = rewardsDistribution.claimable(recipients[0]);
    hoax(recipients[0]);
    treasury.claim(rewardsDistribution);
    assertEq(token.balanceOf(recipients[0]), claimable);

    hoax(recipients[0]);
    treasury.claim(rewardsDistribution);
    assertEq(token.balanceOf(recipients[0]), claimable);
  }

  function testClaimEmitsEvent() public {
    (address[] memory recipients, uint256[] memory amounts) = prepareRewards(4);
    rewardsDistribution.distribute(recipients, amounts);
    uint256 claimable = rewardsDistribution.claimable(recipients[0]);
    hoax(recipients[0]);
    vm.expectEmit(address(rewardsDistribution));
    emit Claimed(recipients[0], claimable);
    treasury.claim(rewardsDistribution);
  }

  function testDistributorClaimCannotBeCalledByNotTreasury() public {
    (address[] memory recipients, uint256[] memory amounts) = prepareRewards(1);
    rewardsDistribution.distribute(recipients, amounts);
    vm.expectRevert(
      "AccessControl: account 0x7fa9385be102ac3eac297483dd6233d62b3e1496 is missing role 0x1b79d793df9d39a01a8803af5b473fcb035fc3f70eaeb117debd77529e6aefe8"
    );
    rewardsDistribution.claim(recipients[0]);
  }
}
