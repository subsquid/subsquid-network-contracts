// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.18;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "./interfaces/IRewardsDistribution.sol";

contract RewardTreasury is AccessControl {
  mapping(IRewardsDistribution => bool) public isWhitelistedDistributor;
  IERC20 public rewardToken;

  constructor(address admin, IERC20 _rewardToken) {
    rewardToken = _rewardToken;
    _setupRole(DEFAULT_ADMIN_ROLE, admin);
  }

  function claim(IRewardsDistribution rewardDistribution) external {
    require(isWhitelistedDistributor[rewardDistribution], "Distributor not whitelisted");
    uint256 reward = rewardDistribution.claim(msg.sender);
    rewardToken.transfer(msg.sender, reward);
  }

  function setWhitelistedDistributor(IRewardsDistribution distributor, bool isWhitelisted)
    external
    onlyRole(DEFAULT_ADMIN_ROLE)
  {
    isWhitelistedDistributor[distributor] = isWhitelisted;
  }
}
