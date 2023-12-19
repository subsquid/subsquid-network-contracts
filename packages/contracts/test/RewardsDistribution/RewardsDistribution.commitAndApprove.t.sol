pragma solidity 0.8.20;

import "./RewardsDistribution.sol";

contract RewardsDistributionCommitApproveTest is RewardsDistributionTest {
  function test_CurrentDistributorReturnsThisInTests() public {
    assertEq(rewardsDistribution.currentDistributor(), address(this));
    assertEq(rewardsDistribution.distributorIndex(), 0);
  }

  function test_RevertsIf_NotAuthorisedDistributor() public {
    (uint256[] memory recipients, uint256[] memory workerAmounts, uint256[] memory stakerAmounts) = prepareRewards(1);
    vm.roll(10);
    vm.expectRevert("Not a distributor");
    hoax(address(1));
    rewardsDistribution.commit(1, 4, recipients, workerAmounts, stakerAmounts);
  }

  function test_RevertsIf_ArgsLengthsShouldMatch() public {
    (uint256[] memory recipients, uint256[] memory correctWorkerAmounts,) = prepareRewards(1);
    (, uint256[] memory workerAmounts, uint256[] memory stakerAmounts) = prepareRewards(2);
    vm.expectRevert("Recipients and worker amounts length mismatch");
    rewardsDistribution.commit(1, 2, recipients, workerAmounts, stakerAmounts);
    vm.expectRevert("Recipients and staker amounts length mismatch");
    rewardsDistribution.commit(1, 2, recipients, correctWorkerAmounts, stakerAmounts);
  }

  function test_RevertsIf_CommittingForFutureBlock() public {
    (uint256[] memory recipients, uint256[] memory workerAmounts, uint256[] memory stakerAmounts) = prepareRewards(1);
    vm.roll(10);
    vm.expectRevert("Future block");
    rewardsDistribution.commit(1, 11, recipients, workerAmounts, stakerAmounts);
  }

  function test_RevertsIf_CommittingSameDataTwice() public {
    (uint256[] memory recipients, uint256[] memory workerAmounts, uint256[] memory stakerAmounts) = prepareRewards(1);
    vm.roll(10);
    rewardsDistribution.commit(1, 4, recipients, workerAmounts, stakerAmounts);
    vm.expectRevert("Already approved");
    rewardsDistribution.commit(1, 4, recipients, workerAmounts, stakerAmounts);
  }

  function test_RevertsIf_CommitAfterDistributorWasRemoved() public {
    (uint256[] memory recipients, uint256[] memory workerAmounts, uint256[] memory stakerAmounts) = prepareRewards(1);
    rewardsDistribution.addDistributor(address(1));
    rewardsDistribution.removeDistributor(address(1));
    vm.roll(10);
    vm.expectRevert("Not a distributor");
    hoax(address(1));
    rewardsDistribution.commit(1, 4, recipients, workerAmounts, stakerAmounts);
  }

  function test_RevertsIs_ApprovingWithWrongParams() public {
    (uint256[] memory recipients, uint256[] memory workerAmounts, uint256[] memory stakerAmounts) = prepareRewards(1);
    rewardsDistribution.addDistributor(address(1));
    vm.roll(10);
    rewardsDistribution.commit(1, 4, recipients, workerAmounts, stakerAmounts);
    startHoax(address(1));
    vm.expectRevert("Commitment does not exist");
    rewardsDistribution.approve(1, 5, recipients, workerAmounts, stakerAmounts);
    vm.expectRevert("Commitment does not exist");
    rewardsDistribution.approve(2, 4, recipients, workerAmounts, stakerAmounts);
    startHoax(address(this));
    (recipients, workerAmounts, stakerAmounts) = prepareRewards(2);
    startHoax(address(1));
    vm.expectRevert("Commitment mismatch");
    rewardsDistribution.approve(1, 4, recipients, workerAmounts, stakerAmounts);
  }

  function test_RevertsIf_ApprovingByNotAllowedAccount() public {
    (uint256[] memory recipients, uint256[] memory workerAmounts, uint256[] memory stakerAmounts) = prepareRewards(1);
    vm.roll(10);
    rewardsDistribution.commit(1, 4, recipients, workerAmounts, stakerAmounts);
    startHoax(address(1));
    expectNotRoleRevert(rewardsDistribution.REWARDS_DISTRIBUTOR_ROLE());
    rewardsDistribution.approve(1, 4, recipients, workerAmounts, stakerAmounts);
  }

  function test_RevertsIf_ApprovingTwice() public {
    (uint256[] memory recipients, uint256[] memory workerAmounts, uint256[] memory stakerAmounts) = prepareRewards(1);
    rewardsDistribution.addDistributor(address(1));
    vm.roll(10);
    rewardsDistribution.commit(1, 4, recipients, workerAmounts, stakerAmounts);
    startHoax(address(1));
    rewardsDistribution.approve(1, 4, recipients, workerAmounts, stakerAmounts);
    vm.expectRevert("Already approved");
    rewardsDistribution.approve(1, 4, recipients, workerAmounts, stakerAmounts);
  }

  function test_RevertsIf_ApprovingByCommitter() public {
    (uint256[] memory recipients, uint256[] memory workerAmounts, uint256[] memory stakerAmounts) = prepareRewards(1);
    rewardsDistribution.addDistributor(address(1));
    vm.roll(10);
    rewardsDistribution.commit(1, 4, recipients, workerAmounts, stakerAmounts);
    vm.expectRevert("Already approved");
    rewardsDistribution.approve(1, 4, recipients, workerAmounts, stakerAmounts);
  }

  function test_RunsDistributionAfter3Approves() public {
    (uint256[] memory recipients, uint256[] memory workerAmounts, uint256[] memory stakerAmounts) = prepareRewards(1);
    rewardsDistribution.addDistributor(address(1));
    rewardsDistribution.addDistributor(address(2));
    vm.roll(10);
    rewardsDistribution.commit(1, 4, recipients, workerAmounts, stakerAmounts);
    hoax(address(1));
    rewardsDistribution.approve(1, 4, recipients, workerAmounts, stakerAmounts);
    hoax(address(2));
    vm.expectEmit(address(rewardsDistribution));
    emit Distributed(1, 4);
    rewardsDistribution.approve(1, 4, recipients, workerAmounts, stakerAmounts);
  }

  function test_canApproveReturnsTrueIfCanApprove() public {
    (uint256[] memory recipients, uint256[] memory workerAmounts, uint256[] memory stakerAmounts) = prepareRewards(1);
    rewardsDistribution.addDistributor(address(1));
    vm.roll(10);
    rewardsDistribution.commit(1, 4, recipients, workerAmounts, stakerAmounts);
    assertEq(rewardsDistribution.canApprove(address(1), 1, 4, recipients, workerAmounts, stakerAmounts), true);
  }

  function test_canApproveReturnsTrueIfNothingWasCommitted() public {
    (uint256[] memory recipients, uint256[] memory workerAmounts, uint256[] memory stakerAmounts) = prepareRewards(1);
    rewardsDistribution.addDistributor(address(1));
    assertEq(rewardsDistribution.canApprove(address(1), 1, 4, recipients, workerAmounts, stakerAmounts), false);
  }

  function test_canApproveReturnsFalseIfAlreadyApproved() public {
    (uint256[] memory recipients, uint256[] memory workerAmounts, uint256[] memory stakerAmounts) = prepareRewards(2);
    rewardsDistribution.addDistributor(address(1));
    vm.roll(10);
    rewardsDistribution.commit(1, 4, recipients, workerAmounts, stakerAmounts);
    hoax(address(1));
    rewardsDistribution.approve(1, 4, recipients, workerAmounts, stakerAmounts);
    assertEq(rewardsDistribution.canApprove(address(1), 1, 4, recipients, workerAmounts, stakerAmounts), false);
  }

  function test_canApproveReturnsFalseIfCommitmentMismatch() public {
    (uint256[] memory recipients, uint256[] memory workerAmounts, uint256[] memory stakerAmounts) = prepareRewards(2);
    rewardsDistribution.addDistributor(address(1));
    vm.roll(10);
    rewardsDistribution.commit(1, 4, recipients, workerAmounts, stakerAmounts);
    assertEq(rewardsDistribution.canApprove(address(1), 2, 4, recipients, workerAmounts, stakerAmounts), false);
  }

  function test_canApproveReturnsFalseIfNotADistributor() public {
    (uint256[] memory recipients, uint256[] memory workerAmounts, uint256[] memory stakerAmounts) = prepareRewards(2);
    vm.roll(10);
    rewardsDistribution.commit(1, 4, recipients, workerAmounts, stakerAmounts);
    assertEq(rewardsDistribution.canApprove(address(1), 1, 4, recipients, workerAmounts, stakerAmounts), false);
  }
}
