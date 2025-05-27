// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {DistributedRewardsDistribution} from "../src/DistributedRewardsDistribution.sol";
import {IRouter} from "../src/interfaces/IRouter.sol";

/**
 * @title DeployDistributedRewards
 * @notice Deploys DistributedRewardsDistribution contract using existing Router
 * @dev This script is designed to work with the existing Arbitrum mainnet contracts
 */
contract DeployDistributedRewards is Script {
  address constant ROUTER_ADDRESS = 0x67F56D27dab93eEb07f6372274aCa277F49dA941;
  address constant REWARD_TREASURY_ADDRESS = 0x237Abf43bc51fd5c50d0D598A1A4c26E56a8A2A0;
  address constant STAKING_ADDRESS = 0xB31a0D39D2C69Ed4B28d96E12cbf52C5f9Ac9a51;

  function run() external {
    uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
    address deployer = vm.addr(deployerPrivateKey);

    uint256 distributor1PrivateKey = vm.envUint("DISTRIBUTOR1_KEY");
    address distributor1 = vm.addr(distributor1PrivateKey);
    uint256 distributor2PrivateKey = vm.envUint("DISTRIBUTOR2_KEY");
    address distributor2 = vm.addr(distributor2PrivateKey);

    console.log("Deployer address:", deployer);
    console.log("Distributor 1 address:", distributor1);
    console.log("Distributor 2 address:", distributor2);
    console.log("Router address:", ROUTER_ADDRESS);
    console.log("RewardTreasury address:", REWARD_TREASURY_ADDRESS);
    console.log("Staking address:", STAKING_ADDRESS);

    vm.startBroadcast(deployerPrivateKey);

    // Deploy DistributedRewardsDistribution with existing Router
    DistributedRewardsDistribution distributedRewards = new DistributedRewardsDistribution(IRouter(ROUTER_ADDRESS));

    console.log("DistributedRewardsDistribution deployed at:", address(distributedRewards));

    distributedRewards.grantRole(distributedRewards.REWARDS_DISTRIBUTOR_ROLE(), deployer);
    distributedRewards.addDistributor(deployer);
    distributedRewards.grantRole(distributedRewards.REWARDS_DISTRIBUTOR_ROLE(), distributor1);
    distributedRewards.addDistributor(distributor1);
    distributedRewards.grantRole(distributedRewards.REWARDS_DISTRIBUTOR_ROLE(), distributor2);
    distributedRewards.addDistributor(distributor2);
    distributedRewards.grantRole(distributedRewards.REWARDS_TREASURY_ROLE(), REWARD_TREASURY_ADDRESS);

    console.log("Roles granted:");
    console.log("- REWARDS_DISTRIBUTOR_ROLE to deployer:", deployer);
    console.log("- REWARDS_DISTRIBUTOR_ROLE to distributor1:", distributor1);
    console.log("- REWARDS_DISTRIBUTOR_ROLE to distributor2:", distributor2);
    console.log("- REWARDS_TREASURY_ROLE to RewardTreasury:", REWARD_TREASURY_ADDRESS);

    distributedRewards.setApprovesRequired(1);
    distributedRewards.setRoundRobinBlocks(20);
    distributedRewards.setWindowSize(3);

    console.log("Initial parameters set:");
    console.log("- Required approvals: 1");
    console.log("- Round robin blocks: 20");
    console.log("- Window size: 3");

    vm.stopBroadcast();

    console.log("");
    console.log("=== Deployment Summary ===");
    console.log("DistributedRewardsDistribution:", address(distributedRewards));
    console.log("Router:", ROUTER_ADDRESS);
    console.log("RewardTreasury:", REWARD_TREASURY_ADDRESS);
    console.log("Staking:", STAKING_ADDRESS);
    console.log("Deployer:", deployer);

    console.log("");
    console.log("=== Verification ===");
    console.log("Router address in contract:", address(distributedRewards.router()));
    console.log("Required approvals:", distributedRewards.requiredApproves());
    console.log("Round robin blocks:", distributedRewards.roundRobinBlocks());
    console.log("Window size:", distributedRewards.windowSize());

    // Check if deployer can commit
    bool canCommit = distributedRewards.canCommit(deployer);
    console.log("Deployer can commit:", canCommit);
  }
}
