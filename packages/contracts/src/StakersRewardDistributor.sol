// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.18;

struct StakerRewards {
  uint256 cumulatedRewardsPerShare;
  mapping(address staker => uint256) checkpoint;
  mapping(address staker => uint256) depositAmount;
  uint256 totalStaked;
}

library StakersRewardDistributor {
  uint256 internal constant PRECISION = 1e18;

  function distribute(StakerRewards storage rewards, uint256 amount) internal {
    if (amount == 0) return;
    uint256 totalStaked = rewards.totalStaked;
    require(totalStaked > 0, "Nothing staked");
    rewards.cumulatedRewardsPerShare += amount * PRECISION / totalStaked;
  }

  function deposit(StakerRewards storage rewards, uint256 amount) internal returns (uint256) {
    uint256 _reward = claim(rewards);
    rewards.totalStaked += amount;
    rewards.depositAmount[msg.sender] += amount;
    return _reward;
  }

  function withdraw(StakerRewards storage rewards, uint256 amount) internal returns (uint256) {
    require(rewards.depositAmount[msg.sender] >= amount, "Insufficient staked amount");
    uint256 _reward = claim(rewards);
    rewards.totalStaked -= amount;
    rewards.depositAmount[msg.sender] -= amount;
    return _reward;
  }

  function claim(StakerRewards storage rewards) internal returns (uint256) {
    uint256 claimable = reward(rewards, msg.sender);
    rewards.checkpoint[msg.sender] = rewards.cumulatedRewardsPerShare;
    return claimable;
  }

  function reward(StakerRewards storage rewards, address staker) internal view returns (uint256) {
    uint256 amount = rewards.depositAmount[staker];
    return (amount * (rewards.cumulatedRewardsPerShare - rewards.checkpoint[staker])) / PRECISION;
  }
}
