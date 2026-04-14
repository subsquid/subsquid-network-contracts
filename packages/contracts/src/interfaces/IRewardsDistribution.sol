// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

interface IRewardsDistribution {
  event DistributorAdded(address distributor);
  event DistributorRemoved(address distributor);
  event ApprovesRequiredChanged(uint256 approvesRequired);
  event WindowSizeChanged(uint256 windowSize);
  event RoundRobinBlocksChanged(uint256 roundRobinBlocks);
  event NewCommitment(address indexed committer, uint256 fromBlock, uint256 toBlock, bytes32 merkleRoot);
  event Approved(address indexed approver, uint256 fromBlock, uint256 toBlock, bytes32 merkleRoot, string ipfsLink);
  event BatchDistributed(
    uint256 fromBlock,
    uint256 toBlock,
    uint64 batchId,
    uint256[] recipients,
    uint256[] workerRewards,
    uint256[] stakerRewards
  );
  event CommitmentCleared(
    uint256 indexed fromBlock,
    uint256 indexed toBlock,
    bytes32 indexed commitmentKey,
    uint8 previousStatus
  );
  event LastRewardedBlockUpdated(uint256 indexed previousBlock, uint256 indexed newBlock);
  event RewardClaimed(address indexed worker, uint256 workerId, uint256 amount);

  /// @dev claim rewards for worker
  function claim(address worker) external returns (uint256 reward);

  /// @dev get currently claimable rewards for worker
  function claimable(address worker) external view returns (uint256 reward);
}
