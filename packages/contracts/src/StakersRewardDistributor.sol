// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.18;

import {BitMaps} from "@openzeppelin/contracts/utils/structs/BitMaps.sol";
import "forge-std/console2.sol";
  struct Transition {
    uint256 epoch;
    uint256 endEpoch;
    uint256 amount;
  }

  struct StakerRewards {
    mapping(uint256 epoch => uint256) cumulatedRewardsPerShare;
    mapping(uint256 epoch => uint256) totalStakedPerEpoch;
    mapping(uint256 epoch => int256) cumulativeDelta;
    mapping(address staker => uint256 epoch) depositEpoch;
    mapping(address staker => uint256) depositAmount;
    mapping(address staker => Transition) pendingTransitions;
    uint256 totalStaked;
    uint256 lastActionEpoch;
    BitMaps.BitMap rewardedEpochs;
    BitMaps.BitMap actionEpochs;
    uint256 firstDistributionEpoch;
    bool actionMade;
  }

library StakersRewardDistributor {
  using BitMaps for BitMaps.BitMap;

  uint256 internal constant PRECISION = 1e18;

  /**
  * @dev Explanation why we need to mark and find previous deposits:
  * Imagine, we have a distribution on epoch #100, then nothing happens, we have a deposit on epoch #200,
  * and distribution on epoch #201
  * To calculate staker's rewards, we need to have cumulatedRewardsPerShare for epoch #200 and it will be same
  * as for epoch #100, because there were no distributions in between. But we didn't have a chance to set it and we need
  * to find previous distribution epoch, which is #100 in this case.
  * Finding it by iterating over all epochs is too expensive, so we use bitmaps to mark epochs with distributions.
  */
  function _findLeftmostBit(uint256 x) internal pure returns (uint256) {
    uint256 n = 256;
    if (x >> 128 != 0) {
      n -= 128;
      x >>= 128;
    }
    if (x >> 64 != 0) {
      n -= 64;
      x >>= 64;
    }
    if (x >> 32 != 0) {
      n -= 32;
      x >>= 32;
    }
    if (x >> 16 != 0) {
      n -= 16;
      x >>= 16;
    }
    if (x >> 8 != 0) {
      n -= 8;
      x >>= 8;
    }
    if (x >> 4 != 0) {
      n -= 4;
      x >>= 4;
    }
    if (x >> 2 != 0) {
      n -= 2;
      x >>= 2;
    }
    if (x >> 1 != 0) return 0xff - (n - 2);
    return 0xff - (n - x);
  }

  function _findPreviousBitInBitmap(BitMaps.BitMap storage bitmap, uint256 position) internal view returns (uint256) {
    uint256 blockIndex = position >> 8;
    uint256 bitBlock = bitmap._data[blockIndex];
    if (bitBlock > 0) {
      uint8 bitIndex = 0xff - uint8(position & 0xff);
      bitBlock <<= bitIndex;
      if (bitBlock > 0) {
        return (blockIndex << 8) + _findLeftmostBit(bitBlock) - bitIndex;
      }
    }
    do {
      blockIndex--;
    }
    while (bitmap._data[blockIndex] == 0);
    return (blockIndex << 8) + _findLeftmostBit(bitmap._data[blockIndex]);
  }

  function _getCumulatedRewardsForEpoch(StakerRewards storage rewards, uint256 epoch) internal view returns (uint256) {
    uint256 rewardsPerShare = rewards.cumulatedRewardsPerShare[epoch];
    if (rewardsPerShare > 0) {
      return rewardsPerShare;
    }
    if (rewards.firstDistributionEpoch == 0 || rewards.firstDistributionEpoch > epoch) return 0;
    return rewards.cumulatedRewardsPerShare[_findPreviousBitInBitmap(rewards.rewardedEpochs, epoch)];
  }

  function _getPreviousDistributionEpoch(StakerRewards storage rewards, uint256 epoch) internal view returns (uint256) {
    uint256 rewardsPerShare = rewards.cumulatedRewardsPerShare[epoch];
    if (rewardsPerShare > 0) return epoch;
    if (rewards.firstDistributionEpoch == 0 || rewards.firstDistributionEpoch > epoch) return 0;
    return _findPreviousBitInBitmap(rewards.rewardedEpochs, epoch);
  }

  function _getPreviousActionEpoch(StakerRewards storage rewards, uint256 epoch) internal view returns (uint256) {
    if (rewards.totalStakedPerEpoch[epoch] > 0) return epoch;
    if (!rewards.actionMade) return 0;
    return _findPreviousBitInBitmap(rewards.actionEpochs, epoch);
  }

  function _markLastAction(StakerRewards storage rewards, uint256 epoch) internal {
    if (epoch == rewards.lastActionEpoch) return;
    if (!rewards.actionMade) {
      rewards.actionMade = true;
    }
    require(epoch > rewards.lastActionEpoch, "Cannot mark previous epoch");
    rewards.lastActionEpoch = epoch;
    rewards.actionEpochs.set(epoch);
  }

  // TODO try to remove bitmap, update everything we can in actions

  /**
   * @dev Is expected to be called for each epoch
   */
  function distribute(StakerRewards storage rewards, uint256 amount, uint256 epoch) internal {
    if (amount == 0) return;
    uint256 previousDistributionEpoch = _getPreviousDistributionEpoch(rewards, epoch - 1);
    uint256 previousActionEpoch = _getPreviousActionEpoch(rewards, epoch);
    uint256 totalStaked = rewards.totalStakedPerEpoch[previousActionEpoch];
    rewards.totalStakedPerEpoch[epoch] = totalStaked;
    if (rewards.firstDistributionEpoch == 0) {
      rewards.firstDistributionEpoch = epoch;
    }
    require(totalStaked > 0, "Nothing staked in this epoch");
    rewards.rewardedEpochs.set(epoch);
    uint256 lastEpochReward = epoch > 0 ? rewards.cumulatedRewardsPerShare[previousDistributionEpoch] : 0;
    rewards.cumulatedRewardsPerShare[epoch] = lastEpochReward + amount * PRECISION / totalStaked;
  }

  function _firstDeposit(StakerRewards storage rewards, uint256 amount, uint256 epoch) internal {
    rewards.depositEpoch[msg.sender] = epoch;
    rewards.depositAmount[msg.sender] += amount;
    rewards.totalStaked += amount;
    rewards.totalStakedPerEpoch[epoch] = rewards.totalStaked;
    _markLastAction(rewards, epoch);
  }

  function deposit(StakerRewards storage rewards, uint256 amount, uint256 epoch, uint256 lastRewardEpoch)
  internal
  returns (uint256)
  {
    _requireFutureEpoch(epoch, lastRewardEpoch);
    require(epoch >= rewards.lastActionEpoch, "Current epoch is in the past");
    if (rewards.depositEpoch[msg.sender] == 0) {
      require(rewards.pendingTransitions[msg.sender].endEpoch <= epoch, "Cannot deposit with pending transition");
      _firstDeposit(rewards, amount, epoch);
      return 0;
    }
    require(rewards.depositEpoch[msg.sender] <= lastRewardEpoch, "Cannot deposit with pending transition");
    rewards.pendingTransitions[msg.sender] =
            Transition({epoch: rewards.depositEpoch[msg.sender], amount: rewards.depositAmount[msg.sender], endEpoch: epoch});
    _firstDeposit(rewards, amount, epoch);
    return claim(rewards, lastRewardEpoch);
  }

  function withdraw(StakerRewards storage rewards, uint256 amount, uint256 epoch, uint256 lastRewardEpoch)
  internal
  returns (uint256)
  {
    _requireFutureEpoch(epoch, lastRewardEpoch);
    require(rewards.depositEpoch[msg.sender] <= lastRewardEpoch, "Cannot withdraw with pending transition");
    require(rewards.depositAmount[msg.sender] >= amount, "Insufficient staked amount");

    rewards.pendingTransitions[msg.sender] =
            Transition({epoch: rewards.depositEpoch[msg.sender], amount: rewards.depositAmount[msg.sender], endEpoch: epoch});
    rewards.depositAmount[msg.sender] -= amount;
    rewards.depositEpoch[msg.sender] = epoch;
    rewards.totalStaked -= amount;
    rewards.totalStakedPerEpoch[epoch] = rewards.totalStaked;
    _markLastAction(rewards, epoch);
    uint256 r = claim(rewards, lastRewardEpoch);
    if (rewards.depositAmount[msg.sender] == 0) delete rewards.depositEpoch[msg.sender];
    return r;
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
    uint256 latestTransitionEpoch =
      latestRewardEpoch > transition.endEpoch - 1 ? transition.endEpoch - 1 : latestRewardEpoch;
    return (
      _getCumulatedRewardsForEpoch(rewards, latestTransitionEpoch)
      - _getCumulatedRewardsForEpoch(rewards, transition.epoch - 1)
    ) * transition.amount / PRECISION;
  }

  function reward(StakerRewards storage rewards, address staker, uint256 latestRewardEpoch)
  internal
  view
  returns (uint256)
  {
    uint256 depositEpoch = rewards.depositEpoch[staker];
    uint256 amount = rewards.depositAmount[staker];
    if (depositEpoch > latestRewardEpoch || amount == 0) return 0;
    return (
      amount
      * (
      _getCumulatedRewardsForEpoch(rewards, latestRewardEpoch)
      - _getCumulatedRewardsForEpoch(rewards, depositEpoch - 1)
    )
    ) / PRECISION;
  }

  function hasPendingTransitionRewards(StakerRewards storage rewards, address staker) internal view returns (bool) {
    return rewards.pendingTransitions[staker].epoch > 0
      && rewards.pendingTransitions[staker].epoch <= rewards.pendingTransitions[staker].endEpoch;
  }

  function _requireFutureEpoch(uint256 currentEpoch, uint256 latestRewardedEpoch) internal pure {
    require(currentEpoch > latestRewardedEpoch, "Current epoch is in the past");
  }
}
