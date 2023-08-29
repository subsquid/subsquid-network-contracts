// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.18;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./WorkerRegistration.sol";
import "./interfaces/IRewardsDistribution.sol";

contract RewardsDistribution is AccessControl, IRewardsDistribution {
  bytes32 public constant REWARDS_DISTRIBUTOR_ROLE = keccak256("REWARDS_DISTRIBUTOR_ROLE");
  bytes32 public constant REWARDS_TREASURY_ROLE = keccak256("REWARDS_TREASURY_ROLE");

  mapping(address => uint256) public claimable;
  uint256 public nextEpochStartBlock;
  WorkerRegistration public workerRegistration;

  event NewReward(address indexed sender, uint256 totalReward);
  event Claimed(address indexed who, uint256 amount);

  constructor(address admin, WorkerRegistration _workerRegistration) {
    workerRegistration = _workerRegistration;
    _setupRole(DEFAULT_ADMIN_ROLE, admin);
  }

  function distribute(uint256 epochEndBlock, address[] memory recipients, uint256[] memory amounts)
    public
    onlyRole(REWARDS_DISTRIBUTOR_ROLE)
  {
    require(recipients.length == amounts.length, "Recipients and amounts length mismatch");
    require(block.number >= nextEpochStartBlock, "Epoch not ended");
    require(epochEndBlock > nextEpochStartBlock, "Rewards for epoch already distributed");
    uint256 totalDistributedAmount = 0;
    for (uint256 i = 0; i < recipients.length; i++) {
      claimable[recipients[i]] += amounts[i];
      totalDistributedAmount += amounts[i];
    }
    nextEpochStartBlock = epochEndBlock + 1;

    emit NewReward(msg.sender, totalDistributedAmount);
  }

  function distribute(address[] memory recipients, uint256[] memory amounts) public {
    distribute(workerRegistration.nextEpoch() - 1, recipients, amounts);
  }

  function claim(address worker) external onlyRole(REWARDS_TREASURY_ROLE) returns (uint256) {
    uint256 reward = claimable[worker];
    claimable[worker] = 0;

    emit Claimed(worker, reward);
    return reward;
  }
}
