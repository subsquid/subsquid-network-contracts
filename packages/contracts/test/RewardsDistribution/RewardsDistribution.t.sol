// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.18;

import "forge-std/Test.sol";
import "../../src/DistributedRewardDistribution.sol";
import "../../src/testnet/tSQD.sol";
import "../../src/RewardTreasury.sol";
import "../../src/NetworkController.sol";
import "../../src/Staking.sol";
import "../../src/WorkerRegistration.sol";

contract DistributionHelper is DistributedRewardsDistribution {
  constructor(IStaking _staking, IWorkerRegistration _workers) DistributedRewardsDistribution(_staking, _workers) {}

  function distributeHelper(
    uint256 fromBlock,
    uint256[] calldata recipients,
    uint256[] calldata workerRewards,
    uint256[] calldata _stakerRewards
  ) public {
    distribute(fromBlock, fromBlock + 1, recipients, workerRewards, _stakerRewards);
  }
}

contract RewardsDistributionTest is Test {
  bytes workerId = "1337";
  uint256 epochRewardAmount = 1000;
  address workerOwner = address(1);
  DistributionHelper rewardsDistribution;
  RewardTreasury treasury;
  Staking staking;
  WorkerRegistration workerRegistration;
  IERC20 token;

  event Distributed(uint256 fromBlock, uint256 toBlock);
  event Claimed(address indexed who, uint256 amount);

  function setUp() public {
    uint256[] memory shares = new uint256[](2);
    shares[0] = 50;
    shares[1] = 50;
    address[] memory holders = new address[](2);
    holders[0] = address(this);
    holders[1] = workerOwner;

    token = new tSQD(holders, shares);
    NetworkController networkController = new NetworkController(1, 10 ether);
    staking = new Staking(token, networkController);
    workerRegistration = new WorkerRegistration(token, networkController, staking);
    token.approve(address(staking), type(uint256).max);
    hoax(workerOwner);
    token.approve(address(workerRegistration), type(uint256).max);
    hoax(workerOwner);
    workerRegistration.register(workerId);
    rewardsDistribution = new DistributionHelper(staking, workerRegistration);
    staking.grantRole(staking.REWARDS_DISTRIBUTOR_ROLE(), address(rewardsDistribution));
    treasury = new RewardTreasury(token);
    rewardsDistribution.addDistributor(address(this));
    rewardsDistribution.grantRole(rewardsDistribution.REWARDS_TREASURY_ROLE(), address(treasury));
    treasury.setWhitelistedDistributor(rewardsDistribution, true);
    token.transfer(address(treasury), epochRewardAmount * 10);
  }

  function prepareRewards(uint256 n)
    internal
    returns (uint256[] memory recipients, uint256[] memory workerAmounts, uint256[] memory stakerAmounts)
  {
    workerAmounts = new uint256[](n);
    stakerAmounts = new uint256[](n);
    recipients = new uint[](n);
    for (uint160 i = 0; i < n; i++) {
      staking.deposit(i + 1, 1);
      workerAmounts[i] = epochRewardAmount / n;
      stakerAmounts[i] = 1;
      recipients[i] = i + 1;
    }
  }
}
