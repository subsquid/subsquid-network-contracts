// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.18;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "../src/NetworkController.sol";
import "../src/Staking.sol";
import "../src/WorkerRegistration.sol";
import "../src/RewardTreasury.sol";
import "../src/RewardCalculation.sol";
import "../src/DistributedRewardDistribution.sol";

contract Deploy is Script {
  function run() public {
    uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
    vm.startBroadcast(deployerPrivateKey);

    // Don't redeploy token yet
    IERC20 token = IERC20(address(0x6a117CBe9Bfab42151396FC54ddb588151a8Aac7));
    NetworkController network = new NetworkController(100, 100000 ether);
    Staking staking = new Staking(token, network);
    WorkerRegistration workerRegistration = new WorkerRegistration(token, network, staking);
    RewardTreasury treasury = new RewardTreasury(token);
    DistributedRewardsDistribution distributor = new DistributedRewardsDistribution(staking, workerRegistration);
    new RewardCalculation(workerRegistration, network);

    staking.grantRole(staking.REWARDS_DISTRIBUTOR_ROLE(), address(distributor));
    treasury.setWhitelistedDistributor(distributor, true);
    distributor.grantRole(distributor.REWARDS_TREASURY_ROLE(), address(treasury));
    distributor.grantRole(distributor.REWARDS_DISTRIBUTOR_ROLE(), address(distributor));

    vm.stopBroadcast();

  }
}
