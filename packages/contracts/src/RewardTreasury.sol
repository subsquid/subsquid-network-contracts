// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.18;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "./interfaces/IRewardsDistribution.sol";

contract RewardTreasury is AccessControl {
  mapping(IRewardsDistribution => bool) public isWhitelistedDistributor;
  IERC20 public rewardToken;

  event Claimed(address indexed by, uint256 amount);
  event WhitelistedDistributorSet(IRewardsDistribution indexed distributor, bool isWhitelisted);

  constructor(address admin, IERC20 _rewardToken) {
    rewardToken = _rewardToken;
    _setupRole(DEFAULT_ADMIN_ROLE, admin);
  }

  function claim(IRewardsDistribution rewardDistribution) external {
    require(isWhitelistedDistributor[rewardDistribution], "Distributor not whitelisted");
    uint256 reward = rewardDistribution.claim(msg.sender);
    rewardToken.transfer(msg.sender, reward);

    emit Claimed(msg.sender, reward);
  }

  function claimable(IRewardsDistribution rewardDistribution, address worker) external view returns (uint256) {
    return rewardDistribution.claimable(worker);
  }

  function setWhitelistedDistributor(IRewardsDistribution distributor, bool isWhitelisted)
    external
    onlyRole(DEFAULT_ADMIN_ROLE)
  {
    isWhitelistedDistributor[distributor] = isWhitelisted;

    emit WhitelistedDistributorSet(distributor, isWhitelisted);
  }
}
