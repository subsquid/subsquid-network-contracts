// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.20;

import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {AccessControlledPausable} from "./AccessControlledPausable.sol";

import {MerkleMountainRange} from "./mmr/MerkleMountainRange.sol";
import {StorageValue, Node, MmrLeaf, Iterator} from "./mmr/Types.sol";
import {IRewardsDistribution} from "./interfaces/IRewardsDistribution.sol";
import {IRouter} from "./interfaces/IRouter.sol";
import {Errors} from "./libs/Errors.sol";

/**
 * @title DistributedRewardsDistribution V2
 * @notice A rewards distribution system that uses Merkle Mountain Range for reward verification
 * @dev This contract manages reward distribution based on a single, final MMR root per block range.
 */
contract DistributedRewardsDistribution is IRewardsDistribution, AccessControlledPausable {
  using EnumerableSet for EnumerableSet.AddressSet;

  bytes32 public constant REWARDS_DISTRIBUTOR_ROLE = keccak256("REWARDS_DISTRIBUTOR_ROLE");
  bytes32 public constant REWARDS_TREASURY_ROLE = keccak256("REWARDS_TREASURY_ROLE");

  IRouter public immutable router;
  EnumerableSet.AddressSet private distributors;

  uint256 public requiredApproves;
  uint256 public lastBlockRewarded;
  uint128 public roundRobinBlocks;
  uint128 public windowSize;

  mapping(uint256 => uint256) public accumulatedRewards;
  mapping(uint256 => uint256) public withdrawnRewards;

  struct MMRData {
    uint64 totalLeaves; // total number of leaves in the final MMR
    bytes32 finalRoot; // the single, final, approved MMR root
    uint256 approvalCount; // approvals for the finalRoot
    mapping(address => bool) approvedBy; // who approved the finalRoot
  }

  mapping(bytes32 => MMRData) private mmrStore;

  mapping(bytes32 => mapping(uint64 => bool)) public processed;

  constructor(IRouter _router) {
    if (address(_router) == address(0)) revert Errors.ZeroAddress();

    requiredApproves = 1;
    router = _router;
    roundRobinBlocks = 256;
    windowSize = 1;
  }

  /**
   * @dev Add whitelisted distributor
   * @param distributor Address of the new distributor
   */
  function addDistributor(address distributor) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (!distributors.add(distributor)) revert Errors.DistributorAlreadyAdded();
    _grantRole(REWARDS_DISTRIBUTOR_ROLE, distributor);

    emit DistributorAdded(distributor);
  }

  /**
   * @dev Remove whitelisted distributor
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
   * @param _approvesRequired New number of required approvals
   */
  function setApprovesRequired(uint256 _approvesRequired) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (_approvesRequired == 0) revert Errors.ApprovesRequiredMustBeGreaterThanZero();
    if (_approvesRequired > distributors.length()) {
      revert Errors.ApprovesRequiredMustBeLessThanOrEqualToDistributorsCount();
    }
    requiredApproves = _approvesRequired;
    emit ApprovesRequiredChanged(_approvesRequired);
  }

  /**
   * @notice Sets the window size for eligible distributors
   * @param _windowSize New window size
   */
  function setWindowSize(uint256 _windowSize) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (_windowSize == 0) revert Errors.WindowSizeMustBeGreaterThanZero();
    if (_windowSize > distributors.length()) revert Errors.WindowSizeMustBeLessThanOrEqualToDistributorsCount();
    windowSize = uint128(_windowSize);
    emit WindowSizeChanged(_windowSize);
  }

  /**
   * @notice Sets the number of blocks between distributor rotations
   * @param _roundRobinBlocks New number of blocks
   */
  function setRoundRobinBlocks(uint256 _roundRobinBlocks) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (_roundRobinBlocks == 0) revert Errors.RoundRobinBlocksMustBeGreaterThanZero();
    roundRobinBlocks = uint128(_roundRobinBlocks);
    emit RoundRobinBlocksChanged(_roundRobinBlocks);
  }

  /**
   * @notice Checks if an address is currently eligible to commit a distribution
   * @param who Address to check
   * @return canPerformCommit True if the address can commit, false otherwise
   * @dev Round-robin distributor selection mechanism:
   *      1. Calculates the current eligible distributor window based on block number
   *      2. The window size determines how many consecutive distributors are eligible
   *      3. Rotates through the distributor list every roundRobinBlocks blocks
   *      This prevents any single distributor from having permanent control while
   *      ensuring a consistent, predictable schedule for reward distributions
   */
  function canCommit(address who) public view returns (bool canPerformCommit) {
    uint256 distCount = distributors.length();
    if (distCount == 0) revert Errors.NoDistributorsAdded();

    uint256 firstIndex = distributorIndex();
    for (uint256 i = 0; i < uint256(windowSize); i++) {
      if (distributors.at((firstIndex + i) % distCount) == who) {
        return true;
      }
    }
    return false;
  }

  /**
   * @notice Commit the single, final merkle root for a distribution block range
   * @param blockRange Array with [fromBlock, toBlock]
   * @param _finalRoot The final MMR root calculated off-chain
   * @param _totalLeaves The total number of leaves (batches) included in the MMR
   * @param ipfsLink IPFS link to the full data
   * @dev This function initiates the approval process for a new reward distribution:
   *      1. Ensures the caller is eligible to commit based on current round-robin status
   *      2. Validates the root and totalLeaves inputs to prevent empty distributions
   *      3. Creates a new MMR entry for the block range and records the first approval
   *      4. If requiredApproves is 1, the distribution is immediately considered fully approved
   *      5. Otherwise, additional approvals must be gathered via approveFinalRoot
   *      Multiple distributors provide fault tolerance and prevent malicious distributions
   */
  function commitFinalRoot(
    uint256[2] calldata blockRange,
    bytes32 _finalRoot,
    uint64 _totalLeaves,
    string memory ipfsLink
  ) external whenNotPaused onlyRole(REWARDS_DISTRIBUTOR_ROLE) {
    require(canCommit(msg.sender), "COMMIT_ERR:NOT_COMMITTER");
    if (!canCommit(msg.sender)) revert Errors.NotACommitter();

    require(_finalRoot != bytes32(0), "COMMIT_ERR:ROOT_ZERO");
    if (_finalRoot == bytes32(0)) revert Errors.MerkleRootCannotBeZero();

    require(_totalLeaves > 0, "COMMIT_ERR:LEAVES_ZERO");
    if (_totalLeaves == 0) revert Errors.TotalLeavesCannotBeZero();

    bytes32 key = _blockRangeKey(blockRange[0], blockRange[1]);
    MMRData storage mmrData = mmrStore[key];

    require(mmrData.finalRoot == bytes32(0), "COMMIT_ERR:ALREADY_COMMITTED");
    if (mmrData.finalRoot != bytes32(0)) revert Errors.MerkleRootAlreadyCommitted();

    mmrData.finalRoot = _finalRoot;
    mmrData.totalLeaves = _totalLeaves;

    mmrData.approvalCount = 1;
    mmrData.approvedBy[msg.sender] = true;

    emit FinalRootCommitted(key, _finalRoot, _totalLeaves, msg.sender);
    emit NewCommitment(msg.sender, blockRange[0], blockRange[1], _finalRoot);

    if (requiredApproves == 1) {
      emit Approved(msg.sender, blockRange[0], blockRange[1], _finalRoot, ipfsLink);
    }
  }

  /**
   * @notice Approve the final merkle root for a distribution block range
   * @param blockRange Array with [fromBlock, toBlock]
   * @param _finalRoot The final MMR root to approve
   */
  function approveFinalRoot(uint256[2] calldata blockRange, bytes32 _finalRoot)
    external
    whenNotPaused
    onlyRole(REWARDS_DISTRIBUTOR_ROLE)
  {
    bytes32 key = _blockRangeKey(blockRange[0], blockRange[1]);
    MMRData storage mmrData = mmrStore[key];

    if (mmrData.finalRoot == bytes32(0)) revert Errors.MerkleRootNotCommitted();
    if (mmrData.finalRoot != _finalRoot) revert Errors.MerkleRootMismatch();

    if (mmrData.approvedBy[msg.sender]) revert Errors.AlreadyApproved();

    if (mmrData.approvalCount >= requiredApproves) revert Errors.AlreadyFullyApproved();

    mmrData.approvalCount += 1;
    mmrData.approvedBy[msg.sender] = true;

    emit FinalRootApproved(key, _finalRoot, msg.sender);

    if (mmrData.approvalCount >= requiredApproves) {
      emit Approved(msg.sender, blockRange[0], blockRange[1], _finalRoot, "");
    }
  }

  /**
   * @notice Distribute rewards for a single batch, verifying against the final MMR root
   * @param blockRange Array with [fromBlock, toBlock]
   * @param kIndex Node position index of the leaf in the MMR structure
   * @param leafIndex Sequential index (0-based) of the leaf/batch in the MMR
   * @param recipients Array of worker IDs receiving rewards
   * @param workerRewards Array of worker reward amounts
   * @param stakerRewards Array of staker reward amounts
   * @param merkleProof Proof that this batch is part of the final MMR
   * @dev Several critical steps:
   *      1. Validates array lengths match and ensures MMR root is committed/approved
   *      2. Checks that this batch hasn't been processed before
   *      3. Calculates and verifies the batch leaf hash against the MMR proof
   *      4. Updates accumulated rewards for recipients and distributes to stakers
   *      5. Updates lastBlockRewarded if applicable
   */
  function distributeBatch(
    uint256[2] calldata blockRange,
    uint64 kIndex,
    uint64 leafIndex,
    uint256[] calldata recipients,
    uint256[] calldata workerRewards,
    uint256[] calldata stakerRewards,
    bytes32[] calldata merkleProof
  ) external whenNotPaused {
    if (recipients.length != workerRewards.length || recipients.length != stakerRewards.length) {
      revert Errors.ArrayLengthMismatch();
    }

    bytes32 key = _blockRangeKey(blockRange[0], blockRange[1]);
    MMRData storage mmrData = mmrStore[key];

    if (mmrData.finalRoot == bytes32(0)) revert Errors.MerkleRootNotCommitted();
    if (mmrData.approvalCount < requiredApproves) revert Errors.NotEnoughApprovals();

    if (leafIndex >= mmrData.totalLeaves) {
      revert Errors.InvalidBatchId();
    }

    if (processed[key][leafIndex]) {
      revert Errors.BatchAlreadyProcessed();
    }

    bytes32 batchLeafHash = calculateBatchRoot(recipients, workerRewards, stakerRewards);

    if (!_verifyProof(mmrData.finalRoot, merkleProof, kIndex, leafIndex, batchLeafHash, mmrData.totalLeaves)) {
      revert Errors.InvalidMerkleProof();
    }

    processed[key][leafIndex] = true;

    for (uint256 i = 0; i < recipients.length; i++) {
      uint256 workerId = recipients[i];
      accumulatedRewards[workerId] += workerRewards[i];
    }

    router.staking().distribute(recipients, stakerRewards);

    if (blockRange[1] > lastBlockRewarded) {
      lastBlockRewarded = blockRange[1];
    }

    emit BatchDistributed(blockRange[0], blockRange[1], leafIndex, recipients, workerRewards, stakerRewards);
  }

  /**
   * @dev Helper function to verify MMR proof with fewer stack variables
   * @param root the final MMR root to verify against
   * @param merkleProof array of hashes comprising the Merkle proof
   * @param kIndex position index of the leaf node in the MMR structure
   * @param leafIndex sequential index of the leaf in the MMR (0-based)
   * @param leafHash hash of the leaf data being verified
   * @param totalLeaves total number of leaves in the MMR
   * @return true if the proof successfully verifies the leaf against the root
   * @dev ceates a single-element MmrLeaf array and delegates to the MerkleMountainRange library
   *      for actual proof verification. The MMR structure allows efficient verification that
   *      a specific leaf (batch of rewards) is part of the committed distribution
   */
  function _verifyProof(
    bytes32 root,
    bytes32[] calldata merkleProof,
    uint64 kIndex,
    uint64 leafIndex,
    bytes32 leafHash,
    uint64 totalLeaves
  ) internal pure returns (bool) {
    MmrLeaf[] memory leaves = new MmrLeaf[](1);
    leaves[0] = MmrLeaf(kIndex, leafIndex, leafHash);
    return MerkleMountainRange.VerifyProof(root, merkleProof, leaves, totalLeaves);
  }

  /**
   * @notice Claim rewards for a worker
   * @param worker Address of the worker
   * @return reward Amount of rewards claimed
   */
  function claim(address worker) external whenNotPaused onlyRole(REWARDS_TREASURY_ROLE) returns (uint256 reward) {
    uint256 claimedAmount = router.staking().claim(worker);

    uint256[] memory ownedWorkers = router.workerRegistration().getOwnedWorkers(worker);
    for (uint256 i = 0; i < ownedWorkers.length; i++) {
      uint256 workerId = ownedWorkers[i];
      uint256 workerReward = withdrawableRewardOf(workerId);
      if (workerReward > 0) {
        withdrawnRewards[workerId] += workerReward;
        claimedAmount += workerReward;
        emit RewardClaimed(worker, workerId, workerReward);
      }
    }

    return claimedAmount;
  }

  /**
   * @notice Get currently claimable rewards for worker
   * @param worker Address of the worker
   * @return reward Amount of claimable rewards
   */
  function claimable(address worker) external view returns (uint256 reward) {
    uint256 workerId = getWorkerId(worker);
    if (workerId == 0) return 0;

    return withdrawableRewardOf(workerId);
  }

  /**
   * @notice Get withdrawable rewards for a worker
   * @param workerId Worker ID to check
   * @return Withdrawable reward amount
   */
  function withdrawableRewardOf(uint256 workerId) public view returns (uint256) {
    return accumulatedRewards[workerId] - withdrawnRewards[workerId];
  }

  // --- Internal Functions ---

  /**
   * @dev Get an index of the first distribuor which can currently commit a distribution
   * @return Index of the current distributor in the round-robin rotation
   */
  function distributorIndex() internal view returns (uint256) {
    uint256 distCount = distributors.length();
    if (distCount == 0) return 0;
    return (block.number / uint256(roundRobinBlocks)) % distCount;
  }

  /**
   * @dev Generates a unique key for a block range
   * @param fromBlock Starting block
   * @param toBlock Ending block
   * @return Hash representing the block range
   * @dev Creates a deterministic, unique identifier for each block range by:
   *      1. Packing the fromBlock and toBlock into a single bytes value
   *      2. Applying keccak256 hash function to get a unique 32-byte key
   *      This key is used as the primary identifier for MMR data storage and retrieval
   */
  function _blockRangeKey(uint256 fromBlock, uint256 toBlock) internal pure returns (bytes32) {
    return keccak256(abi.encodePacked(fromBlock, toBlock));
  }

  /**
   * @dev Calculate the root hash for a batch leaf
   * @param recipients Worker IDs
   * @param workerRewards Worker reward amounts
   * @param stakerRewards Staker reward amounts
   * @return Root hash for the batch leaf
   * @dev Creates a deterministic hash of the entire batch data (recipients and their rewards)
   *      This hash serves as the leaf value in the MMR structure, allowing verification
   *      that this specific distribution data was included in the committed MMR root
   */
  function calculateBatchRoot(
    uint256[] calldata recipients,
    uint256[] calldata workerRewards,
    uint256[] calldata stakerRewards
  ) internal pure returns (bytes32) {
    return keccak256(abi.encode(recipients, workerRewards, stakerRewards));
  }

  /**
   * @notice Helper function to get worker ID from address
   * @param worker Address of the worker
   * @return workerId Worker ID
   */
  function getWorkerId(address worker) internal view returns (uint256 workerId) {
    try router.workerRegistration().getOwnedWorkers(worker) returns (uint256[] memory ownedWorkers) {
      if (ownedWorkers.length > 0) {
        workerId = ownedWorkers[0];
      }
    } catch {
      workerId = 0;
    }
    return workerId;
  }

  /**
   * @dev Calculates the peak positions in a Merkle Mountain Range
   * @param leaves Number of leaves in the MMR
   * @return Array of peak positions in post-order traversal
   * @dev MMR structure consists of multiple perfect binary trees (mountains) where:
   *      1. Each bit in the binary representation of 'leaves' corresponds to a mountain
   *      2. The algorithm finds the rightmost node of each mountain (peak)
   *      3. Returns peaks in left-to-right order for MMR verification
   *      This implementation uses bit manipulation to efficiently find peaks without
   *      building the entire tree structure
   */
  function _getPeaks(uint256 leaves) internal pure returns (uint256[] memory) {
    uint256[] memory buf = new uint256[](64); // scratch
    uint256 count;
    uint256 pos = leaves * 2 - 2; // post-order index of right-most node

    while (leaves != 0) {
      uint256 bit = leaves & (~leaves + 1); // lowest set bit
      buf[count++] = pos; // remember the peak
      pos -= (bit << 1) - 1; // jump over subtree
      leaves -= bit; // clear that bit
    }

    uint256[] memory peaks = new uint256[](count);
    for (uint256 i = 0; i < count; ++i) {
      peaks[i] = buf[count - 1 - i]; // left-to-right order
    }
    return peaks;
  }
}
