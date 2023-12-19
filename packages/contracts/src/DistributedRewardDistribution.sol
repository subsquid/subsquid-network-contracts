// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import "./interfaces/IRewardsDistribution.sol";
import "./interfaces/IRouter.sol";
import "./AccessControlledPausable.sol";

/**
 * @title Distributed Rewards Distribution Contract
 * @dev Contract has a list of whitelisted distributors
 * Each distributor has a timeframe (256 blocks) to commit a distribution
 * Other distributors can approve it
 * After 3 approvals, the distribution is executed
 */
contract DistributedRewardsDistribution is AccessControlledPausable, IRewardsDistribution {
  using EnumerableSet for EnumerableSet.AddressSet;

  bytes32 public constant REWARDS_DISTRIBUTOR_ROLE = keccak256("REWARDS_DISTRIBUTOR_ROLE");
  bytes32 public constant REWARDS_TREASURY_ROLE = keccak256("REWARDS_TREASURY_ROLE");
  uint8 internal constant APPROVES_REQUIRED = 3;

  mapping(uint256 workerId => uint256) internal _claimable;
  mapping(uint256 fromBlock => mapping(uint256 toBlock => bytes32)) public commitments;
  mapping(uint256 fromBlock => mapping(uint256 toBlock => uint8)) public approves;
  mapping(bytes32 => mapping(address => bool)) public alreadyApproved;
  uint256 public lastBlockRewarded;
  IRouter public immutable router;
  EnumerableSet.AddressSet private distributors;

  /// @dev Emitted on new commitment
  event NewCommitment(
    address indexed who,
    uint256 fromBlock,
    uint256 toBlock,
    uint256[] recipients,
    uint256[] workerRewards,
    uint256[] stakerRewards,
    uint256[] allocationsUsed
  );

  /// @dev Emitted when commitment is approved
  event Approved(
    address indexed who,
    uint256 fromBlock,
    uint256 toBlock,
    uint256[] recipients,
    uint256[] workerRewards,
    uint256[] stakerRewards,
    uint256[] allocationsUsed
  );

  /// @dev Emitted when new distributor is added
  event DistributorAdded(address indexed distributor);
  /// @dev Emitted when distributor is removed
  event DistributorRemoved(address indexed distributor);

  constructor(IRouter _router) {
    router = _router;
  }

  /**
   * @dev Add whitelisted distributor
   * Only admin can call this function
   */
  function addDistributor(address distributor) external onlyRole(DEFAULT_ADMIN_ROLE) {
    require(distributors.add(distributor), "Distributor already added");
    _grantRole(REWARDS_DISTRIBUTOR_ROLE, distributor);

    emit DistributorAdded(distributor);
  }

  /**
   * @dev Remove whitelisted distributor
   * Only admin can call this function
   */
  function removeDistributor(address distributor) external onlyRole(DEFAULT_ADMIN_ROLE) {
    require(distributors.remove(distributor), "Distributor does not exist");
    _revokeRole(REWARDS_DISTRIBUTOR_ROLE, distributor);

    emit DistributorRemoved(distributor);
  }

  /**
   * @notice Distributor has 256 blocks to commit a distribution
   */
  function distributorIndex() public view returns (uint256) {
    uint256 slotStart = block.number / 256 * 256;
    return uint256(blockhash(slotStart)) % distributors.length();
  }

  /// @return the distributor which can currently commit rewards
  function currentDistributor() public view returns (address) {
    return distributors.at(distributorIndex());
  }

  /**
   * @dev Commit rewards for a worker
   * @param fromBlock block from which the rewards are calculated
   * @param toBlock block to which the rewards are calculated
   * @param recipients array of recipients of rewards
   * @param workerRewards array of rewards for workers
   * @param _stakerRewards array of rewards for stakers
   * can only be called by current distributor
   * lengths of recipients, workerRewards and _stakerRewards must be equal
   * can recommit to same toBlock, but this drops approve count back to 1
   */
  function commit(
    uint256 fromBlock,
    uint256 toBlock,
    uint256[] calldata recipients,
    uint256[] calldata workerRewards,
    uint256[] calldata _stakerRewards,
    uint256[] calldata _allocationsUsed
  ) external whenNotPaused {
    require(recipients.length == workerRewards.length, "Recipients and worker amounts length mismatch");
    require(recipients.length == _stakerRewards.length, "Recipients and staker amounts length mismatch");

    require(currentDistributor() == msg.sender, "Not a distributor");
    require(toBlock < block.number, "Future block");
    bytes32 commitment = keccak256(msg.data[4:]);
    require(!alreadyApproved[commitment][msg.sender], "Already approved");
    commitments[fromBlock][toBlock] = commitment;
    approves[fromBlock][toBlock] = 1;
    alreadyApproved[commitment][msg.sender] = true;

    emit NewCommitment(msg.sender, fromBlock, toBlock, recipients, workerRewards, _stakerRewards, _allocationsUsed);
  }

  /**
   * @dev Approve a commitment
   * Same args as for commit
   * After 3 approvals, the distribution is executed
   */
  function approve(
    uint256 fromBlock,
    uint256 toBlock,
    uint256[] calldata recipients,
    uint256[] calldata workerRewards,
    uint256[] calldata _stakerRewards,
    uint256[] calldata _allocationsUsed
  ) external onlyRole(REWARDS_DISTRIBUTOR_ROLE) whenNotPaused {
    require(commitments[fromBlock][toBlock] != 0, "Commitment does not exist");
    bytes32 commitment = keccak256(msg.data[4:]);
    require(commitments[fromBlock][toBlock] == commitment, "Commitment mismatch");
    require(!alreadyApproved[commitment][msg.sender], "Already approved");
    approves[fromBlock][toBlock]++;
    alreadyApproved[commitment][msg.sender] = true;

    if (approves[fromBlock][toBlock] == APPROVES_REQUIRED) {
      distribute(fromBlock, toBlock, recipients, workerRewards, _stakerRewards);
    }

    emit Approved(msg.sender, fromBlock, toBlock, recipients, workerRewards, _stakerRewards, _allocationsUsed);
  }

  /// @return true if the commitment can be approved by `who`
  function canApprove(
    address who,
    uint256 fromBlock,
    uint256 toBlock,
    uint256[] calldata recipients,
    uint256[] calldata workerRewards,
    uint256[] calldata _stakerRewards,
    uint256[] calldata _allocationsUsed
  ) external view returns (bool) {
    if (!hasRole(REWARDS_DISTRIBUTOR_ROLE, who)) {
      return false;
    }
    if (commitments[fromBlock][toBlock] == 0) {
      return false;
    }
    bytes32 commitment =
      keccak256(abi.encode(fromBlock, toBlock, recipients, workerRewards, _stakerRewards, _allocationsUsed));
    if (commitments[fromBlock][toBlock] != commitment) {
      return false;
    }
    if (alreadyApproved[commitment][who]) {
      return false;
    }
    return true;
  }

  /// @dev All distributions must be sequential and not blocks can be missed
  /// E.g, after distribution for blocks [A, B], next one bust be for [B + 1, C]
  function distribute(
    uint256 fromBlock,
    uint256 toBlock,
    uint256[] calldata recipients,
    uint256[] calldata workerRewards,
    uint256[] calldata _stakerRewards
  ) internal {
    require(lastBlockRewarded == 0 || fromBlock == lastBlockRewarded + 1, "Not all blocks covered");
    for (uint256 i = 0; i < recipients.length; i++) {
      _claimable[recipients[i]] += workerRewards[i];
    }
    router.staking().distribute(recipients, _stakerRewards);
    lastBlockRewarded = toBlock;

    emit Distributed(fromBlock, toBlock);
  }

  /// @dev Treasury claims rewards for an address
  /// @notice Can only be called by the treasury
  /// @notice Claimable amount should drop to 0 after function call
  function claim(address who) external onlyRole(REWARDS_TREASURY_ROLE) whenNotPaused returns (uint256 claimedAmount) {
    claimedAmount = router.staking().claim(who);
    uint256[] memory ownedWorkers = router.workerRegistration().getOwnedWorkers(who);
    for (uint256 i = 0; i < ownedWorkers.length; i++) {
      uint256 workerId = ownedWorkers[i];
      claimedAmount += _claimable[workerId];
      _claimable[workerId] = 0;
    }

    emit Claimed(who, claimedAmount);
    return claimedAmount;
  }

  /// @return claimable amount for the address
  function claimable(address who) external view returns (uint256) {
    uint256 reward = router.staking().claimable(who);
    uint256[] memory ownedWorkers = router.workerRegistration().getOwnedWorkers(who);
    for (uint256 i = 0; i < ownedWorkers.length; i++) {
      uint256 workerId = ownedWorkers[i];
      reward += _claimable[workerId];
    }
    return reward;
  }
}
