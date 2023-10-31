// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import "./interfaces/IStaking.sol";
import "./NetworkController.sol";

/**
 * @title Staking Contract
 * @dev Stake tSQD tokens to earn rewards for the staked worker
 * Stakes and rewards are calculated per each worker separately
 * Distributions are expected to be called by the RewardsDistributor contract on each epoch, but this is not enforced
 * Rewards are shared between all stakers of a worker proportionally to their stake
 * On each reward distriution, the cumulative rewards per share is increased by a value v
 * Which represents how much reward staker is getting per each staked wei
 * So the reward at any point is calculated as difference between current cumulative rewards per share and its value when the user's last action was performed
 */
contract Staking is AccessControl, IStaking {
  using EnumerableSet for EnumerableSet.UintSet;

  uint256 internal constant PRECISION = 1e18;
  bytes32 public constant REWARDS_DISTRIBUTOR_ROLE = keccak256("REWARDS_DISTRIBUTOR_ROLE");

  IERC20 public immutable token;
  INetworkController public immutable network;
  uint256 public lastEpochRewarded;
  mapping(uint256 worker => StakerRewards) internal rewards;
  mapping(address staker => uint256) internal _claimable;
  mapping(address staker => EnumerableSet.UintSet workers) internal delegatedTo;

  constructor(IERC20 _token, INetworkController _network) {
    _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
    token = _token;
    network = _network;
  }

  /**
   * @dev Distribute tokens to stakers in favour of a worker
   * i-th element in amounts array is the amount of tokens to distribute to the stakers of i-th worker
   * will update lastEpochRewarded to current epoch
   * will increase cumulative rewards per share for each worker
   * @dev will revert if total staked amount of a worker is 0 and distributed amount is not 0
   */
  function distribute(uint256[] calldata workers, uint256[] calldata amounts)
    external
    onlyRole(REWARDS_DISTRIBUTOR_ROLE)
  {
    lastEpochRewarded = network.epochNumber();
    for (uint256 i = 0; i < workers.length; i++) {
      _distribute(workers[i], amounts[i]);
    }

    emit Distributed(lastEpochRewarded);
  }

  function _distribute(uint256 worker, uint256 amount) internal {
    if (amount == 0) return;
    uint256 totalStaked = rewards[worker].totalStaked;
    require(totalStaked > 0, "Nothing staked");
    rewards[worker].cumulatedRewardsPerShare += amount * PRECISION / totalStaked;
  }

  /**
   * @dev Deposit amount of tokens in favour of a worker
   * Will remember claimable rewards and update checkpoint for the staker
   * Cannot deposit if rewards were not distributed for 2 epochs (this means something is broken)
   * Cannot withdraw for at least one full epoch latest deposit
   * @notice transfers amount of tSQD from msg.sender to this contract
   */
  function deposit(uint256 worker, uint256 amount) external {
    require(lastEpochRewarded + 2 >= network.epochNumber() || lastEpochRewarded == 0, "Rewards out of date");

    StakerRewards storage _rewards = rewards[worker];
    updateCheckpoint(_rewards);
    _rewards.totalStaked += amount;
    _rewards.depositAmount[msg.sender] += amount;
    delegatedTo[msg.sender].add(worker);
    rewards[worker].withdrawAllowed[msg.sender] = network.nextEpoch() + network.epochLength();

    token.transferFrom(msg.sender, address(this), amount);

    emit Deposited(worker, msg.sender, amount);
  }

  /**
   * @dev Withdraw amount of tokens staked in favour of a worker
   * Will remember claimable rewards and update checkpoint for the staker
   * Can withdraw even if rewards were not distributed for 2 epochs because we cannot lock user's funds
   * @notice transfers amount of tSQD from this contract to msg.sender
   */
  function withdraw(uint256 worker, uint256 amount) external {
    StakerRewards storage _rewards = rewards[worker];
    require(_rewards.depositAmount[msg.sender] >= amount, "Insufficient staked amount");
    require(_rewards.withdrawAllowed[msg.sender] <= block.number, "Too early to withdraw");
    updateCheckpoint(_rewards);
    _rewards.totalStaked -= amount;
    _rewards.depositAmount[msg.sender] -= amount;
    if (_rewards.depositAmount[msg.sender] == 0) {
      delegatedTo[msg.sender].remove(worker);
    }

    token.transfer(msg.sender, amount);

    emit Withdrawn(worker, msg.sender, amount);
  }

  /// @dev For each workerId, returns total staked amount
  /// i-th element in resulting array is the total staked amount for i-th worker
  function totalStakedPerWorker(uint256[] calldata workers) external view returns (uint256[] memory) {
    uint256[] memory result = new uint256[](workers.length);
    for (uint256 i = 0; i < workers.length; i++) {
      result[i] = rewards[workers[i]].totalStaked;
    }
    return result;
  }

  /// @dev Total stake for all active workers
  function activeStake(uint256[] calldata activeWorkers) external view returns (uint256) {
    uint256 result = 0;
    for (uint256 i = 0; i < activeWorkers.length; i++) {
      result += rewards[activeWorkers[i]].totalStaked;
    }
    return result;
  }

  /**
   * @dev Claim rewards for a staker
   * Will update checkpoint and set previously claimed rewards to 0
   * Can only be called by rewards distributor
   * @notice should not transfer any tokens
   */
  function claim(address staker) external onlyRole(REWARDS_DISTRIBUTOR_ROLE) returns (uint256) {
    uint256[] memory workers = delegates(staker);
    uint256 reward = _claimable[staker];
    for (uint256 i = 0; i < workers.length; i++) {
      reward += pendingReward(rewards[workers[i]], staker);
      rewards[workers[i]].checkpoint[staker] = rewards[workers[i]].cumulatedRewardsPerShare;
    }
    _claimable[staker] = 0;

    emit Claimed(staker, reward);

    return reward;
  }

  /**
   * @dev Claimable amount
   * @notice does not modify any state
   */
  function claimable(address staker) external view returns (uint256) {
    uint256[] memory workers = delegates(staker);
    uint256 reward = _claimable[staker];
    for (uint256 i = 0; i < workers.length; i++) {
      reward += pendingReward(rewards[workers[i]], staker);
    }
    return reward;
  }

  /// @dev Get list of all workers that the staker has staked into
  function delegates(address staker) public view returns (uint256[] memory) {
    return delegatedTo[staker].values();
  }

  function updateCheckpoint(StakerRewards storage _rewards) internal {
    _claimable[msg.sender] += pendingReward(_rewards, msg.sender);
    _rewards.checkpoint[msg.sender] = _rewards.cumulatedRewardsPerShare;
  }

  function pendingReward(StakerRewards storage _rewards, address staker) internal view returns (uint256) {
    uint256 amount = _rewards.depositAmount[staker];
    return (amount * (_rewards.cumulatedRewardsPerShare - _rewards.checkpoint[staker])) / PRECISION;
  }

  /// @dev Get the total deposit amount and how much the staker is allowed to withdraw
  function getDeposit(address staker, uint256 worker)
    external
    view
    returns (uint256 depositAmount, uint256 withdrawAllowed)
  {
    return (rewards[worker].depositAmount[staker], rewards[worker].withdrawAllowed[staker]);
  }
}
