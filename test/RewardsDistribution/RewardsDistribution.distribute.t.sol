pragma solidity ^0.8.16;

import "./RewardsDistribution.t.sol";

contract RewardsDistributionDistributeTest is RewardsDistributionTest {
    function gasUsageForNWorkers(uint256 n) internal {
        (address[] memory recipients, uint256[] memory amounts) = prepareRewards(n);
        uint256 gasBefore = gasleft();
        rewardsDistribution.distribute(recipients, amounts, epochRewardAmount);
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

    function testDistributeCannotDistributeRewardsIfNotAllowed() public {
        (address[] memory recipients, uint256[] memory amounts) = prepareRewards(1);
        vm.expectRevert(
            "AccessControl: account 0x000000000000000000000000000000000000007b is missing role 0x9df62d436bfc9f3be4953ab398f3aa862316b013d490e2138c80b4b2eadeabd7"
        );
        hoax(address(123));
        rewardsDistribution.distribute(recipients, amounts, epochRewardAmount);
    }

    function testDistributeDistributionsShouldSumToTotal() public {
        (address[] memory recipients, uint256[] memory amounts) = prepareRewards(1);
        vm.expectRevert("Total distributed != epoch reward");
        rewardsDistribution.distribute(recipients, amounts, epochRewardAmount + 1);
    }

    function testDistributeArgLengthsShouldMatch() public {
        (address[] memory recipients,) = prepareRewards(1);
        (, uint256[] memory amounts) = prepareRewards(2);
        vm.expectRevert("Recipients and amounts length mismatch");
        rewardsDistribution.distribute(recipients, amounts, epochRewardAmount + 1);
    }

    function testDistributeEmitsEvent() public {
        (address[] memory recipients, uint256[] memory amounts) = prepareRewards(2);
        vm.expectEmit(address(rewardsDistribution));
        emit NewReward(address(this), epochRewardAmount);
        rewardsDistribution.distribute(recipients, amounts, epochRewardAmount);
    }

    function testIncreasesClaimableAmount() public {
        (address[] memory recipients, uint256[] memory amounts) = prepareRewards(1);
        rewardsDistribution.distribute(recipients, amounts, epochRewardAmount);
        assertEq(rewardsDistribution.claimable(recipients[0]), epochRewardAmount);
        rewardsDistribution.distribute(recipients, amounts, epochRewardAmount);
        assertEq(rewardsDistribution.claimable(recipients[0]), epochRewardAmount * 2);
    }
}
