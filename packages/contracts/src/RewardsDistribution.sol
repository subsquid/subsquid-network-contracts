// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.18;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./WorkerRegistration.sol";

contract RewardsDistribution is AccessControl {
  bytes32 public constant REWARDS_DISTRIBUTOR_ROLE = keccak256("REWARDS_DISTRIBUTOR_ROLE");

  mapping(address => uint256) public claimable;
  IERC20 public rewardToken;
  uint256 public nextEpochStartBlock;
  WorkerRegistration public workerRegistration;

  event NewReward(address indexed sender, uint256 totalReward);
  event Claimed(address indexed who, uint256 amount);

  constructor(address admin, IERC20 _rewardToken, WorkerRegistration _workerRegistration) {
    rewardToken = _rewardToken;
    workerRegistration = _workerRegistration;
    _setupRole(DEFAULT_ADMIN_ROLE, admin);
  }

  function distribute(address[] memory recipients, uint256[] memory amounts)
    external
    onlyRole(REWARDS_DISTRIBUTOR_ROLE)
  {
    require(recipients.length == amounts.length, "Recipients and amounts length mismatch");
    require(block.number >= nextEpochStartBlock, "Epoch not ended");
    uint256 totalDistributedAmount = 0;
    for (uint256 i = 0; i < recipients.length; i++) {
      claimable[recipients[i]] += amounts[i];
      totalDistributedAmount += amounts[i];
    }
    nextEpochStartBlock = workerRegistration.nextEpoch();

    emit NewReward(msg.sender, totalDistributedAmount);
  }

  function claim() external {
    uint256 reward = claimable[msg.sender];
    claimable[msg.sender] = 0;
    rewardToken.transfer(msg.sender, reward);

    emit Claimed(msg.sender, reward);
  }
}
