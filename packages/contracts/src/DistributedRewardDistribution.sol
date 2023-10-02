// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.18;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "./interfaces/IWorkerRegistration.sol";
import "./interfaces/IRewardsDistribution.sol";
import "./interfaces/IStaking.sol";

contract DistributedRewardsDistribution is AccessControl, IRewardsDistribution {
  using EnumerableSet for EnumerableSet.AddressSet;

  bytes32 public constant REWARDS_DISTRIBUTOR_ROLE = keccak256("REWARDS_DISTRIBUTOR_ROLE");
  bytes32 public constant REWARDS_TREASURY_ROLE = keccak256("REWARDS_TREASURY_ROLE");
  uint8 internal constant APPROVES_REQUIRED = 3;

  mapping(uint256 workerId => uint256) _claimable;
  mapping(uint256 block => bytes32) public commitments;
  mapping(uint256 block => uint8) public approves;
  mapping(bytes32 => mapping(address => bool)) public alreadyApproved;
  uint256 public lastBlockRewarded;
  IStaking public immutable staking;
  IWorkerRegistration public immutable workers;
  EnumerableSet.AddressSet private distributors;

  event NewCommitment(
    address indexed who,
    uint256 fromBlock,
    uint256 toBlock,
    uint256[] recipients,
    uint256[] workerRewards,
    uint256[] stakerRewards
  );
  event Approved(
    address indexed who,
    uint256 fromBlock,
    uint256 toBlock,
    uint256[] recipients,
    uint256[] workerRewards,
    uint256[] stakerRewards
  );
  event Distributed(uint256 fromBlock, uint256 toBlock);
  event Claimed(address indexed by, uint256 amount);

  event DistributorAdded(address indexed distributor);
  event DistributorRemoved(address indexed distributor);

  constructor(IStaking _staking, IWorkerRegistration _workers) {
    _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
    staking = _staking;
    workers = _workers;
  }

  function addDistributor(address distributor) external onlyRole(DEFAULT_ADMIN_ROLE) {
    distributors.add(distributor);
    _grantRole(REWARDS_DISTRIBUTOR_ROLE, distributor);

    emit DistributorAdded(distributor);
  }

  function removeDistributor(address distributor) external onlyRole(DEFAULT_ADMIN_ROLE) {
    distributors.remove(distributor);
    _revokeRole(REWARDS_DISTRIBUTOR_ROLE, distributor);

    emit DistributorRemoved(distributor);
  }

  function distributorIndex() public view returns (uint256) {
    uint256 slotStart = block.number / 256 * 256;
    return uint256(blockhash(slotStart)) % distributors.length();
  }

  function currentDistributor() public view returns (address) {
    return distributors.at(distributorIndex());
  }

  function commit(
    uint256 fromBlock,
    uint256 toBlock,
    uint256[] calldata recipients,
    uint256[] calldata workerRewards,
    uint256[] calldata _stakerRewards
  ) external {
    require(recipients.length == workerRewards.length, "Recipients and worker amounts length mismatch");
    require(recipients.length == _stakerRewards.length, "Recipients and staker amounts length mismatch");

    require(currentDistributor() == msg.sender, "Not a distributor");
    require(toBlock < block.number, "Future block");
    bytes32 commitment = keccak256(msg.data[4:]);
    require(!alreadyApproved[commitment][msg.sender], "Already approved");
    commitments[toBlock] = commitment;
    approves[toBlock] = 1;
    alreadyApproved[commitment][msg.sender] = true;

    emit NewCommitment(msg.sender, fromBlock, toBlock, recipients, workerRewards, _stakerRewards);
  }

  function approve(
    uint256 fromBlock,
    uint256 toBlock,
    uint256[] calldata recipients,
    uint256[] calldata workerRewards,
    uint256[] calldata _stakerRewards
  ) external onlyRole(REWARDS_DISTRIBUTOR_ROLE) {
    require(commitments[toBlock] != 0, "Commitment does not exist");
    bytes32 commitment = keccak256(msg.data[4:]);
    require(commitments[toBlock] == commitment, "Commitment mismatch");
    require(!alreadyApproved[commitment][msg.sender], "Already approved");
    approves[toBlock]++;
    alreadyApproved[commitment][msg.sender] = true;

    if (approves[toBlock] == APPROVES_REQUIRED) {
      distribute(fromBlock, toBlock, recipients, workerRewards, _stakerRewards);
    }

    emit Approved(msg.sender, fromBlock, toBlock, recipients, workerRewards, _stakerRewards);
  }

  function canApprove(
    uint256 fromBlock,
    uint256 toBlock,
    uint256[] calldata recipients,
    uint256[] calldata workerRewards,
    uint256[] calldata _stakerRewards
  ) external view returns (bool) {
    if (commitments[toBlock] == 0) {
      return false;
    }
    bytes32 commitment = keccak256(msg.data[4:]);
    if (commitments[toBlock] != commitment) {
      return false;
    }
    if (alreadyApproved[commitment][msg.sender]) {
      return false;
    }
    return true;
  }

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
    staking.distribute(recipients, _stakerRewards);
    lastBlockRewarded = toBlock;

    emit Distributed(fromBlock, toBlock);
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
