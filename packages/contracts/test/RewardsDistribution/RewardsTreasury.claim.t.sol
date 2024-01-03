pragma solidity 0.8.20;

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
    emit Claimed(workerOwner, 1, claimable);
    treasury.claim(rewardsDistribution);
  }

  function testDistributorClaimCannotBeCalledByNotTreasury() public {
    (uint256[] memory recipients, uint256[] memory workerAmounts, uint256[] memory stakerAmounts) = prepareRewards(1);
    rewardsDistribution.distributeHelper(1, recipients, workerAmounts, stakerAmounts);
    expectNotRoleRevert(rewardsDistribution.REWARDS_TREASURY_ROLE());
    rewardsDistribution.claim(workerOwner);
  }

  function test_CanClaimRewardsForWithdrawnWorker() public {
    (uint256[] memory recipients, uint256[] memory workerAmounts, uint256[] memory stakerAmounts) = prepareRewards(1);
    startHoax(workerOwner);
    vm.roll(block.number + 3);
    workerRegistration.deregister(workerId);
    vm.roll(block.number + 4);
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
