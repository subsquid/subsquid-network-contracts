// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.18;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import "./WorkerRegistration.sol";
import "./interfaces/IRewardsDistribution.sol";

contract DistributedRewardsDistribution is AccessControl, IRewardsDistribution {
  using EnumerableSet for EnumerableSet.AddressSet;

  bytes32 public constant REWARDS_DISTRIBUTOR_ROLE = keccak256("REWARDS_DISTRIBUTOR_ROLE");
  bytes32 public constant REWARDS_TREASURY_ROLE = keccak256("REWARDS_TREASURY_ROLE");
  uint8 public constant APPROVES_REQUIRED = 3;

  mapping(address => uint256) public claimable;
  mapping(uint256 epoch => bytes32) public commitments;
  mapping(uint256 epoch => uint8) public approves;
  uint256 public lastEpochRewarded;
  EnumerableSet.AddressSet private distributors;

  event NewCommitment(
    address indexed who, uint256 epoch, address[] recipients, uint256[] workerRewards, uint256[] stakerRewards
  );
  event Claimed(address indexed who, uint256 amount);

  constructor(address admin) {
    _setupRole(DEFAULT_ADMIN_ROLE, admin);
  }

  function addDistributor(address distributor) external onlyRole(DEFAULT_ADMIN_ROLE) {
    distributors.add(distributor);
  }

  function removeDistributor(address distributor) external onlyRole(DEFAULT_ADMIN_ROLE) {
    distributors.remove(distributor);
  }

  function distributorIndex() public view returns (uint256) {
    uint256 slotStart = block.number / 256 * 256;
    return uint256(blockhash(slotStart)) % distributors.length();
  }

  function commit(
    uint256 epoch,
    address[] memory recipients,
    uint256[] memory workerRewards,
    uint256[] memory stakerRewards
  ) external {
    require(distributors.at(distributorIndex()) == msg.sender, "Not a distributor");
    commitments[epoch] = keccak256(msg.data[4:]);
    approves[epoch] = 1;

    emit NewCommitment(msg.sender, epoch, recipients, workerRewards, stakerRewards);
  }

  function approve(
    uint256 epoch,
    address[] memory recipients,
    uint256[] memory workerRewards,
    uint256[] memory stakerRewards
  ) external onlyRole(REWARDS_DISTRIBUTOR_ROLE) {
    require(commitments[epoch] != 0, "Commitment does not exist");
    require(commitments[epoch] == keccak256(msg.data[4:]), "Commitment mismatch");
    approves[epoch]++;
    if (approves[epoch] == APPROVES_REQUIRED) {
      distribute(epoch, recipients, workerRewards, stakerRewards);
    }
  }

  function distribute(
    uint256 epoch,
    address[] memory recipients,
    uint256[] memory workerRewards,
    uint256[] memory stakerRewards
  ) internal {
    require(recipients.length == workerRewards.length, "Recipients and amounts length mismatch");
    require(epoch == lastEpochRewarded + 1, "Rewards for epoch already distributed");
    uint256 totalDistributedAmount = 0;
    for (uint256 i = 0; i < recipients.length; i++) {
      claimable[recipients[i]] += workerRewards[i];
      totalDistributedAmount += workerRewards[i];
    }
    lastEpochRewarded++;
  }

  function claim(address worker) external onlyRole(REWARDS_TREASURY_ROLE) returns (uint256) {
    uint256 reward = claimable[worker];
    claimable[worker] = 0;

    emit Claimed(worker, reward);
    return reward;
  }
}
