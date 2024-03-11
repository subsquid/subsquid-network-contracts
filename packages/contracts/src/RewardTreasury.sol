// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "./interfaces/IRewardsDistribution.sol";
import "./AccessControlledPausable.sol";

/**
 * @title Reward Treasury Contract
 * @dev Contract that stores rewards for workers and stakers and has a list of whitelisted distributors that it can claim from
 */
contract RewardTreasury is AccessControlledPausable {
  mapping(IRewardsDistribution => bool) public isWhitelistedDistributor;
  IERC20 public immutable rewardToken;

  /// @dev Emitted when rewards are claimed
  event Claimed(address indexed by, address indexed receiver, uint256 amount);
  /// @dev Emitted when distributor is whitelisted or removed from whitelist
  event WhitelistedDistributorSet(IRewardsDistribution indexed distributor, bool isWhitelisted);

  /**
   * @dev Constructor
   * @param _rewardToken address of the SQD token
   */
  constructor(IERC20 _rewardToken) {
    rewardToken = _rewardToken;
  }

  /**
   * @dev Claim rewards from distributor and send rewards to the caller
   * @param rewardDistribution address of the rewards distribution contract
   * rewardDistribution must be whitelisted by admin
   */
  function claim(IRewardsDistribution rewardDistribution) external {
    _claim(rewardDistribution, msg.sender);
  }

  /**
   * @dev Claim rewards from distributor and send to receiver
   * @param rewardDistribution address of the rewards distribution contract
   * @param receiver address that receives funds
   */
  function claimFor(IRewardsDistribution rewardDistribution, address receiver) external {
    _claim(rewardDistribution, receiver);
  }

  /// @return how much can be claimed by sender from rewardDistribution
  function claimable(IRewardsDistribution rewardDistribution, address sender) external view returns (uint256) {
    return rewardDistribution.claimable(sender);
  }

  /**
   * @dev Set distributor as whitelisted or not
   * @param distributor address of the rewards distribution contract
   * @param isWhitelisted whether the distributor is whitelisted or not
   * can only be called by admin
   */
  function setWhitelistedDistributor(IRewardsDistribution distributor, bool isWhitelisted)
    external
    onlyRole(DEFAULT_ADMIN_ROLE)
  {
    isWhitelistedDistributor[distributor] = isWhitelisted;

    emit WhitelistedDistributorSet(distributor, isWhitelisted);
  }

  function _claim(IRewardsDistribution rewardDistribution, address receiver) internal whenNotPaused {
    require(isWhitelistedDistributor[rewardDistribution], "Distributor not whitelisted");
    uint256 reward = rewardDistribution.claim(msg.sender);
    rewardToken.transfer(receiver, reward);

    emit Claimed(msg.sender, receiver, reward);
  }

  /// @dev Reclaim all funds from the contract in case of emergency
  function reclaimFunds() external onlyRole(DEFAULT_ADMIN_ROLE) {
    rewardToken.transfer(msg.sender, rewardToken.balanceOf(address(this)));
  }
}
