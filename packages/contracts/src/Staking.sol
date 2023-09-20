// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import "./interfaces/IStaking.sol";

struct StakerRewards {
  uint256 cumulatedRewardsPerShare;
  mapping(address staker => uint256) checkpoint;
  mapping(address staker => uint256) depositAmount;
  uint256 totalStaked;
}

contract Staking is AccessControl, IStaking {
  using EnumerableSet for EnumerableSet.AddressSet;

  uint256 internal constant PRECISION = 1e18;
  bytes32 public constant REWARDS_DISTRIBUTOR_ROLE = keccak256("REWARDS_DISTRIBUTOR_ROLE");

  IERC20 public token;
  mapping(address worker => StakerRewards) internal rewards;
  mapping(address staker => uint256) _claimable;
  mapping(address staker => EnumerableSet.AddressSet workers) delegatedTo;

  constructor(IERC20 _token) {
    _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
    token = _token;
  }

  function distribute(address[] calldata workers, uint256[] calldata amounts)
    external
    onlyRole(REWARDS_DISTRIBUTOR_ROLE)
  {
    for (uint256 i = 0; i < workers.length; i++) {
      _distribute(workers[i], amounts[i]);
    }
  }

  function _distribute(address worker, uint256 amount) internal {
    if (amount == 0) return;
    uint256 totalStaked = rewards[worker].totalStaked;
    require(totalStaked > 0, "Nothing staked");
    rewards[worker].cumulatedRewardsPerShare += amount * PRECISION / totalStaked;
  }

  function deposit(address worker, uint256 amount) external {
    StakerRewards storage _rewards = rewards[worker];
    updateCheckpoint(_rewards);
    _rewards.totalStaked += amount;
    _rewards.depositAmount[msg.sender] += amount;
    delegatedTo[msg.sender].add(worker);

    token.transferFrom(msg.sender, address(this), amount);
  }

  function withdraw(address worker, uint256 amount) external {
    StakerRewards storage _rewards = rewards[worker];
    require(_rewards.depositAmount[msg.sender] >= amount, "Insufficient staked amount");
    updateCheckpoint(_rewards);
    _rewards.totalStaked -= amount;
    _rewards.depositAmount[msg.sender] -= amount;
    if (_rewards.depositAmount[msg.sender] == 0) {
      delegatedTo[msg.sender].remove(worker);
    }

    token.transfer(msg.sender, amount);
  }

  function claim(address staker) external onlyRole(REWARDS_DISTRIBUTOR_ROLE) returns (uint256) {
    address[] memory workers = delegatedTo[staker].values();
    uint256 reward = _claimable[staker];
    for (uint256 i = 0; i < workers.length; i++) {
      reward += pendingReward(rewards[workers[i]], staker);
      rewards[workers[i]].checkpoint[msg.sender] = rewards[workers[i]].cumulatedRewardsPerShare;
    }
    _claimable[staker] = 0;
    return reward;
  }

  function claimable(address staker) external view returns (uint256) {
    address[] memory workers = delegatedTo[staker].values();
    uint256 reward = _claimable[staker];
    for (uint256 i = 0; i < workers.length; i++) {
      reward += pendingReward(rewards[workers[i]], staker);
    }
    return reward;
  }

  function updateCheckpoint(StakerRewards storage _rewards) internal {
    _claimable[msg.sender] += pendingReward(_rewards, msg.sender);
    _rewards.checkpoint[msg.sender] = _rewards.cumulatedRewardsPerShare;
  }

  function pendingReward(StakerRewards storage _rewards, address staker) internal view returns (uint256) {
    uint256 amount = _rewards.depositAmount[staker];
    return (amount * (_rewards.cumulatedRewardsPerShare - _rewards.checkpoint[staker])) / PRECISION;
  }
}
