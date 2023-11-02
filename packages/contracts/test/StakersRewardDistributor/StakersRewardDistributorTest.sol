// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.18;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../../src/Staking.sol";
import "../../src/testnet/tSQD.sol";
import "forge-std/Test.sol";

contract StakingHelper is Staking {
  constructor(IERC20 token, INetworkController network) Staking(token, network) {}

  function distribute(uint256 worker, uint256 amount) external {
    lastEpochRewarded = network.epochNumber();
    _distribute(worker, amount);
  }
}

contract StakersRewardDistributionTest is Test {
  uint256[] workers = [1234];
  StakingHelper staking;
  IERC20 token;
  NetworkController network;

  function setUp() public {
    uint256[] memory shares = new uint256[](2);
    shares[0] = 50;
    shares[1] = 50;
    address[] memory holders = new address[](2);
    holders[0] = address(this);
    holders[1] = address(1);

    token = new tSQD(holders, shares);
    network = new NetworkController(1,10 ether);
    staking = new StakingHelper(token, network);
    token.approve(address(staking), type(uint256).max);
    hoax(address(1));
    token.approve(address(staking), type(uint256).max);
    staking.grantRole(staking.REWARDS_DISTRIBUTOR_ROLE(), address(this));
  }

  function assertPairClaimable(uint256 rewardA, uint256 rewardB) internal {
    assertEq(staking.claimable(address(this)), rewardA);
    assertEq(staking.claimable(address(1)), rewardB);
  }
}
