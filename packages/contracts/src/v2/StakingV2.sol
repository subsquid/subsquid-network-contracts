// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import "../interfaces/IStaking.sol";
import "../interfaces/IRouter.sol";
import "../interfaces/IRewardCalculationHook.sol";
import "./AccessControlledPausableUpgradeableV2.sol";

/**
 * @title StakingV2
 * @dev UUPS-upgradeable staking with SafeERC20.
 *      Claim loop is bounded by maxDelegations (default 100, adjustable via governance).
 */
contract StakingV2 is AccessControlledPausableUpgradeableV2, IStaking {
  using EnumerableSet for EnumerableSet.UintSet;
  using SafeERC20 for IERC20;

  uint256 internal constant PRECISION = 1e18;
  bytes32 public constant REWARDS_DISTRIBUTOR_ROLE = keccak256("REWARDS_DISTRIBUTOR_ROLE");

  IERC20 public token;
  IRouter public router;
  uint256 public lastEpochRewarded;
  uint256 public maxDelegations;
  uint128 public epochsLockedAfterStake;
  mapping(uint256 worker => StakerRewards) internal rewards;
  mapping(address staker => uint256) internal _claimable;
  mapping(address staker => EnumerableSet.UintSet workers) internal delegatedTo;

  function initialize(IERC20 _token, IRouter _router) external initializer {
    __AccessControlledPausableUpgradeableV2_init();
    token = _token;
    router = _router;
    maxDelegations = 100;
    epochsLockedAfterStake = 1;
  }

  function distribute(uint256[] calldata workers, uint256[] calldata amounts)
    external
    onlyRole(REWARDS_DISTRIBUTOR_ROLE)
    whenNotPaused
  {
    lastEpochRewarded = router.networkController().epochNumber();
    for (uint256 i = 0; i < workers.length; i++) {
      _distribute(workers[i], amounts[i]);
    }

    emit Distributed(lastEpochRewarded);
  }

  function _distribute(uint256 worker, uint256 amount) internal {
    if (amount == 0) return;
    uint256 totalStaked = rewards[worker].totalStaked;
    if (totalStaked == 0) {
      return;
    }
    rewards[worker].cumulatedRewardsPerShare += amount * PRECISION / totalStaked;
  }

  function deposit(uint256 worker, uint256 amount) external whenNotPaused {
    INetworkController network = router.networkController();
    require(
      lastEpochRewarded + network.stakingDeadlock() >= network.epochNumber() || lastEpochRewarded == 0,
      "Rewards out of date"
    );
    require(router.workerRegistration().isWorkerActive(worker), "Worker not active");
    StakerRewards storage _rewards = rewards[worker];

    _rewardCalculation().onDelegationWillChange(worker, int256(amount));
    updateCheckpoint(_rewards, worker);
    _rewards.totalStaked += amount;
    _rewards.depositAmount[msg.sender] += amount;
    delegatedTo[msg.sender].add(worker);
    require(delegatedTo[msg.sender].length() <= maxDelegations, "Max delegations reached");
    rewards[worker].withdrawAllowed[msg.sender] = network.nextEpoch() + lockLengthBlocks();

    token.safeTransferFrom(msg.sender, address(this), amount);

    emit Deposited(worker, msg.sender, amount);
  }

  function withdraw(uint256 worker, uint256 amount) external whenNotPaused {
    StakerRewards storage _rewards = rewards[worker];
    require(_rewards.depositAmount[msg.sender] >= amount, "Insufficient staked amount");
    require(_rewards.withdrawAllowed[msg.sender] <= block.number, "Too early to withdraw");
    _rewardCalculation().onDelegationWillChange(worker, -int256(amount));
    updateCheckpoint(_rewards, worker);
    _rewards.totalStaked -= amount;
    _rewards.depositAmount[msg.sender] -= amount;
    if (_rewards.depositAmount[msg.sender] == 0) {
      delegatedTo[msg.sender].remove(worker);
    }

    token.safeTransfer(msg.sender, amount);

    emit Withdrawn(worker, msg.sender, amount);
  }

  function totalStakedPerWorker(uint256[] calldata workers) external view returns (uint256[] memory) {
    uint256[] memory result = new uint256[](workers.length);
    for (uint256 i = 0; i < workers.length; i++) {
      result[i] = rewards[workers[i]].totalStaked;
    }
    return result;
  }

  function delegated(uint256 worker) external view returns (uint256) {
    return rewards[worker].totalStaked;
  }

  /// @dev Claim rewards for a staker. Bounded by maxDelegations.
  function claim(address staker) external onlyRole(REWARDS_DISTRIBUTOR_ROLE) whenNotPaused returns (uint256) {
    uint256[] memory workers = delegates(staker);
    uint256 reward = _claimable[staker];
    for (uint256 i = 0; i < workers.length; i++) {
      StakerRewards storage _rewards = rewards[workers[i]];
      uint256 claimed = pendingReward(_rewards, staker);
      reward += claimed;
      _rewards.checkpoint[staker] = _rewards.cumulatedRewardsPerShare;
      if (claimed > 0) {
        emit Rewarded(workers[i], staker, claimed);
      }
    }
    _claimable[staker] = 0;
    emit Claimed(staker, reward, workers);
    return reward;
  }

  function claimable(address staker) external view returns (uint256) {
    uint256[] memory workers = delegates(staker);
    uint256 reward = _claimable[staker];
    for (uint256 i = 0; i < workers.length; i++) {
      reward += pendingReward(rewards[workers[i]], staker);
    }
    return reward;
  }

  function delegates(address staker) public view returns (uint256[] memory) {
    return delegatedTo[staker].values();
  }

  function updateCheckpoint(StakerRewards storage _rewards, uint256 workerId) internal {
    uint256 rewarded = pendingReward(_rewards, msg.sender);
    _claimable[msg.sender] += rewarded;
    _rewards.checkpoint[msg.sender] = _rewards.cumulatedRewardsPerShare;
    if (rewarded > 0) {
      emit Rewarded(workerId, msg.sender, rewarded);
    }
  }

  function pendingReward(StakerRewards storage _rewards, address staker) internal view returns (uint256) {
    uint256 amount = _rewards.depositAmount[staker];
    return (amount * (_rewards.cumulatedRewardsPerShare - _rewards.checkpoint[staker])) / PRECISION;
  }

  /// @dev Minimum amount of time when withdraw is not allowed after stake
  function lockLengthBlocks() public view returns (uint128) {
    return router.networkController().epochLength() * epochsLockedAfterStake;
  }

  function getDeposit(address staker, uint256 worker)
    external
    view
    returns (uint256 depositAmount, uint256 withdrawAllowed)
  {
    return (rewards[worker].depositAmount[staker], rewards[worker].withdrawAllowed[staker]);
  }

  function setMaxDelegations(uint256 _maxDelegations) external onlyRole(DEFAULT_ADMIN_ROLE) {
    maxDelegations = _maxDelegations;
    emit MaxDelegationsChanged(_maxDelegations);
  }

  function setEpochsLock(uint128 _epochsLock) external onlyRole(DEFAULT_ADMIN_ROLE) {
    require(_epochsLock > 0, "Epochs lock must be greater than 0");
    require(_epochsLock < 100, "Epochs lock too high");
    epochsLockedAfterStake = _epochsLock;
    emit EpochsLockChanged(_epochsLock);
  }

  function _rewardCalculation() internal view returns (IRewardCalculationHook) {
    return IRewardCalculationHook(address(router.rewardCalculation()));
  }

  uint256[42] private __gap;
}
