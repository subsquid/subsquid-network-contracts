pragma solidity 0.8.18;

import "./RewardsDistribution.sol";

contract RewardsDistributionClaimTest is RewardsDistributionTest {
  function testTransfersClaimableRewardsToSender() public {
    (uint256[] memory recipients, uint256[] memory workerAmounts, uint256[] memory stakerAmounts) = prepareRewards(4);
    rewardsDistribution.distributeHelper(1, recipients, workerAmounts, stakerAmounts);
    uint256 claimable = rewardsDistribution.claimable(workerOwner);
    uint256 balanceBefore = token.balanceOf(workerOwner);
    hoax(workerOwner);
    treasury.claim(rewardsDistribution);
    assertEq(rewardsDistribution.claimable(workerOwner), 0);
    assertEq(token.balanceOf(workerOwner) - balanceBefore, claimable);
  }

  function testCannotClaimSameRewardTwice() public {
    (uint256[] memory recipients, uint256[] memory workerAmounts, uint256[] memory stakerAmounts) = prepareRewards(4);
    rewardsDistribution.distributeHelper(1, recipients, workerAmounts, stakerAmounts);
    uint256 claimable = rewardsDistribution.claimable(workerOwner);
    uint256 balanceBefore = token.balanceOf(workerOwner);
    hoax(workerOwner);
    treasury.claim(rewardsDistribution);
    assertEq(token.balanceOf(workerOwner) - balanceBefore, claimable);

    hoax(workerOwner);
    treasury.claim(rewardsDistribution);
    assertEq(token.balanceOf(workerOwner) - balanceBefore, claimable);
  }

  function testClaimEmitsEvent() public {
    (uint256[] memory recipients, uint256[] memory workerAmounts, uint256[] memory stakerAmounts) = prepareRewards(4);
    rewardsDistribution.distributeHelper(1, recipients, workerAmounts, stakerAmounts);
    uint256 claimable = rewardsDistribution.claimable(workerOwner);
    hoax(workerOwner);
    vm.expectEmit(address(rewardsDistribution));
    emit Claimed(workerOwner, claimable);
    treasury.claim(rewardsDistribution);
  }

  function testDistributorClaimCannotBeCalledByNotTreasury() public {
    (uint256[] memory recipients, uint256[] memory workerAmounts, uint256[] memory stakerAmounts) = prepareRewards(1);
    rewardsDistribution.distributeHelper(1, recipients, workerAmounts, stakerAmounts);
    vm.expectRevert(
      "AccessControl: account 0x7fa9385be102ac3eac297483dd6233d62b3e1496 is missing role 0x1b79d793df9d39a01a8803af5b473fcb035fc3f70eaeb117debd77529e6aefe8"
    );
    rewardsDistribution.claim(workerOwner);
  }

  function test_CanClaimRewardsForWithdrawnWorker() public {
    (uint256[] memory recipients, uint256[] memory workerAmounts, uint256[] memory stakerAmounts) = prepareRewards(1);
    startHoax(workerOwner);
    vm.roll(block.number + 3);
    workerRegistration.deregister(workerId);
    vm.roll(block.number + 3);
    workerRegistration.withdraw(workerId);
    startHoax(address(this));
    rewardsDistribution.distributeHelper(1, recipients, workerAmounts, stakerAmounts);
    uint256 claimable = rewardsDistribution.claimable(workerOwner);
    assertGt(claimable, 0);
    uint256 balanceBefore = token.balanceOf(workerOwner);
    startHoax(workerOwner);
    treasury.claim(rewardsDistribution);
    assertEq(token.balanceOf(workerOwner) - balanceBefore, claimable);
  }
}
