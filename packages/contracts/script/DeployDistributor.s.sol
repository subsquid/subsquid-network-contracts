// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";

import "../src/NetworkController.sol";
import "../src/Staking.sol";
import "../src/WorkerRegistration.sol";
import "../src/RewardTreasury.sol";
import "../src/RewardCalculation.sol";
import "../src/DistributedRewardDistribution.sol";
import "../src/SQD.sol";
import "../src/Router.sol";
import "../src/GatewayRegistry.sol";
import "../src/VestingFactory.sol";
import "../src/SoftCap.sol";
import "../src/gateway-strategies/EqualStrategy.sol";
import "../src/AllocationsViewer.sol";
import "../src/gateway-strategies/SubequalStrategy.sol";

contract DeployDistributor is Script {
  function run() public {
    uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
    vm.startBroadcast(deployerPrivateKey);

    Staking staking = Staking(0xB31a0D39D2C69Ed4B28d96E12cbf52C5f9Ac9a51);
    RewardTreasury treasury = RewardTreasury(0x237Abf43bc51fd5c50d0D598A1A4c26E56a8A2A0);
    DistributedRewardsDistribution oldDistributor =
      DistributedRewardsDistribution(0xab690dA5815659Fe94f08F73E870D91a4d376d8f);
    DistributedRewardsDistribution distributor = new DistributedRewardsDistribution(oldDistributor.router());
    staking.grantRole(staking.REWARDS_DISTRIBUTOR_ROLE(), address(distributor));
    staking.revokeRole(staking.REWARDS_DISTRIBUTOR_ROLE(), address(oldDistributor));
    treasury.setWhitelistedDistributor(distributor, true);
    treasury.setWhitelistedDistributor(oldDistributor, false);
    distributor.grantRole(distributor.REWARDS_TREASURY_ROLE(), address(treasury));

    vm.stopBroadcast();
  }
}
