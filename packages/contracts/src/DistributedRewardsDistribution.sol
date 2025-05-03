// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.20;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

import {IRewardsDistribution} from "./interfaces/IRewardsDistribution.sol";
import {IRouter} from "./interfaces/IRouter.sol";
import {Errors} from "./libs/Errors.sol";

/**
 * @title DistributedRewardsDistribution V2 - backward compatible with V1 set of contracts
 * @notice A reward distribution system using a single Merkle root for each block range
 * @dev This contract manages reward distributions through a Merkle tree verification system
 *      Each distribution cycle covers a block range and is committed as one Merkle root
 */
contract DistributedRewardsDistribution is IRewardsDistribution, AccessControl, Pausable {
  using EnumerableSet for EnumerableSet.AddressSet;

  bytes32 public constant REWARDS_DISTRIBUTOR_ROLE = keccak256("REWARDS_DISTRIBUTOR_ROLE");
  bytes32 public constant REWARDS_TREASURY_ROLE = keccak256("REWARDS_TREASURY_ROLE");

  IRouter public immutable router;

  uint256 public requiredApproves = 1; // default 1/1
  uint128 public roundRobinBlocks = 256; // default 256‑block windows
  uint128 public windowSize = 1; // committers per window

  EnumerableSet.AddressSet private distributors;

  /**
   * @notice Initializes the contract with a router
   * @param _router The router contract address
   */
  constructor(IRouter _router) {
    if (address(_router) == address(0)) revert Errors.ZeroAddress();
    router = _router;
    _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
  }

  /**
   * @notice Represents a commitment for a block range
   * @dev Stores all information about a specific Merkle root commitment
   */
  struct Commitment {
    bool exists;
    bytes32 merkleRoot;
    uint16 totalBatches;
    uint16 processedBatches;
    uint256 approvalCount;
    string ipfsLink;
  }

  // key => Commitment
  mapping(bytes32 => Commitment) public commitments;
  mapping(bytes32 => mapping(address => bool)) public approvedBy;
  mapping(bytes32 => mapping(bytes32 => bool)) public processed;

  uint256 public lastBlockRewarded;

  mapping(uint256 => uint256) public accumulatedRewards;
  mapping(uint256 => uint256) public withdrawnRewards;

  /**
   * @notice Adds a distributor to the whitelist
   * @param distributor Address of the distributor to add
   */
  function addDistributor(address distributor) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (!distributors.add(distributor)) revert Errors.DistributorAlreadyAdded();
    _grantRole(REWARDS_DISTRIBUTOR_ROLE, distributor);
    emit DistributorAdded(distributor);
  }

  /**
   * @notice Removes a distributor from the whitelist
   * @param distributor Address of the distributor to remove
   */
  function removeDistributor(address distributor) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (distributors.length() <= requiredApproves) revert Errors.NotEnoughDistributorsToApprove();
    if (!distributors.remove(distributor)) revert Errors.DistributorDoesNotExist();
    _revokeRole(REWARDS_DISTRIBUTOR_ROLE, distributor);
    emit DistributorRemoved(distributor);
  }

  /**
   * @notice Sets the number of approvals required for a distribution
   * @param approvesRequired New number of required approvals
   */
  function setApprovesRequired(uint256 approvesRequired) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (approvesRequired == 0) revert Errors.ApprovesRequiredMustBeGreaterThanZero();
    if (approvesRequired > distributors.length()) {
      revert Errors.ApprovesRequiredMustBeLessThanOrEqualToDistributorsCount();
    }
    requiredApproves = approvesRequired;
    emit ApprovesRequiredChanged(approvesRequired);
  }

  /**
   * @notice Sets the window size for eligible distributors
   * @param n New window size
   */
  function setWindowSize(uint256 n) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (n == 0) revert Errors.WindowSizeMustBeGreaterThanZero();
    if (n > distributors.length()) revert Errors.WindowSizeMustBeLessThanOrEqualToDistributorsCount();
    windowSize = uint128(n);
    emit WindowSizeChanged(n);
  }

  /**
   * @notice Sets the number of blocks between distributor rotations
   * @param n New number of blocks
   */
  function setRoundRobinBlocks(uint256 n) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (n == 0) revert Errors.RoundRobinBlocksMustBeGreaterThanZero();
    roundRobinBlocks = uint128(n);
    emit RoundRobinBlocksChanged(n);
  }

  /**
   * @dev Get an index of the first distributor which can currently commit a distribution
   * @return Index of the current distributor in the round-robin rotation
   */
  function _firstEligible() internal view returns (uint256) {
    uint256 count = distributors.length();
    return count == 0 ? 0 : (block.number / uint256(roundRobinBlocks)) % count;
  }

  /**
   * @notice Checks if an address is currently eligible to commit a distribution
   * @param who Address to check
   * @return True if the address can commit, false otherwise
   * @dev Round-robin distributor selection mechanism based on current block number
   */
  function canCommit(address who) public view returns (bool) {
    uint256 count = distributors.length();
    if (count == 0) revert Errors.NoDistributorsAdded();
    uint256 first = _firstEligible();
    for (uint256 i; i < windowSize; ++i) {
      if (distributors.at((first + i) % count) == who) return true;
    }
    return false;
  }

  /**
   * @dev Generates a unique key for a block range
   * @param a Starting block
   * @param b Ending block
   * @return Hash representing the block range
   */
  function _key(uint256 a, uint256 b) internal pure returns (bytes32) {
    return keccak256(abi.encode(a, b));
  }

  /**
   * @notice Commit a distribution root for a block range
   * @param blockRange Array with [fromBlock, toBlock]
   * @param root The Merkle root calculated off-chain
   * @param totalBatches The total number of batches included in the Merkle tree
   * @param ipfs IPFS link to the full data
   * @dev This function initiates the approval process for a new reward distribution.
   *      Ensures the caller is eligible to commit and validates all inputs.
   */
  function commitRoot(uint256[2] calldata blockRange, bytes32 root, uint16 totalBatches, string calldata ipfs)
    external
    whenNotPaused
  {
    uint256 fromBlock = blockRange[0];
    uint256 toBlock = blockRange[1];
    if (toBlock < fromBlock) revert Errors.ToBlockLessThanFromBlock();
    if (toBlock >= block.number) revert Errors.FutureBlock();
    if (root == bytes32(0)) revert Errors.InvalidMerkleRoot();
    if (!canCommit(msg.sender)) revert Errors.NotACommitter();
    if (totalBatches == 0) revert Errors.TotalLeavesCannotBeZero();

    bytes32 k = _key(fromBlock, toBlock);
    Commitment storage c = commitments[k];
    if (!c.exists) {
      c.exists = true;
      c.merkleRoot = root;
      c.totalBatches = totalBatches;
      c.ipfsLink = ipfs;
      emit NewCommitment(msg.sender, fromBlock, toBlock, root);
    } else if (c.merkleRoot != root) {
      revert Errors.MerkleRootMismatch();
    }
    _approve(k, fromBlock, toBlock);
  }

  /**
   * @notice Approve a previously committed root
   * @param blockRange Array with [fromBlock, toBlock]
   * @dev Allows distributors to approve an existing commitment
   */
  function approveRoot(uint256[2] calldata blockRange) external whenNotPaused onlyRole(REWARDS_DISTRIBUTOR_ROLE) {
    bytes32 k = _key(blockRange[0], blockRange[1]);
    Commitment storage c = commitments[k];
    if (!c.exists) revert Errors.MerkleRootNotCommitted();
    _approve(k, blockRange[0], blockRange[1]);
  }

  /**
   * @dev Internal function to record an approval for a commitment
   * @param k The commitment key
   * @param fromBlock Starting block
   * @param toBlock Ending block
   */
  function _approve(bytes32 k, uint256 fromBlock, uint256 toBlock) internal {
    if (approvedBy[k][msg.sender]) revert Errors.AlreadyApproved();
    Commitment storage c = commitments[k];
    c.approvalCount += 1;
    approvedBy[k][msg.sender] = true;
    emit Approved(msg.sender, fromBlock, toBlock, c.merkleRoot, c.ipfsLink);
  }

  /**
   * @notice Distribute rewards for a single batch, verifying against the Merkle root
   * @param blockRange Array with [fromBlock, toBlock]
   * @param recipients Array of worker IDs receiving rewards
   * @param workerRewards Array of worker reward amounts
   * @param stakerRewards Array of staker reward amounts
   * @param merkleProof Proof that this batch is part of the Merkle tree
   * @dev Validates the batch data against the Merkle proof and distributes rewards
   */
  function distribute(
    uint256[2] calldata blockRange,
    uint256[] calldata recipients,
    uint256[] calldata workerRewards,
    uint256[] calldata stakerRewards,
    bytes32[] calldata merkleProof
  ) external whenNotPaused {
    if (recipients.length != workerRewards.length || recipients.length != stakerRewards.length) {
      revert Errors.ArrayLengthMismatch();
    }

    uint256 fromBlock = blockRange[0];
    uint256 toBlock = blockRange[1];
    bytes32 k = _key(fromBlock, toBlock);
    Commitment storage c = commitments[k];

    if (!c.exists) revert Errors.MerkleRootNotCommitted();
    if (c.approvalCount < requiredApproves) revert Errors.NotEnoughApprovals();

    bytes32 leaf = keccak256(abi.encode(recipients, workerRewards, stakerRewards));
    if (processed[k][leaf]) revert Errors.BatchAlreadyProcessed();
    if (!MerkleProof.verify(merkleProof, c.merkleRoot, leaf)) revert Errors.InvalidMerkleProof();

    if (lastBlockRewarded != 0 && fromBlock != lastBlockRewarded + 1) revert Errors.NotAllBlocksCovered();

    processed[k][leaf] = true;
    c.processedBatches += 1;
    if (c.processedBatches == c.totalBatches) {
      lastBlockRewarded = toBlock;
    }

    for (uint256 i; i < recipients.length; ++i) {
      accumulatedRewards[recipients[i]] += workerRewards[i];
    }
    router.staking().distribute(recipients, stakerRewards);
    emit BatchDistributed(fromBlock, toBlock, uint64(c.processedBatches - 1), recipients, workerRewards, stakerRewards);
  }

  /**
   * @notice Get accumulated rewards for a worker
   * @param wid Worker ID to check
   * @return Total accumulated rewards
   */
  function accumulativeRewardOf(uint256 wid) public view returns (uint256) {
    return accumulatedRewards[wid];
  }

  /**
   * @notice Get withdrawable rewards for a worker
   * @param wid Worker ID to check
   * @return Withdrawable reward amount
   */
  function withdrawableRewardOf(uint256 wid) public view returns (uint256) {
    return accumulatedRewards[wid] - withdrawnRewards[wid];
  }

  /**
   * @notice Claim rewards for a worker
   * @param who Address of the worker
   * @return claimed Amount of rewards claimed
   * @dev Processes both staking rewards and worker rewards
   * // Loop DOS danger
   */
  function claim(address who) external whenNotPaused onlyRole(REWARDS_TREASURY_ROLE) returns (uint256 claimed) {
    claimed = router.staking().claim(who);
    uint256[] memory owned = router.workerRegistration().getOwnedWorkers(who);
    for (uint256 i; i < owned.length; ++i) {
      uint256 wid = owned[i];
      uint256 amt = withdrawableRewardOf(wid);
      if (amt > 0) {
        withdrawnRewards[wid] += amt;
        claimed += amt;
        emit RewardClaimed(who, wid, amt);
      } 
    }
  }

  /**
   * @notice Get currently claimable rewards for worker
   * @param who Address of the worker
   * @return total Amount of claimable rewards
   * @dev Includes both staking rewards and worker rewards
   */
  function claimable(address who) external view returns (uint256 total) {
    total = router.staking().claimable(who);
    uint256[] memory owned = router.workerRegistration().getOwnedWorkers(who);
    for (uint256 i; i < owned.length; ++i) {
      total += withdrawableRewardOf(owned[i]);
    }
  }
}
