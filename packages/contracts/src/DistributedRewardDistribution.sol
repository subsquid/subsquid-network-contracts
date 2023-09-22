// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.18;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "forge-std/console2.sol";
import "./WorkerRegistration.sol";
import "./interfaces/IRewardsDistribution.sol";
import "./interfaces/IStaking.sol";

contract DistributedRewardsDistribution is AccessControl, IRewardsDistribution {
  using EnumerableSet for EnumerableSet.AddressSet;

  bytes32 public constant REWARDS_DISTRIBUTOR_ROLE = keccak256("REWARDS_DISTRIBUTOR_ROLE");
  bytes32 public constant REWARDS_TREASURY_ROLE = keccak256("REWARDS_TREASURY_ROLE");
  uint8 public constant APPROVES_REQUIRED = 3;

  mapping(uint256 workerId => uint256) _claimable;
  mapping(uint256 epoch => bytes32) public commitments;
  mapping(uint256 epoch => uint8) public approves;
  uint256 public lastEpochRewarded;
  IStaking public staking;
  WorkerRegistration public workers;
  EnumerableSet.AddressSet private distributors;

  event NewCommitment(
    address indexed who, uint256 epoch, uint256[] recipients, uint256[] workerRewards, uint256[] stakerRewards
  );
  event Claimed(address indexed by, uint256 amount);

  constructor(address admin, IStaking _staking, WorkerRegistration _workers) {
    _setupRole(DEFAULT_ADMIN_ROLE, admin);
    staking = _staking;
    workers = _workers;
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
    uint256[] memory recipients,
    uint256[] memory workerRewards,
    uint256[] memory _stakerRewards
  ) external {
    require(distributors.at(distributorIndex()) == msg.sender, "Not a distributor");
    commitments[epoch] = keccak256(msg.data[4:]);
    approves[epoch] = 1;

    emit NewCommitment(msg.sender, epoch, recipients, workerRewards, _stakerRewards);
  }

  function approve(
    uint256 epoch,
    uint256[] memory recipients,
    uint256[] memory workerRewards,
    uint256[] memory _stakerRewards
  ) external onlyRole(REWARDS_DISTRIBUTOR_ROLE) {
    require(commitments[epoch] != 0, "Commitment does not exist");
    require(commitments[epoch] == keccak256(msg.data[4:]), "Commitment mismatch");
    approves[epoch]++;
    if (approves[epoch] == APPROVES_REQUIRED) {
      distribute(epoch, recipients, workerRewards, _stakerRewards);
    }
  }

  function distribute(
    uint256 epoch,
    uint256[] memory recipients,
    uint256[] memory workerRewards,
    uint256[] memory _stakerRewards
  ) public {
    require(recipients.length == workerRewards.length, "Recipients and worker amounts length mismatch");
    require(recipients.length == _stakerRewards.length, "Recipients and staker amounts length mismatch");
    require(epoch == lastEpochRewarded + 1, "Invalid epoch");
    for (uint256 i = 0; i < recipients.length; i++) {
      _claimable[recipients[i]] += workerRewards[i];
    }
    staking.distribute(recipients, _stakerRewards);
    lastEpochRewarded++;
  }

  function claim(address who) external onlyRole(REWARDS_TREASURY_ROLE) returns (uint256) {
    uint256 reward = staking.claim(who);
    uint256[] memory ownedWorkers = workers.getOwnedWorkers(who);
    for (uint256 i = 0; i < ownedWorkers.length; i++) {
      uint256 workerId = ownedWorkers[i];
      reward += _claimable[workerId];
      _claimable[workerId] = 0;
    }

    emit Claimed(who, reward);
    return reward;
  }

  function claimable(address who) external view returns (uint256) {
    uint256 reward = staking.claimable(who);
    uint256[] memory ownedWorkers = workers.getOwnedWorkers(who);
    for (uint256 i = 0; i < ownedWorkers.length; i++) {
      uint256 workerId = ownedWorkers[i];
      reward += _claimable[workerId];
    }
    return reward;
  }
}
