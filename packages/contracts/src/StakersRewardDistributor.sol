// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.18;

struct Transition {
  uint256 epoch;
  uint256 amount;
}

struct StakerRewards {
  mapping(uint256 epoch => uint256 amount) cumulatedRewardsPerShare;
  mapping(uint256 epoch => uint256 amount) totalStakedPerEpoch;
  mapping(uint256 epoch => int256) delta;
  mapping(address staker => uint256 epoch) depositEpoch;
  mapping(address staker => uint256) depositAmount;
  mapping(address staker => Transition) pendingTransitions;
  uint256 totalStaked;
}

library StakersRewardDistributor {
  uint256 internal constant PRECISION = 1e18;

  /**
   * @dev Is expected to be called for each epoch when there are any stakers
   */
  function distribute(StakerRewards storage rewards, uint256 amount, uint256 epoch) internal {
    uint256 totalStaked = uint256(int256(rewards.totalStakedPerEpoch[epoch - 1]) + rewards.delta[epoch]);
    rewards.totalStakedPerEpoch[epoch] = totalStaked;
    require(totalStaked > 0, "Nothing staked in this epoch");
    uint256 lastEpochReward = epoch > 0 ? rewards.cumulatedRewardsPerShare[epoch - 1] : 0;
    rewards.cumulatedRewardsPerShare[epoch] = lastEpochReward + amount * PRECISION / totalStaked;
  }

  function firstDeposit(StakerRewards storage rewards, uint256 amount, uint256 epoch) internal {
    rewards.depositEpoch[msg.sender] = epoch;
    rewards.depositAmount[msg.sender] += amount;
    rewards.delta[epoch] += int256(amount);
    rewards.totalStaked += amount;
    rewards.totalStakedPerEpoch[epoch] = rewards.totalStaked;
  }

  function deposit(StakerRewards storage rewards, uint256 amount, uint256 epoch, uint256 lastRewardEpoch)
    internal
    returns (uint256)
  {
    requireFutureEpoch(epoch, lastRewardEpoch);
    if (rewards.depositEpoch[msg.sender] == 0) {
      firstDeposit(rewards, amount, epoch);
      return 0;
    }
    require(rewards.depositEpoch[msg.sender] <= lastRewardEpoch, "Cannot deposit with pending transition");
    rewards.pendingTransitions[msg.sender] =
      Transition({epoch: rewards.depositEpoch[msg.sender], amount: rewards.depositAmount[msg.sender]});
    firstDeposit(rewards, amount, epoch);
    return claim(rewards, lastRewardEpoch);
  }

  function withdraw(StakerRewards storage rewards, uint256 amount, uint256 epoch, uint256 lastRewardEpoch)
    internal
    returns (uint256)
  {
    requireFutureEpoch(epoch, lastRewardEpoch);
    require(rewards.depositEpoch[msg.sender] <= lastRewardEpoch, "Cannot withdraw with pending transition");
    rewards.pendingTransitions[msg.sender] =
      Transition({epoch: rewards.depositEpoch[msg.sender], amount: rewards.depositAmount[msg.sender]});
    rewards.depositEpoch[msg.sender] = epoch;
    rewards.depositAmount[msg.sender] -= amount;
    rewards.delta[epoch] -= int256(amount);
    rewards.totalStaked -= amount;
    rewards.totalStakedPerEpoch[epoch] = rewards.totalStaked;
    return claim(rewards, lastRewardEpoch);
  }

  function claim(StakerRewards storage rewards, uint256 latestRewardEpoch) internal returns (uint256) {
    uint256 claimable = reward(rewards, msg.sender, latestRewardEpoch);
    if (hasPendingTransitionRewards(rewards, msg.sender)) {
      claimable += transitionReward(rewards, msg.sender, latestRewardEpoch);
      rewards.pendingTransitions[msg.sender].epoch = latestRewardEpoch + 1;
    }
    if (latestRewardEpoch + 1 > rewards.depositEpoch[msg.sender]) {
      rewards.depositEpoch[msg.sender] = latestRewardEpoch + 1;
    }
    return claimable;
  }

  function transitionReward(StakerRewards storage rewards, address staker, uint256 latestRewardEpoch)
    internal
    view
    returns (uint256)
  {
    Transition memory transition = rewards.pendingTransitions[staker];
    uint256 latestTransitionBlock =
      latestRewardEpoch > rewards.depositEpoch[staker] - 1 ? rewards.depositEpoch[staker] - 1 : latestRewardEpoch;
    return (
      rewards.cumulatedRewardsPerShare[latestTransitionBlock] - rewards.cumulatedRewardsPerShare[transition.epoch - 1]
    ) * transition.amount / PRECISION;
  }

  function reward(StakerRewards storage rewards, address staker, uint256 latestRewardEpoch)
    internal
    view
    returns (uint256)
  {
    uint256 depositEpoch = rewards.depositEpoch[staker];
    if (depositEpoch > latestRewardEpoch) {
      return 0;
    }
    return (
      rewards.depositAmount[staker]
        * (rewards.cumulatedRewardsPerShare[latestRewardEpoch] - rewards.cumulatedRewardsPerShare[depositEpoch - 1])
    ) / PRECISION;
  }

  function hasPendingTransitionRewards(StakerRewards storage rewards, address staker) internal view returns (bool) {
    return rewards.pendingTransitions[staker].epoch > 0
      && rewards.pendingTransitions[staker].epoch <= rewards.depositEpoch[staker];
  }

  function requireFutureEpoch(uint256 currentEpoch, uint256 latestRewardedEpoch) internal pure {
    require(currentEpoch > latestRewardedEpoch, "Current epoch is in the past");
  }
}
