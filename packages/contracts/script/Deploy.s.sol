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
import "../src/tSQD.sol";
import "../src/Router.sol";
import "../src/GatewayRegistry.sol";
import "../src/VestingFactory.sol";

contract Deploy is Script {
  function run() public {
    uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
    vm.startBroadcast(deployerPrivateKey);

    tSQD token = tSQD(vm.envAddress("TOKEN"));
    address proxyAdmin = address(new ProxyAdmin(vm.addr(deployerPrivateKey)));
    Router router = Router(address(new TransparentUpgradeableProxy(address(new Router()), proxyAdmin, "")));

    NetworkController network = new NetworkController(100, 100000 ether, new address[](0));
    Staking staking = new Staking(token, router);
    WorkerRegistration workerRegistration = new WorkerRegistration(token, router);
    RewardTreasury treasury = new RewardTreasury(token);
    DistributedRewardsDistribution distributor = new DistributedRewardsDistribution(router);
    new GatewayRegistry(IERC20WithMetadata(address(token)), router);
    new VestingFactory(token, router);
    router.initialize(workerRegistration, staking, address(treasury), network, new RewardCalculation(router));
    staking.grantRole(staking.REWARDS_DISTRIBUTOR_ROLE(), address(distributor));
    treasury.setWhitelistedDistributor(distributor, true);
    distributor.grantRole(distributor.REWARDS_TREASURY_ROLE(), address(treasury));

    network.setAllowedVestedTarget(address(workerRegistration), true);
    network.setAllowedVestedTarget(address(staking), true);

    vm.stopBroadcast();
  }
}
