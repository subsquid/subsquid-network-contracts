// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.20;

import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuardUpgradeable} from
  "openzeppelin-contracts-upgradeable/contracts/utils/ReentrancyGuardUpgradeable.sol";

import {IRewardsDistribution} from "../interfaces/IRewardsDistribution.sol";
import {IRouter} from "../interfaces/IRouter.sol";
import {Errors} from "../libs/Errors.sol";
import {AccessControlledPausableUpgradeableV2} from "./AccessControlledPausableUpgradeableV2.sol";

/**
 * @title DistributedRewardsDistribution V2
 * @notice Merkle-based reward distribution for workers and stakers.
 * @dev Preserves the V1 reward flow while adding:
 *      - UUPS upgradeability
 *      - pause/unpause controls
 *      - bounded worker-reward claim helpers
 *      - batch-size bounds
 *      - commitment versioning so cleared commitments can be safely resubmitted
 */
contract DistributedRewardsDistribution is
  AccessControlledPausableUpgradeableV2,
  ReentrancyGuardUpgradeable,
  IRewardsDistribution
{
  using EnumerableSet for EnumerableSet.AddressSet;

  bytes32 public constant REWARDS_DISTRIBUTOR_ROLE = keccak256("REWARDS_DISTRIBUTOR_ROLE");
  bytes32 public constant REWARDS_TREASURY_ROLE = keccak256("REWARDS_TREASURY_ROLE");
  uint256 public constant MAX_BATCH_SIZE = 200;

  IRouter public router;

  uint256 public requiredApproves;
  uint128 public roundRobinBlocks;
  uint128 public windowSize;

  EnumerableSet.AddressSet private distributors;

  enum CommitmentStatus {
    NONEXISTENT,
    ACTIVE,
    COMPLETED
  }

  struct Commitment {
    CommitmentStatus status;
    uint256 fromBlock;
    uint256 toBlock;
    bytes32 merkleRoot;
    uint16 totalBatches;
    uint16 processedBatches;
    uint256 approvalCount;
    string ipfsLink;
  }

  mapping(bytes32 => Commitment) public commitments;
  mapping(bytes32 => uint256) public commitmentVersion;
  mapping(bytes32 => mapping(address => uint256)) internal approvedAtVersion;
  mapping(bytes32 => mapping(bytes32 => uint256)) internal processedAtVersion;

  uint256 public lastBlockRewarded;
  bytes32 public lastCommitmentKey;

  mapping(uint256 => uint256) public accumulatedRewards;
  mapping(uint256 => uint256) public withdrawnRewards;

  event CommitmentCleared(
    uint256 indexed fromBlock, uint256 indexed toBlock, bytes32 indexed commitmentKey, CommitmentStatus previousStatus
  );
  event LastRewardedBlockUpdated(uint256 indexed previousBlock, uint256 indexed newBlock);

  function initialize(IRouter _router) external initializer {
    if (address(_router) == address(0)) revert Errors.ZeroAddress();

    __AccessControlledPausableUpgradeableV2_init();
    __ReentrancyGuard_init();

    router = _router;
    requiredApproves = 1;
    roundRobinBlocks = 256;
    windowSize = 1;
  }

  function addDistributor(address distributor) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (!distributors.add(distributor)) revert Errors.DistributorAlreadyAdded();
    _grantRole(REWARDS_DISTRIBUTOR_ROLE, distributor);
    emit DistributorAdded(distributor);
  }

  function removeDistributor(address distributor) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (distributors.length() <= requiredApproves) revert Errors.NotEnoughDistributorsToApprove();
    if (!distributors.remove(distributor)) revert Errors.DistributorDoesNotExist();
    _revokeRole(REWARDS_DISTRIBUTOR_ROLE, distributor);
    emit DistributorRemoved(distributor);
  }

  function setApprovesRequired(uint256 approvesRequired) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (approvesRequired == 0) revert Errors.ApprovesRequiredMustBeGreaterThanZero();
    if (approvesRequired > distributors.length()) {
      revert Errors.ApprovesRequiredMustBeLessThanOrEqualToDistributorsCount();
    }
    requiredApproves = approvesRequired;
    emit ApprovesRequiredChanged(approvesRequired);
  }

  function setWindowSize(uint256 n) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (n == 0) revert Errors.WindowSizeMustBeGreaterThanZero();
    if (n > distributors.length()) revert Errors.WindowSizeMustBeLessThanOrEqualToDistributorsCount();
    windowSize = uint128(n);
    emit WindowSizeChanged(n);
  }

  function setRoundRobinBlocks(uint256 n) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (n == 0) revert Errors.RoundRobinBlocksMustBeGreaterThanZero();
    roundRobinBlocks = uint128(n);
    emit RoundRobinBlocksChanged(n);
  }

  function _firstEligible() internal view returns (uint256) {
    uint256 count = distributors.length();
    return count == 0 ? 0 : (block.number / uint256(roundRobinBlocks)) % count;
  }

  function canCommit(address who) public view returns (bool) {
    uint256 count = distributors.length();
    if (count == 0) revert Errors.NoDistributorsAdded();
    uint256 first = _firstEligible();
    for (uint256 i; i < windowSize; ++i) {
      if (distributors.at((first + i) % count) == who) return true;
    }
    return false;
  }

  function _key(uint256 a, uint256 b) internal pure returns (bytes32) {
    return keccak256(abi.encode(a, b));
  }

  function approvedBy(bytes32 commitmentKey, address approver) public view returns (bool) {
    uint256 version = commitmentVersion[commitmentKey];
    return version != 0 && approvedAtVersion[commitmentKey][approver] == version;
  }

  function processed(bytes32 commitmentKey, bytes32 leaf) public view returns (bool) {
    uint256 version = commitmentVersion[commitmentKey];
    return version != 0 && processedAtVersion[commitmentKey][leaf] == version;
  }

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

    if (lastBlockRewarded != 0 && fromBlock != lastBlockRewarded + 1) revert Errors.NotAllBlocksCovered();

    bytes32 k = _key(fromBlock, toBlock);
    Commitment storage c = commitments[k];
    if (c.status == CommitmentStatus.NONEXISTENT) {
      if (commitmentVersion[k] == 0) {
        commitmentVersion[k] = 1;
      }
      c.status = CommitmentStatus.ACTIVE;
      c.merkleRoot = root;
      c.totalBatches = totalBatches;
      c.ipfsLink = ipfs;
      c.fromBlock = fromBlock;
      c.toBlock = toBlock;
      lastCommitmentKey = k;
      emit NewCommitment(msg.sender, fromBlock, toBlock, root);
    } else if (c.status == CommitmentStatus.COMPLETED) {
      revert Errors.CommitmentAlreadyCompleted();
    } else if (c.merkleRoot != root) {
      revert Errors.MerkleRootMismatch();
    }
    _approve(k, fromBlock, toBlock);
  }

  function approveRoot(uint256[2] calldata blockRange) external whenNotPaused onlyRole(REWARDS_DISTRIBUTOR_ROLE) {
    bytes32 k = _key(blockRange[0], blockRange[1]);
    Commitment storage c = commitments[k];
    if (c.status != CommitmentStatus.ACTIVE) revert Errors.MerkleRootNotCommitted();
    _approve(k, blockRange[0], blockRange[1]);
  }

  function _approve(bytes32 k, uint256 fromBlock, uint256 toBlock) internal {
    uint256 version = commitmentVersion[k];
    if (version == 0) {
      version = 1;
      commitmentVersion[k] = version;
    }
    if (approvedAtVersion[k][msg.sender] == version) revert Errors.AlreadyApproved();
    Commitment storage c = commitments[k];
    c.approvalCount += 1;
    approvedAtVersion[k][msg.sender] = version;
    emit Approved(msg.sender, fromBlock, toBlock, c.merkleRoot, c.ipfsLink);
  }

  function distribute(
    uint256[2] calldata blockRange,
    uint256[] calldata recipients,
    uint256[] calldata workerRewards,
    uint256[] calldata stakerRewards,
    bytes32[] calldata merkleProof
  ) external whenNotPaused nonReentrant {
    if (recipients.length != workerRewards.length || recipients.length != stakerRewards.length) {
      revert Errors.ArrayLengthMismatch();
    }
    if (recipients.length > MAX_BATCH_SIZE) revert Errors.BatchSizeTooLarge();

    _validateAndProcessCommitment(blockRange, recipients, workerRewards, stakerRewards, merkleProof);
    _distributeRewards(blockRange, recipients, workerRewards, stakerRewards);
  }

  function _validateAndProcessCommitment(
    uint256[2] calldata blockRange,
    uint256[] calldata recipients,
    uint256[] calldata workerRewards,
    uint256[] calldata stakerRewards,
    bytes32[] calldata merkleProof
  ) internal {
    bytes32 k = _key(blockRange[0], blockRange[1]);
    Commitment storage c = commitments[k];

    if (c.status == CommitmentStatus.NONEXISTENT) revert Errors.MerkleRootNotCommitted();
    if (c.status == CommitmentStatus.COMPLETED) revert Errors.CommitmentAlreadyCompleted();
    if (c.approvalCount < requiredApproves) revert Errors.NotEnoughApprovals();

    uint256 version = commitmentVersion[k];
    bytes32 leaf = keccak256(abi.encode(recipients, workerRewards, stakerRewards));
    if (processedAtVersion[k][leaf] == version) revert Errors.BatchAlreadyProcessed();
    if (!MerkleProof.verify(merkleProof, c.merkleRoot, leaf)) revert Errors.InvalidMerkleProof();

    processedAtVersion[k][leaf] = version;
    c.processedBatches += 1;
    if (c.processedBatches == c.totalBatches) {
      c.status = CommitmentStatus.COMPLETED;
      lastBlockRewarded = blockRange[1];
    }
  }

  function _distributeRewards(
    uint256[2] calldata blockRange,
    uint256[] calldata recipients,
    uint256[] calldata workerRewards,
    uint256[] calldata stakerRewards
  ) internal {
    for (uint256 i; i < recipients.length; ++i) {
      accumulatedRewards[recipients[i]] += workerRewards[i];
    }
    router.staking().distribute(recipients, stakerRewards);

    bytes32 k = _key(blockRange[0], blockRange[1]);
    Commitment storage c = commitments[k];
    emit BatchDistributed(
      blockRange[0], blockRange[1], uint64(c.processedBatches - 1), recipients, workerRewards, stakerRewards
    );
  }

  function accumulativeRewardOf(uint256 wid) public view returns (uint256) {
    return accumulatedRewards[wid];
  }

  function withdrawableRewardOf(uint256 wid) public view returns (uint256) {
    return accumulatedRewards[wid] - withdrawnRewards[wid];
  }

  function claim(address who)
    external
    whenNotPaused
    onlyRole(REWARDS_TREASURY_ROLE)
    nonReentrant
    returns (uint256 claimed)
  {
    claimed = router.staking().claim(who);
    claimed += _claimWorkerRewards(who, router.workerRegistration().getOwnedWorkers(who), false);
  }

  function claimBounded(address who, uint256[] calldata workerIds)
    external
    whenNotPaused
    onlyRole(REWARDS_TREASURY_ROLE)
    nonReentrant
    returns (uint256 claimed)
  {
    claimed = router.staking().claim(who);
    claimed += _claimWorkerRewards(who, workerIds, true);
  }

  function claimable(address who) external view returns (uint256 total) {
    total = router.staking().claimable(who);
    total += _claimableWorkerRewards(who, router.workerRegistration().getOwnedWorkers(who), false);
  }

  function claimableBounded(address who, uint256[] calldata workerIds) external view returns (uint256 total) {
    total = router.staking().claimable(who);
    total += _claimableWorkerRewards(who, workerIds, true);
  }

  function _claimWorkerRewards(address who, uint256[] memory workerIds, bool validateOwnership)
    internal
    returns (uint256 claimed)
  {
    for (uint256 i; i < workerIds.length; ++i) {
      uint256 wid = workerIds[i];
      if (_isDuplicateWorkerId(workerIds, i)) continue;
      if (validateOwnership && !_ownsWorker(who, wid)) revert Errors.NotWorkerOwner();

      uint256 amt = withdrawableRewardOf(wid);
      if (amt > 0) {
        withdrawnRewards[wid] += amt;
        claimed += amt;
        emit RewardClaimed(who, wid, amt);
      }
    }
  }

  function _claimableWorkerRewards(address who, uint256[] memory workerIds, bool validateOwnership)
    internal
    view
    returns (uint256 total)
  {
    for (uint256 i; i < workerIds.length; ++i) {
      uint256 wid = workerIds[i];
      if (_isDuplicateWorkerId(workerIds, i)) continue;
      if (validateOwnership && !_ownsWorker(who, wid)) revert Errors.NotWorkerOwner();
      total += withdrawableRewardOf(wid);
    }
  }

  function _isDuplicateWorkerId(uint256[] memory workerIds, uint256 index) internal pure returns (bool) {
    for (uint256 i; i < index; ++i) {
      if (workerIds[i] == workerIds[index]) {
        return true;
      }
    }
    return false;
  }

  function _ownsWorker(address who, uint256 workerId) internal view returns (bool owns) {
    (bool success, bytes memory data) = address(router.workerRegistration()).staticcall(
      abi.encodeWithSignature("ownsWorker(address,uint256)", who, workerId)
    );
    if (success && data.length >= 32) {
      owns = abi.decode(data, (bool));
      return owns;
    }

    uint256[] memory owned = router.workerRegistration().getOwnedWorkers(who);
    for (uint256 i; i < owned.length; ++i) {
      if (owned[i] == workerId) {
        return true;
      }
    }
    return false;
  }

  function clearCommitment(uint256[2] calldata blockRange) external onlyRole(DEFAULT_ADMIN_ROLE) {
    bytes32 k = _key(blockRange[0], blockRange[1]);
    Commitment storage c = commitments[k];

    if (c.status == CommitmentStatus.NONEXISTENT) revert Errors.MerkleRootNotCommitted();

    CommitmentStatus previousStatus = c.status;
    uint256 previousLastRewardedBlock = lastBlockRewarded;
    uint256 rollbackLastRewardedBlock = previousLastRewardedBlock;
    if (previousStatus == CommitmentStatus.COMPLETED && previousLastRewardedBlock == c.toBlock) {
      rollbackLastRewardedBlock = c.fromBlock == 0 ? 0 : c.fromBlock - 1;
    }

    c.status = CommitmentStatus.NONEXISTENT;
    c.merkleRoot = bytes32(0);
    c.totalBatches = 0;
    c.processedBatches = 0;
    c.approvalCount = 0;
    c.ipfsLink = "";

    unchecked {
      commitmentVersion[k] += 1;
    }
    if (commitmentVersion[k] == 0) {
      commitmentVersion[k] = 1;
    }

    if (lastCommitmentKey == k) {
      lastCommitmentKey = bytes32(0);
    }

    if (rollbackLastRewardedBlock != previousLastRewardedBlock) {
      lastBlockRewarded = rollbackLastRewardedBlock;
      emit LastRewardedBlockUpdated(previousLastRewardedBlock, rollbackLastRewardedBlock);
    }

    emit CommitmentCleared(blockRange[0], blockRange[1], k, previousStatus);
  }

  function setLastRewardedBlock(uint256 blockNumber) external onlyRole(DEFAULT_ADMIN_ROLE) {
    uint256 previousBlock = lastBlockRewarded;
    lastBlockRewarded = blockNumber;
    emit LastRewardedBlockUpdated(previousBlock, blockNumber);
  }

  function getCommitment(uint256[2] calldata blockRange)
    external
    view
    returns (
      CommitmentStatus status,
      bytes32 merkleRoot,
      uint16 totalBatches,
      uint16 processedBatches,
      uint256 approvalCount,
      string memory ipfsLink
    )
  {
    bytes32 k = _key(blockRange[0], blockRange[1]);
    Commitment storage c = commitments[k];
    return (c.status, c.merkleRoot, c.totalBatches, c.processedBatches, c.approvalCount, c.ipfsLink);
  }

  function isCommitmentComplete(uint256[2] calldata blockRange) external view returns (bool isComplete) {
    bytes32 k = _key(blockRange[0], blockRange[1]);
    Commitment storage c = commitments[k];
    return c.status == CommitmentStatus.COMPLETED;
  }

  function canAcceptDistributions(uint256[2] calldata blockRange) external view returns (bool canDistribute) {
    bytes32 k = _key(blockRange[0], blockRange[1]);
    Commitment storage c = commitments[k];
    return c.status == CommitmentStatus.ACTIVE && c.approvalCount >= requiredApproves;
  }

  uint256[41] private __gap;
}
